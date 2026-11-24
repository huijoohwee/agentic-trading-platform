import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { createGateway } from '../runtime/gateway.mjs';
import { createGatewayApi } from '../runtime/gateway-http.mjs';
import { createGatewayMcp } from '../runtime/gateway-mcp.mjs';
import { createMcpMarketReadAdapter } from '../runtime/mcp-market-read.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { createProviderRegistry } from '../runtime/provider-mapping.mjs';
import { captureMapping, captureOperations, captureSummary, captureProvenance } from '../src/provider-capture.mjs';

const fixture = JSON.parse(await readFile(new URL('../qualification/moomoo/desktop-mcp-capture.json', import.meta.url), 'utf8'));
const at = '2026-11-23T23:17:44Z', expiry = '2026-11-24T00:17:44Z', now = () => Date.parse(at), candidate = sha('moomoo-desktop-capture-test');
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'moomoo-capture-fixture' };
const budgetScope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/' + sha(scope.account_alias) };
const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, {
  role, principal: role + '-fixture', runtime: role + '-fixture', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }]));
const attestation = { key_id: 'integration', principal: 'integration-fixture', runtime: 'integration-fixture',
  privateKey: pairs.integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
function signed(role, kind, extra = {}) {
  const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate,
    principal: keys[role].principal, runtime: keys[role].runtime, issued_utc: at, expires_utc: expiry, ...extra };
  return { key_id: role, payload, signature: sign(null, Buffer.from(canonical(payload)), pairs[role].privateKey).toString('base64url') };
}
const descriptorFor = name => fixture.tools.find(tool => tool.name === name);
const tools = captureOperations.map(operation => ({ operation, name: captureMapping.operations[operation].tool,
  effect: 'read', schema_digest: sha(descriptorFor(captureMapping.operations[operation].tool)) }));
const definition = { schema: 'trading-provider-definition/v1', provider: 'moomoo-desktop-capture', adapter_version: '1',
  transport: { kind: 'MCP', origin: 'https://mcp.moomoo.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('moomoo-desktop-adapter'),
  schema_digest: sha(fixture.tools), mapping_digest: sha(captureMapping), mapping: captureMapping, operations: [...captureOperations],
  allowlist: tools.map(tool => tool.name), mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('desktop-capture-receipt'), expires_utc: expiry } };
const capability = { provider: 'moomoo-desktop-capture', adapter_version: '1', adapter_digest: sha('moomoo-desktop-adapter'),
  schema_digest: sha(fixture.tools), mapping_digest: sha(captureMapping), transport: 'MCP', protocol: '2025-11-25', source: 'PROVIDER',
  mode: 'account', operations: [...captureOperations], allowlist: tools.map(tool => tool.name), cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('desktop-capture-receipt'), expires_utc: expiry } };
function grant(nonce = 'grant-one', budget = nonce, overrides = {}) {
  return signed('operator', 'read', { nonce, tools, mapping_digest: sha(captureMapping), limits: { max_calls: 4, timeout_ms: 1000 },
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind === 'cost' ? 'cost:' + budget : kind), expires_utc: expiry })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, ...overrides });
}
function fakeProvider({ listed = fixture.tools, resultFor = name => fixture.calls[name].structuredContent, protocol = '2025-11-25' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, method: body.method, params: body.params });
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: protocol, capabilities: { tools: {} } } }),
      { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-fixture' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: listed } });
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: resultFor(body.params.name) } });
    throw Error('unexpected method ' + body.method);
  };
  return { fetchImpl, calls };
}
async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-moomoo-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
const adapterFor = (fake, edit = value => value) => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000',
  mapping: edit(captureMapping), attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });
const boundaryFor = (store, fake, edit) => createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fake, edit), now });

test('captured Desktop quote projects through the reviewed mapping with exact round-trip decimals', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const result = await boundary({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant() });
  assert.equal(result.source, 'AUTHENTICATED_ADAPTER');
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.symbol, 'HK.00700'); assert.equal(row.name, 'TENCENT'); assert.equal(row.market_date, '2026-11-23');
  assert.equal(row.last, 344); assert.equal(row.high, 344.6); assert.equal(row.volume, 35289665); assert.equal(row.turnover, 11960782218);
  assert.equal(result.decimals[0].last, '344'); assert.equal(result.decimals[0].high, '344.6');
  assert.equal(result.decimals[0].turnover, '11960782218'); assert.equal(result.decimals[0].data_time, '1795421270000');
  assert.equal(result.cost.tool_calls, 4);
  assert.deepEqual(provider.calls.at(-1).params.arguments, { code_list: ['HK.00700'] });
  assert.equal(store.read(budgetScope).telemetry[sha('cost:grant-one')].calls, 4);
});

test('captured depth, tape and candles project from the entitled $0 reads', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const depth = await boundary({ operation: 'read.depth', inputs: { symbol: 'HK.00700', count: 10 }, grant: grant('depth') });
  assert.equal(depth.rows[0].exchange, 'SEHK');
  assert.equal(depth.rows[0].bids.length, 10); assert.equal(depth.rows[0].asks.length, 10);
  assert.equal(depth.rows[0].bids[0].price, 343.8); assert.equal(depth.rows[0].asks[0].price, 344);
  const tape = await boundary({ operation: 'read.tape', inputs: { symbol: 'HK.00700', count: 20 }, grant: grant('tape') });
  assert.equal(tape.rows.length, 20); assert.equal(tape.rows[0].price, 344); assert.equal(tape.rows[0].direction, 'BUY');
  assert.equal(tape.decimals[0].price, '344'); assert.equal(tape.decimals[0].time, '1795421300722');
  const candles = await boundary({ operation: 'read.candles', inputs: { symbol: 'HK.00700', count: 5, ktype: 2 }, grant: grant('candles') });
  assert.equal(candles.rows.length, 5); assert.equal(candles.rows[0].open, 386.6); assert.equal(candles.rows.at(-1).close, 344);
  assert.equal(candles.decimals.at(-1).close, '344'); assert.equal(candles.decimals[0].open, '386.6');
});

test('one provider read replays identically across HTTP and MCP with the same ledger revision', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const readers = Object.fromEntries(captureOperations.map(operation => [operation,
    async ({ inputs }) => boundary({ operation, inputs, grant: inputs.grant })]));
  const gateway = createGateway({ store, scope, candidate, capabilities: [capability], keys, audienceToken: 'fixture-audience-token-0000000000',
    providers: createProviderRegistry([definition]), readers, now });
  const api = createGatewayApi({ gateway, mcp: createGatewayMcp({ gateway }) });
  const server = createServer((req, res) => { if (!api(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = { contract_version: '1', request_id: 'req-parity', capability_digest: sha(capability), operation: 'read.ticker', scope,
    inputs: { symbol: 'HK.00700', grant: grant('parity') }, deadline_utc: '2026-11-23T23:22:44Z' };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-audience-token-0000000000', Origin: origin };
  const http = await (await fetch(origin + '/api/gateway', { method: 'POST', headers, body: JSON.stringify(request) })).json();
  const rpc = await (await fetch(origin + '/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read.ticker', arguments: request } }) })).json();
  const mcp = rpc.result.structuredContent;
  assert.equal(http.status, 'OK'); assert.equal(mcp.status, 'OK');
  assert.equal(http.request_id, 'req-parity'); assert.equal(mcp.request_id, 'req-parity');
  assert.equal(http.ledger_revision, mcp.ledger_revision);
  assert.equal(http.data.digest, mcp.data.digest);
  assert.deepEqual(http.data.rows, mcp.data.rows);
  assert.equal(http.data.rows[0].last, 344);
  assert.equal(provider.calls.length, 4, 'replay must not call the provider again');
  assert.equal(store.read(budgetScope).telemetry[sha('cost:parity')].calls, 4);
});

test('the dashboard display summary is pinned to the captured projection and labelled Desktop-only', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const ticker = (await boundary({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant('a') })).rows[0];
  const depth = (await boundary({ operation: 'read.depth', inputs: { symbol: 'HK.00700', count: 10 }, grant: grant('b') })).rows[0];
  const tape = (await boundary({ operation: 'read.tape', inputs: { symbol: 'HK.00700', count: 20 }, grant: grant('c') })).rows;
  const candles = (await boundary({ operation: 'read.candles', inputs: { symbol: 'HK.00700', count: 5, ktype: 2 }, grant: grant('d') })).rows;
  assert.equal(captureSummary.symbol, ticker.symbol); assert.equal(captureSummary.name, ticker.name);
  assert.equal(captureSummary.market_date, ticker.market_date); assert.equal(captureSummary.last, ticker.last);
  assert.equal(captureSummary.prev_close, ticker.prev_close); assert.equal(captureSummary.high, ticker.high);
  assert.equal(captureSummary.volume, ticker.volume); assert.equal(captureSummary.turnover, ticker.turnover);
  assert.equal(captureSummary.depth_levels, depth.bids.length); assert.equal(captureSummary.tape_ticks, tape.length);
  assert.equal(captureSummary.candle_count, candles.length); assert.equal(captureSummary.candle_last_close, candles.at(-1).close);
  assert.equal(captureProvenance.binding, 'desktop-mcp'); assert.equal(captureProvenance.hosted_n3, false);
  assert.equal(captureProvenance.cost_usd, 0); assert.equal(fixture.provenance.hosted_n3, false);
});

test('schema drift, mapping drift, write-like tools and precision loss are refused', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  await assert.rejects(boundary({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' },
    grant: grant('drift', 'drift', { tools: [{ ...tools[0], schema_digest: sha('wrong') }] }) }), /SCHEMA_DRIFT/);
  await assert.rejects(boundary({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' },
    grant: grant('map', 'map', { mapping_digest: sha('wrong') }) }), /MAPPING_DRIFT/);
  assert.throws(() => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000', attestation, scope, candidate,
    fetchImpl: provider.fetchImpl, now, mapping: { protocol: '2025-11-25', operations: { 'read.ticker': { tool: 'trading_order_place', rows_path: ['data'] } } } }), /SCOPE_DENIED/);
  const nullPrice = fakeProvider({ resultFor: () => ({ ret_code: 0, data: { quote_list: [
    { ...fixture.calls.quote_stock_quote.structuredContent.data.quote_list[0], last_price: null }] } }) });
  await assert.rejects(boundaryFor(store, nullPrice)({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant('null') }), /PRECISION_UNKNOWN/);
});