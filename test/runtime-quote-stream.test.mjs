import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOOMOO_QUOTE_SOCKET } from 'agentic-gateway/connectors/moomoo-quote-socket';
import { canonical, sha, verifyEnvelope } from '../runtime/core.mjs';
import { quoteStreamAdapterDigest, quoteStreamMapping, quoteStreamOperation } from '../runtime/moomoo-quote-stream.mjs';
import { readBudgetScope } from '../runtime/read-budget.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { openStore } from '../runtime/store.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';

const utc = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const symbol = 'HK.00700', operation = quoteStreamOperation;
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-stream' };
const candidate = sha('quote-stream-candidate'), pool = sha('one upstream fixture user');
const audience = 'private-local-quote-stream-fixture-audience', token = 'local-quote-stream-fixture';
const operator = generateKeyPairSync('ed25519'), integration = generateKeyPairSync('ed25519');
const keys = Object.fromEntries(Object.entries({ operator, integration }).map(([role, pair]) => [role,
  { role, principal: role, runtime: role, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }]));
const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
  privateKey: integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const frames = {
  quote: { last_price: 302.5 },
  order_book: { bid_list: [], ask_list: [] },
  ticker: { ticker_list: [{ time_ms: 1700000000000, direction: 'BUY', price: 3.25, volume: 1, turnover: 3.25, sequence: '7647056964060558023' }] },
  kline: { period: '1m', adjust: 'none', kl_list: [] },
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'trading-stream-'));
  const expiry = utc(Date.now() + 3600000), servers = new Set(), peers = [], controls = [];
  const connected = Promise.withResolvers();
  const control = { hold: false, refuse: false };
  class Peer extends EventTarget {
    constructor(url) {
      super(); assert.equal(url, MOOMOO_QUOTE_SOCKET);
      this.url = url; this.readyState = 1; peers.push(this);
    }
    incoming(message) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }
    send(text) {
      const { id, action, data, ...subscription } = JSON.parse(text);
      controls.push(action);
      queueMicrotask(() => {
        if (action === 'auth') {
          assert.deepEqual(data, { auth_type: 'oauth2', authorization: 'Bearer ' + token });
          this.incoming({ id, session_id: 'private-session-id', server_time: 1700000000000000 });
        } else if (action === 'subscribe') {
          connected.resolve();
          if (control.refuse) return this.incoming({ id, code: 4, message: 'private error containing ' + token });
          this.incoming({ id, code: 0 });
          const type = Object.keys(subscription)[0];
          this.subscription = subscription;
          this.push = (data = frames[type]) => this.incoming({ type: type.toUpperCase(), symbol, data });
          if (!control.hold) this.push();
        } else {
          assert.equal(action, 'unsubscribe'); assert.deepEqual(subscription, this.subscription);
          this.incoming({ id, code: 0 });
        }
      });
    }
    close() { this.readyState = 3; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Peer });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', original));
  const definition = { schema: 'trading-provider-definition/v1', provider: 'fixture-moomoo', adapter_version: '1',
    adapter_digest: quoteStreamAdapterDigest, schema_digest: quoteStreamMapping.schema_digest, mapping_digest: sha(quoteStreamMapping),
    mapping: quoteStreamMapping, transport: { kind: 'WEBSOCKET', protocol: '13', origin: MOOMOO_QUOTE_SOCKET },
    operations: [operation], allowlist: ['subscribe'], source: 'PROVIDER', mode: 'account',
    qualification: { status: 'QUALIFIED', receipt_digest: sha('local-only-fixture'), expires_utc: expiry },
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true } };
  const { transport, schema, mapping, ...identity } = definition;
  const capability = { ...identity, transport: transport.kind, protocol: transport.protocol };
  const credential = { attestation, token, quota_pool: pool };
  async function serve(bound = scope, changes = {}) {
    const path = join(dir, bound.account_alias + '.json');
    await writeFile(path, JSON.stringify({ schema: 'trading-runtime-config/v1', scope: bound, candidate, keys, database: 'ledger.sqlite',
      viewer_token: 'local-synthetic-viewer-private-stream', providers: [definition],
      provider_credentials: { [definition.provider]: { transports: { WEBSOCKET: credential } } },
      gateway: { audience_token: audience, capabilities: [capability] }, ...changes }), { mode: 0o600 });
    const server = await runtimeCommand(['gateway', path, '0']); servers.add(server);
    const base = 'http://127.0.0.1:' + server.address().port;
    return {
      base,
      async inspect(request) {
        const response = await fetch(base + '/api/gateway/quote-stream-receipt', { method: 'POST',
          headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.json();
      },
      async post(request, mcp = false) {
        const body = mcp ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: operation, arguments: request } } : request;
        const response = await fetch(base + (mcp ? '/mcp' : '/api/gateway'),
          { method: 'POST', headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        const reply = await response.json();
        return mcp ? reply.result.structuredContent : reply;
      },
      async close() { await new Promise(resolve => server.close(resolve)); servers.delete(server); },
    };
  }
  t.after(async () => {
    await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
    await rm(dir, { recursive: true, force: true });
  });
  function request(id, { type = 'quote', bound = scope, change = () => {}, inputs = {} } = {}) {
    const now = Date.now(), parameters = { symbol, type, frame_limit: 1, capture_ms: 2000, control_timeout_ms: 2000,
      ...(type === 'kline' && { period: '1m', adjust: 'none' }), ...inputs };
    const proofs = ['cost', 'rights', 'account', 'stream-quota'].map(kind => ({ kind, digest: sha(kind + id), expires_utc: expiry }));
    Object.assign(proofs[1], { scope: 'quote:read', symbol, topic: type, display: true, private_ledger: true });
    Object.assign(proofs[3], { pool, remaining_sessions: 1, remaining_keys: 1, observed_utc: utc(now - 1000) });
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope: bound, candidate, principal: 'operator',
      runtime: 'operator', issued_utc: utc(now - 1000), expires_utc: expiry, nonce: id, definition_digest: sha(definition),
      mapping_digest: definition.mapping_digest, tools: [{ operation, name: 'subscribe', effect: 'read',
        schema_digest: definition.schema_digest, inputs_digest: sha(parameters) }], proofs,
      cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 3 }, limits: { max_calls: 3, timeout_ms: 8000 } };
    change(payload);
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    return { contract_version: '1', request_id: id, capability_digest: sha(capability), operation, scope: bound,
      inputs: { ...parameters, grant }, deadline_utc: utc(now + 60000) };
  }
  function read(scope) {
    const store = openStore(join(dir, 'ledger.sqlite'));
    try { return store.read(scope); } finally { store.close(); }
  }
  return { serve, request, control, peers, controls, read, ledger: join(dir, 'ledger.sqlite'), connected: connected.promise };
}

for (const type of Object.keys(frames)) test('signed ' + type + ' capture replays across transports and restart', async t => {
  const f = await fixture(t), host = await f.serve(), request = f.request('read-' + type, { type });
  assert.equal((await host.inspect(request)).error.code, 'FINAL_READ_REQUIRED');
  assert.equal(f.peers.length, 0);
  const result = await host.post(request);
  assert.equal(result.status, 'OK', JSON.stringify(result.error));
  const capture = verifyEnvelope(result.data.receipt, { keys, role: 'integration', kind: 'quote-stream-capture', scope, candidate, now: Date.now() });
  assert.equal(capture.frames.length, 1);
  assert.equal(capture.frames[0].symbol, symbol);
  if (type === 'ticker') assert.equal(capture.frames[0].ticks[0].sequence, '7647056964060558023');
  if (type === 'kline') assert.deepEqual(capture.subscription.kline, [{ symbol, period: '1m', adjust: 'none' }]);
  assert.equal(capture.grant_digest, sha(request.inputs.grant));
  assert.deepEqual(result.data.cost, { tool_calls: 3, sessions: 1, subscription_keys: 1, provider_fees: 'UNKNOWN' });
  assert.deepEqual(f.controls, ['auth', 'subscribe', 'unsubscribe']);
  assert.doesNotMatch(JSON.stringify(result), /private-session-id|local-quote-stream-fixture/);
  await host.close();
  const reopened = await f.serve();
  const { display_until_utc, ...stored } = await reopened.inspect(request);
  assert.deepEqual(stored, result);
  assert.equal(Date.parse(display_until_utc), Date.parse(capture.expires_utc));
  assert.equal((await reopened.inspect({ ...request, request_id: 'absent' })).error.code, 'FINAL_READ_REQUIRED');
  assert.equal((await reopened.inspect({ ...request, scope: { ...scope, account_alias: 'other' } })).status, 'REFUSED');
  assert.equal((await reopened.inspect({ ...request, deadline_utc: utc(Date.now() + 180000) })).status, 'REFUSED');
  assert.deepEqual(await reopened.post(request, true), result);
  if (process.env.TRADING_STREAM_BROWSER === '1') {
    const { verifyStreamBrowser } = await import('./quote-stream-receipt-browser.mjs');
    await verifyStreamBrowser({ base: reopened.base, audience, request });
  }
  const clock = t.mock.method(Date, 'now', () => Date.parse(request.deadline_utc) + 5);
  try {
    assert.equal((await reopened.inspect(request)).status, 'OK');
    clock.mock.mockImplementation(() => Date.parse(display_until_utc));
    assert.equal((await reopened.inspect(request)).status, 'REFUSED');
  } finally { clock.mock.restore(); }
  assert.equal(f.read(scope).revision, result.ledger_revision);
  assert.equal(f.read(readBudgetScope(scope)).telemetry[sha('costread-' + type)].calls, 3);
  assert.equal(f.peers.length, 1);
  await reopened.close();
  const revoked = await f.serve(scope, { keys: { ...keys, integration: { ...keys.integration, revoked: true } } });
  assert.equal((await revoked.inspect(request)).status, 'REFUSED');
  assert.equal((await revoked.post(request)).status, 'REFUSED');
  assert.equal(f.peers.length, 1);
});

test('rejects mismatched inputs, rights, quota, cost, expiry and signature before reserving or dialing', async t => {
  const f = await fixture(t), host = await f.serve();
  const changes = [g => { g.tools[0].inputs_digest = sha('other'); }, g => { g.definition_digest = sha('drift'); },
    g => { g.proofs[1].symbol = 'US.AAPL'; }, g => { g.proofs[1].private_ledger = false; }, g => { g.proofs[3].remaining_keys = 0; },
    g => { g.proofs[3].remaining_sessions = 0; }, g => { g.proofs[3].pool = sha('other-pool'); }, g => { g.cost.remaining_calls = 2; },
    g => { g.proofs[1].expires_utc = utc(Date.now() - 1000); }, g => { g.proofs.push({ ...g.proofs[0] }); }];
  for (const [i, change] of changes.entries()) assert.equal((await host.post(f.request('denied-' + i, { change }))).status, 'REFUSED');
  const edited = f.request('edited'); edited.inputs.symbol = 'US.AAPL';
  for (const req of [edited, f.request('extra', { inputs: { endpoint: 'wss://example.invalid/' } }),
    f.request('oversize', { inputs: { frame_limit: 65 } }), f.request('bad-period', { type: 'kline', inputs: { period: 'other' } })]) {
    assert.equal((await host.post(req)).status, 'REFUSED');
  }
  const unsigned = f.request('bad-signature'); unsigned.inputs.grant.signature = 'x'.repeat(86);
  assert.equal((await host.post(unsigned)).status, 'REFUSED');
  assert.deepEqual(f.read(readBudgetScope(scope)).telemetry, {}); assert.equal(f.peers.length, 0);
});

test('one upstream user cannot spend the same headroom across aliases concurrently', async t => {
  const f = await fixture(t), other = { ...scope, account_alias: 'fixture-stream-other' };
  const first = await f.serve(), second = await f.serve(other);
  f.control.hold = true;
  const reading = first.post(f.request('first'));
  await Promise.race([f.connected, reading.then(result => assert.fail('Capture ended before subscribe: ' + result.status))]);
  const denied = await second.post(f.request('second', { bound: other }));
  assert.equal(denied.error.code, 'BUDGET_HALT');
  assert.deepEqual(f.read(readBudgetScope(other)).telemetry, {});
  f.peers[0].push(); assert.equal((await reading).status, 'OK');
  assert.equal(f.peers.length, 1);
});

test('retains charges and the sanitized provider refusal after an interrupted subscription', async t => {
  const f = await fixture(t), host = await f.serve();
  f.control.refuse = true;
  const request = f.request('quota');
  const refused = await host.post(request);
  assert.deepEqual(refused.error, { code: 'BUDGET_HALT', provider_code: 4 });
  assert.deepEqual(await host.post(request, true), refused);
  const retry = { ...request, request_id: 'retry' };
  assert.equal((await host.post(retry)).error.code, 'BUDGET_HALT');
  assert.equal(f.read(readBudgetScope(scope)).telemetry[sha('costquota')].calls, 3);
  assert.deepEqual(f.controls, ['auth', 'subscribe']);
  assert.doesNotMatch(JSON.stringify(f.read(scope)), /private error|local-quote-stream-fixture/);
});

test('a failed capture exhausts the same cost proof for a subsequent market read', async t => {
  const f = await fixture(t), host = await f.serve();
  f.control.hold = true;
  const expired = await host.post(f.request('short-lease', { change(g) { g.limits.timeout_ms = 150; } }));
  assert.equal(expired.error.code, 'STALE');
  assert.equal(f.peers[0].readyState, 3);
  const sibling = f.request('after-socket', { change(g) {
    g.proofs[0].digest = sha('costshort-lease');
    g.tools = [{ effect: 'read', name: 'quote_stock_quote', operation: 'read.ticker', schema_digest: sha('ticker') }];
  } });
  const store = openStore(f.ledger);
  try {
    const read = createMarketReadBoundary({ store, scope, candidate, keys,
      adapter: { open() { assert.fail('Exhausted proof reached the provider'); } } });
    await assert.rejects(read({ operation: 'read.ticker', inputs: { symbol }, grant: sibling.inputs.grant }), /BUDGET_HALT/);
  } finally { store.close(); }
  assert.deepEqual(f.controls, ['auth', 'subscribe']);
});

for (const frameCount of [0, 2]) test('looks up a completed capture with ' + frameCount + ' frames without dialing', async t => {
  const f = await fixture(t), host = await f.serve();
  f.control.hold = true;
  const request = f.request('frames-' + frameCount, { inputs: { frame_limit: 2, capture_ms: frameCount ? 2000 : 150 } });
  const capture = host.post(request);
  await f.connected;
  assert.equal((await host.inspect(request)).error.code, 'FINAL_READ_REQUIRED');
  if (frameCount) {
    f.peers[0].push();
    f.peers[0].push({ last_price: 308.125 });
  }
  const result = await capture;
  assert.equal(result.status, 'OK', JSON.stringify(result.error));
  assert.equal((await host.inspect(request)).data.receipt.payload.frames.length, frameCount);
  if (process.env.TRADING_STREAM_BROWSER === '1') {
    const { verifyStreamBrowser } = await import('./quote-stream-receipt-browser.mjs');
    await verifyStreamBrowser({ base: host.base, audience, request, frameCount });
  }
  assert.deepEqual(f.controls, ['auth', 'subscribe', 'unsubscribe']);
  assert.equal(f.read(scope).revision, result.ledger_revision);
});
