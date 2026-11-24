import test from 'node:test';
import { researchMapping } from '../runtime/moomoo-research.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
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
    calls.push({ url, method: options.method, authorization: options.headers.Authorization, body: options.body, redirect: options.redirect });
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
  const largeResponse = adapterFor(fakeRest({ result: { padding: 'x'.repeat(480_000) } }));
  const limited = createMarketReadBoundary({ store, scope, candidate, keys, adapter: largeResponse, now });
  await assert.rejects(limited({ operation: 'read.calendar', inputs, grant: grant('wire', 'wire') }), /INPUT_TOO_LARGE/);
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

async function researchRead(t, operation, inputs, response, inspect = () => {}, permittedInputs = inputs) {
  const { store } = await fixture(t);
  const spec = researchMapping.operations[operation];
  const provider = { ...definition, mapping: researchMapping, mapping_digest: sha(researchMapping),
    operations: [operation], allowlist: [spec.tool], schema_digest: spec.schema_digest };
  const fake = fakeRest({ result: response });
  const adapter = createRestMarketReadAdapter({ provider, token: 'fixture-rest-token-000',
    mapping: researchMapping, attestation, scope, candidate, fetchImpl: fake.fetchImpl, now });
  const boundary = createMarketReadBoundary({ store, scope, candidate, keys, adapter, now });
  const permit = grant('research', 'research', { mapping_digest: sha(researchMapping),
    tools: [{ operation, name: spec.tool, effect: 'read', schema_digest: spec.schema_digest, inputs_digest: sha(permittedInputs) }] });
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

test('sector lookup preserves opaque IDs and provider refusals', async t => {
  const inputs = { market: 'HK', plate_class: 'INDUSTRY' };
  const sector = { code: 'HK.LIST001', plate_id: 'LIST001', plate_name: 'Transport' };
  const result = await researchRead(t, 'read.plate', inputs,
    { ret_code: 0, data: { plate_list: [sector] } }, calls => {
      assert.equal(calls[0].url, 'https://webapi.moomoo.com/api/v1.0/quote/plate-list?market=HK&plate_class=INDUSTRY');
    });
  assert.deepEqual(result.rows, [sector]);
  await assert.rejects(researchRead(t, 'read.plate', { ...inputs, plate_class: 'REGION' }, { ret_code: -8 }), /UNSUPPORTED/);
  await assert.rejects(researchRead(t, 'read.plate', { ...inputs, plate_class: 'invalid' }, {},
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
});

test('Hong Kong IPO listings preserve absent prices and dates and omit private application fields', async t => {
  const inputs = { market: 'HK', request_type: 10 };
  const offering = { code: 'HK.12345', name: 'Fixture', list_time: '--', lot_size: 100,
    ipo_price_min: 0, ipo_price_max: 0, list_price: '18.5000', apply_status: 'PRIVATE' };
  const result = await researchRead(t, 'read.ipo', inputs, { ret_code: 0, data: [offering] },
    calls => assert.equal(calls[0].url, 'https://webapi.moomoo.com/api/v1.0/quote/ipo-list/hk?request_type=10'));
  assert.deepEqual(result.rows, [{ code: offering.code, name: 'Fixture', list_time: null, lot_size: 100,
    ipo_price_min: null, ipo_price_max: null, list_price: 18.5 }]);
  assert.equal(result.decimals[0].list_price, '18.5000');
  for (const wrong of [{ market: 'US' }, { market: 'HK', request_type: 12 }]) {
    await assert.rejects(researchRead(t, 'read.ipo', wrong, {}, calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
  }
  await assert.rejects(researchRead(t, 'read.ipo', inputs, { ret_code: 0, data: [{ ...offering, code: 'US.DEMO' }] }), /SOURCE_MAPPING_REQUIRED/);
  const empty = await researchRead(t, 'read.ipo', inputs, { ret_code: 0, data: [] });
  assert.deepEqual(empty.rows, []);
});

test('news search projects only headline metadata and keeps news IDs opaque', async t => {
  const inputs = { keyword: 'A & B', lang: 'en', source_ids: '2,42', page_size: 1 };
  const headline = { news_id: '90071992547409931', title: 'Fixture headline', news_type: 'REPORT',
    source: 'Fixture wire', publish_time: 1795490000000 };
  const result = await researchRead(t, 'read.news', inputs, { ret_code: 0, data: { items: [
    { ...headline, content: '<p>private article</p>', files: ['attachment'], source_url: 'https://example.invalid/' }
  ] } }, calls => {
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/v1.0/news/search');
    for (const [key, value] of Object.entries(inputs)) assert.equal(url.searchParams.get(key), String(value));
  });
  assert.deepEqual(result.rows, [headline]);
  const rows = items => ({ ret_code: 0, data: { items } });
  await assert.rejects(researchRead(t, 'read.news', inputs, rows([headline, headline])), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, 'read.news', inputs, rows([{ ...headline, news_id: 2 ** 53 }])), /PRECISION_UNKNOWN/);
  for (const wrong of [{ keyword: ' ' }, { keyword: 'x'.repeat(201) }, { source_ids: 'all' }, { account: 'other' }]) {
    await assert.rejects(researchRead(t, 'read.news', { ...inputs, ...wrong }, {}, calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
  }
});

test('analyst rating pages keep provider target text and allow the documented cursor without a total', async t => {
  const inputs = { analyst_uid: 'a-123', market: 'CA', page_size: 1 };
  const rating = { code: 'CA.DEMO', rating: 0, target_price: 'N/A', recommendation_date: '2026-11-20' };
  const response = { ret_code: 0, data: { items: [rating] }, pagination: { completed: false, page_flag: 'n/1+' } };
  const page = await researchRead(t, 'read.research', inputs, response);
  assert.deepEqual(page.rows, [rating]);
  assert.deepEqual(page.pagination, { completed: false, next_cursor: 'n/1+' });
  await assert.rejects(researchRead(t, 'read.research', { ...inputs, page_flag: 'n/1+' }, response), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, 'read.research', inputs, { ...response, pagination: { completed: true, page_flag: '', total: -1 } }), /INVALID_PAGE/);
  assert.deepEqual((await researchRead(t, 'read.research', inputs, { ret_code: -10 })).pagination, { completed: true, next_cursor: null });
  await assert.rejects(researchRead(t, 'read.research', inputs, { ret_code: -9 }), /SCOPE_DENIED/);
});

const hk = { symbol: 'HK.00700' };
const response = data => ({ ret_code: 0, data });
const pageEnd = { completed: true, page_flag: '' };

test('company profile, dividends and shareholder disclosures preserve labels, dates and absent values', async t => {
  const profile = { field_type: 1, attribute_type: 23, name: 'Website', value: 'https://example.invalid/' };
  const title = { field_type: 2, attribute_type: 35, name: 'Description' };
  const company = await researchRead(t, 'read.financials', hk, response({ items: [profile, title] }));
  assert.deepEqual(company.rows, [profile, { ...title, value: null }]);
  const dividend = { statement: 'Fixture cash dividend', currency: 'HKD', process: 'Plan', ex_date: '2024/02/29',
    record_date: '', dividend_payable_date: '', dividend_per_share: 12 };
  const actions = await researchRead(t, 'read.corporate-actions', hk, response({ dividend_list: [dividend] }));
  assert.deepEqual(actions.rows[0], { statement: dividend.statement, currency: 'HKD', process: 'Plan',
    ex_date: '2024/02/29', record_date: null, dividend_payable_date: null });
  await assert.rejects(researchRead(t, 'read.corporate-actions', hk,
    response({ dividend_list: [{ ...dividend, ex_date: '2026/02/29' }] })), /PRECISION_UNKNOWN/);
  const holder = { name: 'Others', holder_pct: 28.3, holder_id: null, static_date_str: null };
  const holders = await researchRead(t, 'read.holders', { ...hk, period_id: 0 }, response({ main_holder: [holder] }));
  assert.deepEqual(holders.rows, [holder]);
  await assert.rejects(researchRead(t, 'read.holders', hk, response({ main_holder: [] }),
    calls => assert.equal(calls.length, 0), { symbol: 'US.AAPL' }), /SCOPE_DENIED/);
});

test('influencer holdings require their own response status and preserve USD estimates as supplied', async t => {
  const inputs = { influencer: 'PELOSI', sort_dir: 'DESCENDING', page_size: 1 };
  const row = { code: 'US.DEMO', name: 'Fixture', est_shares: '1,000', last_change_est_shares: '-200',
    last_change_date: '2026-11-19', percent_of_portfolio: 12.5, est_position_value: '1.2M' };
  const body = { code: 0, data: { items: [row] }, pagination: pageEnd };
  const result = await researchRead(t, 'read.influencer', inputs, body);
  assert.deepEqual(result.rows, [row]);
  assert.deepEqual(result.pagination, { completed: true, next_cursor: null });
  await assert.rejects(researchRead(t, 'read.influencer', inputs, { ...body, ret_code: -3 }), /INVALID_RESPONSE/);
  await assert.rejects(researchRead(t, 'read.influencer', inputs, { code: -3 }), /INVALID_PARAMETER/);
});

test('regional macro IDs, ETF disclosure timestamps and series cursors remain source-specific', async t => {
  const macro = await researchRead(t, 'read.macro', { region: 'SG' },
    response([{ category_name: 'Prices', name: 'Fixture index', indicator_id: 287 }]));
  assert.deepEqual(macro.rows, [{ category_name: 'Prices', name: 'Fixture index', indicator_id: '287' }]);
  const holding = { code: '', holding_name: 'Unmapped', holding_rate: 1.5 };
  const etf = await researchRead(t, 'read.etf', { symbol: 'US.SPY' }, response({ update_time: 1792071000000, items: [holding] }));
  assert.deepEqual(etf.rows, [{ ...holding, disclosure_time_ms: 1792071000000 }]);
  await assert.rejects(researchRead(t, 'read.etf', hk, response({ items: [holding] })), /SOURCE_MAPPING_REQUIRED/);
  const series = { series: 'KS.KXNFLGAME' };
  const event = { event_code: 'KS.FIXTURE', event_name: 'Fixture game' };
  const events = await researchRead(t, 'read.event-contract', series, { ...response({ events: [event] }),
    pagination: { completed: false, page_flag: 'b/=', total: 3 } });
  assert.deepEqual(events.rows, [event]);
  assert.equal(events.pagination.next_cursor, 'b/=');
  await assert.rejects(researchRead(t, 'read.event-contract', { series: 'KS/..' }, {},
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
});

test('market-wide crypto, historical valuation and unusual derivatives keep distinct units and statuses', async t => {
  const crypto = { total_market_cap: 230000, total_market_cap_change_24h: -2.1, turnover_24h: 100, turnover_24h_change_24h: 1.2 };
  assert.deepEqual((await researchRead(t, 'read.crypto-market', {}, response(crypto))).rows, [crypto]);
  await assert.rejects(researchRead(t, 'read.crypto-market', {}, response([crypto])), /INVALID_PAGE/);
  const point = { value: 12.1, plate_value: 15, time: 1780197931, time_str: '2026-05-31' };
  const valuation = await researchRead(t, 'read.valuation', { ...hk, valuation_type: 1 }, response({ valuation_type: 1,
    last_update_time: 1780200000, trend: { historical_items: [point] } }));
  assert.deepEqual(valuation.rows, [{ ...point, valuation_type: 1, last_update_time: 1780200000 }]);
  const none = { code: 1, time_range: '', content: '' };
  assert.deepEqual((await researchRead(t, 'read.derivatives', hk, response(none))).rows, [none]);
  await assert.rejects(researchRead(t, 'read.derivatives', hk, response({ ...none, code: 4 })), /SOURCE_MAPPING_REQUIRED/);
});

test('HK short interest, Stock Connect and both broker sides preserve signed integer shares exactly', async t => {
  const point = { timestamp: 1780012800000, timestamp_str: '2026-05-29', aggregated_short: '9007199254740993', aggregated_short_ratio: 4.1 };
  assert.deepEqual((await researchRead(t, 'read.short', hk, response({ items: [point] }))).rows, [point]);
  await assert.rejects(researchRead(t, 'read.short', { symbol: 'US.AAPL' }, {}, calls => assert.equal(calls.length, 0)), /UNSUPPORTED/);
  await assert.rejects(researchRead(t, 'read.short', hk, response({ items: [{ ...point, aggregated_short: 2 ** 53 }] })), /PRECISION_UNKNOWN/);
  const day = { shares: '-9007199254740993', amount: '-73.5400', rank: 10 };
  const flow = await researchRead(t, 'read.stock-connect', hk, response({ latest_daily_data: true, day }));
  assert.deepEqual(flow.rows, [{ ...day, amount: -73.54 }]);
  assert.equal(flow.decimals[0].amount, '-73.5400');
  assert.deepEqual((await researchRead(t, 'read.stock-connect', hk, response({ latest_daily_data: false }))).rows, []);
  const buy = { buy_sell_type: 1, broker_code: 'A', broker_name: 'Fixture A', net_vol: 17 };
  const sell = { buy_sell_type: 2, broker_code: 'B', broker_name: 'Fixture B', net_vol: -12 };
  const source = { data_time: 1780012800000, buy_brokers: [buy], sell_brokers: [sell] };
  const brokers = await researchRead(t, 'read.top-brokers', hk, response(source));
  assert.deepEqual(brokers.rows, [buy, sell].map(row => ({ ...row, net_vol: String(row.net_vol), data_time: source.data_time })));
  await assert.rejects(researchRead(t, 'read.top-brokers', hk, response({ ...source, sell_brokers: [buy] })), /INVALID_PAGE/);
});

test('chip prices, profit ratios and CBBC outstanding quantities survive exact projection', async t => {
  const chip = { timestamp: 1780012800, current_price: '19.3400', avg_cost: '20.000', profit_ratio: '45.10' };
  const result = await researchRead(t, 'read.chip', { symbol: 'SH.600519', ktype: 2 }, response({ items: [chip] }));
  assert.equal(result.decimals[0].current_price, '19.3400');
  assert.equal(result.rows[0].profit_ratio, 45.1);
  const cbbc = { timestamp: 1780012800, close_price: '18.05', prev_close_price: '18.00',
    bull_outstanding: '90071992547409930', bear_outstanding: 10 };
  const source = response({ currency: 'HKD', items: [cbbc] });
  const page = await researchRead(t, 'read.cbbc', hk, source);
  assert.deepEqual(page.rows, [{ ...cbbc, close_price: 18.05, prev_close_price: 18, bear_outstanding: '10', currency: 'HKD' }]);
  await assert.rejects(researchRead(t, 'read.chip', hk, response({ items: [chip, chip] })), /INVALID_PAGE/);
});

test('running gateway replays one parameter-bound headline through HTTP and MCP and refuses a changed keyword', async t => {
  const operation = 'read.news', spec = researchMapping.operations[operation];
  const expiry = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const issued = new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const provider = { ...definition, transport: { kind: 'REST', origin: 'https://research.invalid/', protocol: '1.0' },
    mapping: researchMapping, mapping_digest: sha(researchMapping), schema_digest: spec.schema_digest, operations: [operation],
    allowlist: [spec.tool], qualification: { ...definition.qualification, expires_utc: expiry } };
  const { schema: _schema, mapping: _mapping, ...base } = provider;
  const capability = { ...base, protocol: '1.0', transport: 'REST' }, audience = 'local-research-fixture-audience-0000';
  const directory = await mkdtemp(join(tmpdir(), 'research-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { schema: 'trading-runtime-config/v1', candidate, scope, database: 'research.sqlite', keys,
    viewer_token: 'local-research-fixture-viewer-000000', providers: [provider],
    provider_credentials: { [provider.provider]: { token: 'local-research-fixture-token', attestation } },
    gateway: { audience_token: audience, capabilities: [capability] } };
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const network = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return network(url, options);
    assert.equal(String(url), 'https://research.invalid/api/v1.0/news/search?keyword=example');
    calls.push(options.method);
    return Response.json(response({ items: [{ news_id: 'H1', source: 'Fixture', news_type: 'REPORT',
      title: 'Fixture headline', publish_time: 1795490000000, content: 'PRIVATE BODY' }] }));
  });
  const server = await runtimeCommand(['gateway', path, '0']);
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function post(route, body) {
    const result = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.ok, true);
    return result.json();
  }
  const parameters = { keyword: 'example' };
  const permit = grant('headline-http', 'headline-http', { issued_utc: issued, expires_utc: expiry, mapping_digest: provider.mapping_digest,
    proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: expiry })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 24 },
    tools: [{ operation, name: spec.tool, effect: 'read', schema_digest: spec.schema_digest, inputs_digest: sha(parameters) }] });
  const request = { contract_version: '1', capability_digest: sha(capability), operation, scope, request_id: 'headline-request',
    inputs: { ...parameters, grant: permit }, deadline_utc: new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const result = await post('/api/gateway', request);
  assert.equal(result.status, 'OK', JSON.stringify(result.error));
  assert.equal(result.data.rows[0].news_id, 'H1');
  assert.equal(Object.hasOwn(result.data.rows[0], 'content'), false);
  const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: operation, arguments: request } });
  assert.deepEqual(replay.result.structuredContent, result);
  const refusal = await post('/api/gateway', { ...request, request_id: 'changed-keyword', inputs: { grant: permit, keyword: 'changed' } });
  assert.equal(refusal.status, 'REFUSED');
  assert.equal(refusal.error.code, 'UNAUTHORIZED');
  assert.deepEqual(calls, ['GET']);
});

test('option chains bind contract owner, expiry interval, standard and signed query inputs', async t => {
  const op = 'read.option-chain';
  const parameters = { ...hk, start: '2026-04-01', end: '2026-06-01', filter_standard: 'STANDARD' };
  const contract = { code: 'HK.TCH260528C230000', stock_owner: hk.symbol, strike_time: '2026-05-28',
    strike_price: '230.000', lot_size: 100, option_type: 'CALL', expiration_cycle: 'MONTH', option_standard_type: 'STANDARD' };
  const chain = (row = contract) => response({ option_chain: [row] });
  const zeroCalls = calls => assert.equal(calls.length, 0);
  const result = await researchRead(t, op, parameters, chain(), calls => {
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/v1.0/quote/HK.00700/option-chain');
    assert.equal(url.searchParams.get('end'), parameters.end);
  });
  assert.equal(result.rows[0].strike_price, 230);
  assert.equal(result.decimals[0].strike_price, '230.000');
  for (const wrong of [{ stock_owner: 'HK.00001' }, { strike_time: '2026-06-02' }, { option_standard_type: 'NON_STANDARD' }]) {
    await assert.rejects(researchRead(t, op, parameters, chain({ ...contract, ...wrong })), /SOURCE_MAPPING_REQUIRED/);
  }
  await assert.rejects(researchRead(t, op, { ...parameters, end: '2026-03-01' }, chain(), zeroCalls), /INVALID_PARAMETER/);
  await assert.rejects(researchRead(t, op, { ...parameters, index_option_type: 1002 }, chain(), zeroCalls), /INVALID_PARAMETER/);
  await assert.rejects(researchRead(t, op, { ...parameters, symbol: 'SG.DEMO' }, chain(), zeroCalls), /UNSUPPORTED/);
  await assert.rejects(researchRead(t, op, { ...parameters, start: '' }, chain(), zeroCalls, parameters), /SCOPE_DENIED/);
  const many = Array.from({ length: 21 }, (_, day) => ({ ...contract, strike_time: '2026-05-' + String(day + 1).padStart(2, '0') }));
  await assert.rejects(researchRead(t, op, parameters, response({ option_chain: many })), /INVALID_PAGE/);
});

test('expiry lookup preserves expired dates, filters cycles and accepts empty results', async t => {
  const op = 'read.option-expiries';
  const parameters = { symbol: 'JP.N225', index_option_type: 2001, filter_expiration_cycles: 'MONTH,QUARTERLY' };
  const expiry = { strike_time: '2026-05-28', option_expiry_date_distance: -2, expiration_cycle: 'MONTH' };
  const body = response({ expiration_list: [expiry] });
  const result = await researchRead(t, op, parameters, body,
    calls => assert.equal(new URL(calls[0].url).searchParams.get('index_option_type'), '2001'));
  assert.deepEqual(result.rows, [expiry]);
  await assert.rejects(researchRead(t, op, { ...parameters, filter_expiration_cycles: 'WEEK' }, body), /SOURCE_MAPPING_REQUIRED/);
  await assert.rejects(researchRead(t, op, { ...parameters, filter_expiration_cycles: 'MONTH,BOGUS' }, body,
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
  assert.deepEqual((await researchRead(t, op, { ...hk, filter_expiration_cycles: '' }, { ret_code: -10 })).rows, []);
});

test('option trade Greeks retain zero and absent values, source price strings and the full opaque cursor', async t => {
  const op = 'read.option-events', filter = { option_market: 'US_SECURITY', code: 'US.DEMO', page_size: 1 };
  const fill = { option: 'US.DEMO261218C100000', owner: 'US.DEMO', fill_timestamp: 1795490000000123,
    strike_timestamp: 1797638400000000, price: '3.07000', strike_price: '100.00', bid_price: '3.000', delta: 0, theta: -0.025 };
  const cursor = 'a+/='.repeat(64);
  const body = (event = fill) => ({ ...response({ events: [event] }), pagination: { page_flag: cursor, completed: false, total: 2 } });
  const result = await researchRead(t, op, filter, body());
  assert.deepEqual([result.rows[0].delta, result.rows[0].theta, result.rows[0].rho, result.rows[0].ask_price], [0, -0.025, null, null]);
  assert.equal(result.decimals[0].price, fill.price);
  assert.equal(result.pagination.next_cursor, cursor);
  const end = { ...response({ events: [] }), pagination: { ...pageEnd, total: 2 } };
  const next = await researchRead(t, op, { ...filter, page_flag: cursor }, end,
    calls => assert.equal(new URL(calls[0].url).searchParams.get('page_flag'), cursor));
  assert.equal(next.pagination.next_cursor, null);
  await assert.rejects(researchRead(t, op, filter, body({ ...fill, price: 3.07 })), /PRECISION_UNKNOWN/);
  await assert.rejects(researchRead(t, op, filter, body({ ...fill, owner: 'US.OTHER' })), /SOURCE_MAPPING_REQUIRED/);
  await assert.rejects(researchRead(t, op, { option_market: 'HK_SECURITY' }, body()), /SOURCE_MAPPING_REQUIRED/);
  await assert.rejects(researchRead(t, op, { ...filter, page_flag: cursor }, end,
    calls => assert.equal(calls.length, 0), filter), /SCOPE_DENIED/);
});

test('financial statements keep reported periods, nested amounts, percentages and source precision', async t => {
  const op = 'read.financial-statements';
  const line = { field_id: 1, display_name: 'Fixture revenue', value_type: 'amount',
    data: '9007199254740993.000', yoy: '0.00', qoq: null };
  const ratio = { field_id: 2, display_name: 'Fixture margin', value_type: 'percent', data: 12.375, yoy: 0 };
  const report = { date_time: 1774886400000, fiscal_year: '2026', financial_type: '1', structure: 5,
    structure_name: 'NORMAL_HK', period_text: '2026/Q1', currency_code: 'CNY', accounting_standards: 'IAS',
    auditor_report: '', item_list: [{ ...line, private_attachment: 'discard' }, ratio] };
  const cursor = 'a+/='.repeat(250);
  const body = (reports, page = { has_more: true, next_key: cursor }) =>
    ({ ...response({ report_list: reports }), pagination: page });
  const failBeforeCall = calls => assert.equal(calls.length, 0);
  const parameters = { ...hk, currency_code: 'CNY', limit: 1, statement_type: 1, financial_type: 1 };
  for (const type of [1, 2, 3, 4]) {
    const fixture = { ...report, accounting_standards: type === 4 ? '' : 'IAS' };
    const result = await researchRead(t, op, { ...parameters, statement_type: type }, body([fixture]), calls => {
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, '/api/v1.0/quote/HK.00700/financials/statements');
      assert.equal(url.searchParams.get('statement_type'), String(type));
    });
    assert.deepEqual(result.rows[0], { ...fixture, item_list: [line, { ...ratio, qoq: null }] });
    assert.deepEqual(result.pagination, { completed: false, next_cursor: cursor });
  }
  const final = await researchRead(t, op, { ...parameters, next_key: cursor }, body([], { has_more: false, next_key: '' }),
    calls => assert.equal(new URL(calls[0].url).searchParams.get('next_key'), cursor));
  assert.deepEqual(final.pagination, { completed: true, next_cursor: null });
  assert.deepEqual((await researchRead(t, op, { ...hk, financial_type: 10 }, { ret_code: -10 })).rows, []);
  for (const patch of [{ currency_code: 'USD' }, { financial_type: '7' }])
    await assert.rejects(researchRead(t, op, parameters, body([{ ...report, ...patch }])), /SOURCE_MAPPING_REQUIRED/);
  for (const patch of [{ data: 2 ** 53 }, { data: '12%' }, { yoy: false }])
    await assert.rejects(researchRead(t, op, parameters, body([{ ...report, item_list: [{ ...line, ...patch }] }])), /PRECISION_UNKNOWN/);
  await assert.rejects(researchRead(t, op, parameters, body([{ ...report, item_list: {} }])), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, parameters, body([report, report])), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, { ...parameters, next_key: cursor }, body([report])), /INVALID_PAGE/);
  for (const patch of [{ limit: 51 }, { currency_code: 'Cny' }, { financial_type: 8 }, { statement_type: 5 }])
    await assert.rejects(researchRead(t, op, { ...parameters, ...patch }, {}, failBeforeCall), /INVALID_PARAMETER/);
  await assert.rejects(researchRead(t, op, { ...parameters, next_key: cursor }, {}, failBeforeCall, parameters), /SCOPE_DENIED/);
});

test('CFTC positioning preserves exact signed contracts and report totals across pages', async t => {
  const op = 'read.futures-positions', inputs = { symbol: 'US.CLmain', report_type: 'TOTAL', page_size: 1 };
  const row = { report_time: 1795478400, variety: 'Fixture crude', long: '9007199254740993', short: 87,
    spread: '0', net: '-87', net_change_weekly: -2, open_interest_change_rate_weekly: '-0.050' };
  const body = { ...response({ items: [row], total: 2 }), pagination: { completed: false, page_flag: '1' } };
  const result = await researchRead(t, op, inputs, body, calls => assert.match(calls[0].url, /US.CLmain\/future\/position-analysis/));
  assert.deepEqual(result.rows[0], { ...row, short: '87', net_change_weekly: '-2', open_interest: null, open_interest_change_weekly: null });
  assert.deepEqual(result.pagination, { completed: false, next_cursor: '1', total: 2 });
  await assert.rejects(researchRead(t, op, inputs, { ...body, data: { total: 'example', items: [row] } }), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, inputs, { ...body, data: { total: 1, items: [{ ...row, long: 2 ** 53 }] } }), /PRECISION_UNKNOWN/);
  await assert.rejects(researchRead(t, op, { ...inputs, page_size: 101 }, {}, calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
});

test('futures seasonality keeps the historical mean and timestamp-only observations', async t => {
  const op = 'read.futures-seasonality', inputs = { symbol: 'US.CLmain', period: 'MONTH' };
  const price = { timestamp: 1795478400, close: '-37.630', prev_close: '0.000' }, empty = { timestamp: 1795564800 };
  const series = [{ year: 2020, points: [price] }, { points: [empty] }];
  const result = await researchRead(t, op, inputs, response({ items: series }));
  assert.deepEqual(result.rows, [series[0], { year: null, points: [{ ...empty, close: null, prev_close: null }] }]);
  await assert.rejects(researchRead(t, op, inputs, response({ items: [series[0], series[0]] })), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, inputs, response({ items: [{ year: 0, points: 'example' }] })), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, { ...inputs, period: 'DAY' }, {}, calls => assert.equal(calls.length, 0), inputs), /SCOPE_DENIED/);
});

test('futures correlations bind the related series and apply page size and total to points per future', async t => {
  const op = 'read.futures-correlation', inputs = { symbol: 'US.CLmain', related_codes: 'US.GCmain,US.ESmain', page_size: 1 };
  const point = { timestamp: 1795478400, correlation: '-1.0000' };
  const series = inputs.related_codes.split(',').map(related_code => ({ code: inputs.symbol, related_code, points: [point] }));
  const body = items => ({ ...response({ items, total: 1 }), pagination: pageEnd });
  const result = await researchRead(t, op, inputs, body(series));
  assert.deepEqual(result.rows, series);
  assert.deepEqual(result.pagination, { completed: true, next_cursor: null, total: 1 });
  for (const value of ['1.000000000000000001', '-10.01e-1', '1e400']) {
    await assert.rejects(researchRead(t, op, inputs, body([{ ...series[0], points: [{ ...point, correlation: value }] }])), /INVALID_PAGE/);
  }
  const tiny = { ...point, correlation: '1e-300' };
  assert.deepEqual((await researchRead(t, op, inputs, body([{ ...series[0], points: [tiny] }]))).rows[0].points, [tiny]);
  await assert.rejects(researchRead(t, op, inputs, body([{ ...series[0], points: [point, point] }])), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, inputs, body([{ ...series[0], related_code: 'US.OTHER' }])), /SOURCE_MAPPING_REQUIRED/);
  await assert.rejects(researchRead(t, op, inputs, body([series[0], series[0]])), /INVALID_PAGE/);
  await assert.rejects(researchRead(t, op, { ...inputs, related_codes: 'US.A,US.B,US.C,US.D,US.E' }, {},
    calls => assert.equal(calls.length, 0)), /INVALID_PARAMETER/);
  await assert.rejects(researchRead(t, op, { ...inputs, page_flag: '1' }, {}, calls => assert.equal(calls.length, 0), inputs), /SCOPE_DENIED/);
  assert.deepEqual((await researchRead(t, op, inputs, { ret_code: -10 })).rows, []);
});

test('signed stock screen sends one fixed read-only POST and preserves the terminal page', async t => {
  const inputs = { market: 'HK', factors: ['price_to_book'], limit: 1 };
  const response = { ret_code: 0, data: { items: [{ code: 'HK.00700', name: 'Example', results: [{ result_type: 2, res: { ival: '125000' } }] }] },
    pagination: { total: 1, has_more: false, next_key: '-1' } };
  const page = await researchRead(t, 'read.stock-screen', inputs, response, ([call]) => {
    assert.deepEqual([call.method, call.url, call.redirect], ['POST', 'https://webapi.moomoo.com/api/v1.0/quote/stock-screen', 'error']);
    assert.deepEqual(JSON.parse(call.body), { screen_queries: [{ simple_field_query: { simple_field: 1, screen_value_list: [1] } }],
      retrieve_queries: [{ simple_property: { name: 2304 } }], limit: 1 });
  });
  assert.deepEqual(page.rows[0].factors, [{ factor: 'price_to_book', raw: '125000', value: '1.25000' }]);
  assert.deepEqual(page.pagination, { total: 1, completed: true, next_cursor: null });
  await assert.rejects(researchRead(t, 'read.stock-screen', { ...inputs, next_key: '3' }, response,
    calls => assert.equal(calls.length, 0), inputs), /SCOPE_DENIED/);
});
