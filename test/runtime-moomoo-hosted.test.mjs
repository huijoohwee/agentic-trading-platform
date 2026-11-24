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
import { hostedMapping, hostedOperations, hostedSummary, hostedProvenance } from '../src/provider-hosted.mjs';

const fixture = JSON.parse(await readFile(new URL('../qualification/moomoo/hosted-mcp-capture.json', import.meta.url), 'utf8'));
const at = '2026-11-24T00:32:42Z', expiry = '2026-11-24T01:32:42Z', now = () => Date.parse(at), candidate = sha('moomoo-hosted-n3-test');
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'moomoo-hosted-fixture' };
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
const tools = hostedOperations.map(operation => ({ operation, name: hostedMapping.operations[operation].tool,
  effect: 'read', schema_digest: sha(descriptorFor(hostedMapping.operations[operation].tool)) }));
const definition = { schema: 'trading-provider-definition/v1', provider: 'moomoo-hosted-n3', adapter_version: '1',
  transport: { kind: 'MCP', origin: 'https://mcp.moomoo.com/mcp', protocol: '2025-11-25' }, adapter_digest: sha('moomoo-hosted-adapter'),
  schema_digest: sha(fixture.tools), mapping_digest: sha(hostedMapping), mapping: hostedMapping, operations: [...hostedOperations],
  allowlist: tools.map(tool => tool.name), mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('hosted-n3-receipt'), expires_utc: expiry } };
const capability = { provider: 'moomoo-hosted-n3', adapter_version: '1', adapter_digest: sha('moomoo-hosted-adapter'),
  schema_digest: sha(fixture.tools), mapping_digest: sha(hostedMapping), transport: 'MCP', protocol: '2025-11-25', source: 'PROVIDER',
  mode: 'account', operations: [...hostedOperations], allowlist: tools.map(tool => tool.name), cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('hosted-n3-receipt'), expires_utc: expiry } };
function grant(nonce = 'grant-one', budget = nonce, overrides = {}) {
  return signed('operator', 'read', { nonce, tools, mapping_digest: sha(hostedMapping), limits: { max_calls: 4, timeout_ms: 1000 },
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind === 'cost' ? 'cost:' + budget : kind), expires_utc: expiry })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, ...overrides });
}
function fakeProvider({ listed = fixture.tools, resultFor = () => fixture.calls.quote_stock_quote.structuredContent, protocol = '2025-11-25' } = {}) {
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
  const directory = await mkdtemp(join(tmpdir(), 'trading-hosted-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
const adapterFor = (fake, edit = value => value) => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000',
  mapping: edit(hostedMapping), attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });
const boundaryFor = (store, fake, edit) => createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fake, edit), now });

test('the hosted OAuth read.ticker projects the real entitled $0 response with exact round-trip decimals', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const result = await boundaryFor(store, provider)({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant() });
  assert.equal(result.source, 'AUTHENTICATED_ADAPTER');
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.symbol, 'HK.00700'); assert.equal(row.name, 'TENCENT'); assert.equal(row.market_date, '2026-11-23');
  assert.equal(row.last, 344); assert.equal(row.high, 344.6); assert.equal(row.low, 333); assert.equal(row.open, 335);
  assert.equal(row.volume, 35289665); assert.equal(row.turnover, 11960782218);
  assert.equal(result.decimals[0].last, '344'); assert.equal(result.decimals[0].high, '344.6');
  assert.equal(result.decimals[0].turnover, '11960782218'); assert.equal(result.decimals[0].data_time, '1795421270000');
  assert.equal(result.cost.tool_calls, 4);
  assert.deepEqual(provider.calls.at(-1).params.arguments, { code_list: ['HK.00700'] });
  assert.equal(provider.calls.every(call => call.url === 'https://mcp.moomoo.com/mcp'), true);
  assert.equal(store.read(budgetScope).telemetry[sha('cost:grant-one')].calls, 4);
});

test('one hosted provider read replays identically across HTTP and MCP with the same ledger revision', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const readers = { 'read.ticker': async ({ inputs }) => boundary({ operation: 'read.ticker', inputs, grant: inputs.grant }) };
  const gateway = createGateway({ store, scope, candidate, capabilities: [capability], keys, audienceToken: 'fixture-audience-token-0000000000',
    providers: createProviderRegistry([definition]), readers, now });
  const api = createGatewayApi({ gateway, mcp: createGatewayMcp({ gateway }) });
  const server = createServer((req, res) => { if (!api(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = { contract_version: '1', request_id: 'req-hosted-parity', capability_digest: sha(capability), operation: 'read.ticker', scope,
    inputs: { symbol: 'HK.00700', grant: grant('parity') }, deadline_utc: '2026-11-24T00:37:42Z' };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-audience-token-0000000000', Origin: origin };
  const http = await (await fetch(origin + '/api/gateway', { method: 'POST', headers, body: JSON.stringify(request) })).json();
  const rpc = await (await fetch(origin + '/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read.ticker', arguments: request } }) })).json();
  const mcp = rpc.result.structuredContent;
  assert.equal(http.status, 'OK'); assert.equal(mcp.status, 'OK');
  assert.equal(http.request_id, 'req-hosted-parity'); assert.equal(mcp.request_id, 'req-hosted-parity');
  assert.equal(http.ledger_revision, mcp.ledger_revision);
  assert.equal(http.data.digest, mcp.data.digest);
  assert.deepEqual(http.data.rows, mcp.data.rows);
  assert.equal(http.data.rows[0].last, 344);
  assert.equal(provider.calls.length, 4, 'replay must not call the hosted provider again');
  assert.equal(store.read(budgetScope).telemetry[sha('cost:parity')].calls, 4);
});

test('the hosted qualification provenance is pinned to the captured read and labelled N3', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const row = (await boundaryFor(store, provider)({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant('prov') })).rows[0];
  assert.equal(hostedSummary.symbol, row.symbol); assert.equal(hostedSummary.name, row.name);
  assert.equal(hostedSummary.market_date, row.market_date); assert.equal(hostedSummary.last, row.last);
  assert.equal(hostedSummary.prev_close, row.prev_close); assert.equal(hostedSummary.high, row.high);
  assert.equal(hostedSummary.volume, row.volume); assert.equal(hostedSummary.turnover, row.turnover);
  assert.equal(hostedSummary.data_time, row.data_time);
  assert.equal(hostedProvenance.binding, 'hosted-mcp'); assert.equal(hostedProvenance.hosted_n3, true);
  assert.equal(hostedProvenance.scope, 'quote:read'); assert.equal(hostedProvenance.cost_usd, 0);
  assert.equal(fixture.provenance.hosted_n3, true); assert.equal(fixture.provenance.binding, 'hosted-mcp');
  assert.equal(fixture.provenance.scope, 'quote:read'); assert.equal(fixture.provenance.cost_usd, 0);
  assert.equal(sha(descriptorFor('quote_stock_quote')), '5abc6284b856ea946ad158c96252c99e4d5c4ef3e7a65bb442d201f8b11399fb');
});

test('expired grants, absent entitlements, revocation, schema/mapping drift, write tools and precision loss are refused', async t => {
  const store = await storeFixture(t), provider = fakeProvider();
  const boundary = boundaryFor(store, provider);
  const read = grantOverride => boundary({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grantOverride });
  await assert.rejects(read(grant('drift', 'drift', { tools: [{ ...tools[0], schema_digest: sha('wrong') }] })), /SCHEMA_DRIFT/);
  await assert.rejects(read(grant('map', 'map', { mapping_digest: sha('wrong') })), /MAPPING_DRIFT/);
  const expiredProofs = ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: '2026-11-24T00:00:00Z' }));
  await assert.rejects(read(grant('expired', 'expired', { proofs: expiredProofs })), /MISSING_ADMISSION_PROOF/);
  const noRights = ['cost', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: expiry }));
  await assert.rejects(read(grant('norights', 'norights', { proofs: noRights })), /MISSING_ADMISSION_PROOF/);
  await assert.rejects(read(grant('revoked', 'revoked', { revoked: true })), /REVOKED/);
  assert.throws(() => createMcpMarketReadAdapter({ provider: definition, token: 'fixture-token-000000', attestation, scope, candidate,
    fetchImpl: provider.fetchImpl, now, mapping: { protocol: '2025-11-25', operations: { 'read.ticker': { tool: 'trading_order_place', rows_path: ['data'] } } } }), /SCOPE_DENIED/);
  const nullPrice = fakeProvider({ resultFor: () => ({ ret_code: 0, data: { quote_list: [
    { ...fixture.calls.quote_stock_quote.structuredContent.data.quote_list[0], last_price: null }] } }) });
  await assert.rejects(boundaryFor(store, nullPrice)({ operation: 'read.ticker', inputs: { symbol: 'HK.00700' }, grant: grant('null') }), /PRECISION_UNKNOWN/);
});