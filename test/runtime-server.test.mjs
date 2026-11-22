import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical } from '../runtime/core.mjs';
import { createReadImporter, recoverReadImport } from '../runtime/ingestion.mjs';
import { sha } from '../runtime/core.mjs';
import { openStore, appendEvent } from '../runtime/store.mjs';
import { openConfiguredRuntime, readPrivateJson } from '../runtime/config.mjs';
import { createRuntimeApi } from '../runtime/http.mjs';
import { projectRuntime } from '../runtime/projection.mjs';

const scope = { environment: 'SIMULATE', profile: 'competition', account_alias: 'fixture-private' };
const coordination = { ...scope, profile: 'practice' }, candidate = sha('server-test');
const at = '2026-11-20T15:00:00Z', viewerToken = 'fixture-viewer-only-000000000000000000';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-server-'));
  const store = openStore(join(directory, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
function seed(store) {
  store.transaction(scope, state => {
    for (const [run, equity, time] of [['one', 100, '2026-11-20T14:00:00Z'], ['two', 80, at]]) {
      state.snapshots[run] = { source: 'AUTHENTICATED_ADAPTER', observed_utc: time, digest: sha(run),
        portfolio: { equity, cash: equity, dayPnl: -20, positions: [{ symbol: 'US.TEST', quantity: 1, value: 10, flags: [] }] },
        input: { private_account: 'secret-account-number', IN_Orders: [{ broker_order_id: 'raw-broker-reference', symbol_key: 'US.TEST', side: 'BUY', qty: 1, filled_qty: 0, status_src: 'WORKING' }] } };
    }
    state.currentSnapshot = 'two';
    state.telemetry['forward:fixture'] = { source: { run_ref: sha('provider-run'), stream: 'schedule_run' },
      latest: { status: 'completed', push_status: 'failed', usage: { total_credits: null } }, thread_refs: [sha('child')] };
    state.telemetry['forward-thread:fixture'] = { thread_ref: sha('child'), role: 'child', status: 'idle', usage: { total_credits: 2 } };
  });
  store.transaction(coordination, state => {
    state.halted = true; state.haltReason = 'RELEASE_UNKNOWN';
    const event = appendEvent(state, { id: 'paper-one', type: 'PAPER_UNCERTAIN', at, data: {} });
    state.decisions.push({ scope, status: 'RELEASE_UNKNOWN', reason: 'TIMEOUT', event_id: event.id },
      { scope: coordination, status: 'WORKING', event_id: event.id });
  });
}

test('projection redacts account IDs and keeps scope, completion, delivery and usage distinct', async t => {
  const { store } = await fixture(t); seed(store);
  const view = projectRuntime(store.read(scope), candidate, Date.parse(at), store.read(coordination));
  assert.equal(view.max_drawdown, 0.2);
  assert.equal(view.halted, true);
  assert.equal(view.counts.decisions, 1);
  assert.equal(view.decisions[0].at, at);
  assert.equal(view.runs[0].status, 'completed');
  assert.equal(view.runs[0].delivery, 'failed');
  assert.equal(view.runs[0].usage, null);
  assert.equal(view.threads[0].usage, 2);
  const { digest, ...data } = view; assert.equal(digest, sha(data));
  assert.doesNotMatch(JSON.stringify(view), /secret-account-number|raw-broker-reference|private_account/);
  const oldCandidate = sha('earlier-runtime');
  store.transaction(scope, state => { state.snapshots.two.candidate = oldCandidate; });
  const changed = projectRuntime(store.read(scope), candidate);
  assert.equal(changed.candidate, oldCandidate); assert.equal(changed.configured_candidate, candidate);
});

test('loopback runtime API is authenticated, origin-bound, read-only and never cacheable', async t => {
  const { store } = await fixture(t); seed(store);
  const api = createRuntimeApi({ store, scope, candidate, viewerToken, now: () => Date.parse(at) });
  const server = createServer((request, response) => { if (!api(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + viewerToken };
  for (const [path, options, status] of [
    ['/api/runtime', {}, 401], ['/api/runtime', { headers: { Authorization: 'Bearer wrong' } }, 401],
    ['/api/runtime', { method: 'POST', headers }, 405],
    ['/api/runtime', { headers: { ...headers, Origin: 'https://untrusted.invalid' } }, 403],
    ['/api/runtime', { headers: { ...headers, Host: 'untrusted.invalid' } }, 403],
    ['/api/runtime?token=anything', { headers }, 404], ['/runtime/core.mjs', { headers }, 404],
  ]) {
    const actual = await new Promise((resolve, reject) => {
      const request = httpRequest(origin + path, options, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject); request.end();
    });
    assert.equal(actual, status, path);
  }
  const response = await fetch(origin + '/api/runtime', { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await response.json()).halt_reason, 'RELEASE_UNKNOWN');
  const head = await fetch(origin + '/api/runtime', { headers, method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('private config refuses public files, symlinks, LIVE and database traversal; CLI emits redacted state only', async t => {
  const { directory } = await fixture(t);
  const path = join(directory, 'config.json');
  const config = { schema: 'trading-runtime-config/v1', database: 'configured.sqlite', scope, candidate, keys: {}, viewer_token: viewerToken };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const runtime = openConfiguredRuntime(path); runtime.store.close();
  const output = execFileSync(process.execPath, [new URL('../scripts/runtime.mjs', import.meta.url).pathname, 'inspect', path], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).readiness, 'UNQUALIFIED'); assert.ok(!output.includes(viewerToken));
  await chmod(path, 0o644); assert.throws(() => readPrivateJson(path), /PRIVATE_FILE_REQUIRED/);
  await chmod(path, 0o600);
  const link = join(directory, 'linked.json'); await symlink(path, link); assert.throws(() => readPrivateJson(link));
  for (const change of [{ database: '../escaped.sqlite' }, { scope: { ...scope, environment: 'LIVE' } }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change })); assert.throws(() => openConfiguredRuntime(path));
  }
});

test('signed recovery interrupts an abandoned read without refunds or replacing the accepted snapshot', async t => {
  const { store } = await fixture(t), pair = generateKeyPairSync('ed25519'), proof = sha('cost-proof');
  const keys = { operator: { role: 'operator', principal: 'operator', runtime: 'private-host', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) } };
  const signed = (kind, extra) => {
    const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate, principal: 'operator', runtime: 'private-host',
      issued_utc: at, expires_utc: '2026-11-21T15:00:00Z', ...extra };
    return { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), pair.privateKey).toString('base64url') };
  };
  const binding = sha('original-read'), budget = { ...coordination, account_alias: 'runtime-budget/' + sha(scope.account_alias) };
  store.transaction(scope, state => {
    state.currentSnapshot = 'previous'; state.snapshots.previous = { digest: sha('previous') };
    state.checkpoints['import:interrupted'] = { status: 'READING', binding, reserved_calls: 4 };
  });
  store.transaction(budget, state => { state.telemetry[proof] = { limit: 8, calls: 4 }; });
  let calls = 0;
  const read = createReadImporter({ store, scope, candidate, keys, now: () => Date.parse(at), adapter: {
    open() { calls++; throw Error('MOCK unavailable'); },
  } });
  const grant = signed('read', { nonce: 'next', limits: { max_calls: 4, timeout_ms: 100 }, cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 8 },
    tools: ['IN_Quotes','IN_Positions','IN_Balance','IN_Orders'].map(sheet => ({ sheet, name: 'read-' + sheet, effect: 'read', schema_digest: sha(sheet) })),
    proofs: ['cost','rights','account'].map(kind => ({ kind, digest: kind === 'cost' ? proof : sha(kind), expires_utc: '2026-11-21T15:00:00Z' })) });
  await assert.rejects(read({ run_id: 'next', grant }), /IMPORT_BUSY/); assert.equal(calls, 0);
  const recover = permit => recoverReadImport({ store, scope, candidate, keys, permit, now: Date.parse(at) });
  assert.throws(() => recover(signed('read-recovery', { run_id: 'interrupted', nonce: 'recover', import_binding: sha('wrong') })), /RECOVERY_BINDING/);
  const permit = signed('read-recovery', { run_id: 'interrupted', nonce: 'recover', import_binding: binding });
  assert.deepEqual(recover(permit), { status: 'INTERRUPTED', refunded_calls: 0 });
  assert.equal(store.read(scope).currentSnapshot, 'previous'); assert.equal(store.read(budget).telemetry[proof].calls, 4);
  assert.throws(() => recover(permit), /RECOVERY_BINDING/);
  await assert.rejects(read({ run_id: 'next', grant }), /READ_FAILED/); assert.equal(calls, 1);
  assert.equal(store.read(budget).telemetry[proof].calls, 8); assert.equal(store.read(scope).currentSnapshot, 'previous');
});

test('a transaction with an invalid return value does not commit', async t => {
  const { store } = await fixture(t);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => store.transaction(scope, state => { state.halted = true; return cyclic; }), /INVALID_JSON/);
  assert.equal(store.read(scope).revision, 0); assert.equal(store.read(scope).halted, false);
});
