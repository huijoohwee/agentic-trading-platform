import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha, verifyEnvelope } from '../runtime/core.mjs';
import { openStore, appendEvent } from '../runtime/store.mjs';
import { createReadImporter, SHEETS } from '../runtime/ingestion.mjs';
import { createMcpReadAdapter } from '../runtime/mcp-read.mjs';

const at = '2026-11-20T15:00:00Z', now = () => Date.parse(at), candidate = sha('runtime-test');
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-practice' };
const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, {
  role, principal: role + '-fixture', runtime: role + '-fixture', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
}]));
function signed(role, kind, extra = {}) {
  const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate,
    principal: keys[role].principal, runtime: keys[role].runtime, issued_utc: at, expires_utc: '2026-11-20T16:00:00Z', ...extra };
  return { key_id: role, payload, signature: sign(null, Buffer.from(canonical(payload)), pairs[role].privateKey).toString('base64url') };
}
const tools = SHEETS.map(sheet => ({ sheet, name: 'read_' + sheet, effect: 'read', schema_digest: sha(sheet) }));
const readMapping = { protocol: '2025-11-25', account_identity: 'private-account', sheets: {} };
const readDefinition = { schema: 'trading-provider-definition/v1', provider: 'labelled-read-adapter', adapter_version: '1',
  transport: { kind: 'MCP', origin: 'https://provider.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('read-adapter'),
  schema_digest: sha('read-schema'), mapping_digest: sha(readMapping), mapping: readMapping, operations: ['read.snapshot'],
  allowlist: ['read_quotes'], mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('read-receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
function grant(nonce = 'grant-one', budget = nonce) {
  return signed('operator', 'read', { nonce, tools, limits: { max_calls: 12, timeout_ms: 100 },
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind === 'cost' ? 'cost:' + budget : kind), expires_utc: '2026-11-20T16:00:00Z' })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, fx: { USD: 1 } });
}
function page({ sheet, run_id, cursor = null }) {
  const rows = sheet === 'IN_Quotes' ? [{ run_id, symbol_key: 'US.TEST', market: 'US', ccy: 'USD', last: 10,
    prev_close: 9, quote_ts_utc: at, source_id: 'PROVIDER', delay_class: 'realtime' }] : sheet === 'IN_Balance' ? [{
    run_id, account_alias: scope.account_alias, ccy: 'USD', cash: 100000, total_assets: 100000, as_of_utc: at }] : [];
  return { sheet, run_id, cursor, next: null, rows, decimals: rows.map(row => Object.fromEntries(Object.entries(row)
    .filter(([, value]) => typeof value === 'number').map(([key, value]) => [key, String(value)]))),
  source_event: sheet + '-' + run_id, response_digest: sha(rows), schema_digest: sha(sheet), observed_utc: at };
}
function adapter(edit = value => value) {
  return { open: async () => signed('integration', 'read-capabilities', { calls: 0, tools }),
    read: async request => signed('integration', 'provider-page', edit(page(request))) };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-runtime-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, path };
}

test('signed reads commit atomically, preserve decimals and reopen one accepted snapshot', async t => {
  const { store, path } = await fixture(t);
  let calls = 0;
  const source = adapter(); const read = source.read; source.read = async value => { calls++; return read(value); };
  const ingest = createReadImporter({ store, scope, candidate, keys, adapter: source, now });
  const first = await ingest({ run_id: 'run-one', grant: grant() });
  assert.equal(first.portfolio.equity, 100000);
  assert.equal(first.precisions.IN_Quotes[0].last, '10');
  const other = openStore(path);
  try { assert.equal(other.read(scope).currentSnapshot, 'run-one'); } finally { other.close(); }
  assert.deepEqual(await ingest({ run_id: 'run-one', grant: grant() }), first);
  assert.equal(calls, 4);
  await assert.rejects(ingest({ run_id: 'run-two', grant: grant() }), /GRANT_REPLAY/);
});

test('malformed, wrong-scope, precision-loss and partial pages retain the previous pointer', async t => {
  const { store } = await fixture(t);
  await createReadImporter({ store, scope, candidate, keys, adapter: adapter(), now })({ run_id: 'accepted', grant: grant() });
  for (const [name, edit, reason] of [
    ['formula', value => { if (value.rows[0]) value.rows[0].ccy = '=CMD'; return value; }, /INVALID_ROWS/],
    ['precision', value => { if (value.sheet === 'IN_Quotes') value.decimals[0].last = '10.0000000000000001'; return value; }, /PRECISION_LOSS/],
    ['scope', value => ({ ...value, scope: { ...scope, profile: 'competition' } }), /CANDIDATE_BINDING/],
    ['cursor', value => ({ ...value, next: 'repeat' }), /INVALID_PAGE/],
    ['missing-delay', value => { if (value.sheet === 'IN_Quotes') delete value.rows[0].delay_class; return value; }, /INVALID_ROWS/],
  ]) {
    const ingest = createReadImporter({ store, scope, candidate, keys, adapter: adapter(edit), now });
    await assert.rejects(ingest({ run_id: name, grant: grant(name) }), reason);
    assert.equal(store.read(scope).currentSnapshot, 'accepted');
    assert.equal(store.read(scope).snapshots[name], undefined);
  }
});

test('timeout cancels a pending read and scope denial never retries', async t => {
  const { store } = await fixture(t);
  let count = 0, aborted = false;
  const hung = adapter(); hung.read = ({ signal }) => { count++; signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); };
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: hung, now })({ run_id: 'timeout', grant: grant() }), /TIMEOUT/);
  assert.equal(count, 1); assert.equal(aborted, true); assert.equal(store.read(scope).currentSnapshot, null);
  const denied = adapter(); denied.read = async () => { count++; throw Object.assign(new Error('secret-server-error'), { code: 'SCOPE_DENIED' }); };
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: denied, now })({ run_id: 'denied', grant: grant('second') }), /SCOPE_DENIED/);
  assert.equal(count, 2);
});

test('forged authority, live account, expired grant and revoked principal fail without reads', async t => {
  const { store } = await fixture(t); let called = false;
  const source = { open() { called = true; } };
  const forged = grant(); forged.payload.cost.remaining_calls = 999;
  const ingest = createReadImporter({ store, scope, candidate, keys, adapter: source, now });
  for (const permission of [forged, signed('operator', 'read', { ...grant().payload, expires_utc: at }),
    signed('operator', 'read', { ...grant().payload, scope: { ...scope, environment: 'LIVE' } })]) {
    await assert.rejects(ingest({ run_id: 'forged', grant: permission }));
  }
  assert.throws(() => verifyEnvelope(grant(), { keys: { ...keys, operator: { ...keys.operator, revoked: true } },
    role: 'operator', kind: 'read', scope, candidate, now: now() }), /UNTRUSTED_PRINCIPAL/);
  assert.equal(called, false);
});

test('cost reservations survive reopen, span profiles and preserve accepted-run idempotence', async t => {
  const { store, path } = await fixture(t);
  const budgetScope = { ...scope, account_alias: 'runtime-budget/' + sha(scope.account_alias) };
  const permission = grant('first', 'shared');
  const snapshot = await createReadImporter({ store, scope, candidate, keys, adapter: adapter(), now })({ run_id: 'first', grant: permission });
  const reopened = openStore(path);
  let outbound = 0;
  const source = { open() { outbound++; throw new Error('unexpected call'); } };
  try {
    const ingest = createReadImporter({ store: reopened, scope, candidate, keys, adapter: source, now });
    const revision = reopened.read(budgetScope).revision;
    assert.deepEqual(await ingest({ run_id: 'first', grant: permission }), snapshot);
    assert.equal(reopened.read(budgetScope).revision, revision);
    for (const profile of ['practice', 'competition']) {
      const target = { ...scope, profile };
      const next = signed('operator', 'read', { ...grant(profile, 'shared').payload, scope: target });
      await assert.rejects(createReadImporter({ store: reopened, scope: target, candidate, keys, adapter: source, now })({ run_id: profile, grant: next }), /BUDGET_HALT/);
      const checkpoint = reopened.read(target).checkpoints['import:' + profile];
      assert.equal(checkpoint.status, 'FAILED');
      assert.equal(checkpoint.calls, 0);
      assert.equal(checkpoint.reserved_calls, 0);
    }
    assert.equal(outbound, 0);
    assert.deepEqual(reopened.read(budgetScope).telemetry[permission.payload.proofs[0].digest], { limit: 12, calls: 12 });
    assert.equal(snapshot.cost.tool_calls, 4);
    await createReadImporter({ store: reopened, scope, candidate, keys, adapter: adapter(), now })({ run_id: 'fresh', grant: grant('fresh') });
    assert.equal(reopened.read(scope).currentSnapshot, 'fresh');
  } finally { reopened.close(); }
});

test('the same cost proof cannot change its lifetime limit or reclaim unused calls', async t => {
  const { store } = await fixture(t);
  const permission = (nonce, remaining_calls) => signed('operator', 'read', { ...grant(nonce, 'shared').payload,
    cost: { ...grant().payload.cost, remaining_calls } });
  const source = adapter(); let opens = 0;
  const open = source.open; source.open = async value => { opens++; return open(value); };
  const ingest = createReadImporter({ store, scope, candidate, keys, adapter: source, now });
  await ingest({ run_id: 'first', grant: permission('first', 24) });
  await assert.rejects(ingest({ run_id: 'changed', grant: permission('changed', 36) }), /BUDGET_HALT/);
  await ingest({ run_id: 'second', grant: permission('second', 24) });
  await assert.rejects(ingest({ run_id: 'exhausted', grant: permission('exhausted', 24) }), /BUDGET_HALT/);
  assert.equal(opens, 2);
  assert.deepEqual(store.read({ ...scope, account_alias: 'runtime-budget/' + sha(scope.account_alias) }).telemetry[sha('cost:shared')], { limit: 24, calls: 24 });
});

test('setup failure records UNKNOWN calls and retains the full reservation across reopen', async t => {
  const { store, path } = await fixture(t); let opens = 0;
  const source = { open() { opens++; throw Object.assign(new Error('setup failed'), { code: 'PROVIDER_UNAVAILABLE' }); } };
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'setup', grant: grant('setup', 'shared') }), /PROVIDER_UNAVAILABLE/);
  const state = store.read(scope), checkpoint = state.checkpoints['import:setup'];
  assert.equal(checkpoint.status, 'FAILED');
  assert.equal(checkpoint.calls, 'UNKNOWN');
  assert.equal(checkpoint.reserved_calls, 12);
  assert.equal(state.events.at(-1).data.calls, 'UNKNOWN');
  assert.equal(state.events.at(-1).data.reserved_calls, 12);
  const reopened = openStore(path);
  try {
    await assert.rejects(createReadImporter({ store: reopened, scope, candidate, keys, adapter: source, now })({ run_id: 'retry', grant: grant('retry', 'shared') }), /BUDGET_HALT/);
    assert.equal(opens, 1);
  } finally { reopened.close(); }
});

test('an interrupted checkpoint cannot refund a durable reservation or resume outbound reads', async t => {
  const { store, path } = await fixture(t); let interrupted = false, opens = 0;
  const interruptedStore = { read: store.read, transaction(...args) {
    if (interrupted) throw new Error('storage interrupted');
    return store.transaction(...args);
  } };
  const source = { open() { opens++; interrupted = true; throw new Error('interrupted setup'); } };
  const permission = grant('interrupted', 'shared');
  await assert.rejects(createReadImporter({ store: interruptedStore, scope, candidate, keys, adapter: source, now })({ run_id: 'interrupted', grant: permission }), /storage interrupted/);
  const reopened = openStore(path);
  try {
    const ingest = createReadImporter({ store: reopened, scope, candidate, keys, adapter: source, now });
    assert.equal(reopened.read(scope).checkpoints['import:interrupted'].status, 'READING');
    await assert.rejects(ingest({ run_id: 'interrupted', grant: permission }), /INCOMPLETE_IMPORT/);
    const target = { ...scope, profile: 'competition' };
    await assert.rejects(createReadImporter({ store: reopened, scope: target, candidate, keys, adapter: source, now })({ run_id: 'retry',
      grant: signed('operator', 'read', { ...grant('retry', 'shared').payload, scope: target }) }), /BUDGET_HALT/);
    assert.equal(opens, 1);
    assert.equal(reopened.read({ ...scope, account_alias: 'runtime-budget/' + sha(scope.account_alias) }).telemetry[sha('cost:shared')].calls, 12);
  } finally { reopened.close(); }
});

test('pagination stops exactly at the reserved call cap and does not refund failed reads', async t => {
  const { store } = await fixture(t); let calls = 0;
  const source = adapter(value => ({ ...value, next: 'page-' + ++calls }));
  const permission = signed('operator', 'read', { ...grant('pages', 'shared').payload, limits: { max_calls: 4, timeout_ms: 100 },
    cost: { ...grant().payload.cost, remaining_calls: 4 } });
  const ingest = createReadImporter({ store, scope, candidate, keys, adapter: source, now });
  await assert.rejects(ingest({ run_id: 'pages', grant: permission }), /BUDGET_HALT/);
  assert.equal(calls, 4);
  assert.equal(store.read(scope).checkpoints['import:pages'].calls, 4);
  assert.equal(store.read(scope).checkpoints['import:pages'].reserved_calls, 4);
  await assert.rejects(ingest({ run_id: 'again', grant: signed('operator', 'read', { ...permission.payload, nonce: 'again' }) }), /BUDGET_HALT/);
  assert.equal(calls, 4);
  assert.equal(store.read(scope).currentSnapshot, null);
});

test('reserved budget aliases cannot be used as actual read accounts', async t => {
  const { store } = await fixture(t);
  const target = { ...scope, account_alias: 'runtime-budget/' + sha(scope.account_alias) };
  assert.throws(() => createReadImporter({ store, scope: target, candidate, keys, adapter: adapter(), now }), /ACCOUNT_BINDING/);
  assert.throws(() => createMcpReadAdapter({ provider: readDefinition, scope: target }), /ACCOUNT_BINDING/);
});

test('revoked grants and admission proofs fail before setup', async t => {
  const { store } = await fixture(t); let opens = 0;
  const ingest = createReadImporter({ store, scope, candidate, keys, adapter: { open() { opens++; } }, now });
  const revoked = signed('operator', 'read', { ...grant().payload, revoked: true });
  assert.throws(() => verifyEnvelope(revoked, { keys, role: 'operator', kind: 'read', scope, candidate, now: now() }), /REVOKED/);
  await assert.rejects(ingest({ run_id: 'revoked', grant: revoked }), /REVOKED/);
  for (const kind of ['cost', 'rights', 'account']) {
    const payload = grant(kind).payload;
    payload.proofs.find(proof => proof.kind === kind).revoked = true;
    await assert.rejects(ingest({ run_id: kind, grant: signed('operator', 'read', payload) }), /MISSING_ADMISSION_PROOF/);
  }
  assert.equal(opens, 0);
});

for (const stage of ['setup', 'first-page', 'last-page']) {
  test('proof expiry after ' + stage + ' prevents further calls and acceptance', async t => {
    const { store } = await fixture(t); let clock = now(), reads = 0;
    const payload = grant().payload;
    payload.proofs[0].expires_utc = '2026-11-20T15:00:01Z';
    const source = adapter();
    const open = source.open, read = source.read;
    source.open = async request => { const result = await open(request); if (stage === 'setup') clock += 1000; return result; };
    source.read = async request => {
      const result = await read(request); reads++;
      if (reads === (stage === 'first-page' ? 1 : 4)) clock += 1000;
      return result;
    };
    await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now: () => clock })({ run_id: 'expired', grant: signed('operator', 'read', payload) }), /MISSING_ADMISSION_PROOF/);
    assert.equal(reads, stage === 'setup' ? 0 : stage === 'first-page' ? 1 : 4);
    assert.equal(store.read(scope).currentSnapshot, null);
    assert.equal(store.read(scope).checkpoints['import:expired'].status, 'FAILED');
  });
}

for (const change of ['grant-revoked', 'proof-revoked', 'signature', 'operator-key', 'integration-key', 'halt']) {
  test('read admission rechecks ' + change + ' before continuing', async t => {
    const { store } = await fixture(t); let calls = 0;
    const trust = structuredClone(keys), permission = grant(), source = adapter();
    source.read = async request => {
      calls++;
      if (change === 'grant-revoked') Object.assign(permission, signed('operator', 'read', { ...permission.payload, revoked: true }));
      if (change === 'proof-revoked') {
        permission.payload.proofs[1].revoked = true;
        Object.assign(permission, signed('operator', 'read', permission.payload));
      }
      if (change === 'signature') permission.payload.cost.remaining_calls++;
      if (change === 'operator-key') trust.operator.revoked = true;
      if (change === 'integration-key') trust.integration.revoked = true;
      if (change === 'halt') store.transaction(scope, state => { state.halted = true; });
      return signed('integration', 'provider-page', page(request));
    };
    const reason = { 'grant-revoked': 'REVOKED', 'proof-revoked': 'MISSING_ADMISSION_PROOF', signature: 'INVALID_SIGNATURE',
      'operator-key': 'UNTRUSTED_PRINCIPAL', 'integration-key': 'UNTRUSTED_PRINCIPAL', halt: 'IMPORT_HALTED' }[change];
    await assert.rejects(createReadImporter({ store, scope, candidate, keys: trust, adapter: source, now })({ run_id: 'recheck', grant: permission }), new RegExp(reason));
    assert.equal(calls, 1);
    assert.equal(store.read(scope).currentSnapshot, null);
  });
}

for (const kind of ['read-capabilities', 'provider-page']) {
  test('explicitly revoked ' + kind + ' is terminal without retries', async t => {
    const { store } = await fixture(t); let reads = 0;
    const source = { open: async () => signed('integration', 'read-capabilities', { calls: 0, tools, revoked: kind === 'read-capabilities' }),
      read: async request => { reads++; return signed('integration', 'provider-page', { ...page(request), revoked: true }); } };
    await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'revoked', grant: grant() }), /REVOKED/);
    assert.equal(reads, kind === 'provider-page' ? 1 : 0);
    assert.equal(store.read(scope).currentSnapshot, null);
  });
}

test('a second cost proof cannot hide the reserved proof expiring mid-run', async t => {
  const { store } = await fixture(t); let clock = now(), calls = 0;
  const payload = grant().payload;
  payload.proofs.push({ ...payload.proofs[0], digest: sha('different-cost') });
  payload.proofs[0].expires_utc = '2026-11-20T15:00:01Z';
  const source = adapter();
  source.read = async request => { calls++; clock += 1000; return signed('integration', 'provider-page', page(request)); };
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now: () => clock })({ run_id: 'expired-proof', grant: signed('operator', 'read', payload) }), /MISSING_ADMISSION_PROOF/);
  assert.equal(calls, 1);
  assert.equal(store.read(scope).currentSnapshot, null);
});

test('previously admitted signed capabilities are rechecked after a page', async t => {
  const { store } = await fixture(t); let calls = 0;
  const capabilities = signed('integration', 'read-capabilities', { calls: 0, tools });
  const source = { open: async () => capabilities, read: async request => {
    calls++;
    Object.assign(capabilities, signed('integration', 'read-capabilities', { ...capabilities.payload, revoked: true }));
    return signed('integration', 'provider-page', page(request));
  } };
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'revoked-capabilities', grant: grant() }), /REVOKED/);
  assert.equal(calls, 1);
  assert.equal(store.read(scope).currentSnapshot, null);
});

for (const change of ['proof-expiry', 'key-revocation']) {
  test('acceptance transaction rechecks ' + change, async t => {
    const { store } = await fixture(t); let clock = now(), calls = 0;
    const trust = structuredClone(keys), payload = grant().payload;
    payload.proofs[0].expires_utc = '2026-11-20T15:00:01Z';
    const source = adapter(value => { calls++; return value; });
    const boundary = { read: store.read, transaction(target, mutate) {
      return store.transaction(target, state => {
        if (calls === 4) {
          if (change === 'proof-expiry') clock = now() + 1000;
          else trust.operator.revoked = true;
        }
        return mutate(state);
      });
    } };
    await assert.rejects(createReadImporter({ store: boundary, scope, candidate, keys: trust, adapter: source, now: () => clock })({ run_id: 'acceptance', grant: signed('operator', 'read', payload) }),
      change === 'proof-expiry' ? /MISSING_ADMISSION_PROOF/ : /UNTRUSTED_PRINCIPAL/);
    assert.equal(calls, 4);
    assert.equal(store.read(scope).currentSnapshot, null);
    assert.equal(store.read(scope).checkpoints['import:acceptance'].status, 'FAILED');
  });
}

test('SQLite atomically preserves cursor and journal across conflicts and client reopen', async t => {
  const { store, path } = await fixture(t);
  store.transaction(scope, state => { appendEvent(state, { id: 'event', type: 'read', at, data: { value: 1 } }); state.checkpoints.cursor = 'event'; });
  assert.throws(() => store.transaction(scope, state => { state.checkpoints.cursor = 'wrong'; appendEvent(state, { id: 'event', type: 'read', at, data: { value: 2 } }); }), /CONFLICTING_EVENT/);
  const other = openStore(path);
  try {
    assert.equal(other.read(scope).checkpoints.cursor, 'event');
    assert.throws(() => other.transaction(scope, () => {}, 0), /CONFLICT/);
    assert.throws(() => other.transaction(scope, async () => {}), /ASYNC_TRANSACTION_FORBIDDEN/);
    assert.equal(other.read(scope).events.length, 1);
  } finally { other.close(); }
});

function mcpFixture({ clock = now, rows = {}, onRequest = () => {}, encode = JSON.stringify, textContent = false } = {}) {
  const providerRows = { IN_Quotes: [{ symbol_key: 'US.TEST', market: 'US', ccy: 'USD', last: '10', prev_close: '9',
    quote_ts_utc: at, delay_class: 'realtime' }], IN_Positions: [], IN_Balance: [{ account: 'private-account', ccy: 'USD',
    cash: '100000', total_assets: '100000', as_of_utc: at }], IN_Orders: [], ...rows };
  const descriptors = SHEETS.map(sheet => ({ name: 'read_' + sheet, inputSchema: { type: 'object' } }));
  const mappedTools = tools.map((tool, index) => ({ ...tool, schema_digest: sha(descriptors[index]) }));
  const mapping = { protocol: '2025-11-25', account_identity: 'private-account', sheets: Object.fromEntries(SHEETS.map(sheet => [sheet, {
    tool: 'read_' + sheet, parameters: {}, rows_path: ['rows'], account_path: ['account'],
    fields: Object.fromEntries(Object.keys(providerRows[sheet][0] ?? {}).filter(field => field !== 'account').map(field => [field, { path: [field] }])),
  }])) };
  const definition = { schema: 'trading-provider-definition/v1', provider: 'labelled-read-adapter', adapter_version: '1',
    transport: { kind: 'MCP', origin: 'https://provider.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('read-adapter'),
    schema_digest: sha('read-schema'), mapping_digest: sha(mapping), mapping, operations: ['read.snapshot'],
    allowlist: SHEETS.map(sheet => 'read_' + sheet), mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('read-receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
  const received = [];
  const source = createMcpReadAdapter({ provider: definition, token: 'fixture-token-not-a-real-secret', aliasSecret: 'x'.repeat(32), scope, candidate, mapping,
    attestation: { key_id: 'integration', principal: keys.integration.principal, runtime: keys.integration.runtime,
      privateKey: pairs.integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, now: clock,
    fetchImpl: async (url, options) => {
      assert.equal(url, definition.transport.origin); assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body); received.push(request.method);
      await onRequest(request);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const data = { rows: providerRows[request.params?.name?.slice(5)] ?? [] };
      const result = request.method === 'initialize' ? { protocolVersion: mapping.protocol, capabilities: { tools: {} } }
        : request.method === 'tools/list' ? { tools: descriptors }
        : textContent ? { content: [{ type: 'text', text: encode(data) }] } : { structuredContent: data };
      return new Response(encode({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
    } });
  return { source, received, mapping, permission: () => signed('operator', 'read', { ...grant().payload, tools: mappedTools, mapping_digest: sha(mapping) }) };
}

test('MCP read transport pins protocol/schema/mapping and keeps credentials on the pinned reviewed origin', async () => {
  const { source, received, permission } = mcpFixture();
  const admitted = permission().payload;
  const opened = await source.open({ grant: admitted, signal: new AbortController().signal });
  assert.equal(opened.payload.calls, 3);
  const result = await source.read({ sheet: 'IN_Quotes', cursor: null, run_id: 'mcp-run', limit: 50, signal: new AbortController().signal });
  assert.equal(result.payload.rows[0].last, 10);
  assert.equal(result.payload.decimals[0].last, '10');
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  assert.deepEqual(received, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  await assert.rejects(source.open({ grant: { ...admitted, mapping_digest: sha('wrong') }, signal: new AbortController().signal }), /MAPPING_DRIFT/);
});

test('MCP string decimals import successfully while accounting for all setup calls', async t => {
  const { store } = await fixture(t), { source, received, permission } = mcpFixture();
  const snapshot = await createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'mcp', grant: permission() });
  assert.equal(snapshot.portfolio.equity, 100000);
  assert.equal(snapshot.precisions.IN_Balance[0].cash, '100000');
  assert.equal(snapshot.cost.tool_calls, 7);
  assert.equal(received.length, 7);
});

for (const textContent of [false, true]) {
  test('raw long-decimal JSON numbers cannot claim original precision in ' + (textContent ? 'text content' : 'structured content'), async t => {
    const { store } = await fixture(t);
    const { source, received, permission } = mcpFixture({ textContent,
      encode: value => JSON.stringify(value).replace('"last":"10"', '"last":10.0000000000000001') });
    await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'rounded', grant: permission() }), /PRECISION_UNKNOWN/);
    assert.deepEqual(received, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(store.read(scope).currentSnapshot, null);
  });
}

for (const [sheet, fields] of Object.entries({ IN_Quotes: ['last', 'prev_close'], IN_Positions: ['qty', 'avg_cost'],
  IN_Balance: ['cash', 'total_assets'], IN_Orders: ['qty', 'limit_price', 'filled_qty', 'avg_fill_price'] })) {
  test('MCP requires source decimal strings for every ' + sheet + ' monetary and quantity field', async () => {
    for (const field of fields) {
      for (const projection of ['number', 'constant-number', 'constant-string']) {
        const value = projection === 'number' ? 10 : '10';
        const { source, mapping, permission } = mcpFixture({ rows: { [sheet]: [{ account: 'private-account', [field]: value }] } });
        if (projection.startsWith('constant-')) mapping.sheets[sheet].fields[field] = { constant: projection === 'constant-number' ? 10 : '10' };
        await source.open({ grant: permission().payload });
        await assert.rejects(source.read({ sheet, cursor: null, run_id: 'numeric', limit: 50 }), /PRECISION_UNKNOWN/);
      }
    }
  });
}

test('MCP preserves nullable average fill price and exact source strings, rejecting lossy conversion', async t => {
  const nullable = mcpFixture({ rows: { IN_Orders: [{ account: 'private-account', qty: '1.00', avg_fill_price: null }] } });
  await nullable.source.open({ grant: nullable.permission().payload });
  const page = await nullable.source.read({ sheet: 'IN_Orders', cursor: null, run_id: 'nullable', limit: 50 });
  assert.equal(page.payload.rows[0].qty, 1);
  assert.equal(page.payload.decimals[0].qty, '1.00');
  assert.equal(page.payload.rows[0].avg_fill_price, null);
  assert.equal(page.payload.decimals[0].avg_fill_price, undefined);
  const { store } = await fixture(t);
  const precise = mcpFixture({ encode: value => JSON.stringify(value).replace('"last":"10"', '"last":"10.0000000000000001"') });
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: precise.source, now })({ run_id: 'lossy', grant: precise.permission() }), /PRECISION_LOSS/);
  assert.equal(precise.received.length, 4);
  assert.equal(store.read(scope).currentSnapshot, null);
});

for (const change of ['proof-expiry', 'operator-key', 'signature', 'halt']) {
  test('MCP revalidates ' + change + ' between setup outbound calls', async t => {
    const { store } = await fixture(t); let clock = now();
    const trust = structuredClone(keys);
    let admitted;
    const { source, received, permission } = mcpFixture({ clock: () => clock, onRequest: request => {
      if (request.method !== 'initialize') return;
      if (change === 'proof-expiry') clock += 1000;
      if (change === 'operator-key') trust.operator.revoked = true;
      if (change === 'signature') admitted.payload.cost.remaining_calls++;
      if (change === 'halt') store.transaction(scope, state => { state.halted = true; });
    } });
    const payload = permission().payload;
    payload.proofs[0].expires_utc = '2026-11-20T15:00:01Z';
    admitted = signed('operator', 'read', payload);
    const reason = { 'proof-expiry': 'MISSING_ADMISSION_PROOF', 'operator-key': 'UNTRUSTED_PRINCIPAL', signature: 'INVALID_SIGNATURE', halt: 'IMPORT_HALTED' }[change];
    await assert.rejects(createReadImporter({ store, scope, candidate, keys: trust, adapter: source, now: () => clock })({ run_id: 'setup-recheck', grant: admitted }), new RegExp(reason));
    assert.deepEqual(received, ['initialize']);
    const checkpoint = store.read(scope).checkpoints['import:setup-recheck'];
    assert.equal(checkpoint.status, 'FAILED');
    assert.equal(checkpoint.calls, 'UNKNOWN');
    assert.equal(checkpoint.reserved_calls, 12);
  });
}

test('MCP stops outbound calls at exhaustion including setup and never retries the cap', async t => {
  const { store } = await fixture(t), { source, received, permission } = mcpFixture();
  const payload = permission().payload;
  payload.limits.max_calls = 4;
  payload.cost.remaining_calls = 4;
  await assert.rejects(createReadImporter({ store, scope, candidate, keys, adapter: source, now })({ run_id: 'exhausted', grant: signed('operator', 'read', payload) }), /BUDGET_HALT/);
  assert.equal(received.length, 4);
  assert.equal(store.read(scope).checkpoints['import:exhausted'].calls, 4);
  assert.equal(store.read(scope).currentSnapshot, null);
});
