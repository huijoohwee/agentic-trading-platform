import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../runtime/gateway.mjs';
import { createGatewayApi } from '../runtime/gateway-http.mjs';
import { createGatewayMcp } from '../runtime/gateway-mcp.mjs';
import { openStore } from '../runtime/store.mjs';
import { canonical, sha } from '../runtime/core.mjs';
import { createProviderRegistry } from '../runtime/provider-mapping.mjs';

// MOCK admission plus signed-grant verification. These tests prove gateway decision parity,
// isolation, durability and admission authority; they qualify no live provider or credential.
const BASE = Date.parse('2026-11-21T15:00:00Z');
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
const AUDIENCE = 'gateway-audience-token-0123456789abcdef';
const AUTH = 'Bearer ' + AUDIENCE;

function fixture(t) {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.runtime-gateway-'));
  const path = join(directory, 'state.sqlite'), stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  const f = { time: BASE, candidate: sha('MOCK-candidate'), scope: { environment: 'SIMULATE', profile: 'practice', account_alias: 'paper-alias' },
    calls: { read: 0, snapshot: 0, release: 0, reconcile: 0, halt: 0 }, releaseUnknown: false, keys: {}, privateKeys: {} };
  for (const role of ['operator', 'risk', 'research', 'integration']) {
    const pair = generateKeyPairSync('ed25519'); f.privateKeys[role] = pair.privateKey;
    f.keys[role] = { role, principal: `MOCK-${role}`, runtime: `MOCK-${role}-runtime`, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  f.sign = (key, kind, fields = {}) => {
    const actor = f.keys[key], payload = { schema: 'trading-runtime-envelope/v1', kind,
      principal: actor.principal, runtime: actor.runtime, scope: f.scope, candidate: f.candidate,
      issued_utc: iso(f.time - 1000), expires_utc: iso(f.time + 300_000), ...fields };
    return { key_id: key, payload, signature: sign(null, Buffer.from(canonical(payload)), f.privateKeys[key]).toString('base64url') };
  };
  f.proofs = kinds => kinds.map(kind => ({ kind, digest: sha('MOCK-' + kind), expires_utc: iso(f.time + 300_000) }));
  f.providerMapping = { protocol: '2025-11-25', account_identity: 'private-account',
    sheets: { IN_Quotes: { tool: 'read_quotes', rows_path: ['data'], fields: { symbol_key: { path: ['symbol'] } } } } };
  f.paperGrant = (fields = {}) => f.sign('operator', 'paper', { provider: 'mock-broker', source: 'MOCK',
    proofs: f.proofs(['cost', 'rights', 'account', 'isolation']),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 20 }, ...fields });
  f.readGrant = (fields = {}) => f.sign('operator', 'read', { mapping_digest: sha(f.providerMapping),
    tools: [{ sheet: 'IN_Quotes', name: 'read_quotes', effect: 'read', schema_digest: sha('IN_Quotes') }],
    proofs: f.proofs(['cost', 'rights', 'account']),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, ...fields });
  f.db = () => { const s = openStore(path); stores.push(s); return s; };
  f.store = f.db();
  f.capability = { provider: 'mock-broker', adapter_version: '1', adapter_digest: sha('MOCK-adapter'), transport: 'MCP',
    protocol: '2025-11-25', schema_digest: sha('MOCK-schema'), mapping_digest: sha('MOCK-mapping'), mode: 'account', source: 'MOCK',
    operations: ['read.fixture', 'release', 'reconcile', 'halt'], allowlist: ['read.fixture'], rights: 'MOCK', delay: 'realtime',
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 20 },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('MOCK-receipt'), expires_utc: iso(BASE + 300_000) } };
  f.capDigest = sha(f.capability);
  f.providerCap = { ...f.capability, provider: 'provider-broker', source: 'PROVIDER', operations: ['read.snapshot'],
    allowlist: ['read_quotes'], adapter_digest: sha('PROVIDER-adapter'), schema_digest: sha('PROVIDER-schema'), mapping_digest: sha(f.providerMapping) };
  f.providerDigest = sha(f.providerCap);
  f.providerDefinition = { schema: 'trading-provider-definition/v1', provider: 'provider-broker', adapter_version: '1',
    transport: { kind: 'MCP', origin: 'https://provider.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('PROVIDER-adapter'),
    schema_digest: sha('PROVIDER-schema'), mapping_digest: sha(f.providerMapping), mapping: f.providerMapping,
    operations: ['read.snapshot'], allowlist: ['read_quotes'], mode: 'account', source: 'PROVIDER',
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true }, qualification: { status: 'QUALIFIED', receipt_digest: sha('PROVIDER-receipt'), expires_utc: iso(BASE + 300_000) } };
  f.providers = createProviderRegistry([f.providerDefinition]);
  f.readers = { 'read.fixture': async ({ capability, inputs }) => {
    f.calls.read++;
    if (capability.schema_digest !== sha('MOCK-schema')) { const e = new Error('SCHEMA_DRIFT'); e.code = 'SCHEMA_DRIFT'; throw e; }
    if (inputs.bad) { const e = new Error('PRECISION_UNKNOWN'); e.code = 'PRECISION_UNKNOWN'; throw e; }
    return { rows: [{ symbol_key: 'US.AAPL', last: '100.25', prev_close: '99.50', ccy: 'USD' }], decimals: [{ last: '100.25', prev_close: '99.50' }], source: 'MOCK' };
  }, 'read.snapshot': async ({ inputs }) => {
    f.calls.snapshot++;
    return { run_id: inputs.run_id, digest: sha('snapshot'), source: 'AUTHENTICATED_ADAPTER', cost: { tool_calls: 4 } };
  } };
  f.guard = {
    async release(inputs) { f.calls.release++; if (f.releaseUnknown) { const e = new Error('RELEASE_UNKNOWN'); e.code = 'RELEASE_UNKNOWN'; throw e; } return { intent_id: inputs.intent?.intent_id ?? null, status: 'FILLED', source: 'MOCK' }; },
    async reconcile() { f.calls.reconcile++; return { status: 'FILLED', source: 'MOCK' }; },
    async halt() { f.calls.halt++; return { status: 'HALTED', reason: 'OPERATOR_HALT' }; },
  };
  f.gateway = (capabilities = [f.capability], store = f.store) => createGateway({ store, scope: f.scope, candidate: f.candidate,
    capabilities, readers: f.readers, guard: f.guard, keys: f.keys, audienceToken: AUDIENCE, now: () => f.time, providers: f.providers });
  f.request = (operation = 'read.fixture', adjust = {}) => ({ contract_version: '1', request_id: 'req-1', capability_digest: f.capDigest,
    operation, scope: structuredClone(f.scope), inputs: {}, deadline_utc: iso(f.time + 60_000), ...adjust });
  f.finalEvent = (requestId, store = f.store) => store.read(f.scope).events.find(event => event.type === 'gateway-finalized' && event.data.request_id === requestId)?.data;
  return f;
}

function httpRequest({ method = 'POST', url = '/api/gateway', body = null, authorization = AUTH, port = 4181, crossSite = false } = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.socket = { localPort: port };
  req.headers = { host: '127.0.0.1:' + port, ...(authorization !== undefined && { authorization }), ...(crossSite && { 'sec-fetch-site': 'cross-site' }) };
  const res = new EventEmitter();
  res.headersSent = false; res.code = null; res.body = null;
  res.writeHead = code => { res.code = code; res.headersSent = true; };
  res.end = b => { res.body = b; res.emit('finish'); };
  const done = new Promise(resolve => res.once('finish', resolve));
  setImmediate(() => { if (body !== null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); });
  return { req, res, done };
}
const mcpCall = (mcp, request, authorization = AUTH) => mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: request.operation, arguments: request } }, authorization);

test('API and MCP frontends admit identical semantic requests to one ledger revision', async t => {
  const f = fixture(t), gateway = f.gateway(), mcp = createGatewayMcp({ gateway }), api = createGatewayApi({ gateway, mcp });
  const request = f.request('read.fixture', { request_id: 'req-parity' });
  const direct = await gateway.admit(request, AUTH);
  assert.equal(direct.status, 'OK');
  assert.equal(direct.data.rows[0].last, '100.25');
  assert.ok(Number.isSafeInteger(direct.ledger_revision));
  const viaMcp = await mcpCall(mcp, request);
  assert.equal(viaMcp.result.isError, false);
  assert.deepEqual(viaMcp.result.structuredContent, direct);
  const { req, res, done } = httpRequest({ body: request });
  assert.equal(api(req, res), true); await done;
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body), direct);
  assert.equal(f.calls.read, 1, 'identical retries across transports dispatch once');
  assert.equal(f.finalEvent('req-parity').cost_proof, null, 'labelled fixtures carry no provider cost proof');
});

test('wrong gateway audience is refused before admission on every frontend', async t => {
  const f = fixture(t), gateway = f.gateway(), mcp = createGatewayMcp({ gateway }), api = createGatewayApi({ gateway, mcp });
  await assert.rejects(() => gateway.admit(f.request(), 'Bearer wrong'), { code: 'UNAUTHORIZED' });
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, 'Bearer wrong');
  assert.equal(init.error.code, -32001);
  const { req, res, done } = httpRequest({ body: f.request(), authorization: 'Bearer wrong' });
  api(req, res); await done;
  assert.equal(res.code, 401);
  assert.equal(f.calls.read, 0);
});

test('cross-account scope and raw proxy fields are refused', async t => {
  const f = fixture(t), gateway = f.gateway();
  const cross = await gateway.admit(f.request('read.fixture', { scope: { ...f.scope, account_alias: 'other-alias' } }), AUTH);
  assert.equal(cross.status, 'REFUSED'); assert.equal(cross.error.code, 'UNAUTHORIZED');
  const proxy = await gateway.admit({ ...f.request(), endpoint: 'https://caller.example/raw' }, AUTH);
  assert.equal(proxy.status, 'REFUSED'); assert.equal(proxy.error.code, 'UNQUALIFIED');
  assert.equal(f.calls.read, 0);
});

test('unknown capability, unsupported operation and expired qualification refuse typed', async t => {
  const f = fixture(t);
  const gateway = f.gateway();
  assert.equal((await gateway.admit(f.request('read.fixture', { capability_digest: sha('absent'), request_id: 'req-absent' }), AUTH)).error.code, 'UNQUALIFIED');
  assert.equal((await gateway.admit(f.request('not.real', { request_id: 'req-unsupported' }), AUTH)).error.code, 'UNSUPPORTED');
  assert.equal((await gateway.admit(f.request('read.fixture', { deadline_utc: iso(f.time - 1), request_id: 'req-stale-deadline' }), AUTH)).error.code, 'STALE');
  const expired = { ...f.capability, qualification: { ...f.capability.qualification, expires_utc: iso(BASE - 1) } };
  const staleGateway = f.gateway([expired]);
  assert.equal((await staleGateway.admit(f.request('read.fixture', { capability_digest: sha(expired), request_id: 'req-expired' }), AUTH)).error.code, 'STALE');
});

test('schema drift and precision-unknown propagate as typed refusals, never empty success', async t => {
  const f = fixture(t);
  const drifted = { ...f.capability, schema_digest: sha('OTHER-schema') };
  const gateway = f.gateway([f.capability, drifted]);
  const drift = await gateway.admit(f.request('read.fixture', { capability_digest: sha(drifted), request_id: 'req-drift' }), AUTH);
  assert.equal(drift.status, 'REFUSED'); assert.equal(drift.error.code, 'SCHEMA_DRIFT');
  const precision = await gateway.admit(f.request('read.fixture', { inputs: { bad: true }, request_id: 'req-precision' }), AUTH);
  assert.equal(precision.status, 'REFUSED'); assert.equal(precision.error.code, 'PRECISION_UNKNOWN');
});

test('identical retries are idempotent; changed bytes conflict without new dispatch', async t => {
  const f = fixture(t), gateway = f.gateway();
  const first = await gateway.admit(f.request(), AUTH);
  const eventsBefore = f.store.read(f.scope).events.length;
  const retry = await gateway.admit(f.request(), AUTH);
  assert.deepEqual(retry, first);
  assert.equal(f.store.read(f.scope).events.length, eventsBefore);
  const changed = await gateway.admit(f.request('read.fixture', { inputs: { different: true } }), AUTH);
  assert.equal(changed.status, 'REFUSED'); assert.equal(changed.error.code, 'CONFLICTING_EVENT');
  assert.equal(f.calls.read, 1);
});

test('restart recovery preserves admitted results and unresolved-release halt', async t => {
  const f = fixture(t), gateway = f.gateway();
  const first = await gateway.admit(f.request('read.fixture', { request_id: 'req-restart' }), AUTH);
  f.store.close();
  const reopened = f.db(), recovered = f.gateway([f.capability], reopened);
  assert.deepEqual(await recovered.admit(f.request('read.fixture', { request_id: 'req-restart' }), AUTH), first);
  reopened.transaction(f.scope, s => { s.halted = true; s.haltReason = 'RELEASE_UNKNOWN'; });
  const halted = await recovered.admit(f.request('read.fixture', { request_id: 'req-halted' }), AUTH);
  assert.equal(halted.status, 'REFUSED'); assert.equal(halted.error.code, 'RELEASE_UNKNOWN');
  reopened.close();
  const again = f.db();
  assert.equal(again.read(f.scope).haltReason, 'RELEASE_UNKNOWN');
  assert.equal(f.calls.read, 1, 'halt blocks new dispatch');
});

test('approved writes route only to the single guard; uncertainty refuses without resubmission', async t => {
  const f = fixture(t), gateway = f.gateway();
  const released = await gateway.admit(f.request('release', { inputs: { intent: { intent_id: 'intent-1' }, grant: f.paperGrant() }, request_id: 'req-release' }), AUTH);
  assert.equal(released.status, 'OK'); assert.equal(released.data.status, 'FILLED');
  assert.equal(f.calls.release, 1); assert.equal(f.calls.read, 0);
  assert.equal(f.finalEvent('req-release').cost_proof, sha('MOCK-cost'));
  f.releaseUnknown = true;
  const unknown = await gateway.admit(f.request('release', { inputs: { intent: { intent_id: 'intent-2' }, grant: f.paperGrant() }, request_id: 'req-unknown' }), AUTH);
  assert.equal(unknown.status, 'REFUSED'); assert.equal(unknown.error.code, 'RELEASE_UNKNOWN');
  assert.equal(f.calls.release, 2, 'uncertain write is not automatically resubmitted');
});

test('discovery and tools/list expose metadata without dispatch authority', async t => {
  const f = fixture(t), gateway = f.gateway(), mcp = createGatewayMcp({ gateway }), api = createGatewayApi({ gateway, mcp });
  const discovered = gateway.discover();
  assert.equal(discovered[0].capability_digest, f.capDigest);
  assert.equal(discovered[0].qualification.status, 'QUALIFIED');
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, AUTH);
  assert.ok(listed.result.tools.some(tool => tool.name === 'read.fixture'));
  const { req, res, done } = httpRequest({ method: 'GET', url: '/api/gateway/capabilities', body: null });
  api(req, res); await done;
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body).capabilities, discovered);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.release, 0);
});

test('MCP initialize negotiates a pinned protocol and rejects unknown methods', async t => {
  const f = fixture(t), mcp = createGatewayMcp({ gateway: f.gateway() });
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, AUTH);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.capabilities.tools.listChanged, false);
  const unknown = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'sampling/createMessage' }, AUTH);
  assert.equal(unknown.error.code, -32601);
  const notification = await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, AUTH);
  assert.equal(notification, null);
});

test('PROVIDER reads admit only signed allowlisted grants and ledger the cost proof and charged calls', async t => {
  const f = fixture(t), gateway = f.gateway([f.providerCap]);
  const request = f.request('read.snapshot', { capability_digest: f.providerDigest, request_id: 'req-provider',
    inputs: { run_id: 'run-1', grant: f.readGrant() } });
  const admitted = await gateway.admit(request, AUTH);
  assert.equal(admitted.status, 'OK');
  assert.equal(admitted.data.cost.tool_calls, 4);
  assert.equal(admitted.provenance.source, 'PROVIDER');
  assert.equal(admitted.provenance.definition_digest, sha(f.providerDefinition));
  const event = f.finalEvent('req-provider');
  assert.equal(event.cost_proof, sha('MOCK-cost'));
  assert.equal(event.charged_calls, 4);
  assert.equal(f.calls.snapshot, 1);
  const retry = await gateway.admit(request, AUTH);
  assert.deepEqual(retry, admitted);
  assert.equal(f.calls.snapshot, 1, 'idempotent retry does not re-read the provider');
});

test('forged, absent, expired, exhausted and out-of-allowlist grants refuse before provider dispatch', async t => {
  const f = fixture(t), gateway = f.gateway([f.providerCap]);
  const attempt = (grant, requestId) => gateway.admit(f.request('read.snapshot', { capability_digest: f.providerDigest,
    request_id: requestId, inputs: { run_id: 'run-1', ...(grant !== undefined && { grant }) } }), AUTH);
  assert.equal((await attempt(undefined, 'req-absent-grant')).error.code, 'UNQUALIFIED');
  const forged = f.readGrant(); forged.payload.cost.remaining_calls = 999;
  assert.equal((await attempt(forged, 'req-forged')).error.code, 'UNAUTHORIZED');
  const expired = f.readGrant({ expires_utc: iso(f.time - 1) });
  assert.equal((await attempt(expired, 'req-expired-grant')).error.code, 'STALE');
  const exhausted = f.readGrant({ cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 0 } });
  assert.equal((await attempt(exhausted, 'req-exhausted')).error.code, 'BUDGET_HALT');
  const noProofs = f.readGrant({ proofs: f.proofs(['cost', 'rights']) });
  assert.equal((await attempt(noProofs, 'req-no-account-proof')).error.code, 'UNQUALIFIED');
  const outOfList = f.readGrant({ tools: [{ sheet: 'IN_Quotes', name: 'place_order', effect: 'read', schema_digest: sha('IN_Quotes') }] });
  assert.equal((await attempt(outOfList, 'req-out-of-allowlist')).error.code, 'UNAUTHORIZED');
  const wrongMapping = f.readGrant({ mapping_digest: sha('OTHER-mapping') });
  assert.equal((await attempt(wrongMapping, 'req-mapping-drift')).error.code, 'UNAUTHORIZED');
  assert.equal(f.calls.snapshot, 0, 'no refused grant reaches the provider reader');
});

test('writes demand a paper-kind grant with isolation proof; read grants cannot authorize writes', async t => {
  const f = fixture(t), gateway = f.gateway();
  const write = (grant, requestId) => gateway.admit(f.request('release', { request_id: requestId,
    inputs: { intent: { intent_id: 'intent-1' }, grant } }), AUTH);
  assert.equal((await write(f.readGrant(), 'req-read-grant-write')).error.code, 'UNAUTHORIZED');
  assert.equal((await write(f.paperGrant({ proofs: f.proofs(['cost', 'rights', 'account']) }), 'req-no-isolation')).error.code, 'UNQUALIFIED');
  assert.equal((await write(undefined, 'req-absent-write-grant')).error.code, 'UNQUALIFIED');
  assert.equal(f.calls.release, 0);
  const ok = await write(f.paperGrant(), 'req-authorized-write');
  assert.equal(ok.status, 'OK'); assert.equal(f.calls.release, 1);
});

test('a gateway without trusted keys cannot admit connected reads or writes', async t => {
  const f = fixture(t);
  const keyless = createGateway({ store: f.store, scope: f.scope, candidate: f.candidate, capabilities: [f.providerCap],
    readers: f.readers, guard: f.guard, audienceToken: AUDIENCE, now: () => f.time, providers: f.providers });
  const read = await keyless.admit(f.request('read.snapshot', { capability_digest: f.providerDigest, request_id: 'req-keyless',
    inputs: { run_id: 'run-1', grant: f.readGrant() } }), AUTH);
  assert.equal(read.error.code, 'UNQUALIFIED');
  assert.equal(f.calls.snapshot, 0);
});
test('portable resolver preserves the native fixture quote and refusals across direct, HTTP and MCP', async t => {
  const { createResolver } = await import('agentic-gateway');
  const { default: manifest } = await import('../qualification/universal-gateway/quote.json', { with: { type: 'json' } });
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const schemaDigest = createHash('sha256').update(readFileSync(new URL('../runtime/gateway.mjs', import.meta.url))).digest('hex');
  const f = fixture(t), gateway = f.gateway(), mcp = createGatewayMcp({ gateway }), api = createGatewayApi({ gateway, mcp });
  const direct = (request, auth) => gateway.admit(request, auth);
  const routes = {
    direct,
    async http(body, authorization) {
      const { req, res, done } = httpRequest({ body, authorization });
      assert.equal(api(req, res), true); await done;
      return JSON.parse(res.body);
    },
    async mcp(request, auth) {
      const reply = await mcpCall(mcp, request, auth);
      return reply.result.structuredContent;
    },
  };
  const bindings = Object.fromEntries(Object.entries(routes).map(([route, invoke]) => [route, {
    revision: manifest.revision, schemaDigest, costUsd: 0, offline: true, invoke,
  }]));
  const resolver = createResolver([{ manifest, bindings }]);
  assert.deepEqual(resolver.discover()[0].configuredRoutes, manifest.routes);
  const request = f.request('read.fixture', { request_id: 'portable-quote' });
  const plan = { ...manifest, route: 'direct', required: ['decimal-text'], acceptedLosses: [] };
  const first = await resolver.invoke(plan, request, AUTH);
  assert.equal(first.native.data.rows[0].last, '100.25');
  assert.equal(f.calls.read, 1);
  const equivalent = await direct(request, AUTH);
  const expired = f.request('read.fixture', { request_id: 'portable-expired', deadline_utc: iso(f.time - 1) });
  const refusal = await direct(expired, AUTH);
  assert.equal(refusal.error.code, 'STALE');
  for (const route of manifest.routes) {
    const plan = { ...manifest, route, required: ['decimal-text'], acceptedLosses: [] };
    assert.deepEqual((await resolver.invoke(plan, request, AUTH)).native, equivalent);
    assert.deepEqual((await resolver.invoke(plan, expired, AUTH)).native, refusal);
  }
  assert.equal(f.calls.read, 1);
});
