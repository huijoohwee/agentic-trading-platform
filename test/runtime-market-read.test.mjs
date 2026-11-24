import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { createGateway } from '../runtime/gateway.mjs';
import { createMcpMarketReadAdapter } from '../runtime/mcp-market-read.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { createProviderRegistry } from '../runtime/provider-mapping.mjs';

const at = '2026-11-20T15:00:00Z', now = () => Date.parse(at), candidate = sha('market-read-test');
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-practice' };
const budgetScope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/' + sha(scope.account_alias) };
const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, {
  role, principal: role + '-fixture', runtime: role + '-fixture', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
}]));
const attestation = { key_id: 'integration', principal: 'integration-fixture', runtime: 'integration-fixture',
  privateKey: pairs.integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
function signed(role, kind, extra = {}) {
  const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate,
    principal: keys[role].principal, runtime: keys[role].runtime, issued_utc: at, expires_utc: '2026-11-20T16:00:00Z', ...extra };
  return { key_id: role, payload, signature: sign(null, Buffer.from(canonical(payload)), pairs[role].privateKey).toString('base64url') };
}
const descriptor = { name: 'quote_cur_kline', description: 'kline', inputSchema: { type: 'object' } };
const mapping = { protocol: '2025-11-25', operations: { 'read.candles': { tool: 'quote_cur_kline',
  input_map: { code_list: 'symbol', num: 'count' }, array_parameters: ['code_list'], rows_path: ['data', 'kline_list'],
  fields: { time: { path: ['timestamp'] }, open: { path: ['open'] }, close: { path: ['close'] } }, numeric: ['open', 'close'] } } };
const tools = [{ operation: 'read.candles', name: 'quote_cur_kline', effect: 'read', schema_digest: sha(descriptor) }];
const definition = { schema: 'trading-provider-definition/v1', provider: 'labelled-market-adapter', adapter_version: '1',
  transport: { kind: 'MCP', origin: 'https://provider.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('adapter'),
  schema_digest: sha(descriptor), mapping_digest: sha(mapping), mapping, operations: ['read.candles'], allowlist: ['quote_cur_kline'],
  mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
function grant(nonce = 'grant-one', budget = nonce, overrides = {}) {
  return signed('operator', 'read', { nonce, tools, mapping_digest: sha(mapping), limits: { max_calls: 12, timeout_ms: 1000 },
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind === 'cost' ? 'cost:' + budget : kind), expires_utc: '2026-11-20T16:00:00Z' })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, ...overrides });
}
const klineResponse = { data: { kline_list: [{ timestamp: 1700000000, open: '100.25', close: '101.50' }, { timestamp: 1700000060, open: '101.50', close: '102.00' }] } };
function fakeProvider({ tools: listed = [descriptor], catalog = () => ({ tools: listed }), result = klineResponse, protocol = '2025-11-25' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, method: body.method, params: body.params });
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: protocol, capabilities: { tools: {} } } }),
      { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-fixture' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: catalog(body.params) });
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: result } });
    throw Error('unexpected method ' + body.method);
  };
  return { fetchImpl, calls };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-market-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, path };
}
const adapterFor = (fake, edit = value => value) => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000', mapping: edit(mapping),
  attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });

test('provider market read projects candles, preserves precision and charges the shared $0 counter', async t => {
  const { store } = await fixture(t);
  const provider = fakeProvider();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  const result = await boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant() });
  assert.equal(result.source, 'AUTHENTICATED_ADAPTER');
  assert.deepEqual(result.rows, [{ time: 1700000000, open: 100.25, close: 101.5 }, { time: 1700000060, open: 101.5, close: 102 }]);
  assert.equal(result.decimals[0].open, '100.25');
  assert.equal(result.cost.tool_calls, 4);
  assert.equal(provider.calls[0].url, definition.transport.origin);
  assert.deepEqual(provider.calls.at(-1).params.arguments, { code_list: ['US.AAPL'], num: 2 });
  const counter = store.read(budgetScope).telemetry[sha('cost:grant-one')];
  assert.equal(counter.calls, 12);
});

test('schema drift, mapping drift and write-like tools are refused', async t => {
  const { store } = await fixture(t);
  const provider = fakeProvider();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  await assert.rejects(boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant('drift', 'drift', { tools: [{ ...tools[0], schema_digest: sha('wrong') }] }) }), /SCHEMA_DRIFT/);
  await assert.rejects(boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant('map', 'map', { mapping_digest: sha('wrong') }) }), /MAPPING_DRIFT/);
  assert.throws(() => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000', attestation, scope, candidate, fetchImpl: provider.fetchImpl, now,
    mapping: { protocol: '2025-11-25', operations: { 'read.candles': { tool: 'trading_order_place', rows_path: ['data'] } } } }), /SCOPE_DENIED/);
});

test('the single counter denies reads once the budget is exhausted', async t => {
  const { store } = await fixture(t);
  const provider = fakeProvider();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  await boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant('first', 'shared') });
  await assert.rejects(boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant('second', 'shared') }), /BUDGET_HALT/);
});

test('gateway admits a PROVIDER market read through the boundary and refuses unallowlisted tools', async t => {
  const { store } = await fixture(t);
  const provider = fakeProvider();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  const capability = { provider: 'labelled-market-adapter', adapter_version: '1', adapter_digest: sha('adapter'), schema_digest: sha(descriptor),
    mapping_digest: sha(mapping), transport: 'MCP', protocol: '2025-11-25', source: 'PROVIDER', mode: 'account', operations: ['read.candles'], allowlist: ['quote_cur_kline'],
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true }, qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
  const gateway = createGateway({ store, scope, candidate, capabilities: [capability], keys, audienceToken: 'fixture-audience-token-0000000000',
    providers: createProviderRegistry([definition]),
    readers: { 'read.candles': async ({ inputs }) => boundary({ operation: 'read.candles', inputs, grant: inputs.grant }) }, now });
  const request = { contract_version: '1', request_id: 'req-one', capability_digest: sha(capability), operation: 'read.candles', scope,
    inputs: { symbol: 'US.AAPL', count: 2, grant: grant('gw', 'gw') }, deadline_utc: '2026-11-20T15:05:00Z' };
  const admitted = await gateway.admit(request, 'Bearer fixture-audience-token-0000000000');
  assert.equal(admitted.status, 'OK');
  assert.equal(admitted.data.source, 'AUTHENTICATED_ADAPTER');
  assert.equal(admitted.provenance.source, 'PROVIDER');
  const denied = await gateway.admit({ ...request, request_id: 'req-two', inputs: { ...request.inputs, grant: grant('gw2', 'gw2', { tools: [{ ...tools[0], name: 'quote_other' }] }) } }, 'Bearer fixture-audience-token-0000000000');
  assert.equal(denied.status, 'REFUSED');
  assert.equal(denied.error.code, 'UNAUTHORIZED');
});

test('discovery follows opaque cursors within the grant before a single business read', async t => {
  const { store } = await fixture(t);
  const cursor = 'two/+==';
  const provider = fakeProvider({ catalog: params => Object.hasOwn(params, 'cursor')
    ? { tools: [descriptor] } : { tools: [], nextCursor: cursor } });
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  const result = await boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 }, grant: grant() });
  assert.deepEqual(provider.calls.filter(call => call.method === 'tools/list').map(call => call.params), [{}, { cursor }]);
  assert.equal(result.cost.tool_calls, 5);
  assert.equal(provider.calls.filter(call => call.method === 'tools/call').length, 1);
});

test('catalog cycles, ambiguous tool names, oversized catalogs and exhausted discovery grants refuse before read', async t => {
  const cases = [
    ['cycle', () => ({ tools: [], nextCursor: 'repeat' }), 12, /TOOL_CATALOG_INCOMPLETE/],
    ['duplicate', params => params.cursor ? { tools: [descriptor] } : { tools: [descriptor], nextCursor: 'next' }, 12, /SCHEMA_DRIFT/],
    ['size', () => ({ tools: Array(1025).fill(descriptor) }), 12, /TOOL_CATALOG_INCOMPLETE/],
    ['budget', () => ({ tools: [], nextCursor: 'next' }), 4, /BUDGET_HALT/],
    ['pages', params => ({ tools: [], nextCursor: (params.cursor ?? '') + 'a' }), 12, /TOOL_CATALOG_INCOMPLETE/],
  ];
  for (const [name, catalog, max_calls, error] of cases) {
    const { store } = await fixture(t);
    const provider = fakeProvider({ catalog });
    const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
    await assert.rejects(boundary({ operation: 'read.candles', inputs: { symbol: 'US.AAPL', count: 2 },
      grant: grant(name, name, { limits: { max_calls, timeout_ms: 1000 } }) }), error);
    assert.ok(provider.calls.length < max_calls);
    assert.equal(provider.calls.some(call => call.method === 'tools/call'), false);
  }
});
