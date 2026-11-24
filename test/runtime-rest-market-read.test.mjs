import test from 'node:test';
import { researchMapping } from '../runtime/moomoo-research.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { createGateway } from '../runtime/gateway.mjs';
import { createGatewayMcp } from '../runtime/gateway-mcp.mjs';
import { createRestMarketReadAdapter } from '../runtime/rest-market-read.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { createProviderRegistry, validateProviderDefinition } from '../runtime/provider-mapping.mjs';

const at = '2026-11-20T15:00:00Z', now = () => Date.parse(at), candidate = sha('rest-calendar-test');
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
const responseDescriptor = { ret_code: 0, ret_msg: 'success', data: { items: [] } };
const calendarSpec = {
  tool: 'quote.earnings-calendar', method: 'GET', path: '/api/v1.0/quote/earnings-calendar', schema_digest: sha(responseDescriptor),
  input_map: { market: 'market', begin_date: 'begin_date', end_date: 'end_date', sort_type: 'sort_type', count: 'count' },
  params: { market: { required: true, enum: ['HK', 'US', 'SH', 'SZ', 'CN', 'SG', 'JP', 'AU', 'CA', 'MY'] },
    begin_date: { date: true }, end_date: { date: true },
    sort_type: { enum: ['HOT', 'MARKET_CAP', 'OPTION_VOLUME', 'IV', 'IV_RANK', 'IV_PERCENTILE', 'RT_MARKET_CAP'] },
    count: { integer: [1, 1000] } },
  window: { begin: 'begin_date', end: 'end_date', max_days: 7 },
  rows_path: ['data', 'items'],
  fields: { code: { path: ['code'] }, name: { path: ['name'] }, earnings_date: { path: ['earnings_date'] },
    earnings_timestamp: { path: ['earnings_timestamp'] }, pub_type: { path: ['pub_type'] }, period_text: { path: ['period_text'] },
    eps_actual: { path: ['eps_actual'] }, eps_predict: { path: ['eps_predict'] }, price: { path: ['price'] }, published: { path: ['published'] } },
  numeric: ['price'], integer: ['earnings_timestamp'], date: ['earnings_date'], nullable: ['eps_actual', 'eps_predict', 'period_text']
};
const mapping = { protocol: '1.0', operations: { 'read.calendar': calendarSpec } };
const tools = [{ operation: 'read.calendar', name: 'quote.earnings-calendar', effect: 'read', schema_digest: sha(responseDescriptor) }];
const definition = { schema: 'trading-provider-definition/v1', provider: 'labelled-calendar-adapter', adapter_version: '1',
  transport: { kind: 'REST', origin: 'https://webapi.moomoo.com/', protocol: '1.0' }, adapter_digest: sha('adapter'),
  schema_digest: sha(responseDescriptor), mapping_digest: sha(mapping), mapping, operations: ['read.calendar'], allowlist: ['quote.earnings-calendar'],
  mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
function grant(nonce = 'grant-one', budget = nonce, overrides = {}) {
  return signed('operator', 'read', { nonce, tools, mapping_digest: sha(mapping), limits: { max_calls: 12, timeout_ms: 1000 },
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind === 'cost' ? 'cost:' + budget : kind), expires_utc: '2026-11-20T16:00:00Z' })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 }, ...overrides });
}
const calendarResponse = { ret_code: 0, ret_msg: 'success', data: { items: [
  { code: 'US.AAPL', name: 'Apple', earnings_date: '2026-11-19', earnings_timestamp: 1710000000000000, pub_type: 'BEFORE', period_text: '2026Q3', eps_actual: 1.2, eps_predict: 1.25, price: '100.25', published: true },
  { code: 'US.MSFT', name: 'Microsoft', earnings_date: '2026-11-20', earnings_timestamp: 1710086400000000, pub_type: 'AFTER', period_text: '2026Q3', eps_actual: null, eps_predict: 1.3, price: '200.50', published: false }
] } };
function fakeRest({ result = calendarResponse, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, authorization: options.headers.Authorization });
    return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-rest-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, path };
}
const adapterFor = (fake, edit = value => value) => createRestMarketReadAdapter({ provider: definition, token: 'fixture-token-000000',
  mapping: edit(mapping), attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });
const inputs = { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-21', count: 2 };

test('REST calendar read preserves market-local dates, microsecond time, decimal price and null estimates on the shared $0 counter', async t => {
  const { store } = await fixture(t);
  const provider = fakeRest();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  const result = await boundary({ operation: 'read.calendar', inputs, grant: grant() });
  assert.equal(result.source, 'AUTHENTICATED_ADAPTER');
  assert.equal(result.rows[0].earnings_date, '2026-11-19');
  assert.equal(result.rows[0].earnings_timestamp, 1710000000000000);
  assert.equal(result.decimals[0].earnings_timestamp, '1710000000000000');
  assert.equal(result.decimals[0].price, '100.25');
  assert.equal(result.rows[0].price, 100.25);
  assert.equal(result.rows[1].eps_actual, null);
  assert.equal(result.rows[1].eps_predict, 1.3);
  assert.equal(result.cost.tool_calls, 1);
  assert.equal(provider.calls[0].method, 'GET');
  assert.equal(provider.calls[0].url, 'https://webapi.moomoo.com/api/v1.0/quote/earnings-calendar?market=US&begin_date=2026-11-19&end_date=2026-11-21&count=2');
  assert.equal(provider.calls[0].authorization, 'Bearer fixture-token-000000');
  assert.equal(store.read(budgetScope).telemetry[sha('cost:grant-one')].calls, 12);
});

test('REST schema drift, mapping drift and write-like tools are refused', async t => {
  const { store } = await fixture(t);
  const provider = fakeRest();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  await assert.rejects(boundary({ operation: 'read.calendar', inputs, grant: grant('drift', 'drift', { tools: [{ ...tools[0], schema_digest: sha('wrong') }] }) }), /SCHEMA_DRIFT/);
  await assert.rejects(boundary({ operation: 'read.calendar', inputs, grant: grant('map', 'map', { mapping_digest: sha('wrong') }) }), /MAPPING_DRIFT/);
  assert.throws(() => createRestMarketReadAdapter({ provider: definition, token: 'fixture-token-000000', attestation, scope, candidate, fetchImpl: provider.fetchImpl, now,
    mapping: { protocol: '1.0', operations: { 'read.calendar': { ...calendarSpec, tool: 'trading_order_place' } } } }), /SCOPE_DENIED/);
});

test('the single counter denies REST reads once the budget is exhausted', async t => {
  const { store } = await fixture(t);
  const provider = fakeRest();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  await boundary({ operation: 'read.calendar', inputs, grant: grant('first', 'shared') });
  await assert.rejects(boundary({ operation: 'read.calendar', inputs, grant: grant('second', 'shared') }), /BUDGET_HALT/);
});

test('invalid market, over-long window and provider ret_code refusals are typed; no_data is an empty observation', async t => {
  const { store } = await fixture(t);
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fakeRest()), now });
  await assert.rejects(boundary({ operation: 'read.calendar', inputs: { ...inputs, market: 'XX' }, grant: grant('m', 'm') }), /INVALID_PARAMETER/);
  await assert.rejects(boundary({ operation: 'read.calendar', inputs: { ...inputs, begin_date: '2026-11-19', end_date: '2026-11-27' }, grant: grant('w', 'w') }), /INVALID_PARAMETER/);
  const rejected = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fakeRest({ result: { ret_code: -3, ret_msg: 'invalid_parameter' } })), now });
  await assert.rejects(rejected({ operation: 'read.calendar', inputs, grant: grant('r', 'r') }), /PROVIDER_ERROR/);
  const empty = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fakeRest({ result: { ret_code: -10, ret_msg: 'no_data' } })), now });
  const page = await empty({ operation: 'read.calendar', inputs, grant: grant('e', 'e') });
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.decimals, []);
});

test('precision loss on microsecond time and oversize pages are refused', async t => {
  const { store } = await fixture(t);
  const unsafe = { ret_code: 0, data: { items: [{ ...calendarResponse.data.items[0], earnings_timestamp: 9007199254740993 }] } };
  const loss = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fakeRest({ result: unsafe })), now });
  await assert.rejects(loss({ operation: 'read.calendar', inputs, grant: grant('p', 'p') }), /PRECISION_UNKNOWN/);
  const big = { ret_code: 0, data: { items: Array.from({ length: 601 }, () => calendarResponse.data.items[0]) } };
  const oversize = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(fakeRest({ result: big })), now });
  await assert.rejects(oversize({ operation: 'read.calendar', inputs, grant: grant('b', 'b') }), /INVALID_PAGE/);
});

test('REST transport pins are reviewed: MCP pins preserved, wrong REST protocol refused', () => {
  assert.equal(validateProviderDefinition(definition).definition.transport.kind, 'REST');
  assert.throws(() => validateProviderDefinition({ ...definition, transport: { kind: 'REST', origin: 'https://webapi.moomoo.com/', protocol: '2.0' } }), /INVALID_TRANSPORT_PIN/);
  assert.throws(() => validateProviderDefinition({ ...definition, transport: { kind: 'REST', origin: 'https://webapi.moomoo.com/', protocol: '2025-11-25' } }), /INVALID_TRANSPORT_PIN/);
  assert.throws(() => validateProviderDefinition({ ...definition, transport: { kind: 'MCP', origin: 'https://webapi.moomoo.com/', protocol: '1.0' } }), /INVALID_TRANSPORT_PIN/);
});

test('gateway admits a PROVIDER REST read with identical HTTP and MCP decisions and refuses unallowlisted tools', async t => {
  const { store } = await fixture(t);
  const provider = fakeRest();
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter: adapterFor(provider), now });
  const capability = { provider: 'labelled-calendar-adapter', adapter_version: '1', adapter_digest: sha('adapter'), schema_digest: sha(responseDescriptor),
    mapping_digest: sha(mapping), transport: 'REST', protocol: '1.0', source: 'PROVIDER', mode: 'account', operations: ['read.calendar'], allowlist: ['quote.earnings-calendar'],
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true }, qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt'), expires_utc: '2026-11-20T16:00:00Z' } };
  const gateway = createGateway({ store, scope, candidate, capabilities: [capability], keys, audienceToken: 'fixture-audience-token-0000000000',
    providers: createProviderRegistry([definition]),
    readers: { 'read.calendar': async ({ inputs }) => boundary({ operation: 'read.calendar', inputs, grant: inputs.grant }) }, now });
  const mcp = createGatewayMcp({ gateway });
  const request = { contract_version: '1', request_id: 'req-rest-one', capability_digest: sha(capability), operation: 'read.calendar', scope,
    inputs: { ...inputs, grant: grant('gw', 'gw') }, deadline_utc: '2026-11-20T15:05:00Z' };
  const admitted = await gateway.admit(request, 'Bearer fixture-audience-token-0000000000');
  assert.equal(admitted.status, 'OK');
  assert.equal(admitted.data.source, 'AUTHENTICATED_ADAPTER');
  assert.equal(admitted.provenance.source, 'PROVIDER');
  const viaMcp = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read.calendar', arguments: request } }, 'Bearer fixture-audience-token-0000000000');
  assert.deepEqual(viaMcp.result.structuredContent, admitted);
  const denied = await gateway.admit({ ...request, request_id: 'req-rest-two', inputs: { ...inputs, grant: grant('gw2', 'gw2', { tools: [{ ...tools[0], name: 'quote_other' }] }) } }, 'Bearer fixture-audience-token-0000000000');
  assert.equal(denied.status, 'REFUSED');
  assert.equal(denied.error.code, 'UNAUTHORIZED');
});

async function researchRead(t, operation, inputs, response, inspect = () => {}) {
  const { store } = await fixture(t);
  const spec = researchMapping.operations[operation];
  const provider = { ...definition, mapping: researchMapping, mapping_digest: sha(researchMapping),
    operations: [operation], allowlist: [spec.tool], schema_digest: spec.schema_digest };
  const fake = fakeRest({ result: response });
  const adapter = createRestMarketReadAdapter({ provider, token: 'fixture-rest-token-000',
    mapping: researchMapping, attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter, now });
  const permit = grant('research', 'research', { mapping_digest: sha(researchMapping),
    tools: [{ operation, name: spec.tool, effect: 'read', schema_digest: spec.schema_digest }] });
  try { return await boundary({ operation, inputs, grant: permit }); }
  finally { inspect(fake.calls); }
}

test('intraday flow binds the symbol and session, preserving signed amounts and local currency units', async t => {
  const point = { capital_flow_item_time: 1780536660000, in_flow: '-312.0500', super_in_flow: -312.05,
    big_in_flow: 0, mid_in_flow: 0, sml_in_flow: 0 };
  const result = await researchRead(t, 'read.capital-flow', { symbol: 'HK.00700', section: 'NORMAL' },
    { ret_code: 0, data: { flow_list: [point], last_valid_time: point.capital_flow_item_time } },
    calls => assert.deepEqual(calls.map(c => c.url), ['https://webapi.moomoo.com/api/v1.0/quote/HK.00700/capital-flow?section=NORMAL']));
  assert.equal(result.decimals[0].in_flow, '-312.0500');
  assert.equal(result.last_valid_time_ms, point.capital_flow_item_time);
  const empty = await researchRead(t, 'read.capital-flow', { symbol: 'HK.00700' },
    { ret_code: 0, data: { flow_list: [], last_valid_time: null } });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.last_valid_time_ms, null);
  await assert.rejects(researchRead(t, 'read.capital-flow', { symbol: 'no symbol' }, {},
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
});

test('rank reads return the provider cursor, refuse a repeated cursor and preserve an empty final page', async t => {
  const row = { code: 'HK.00700', name: 'Fixture' };
  for (const field of researchMapping.operations['read.rank'].numeric) row[field] = '1.200';
  const first = await researchRead(t, 'read.rank', { market: 'HK', page_size: 1 }, {
    ret_code: 0, data: { items: [row] }, pagination: { total: 3, completed: false, page_flag: '2/+=' }
  });
  assert.equal(first.decimals[0].news_heat, '1.200');
  assert.deepEqual(first.pagination, { total: 3, completed: false, next_cursor: '2/+=' });
  const final = await researchRead(t, 'read.rank', { market: 'HK', page_flag: '2/+=' },
    { ret_code: 0, data: { items: [] }, pagination: { completed: true, page_flag: '', total: 3 } },
    calls => assert.equal(new URL(calls[0].url).searchParams.get('page_flag'), '2/+='));
  assert.equal(final.pagination.next_cursor, null);
  await assert.rejects(researchRead(t, 'read.rank', { market: 'HK', page_flag: 'a' },
    { ret_code: 0, data: { items: [] }, pagination: { completed: false, page_flag: 'a', total: 3 } }), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, 'read.rank', { market: 'HK', page_size: 201 }, {},
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
});
