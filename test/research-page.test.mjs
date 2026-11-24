import test from 'node:test';
import assert from 'node:assert/strict';
import { marketPage, marketRestSpecs } from '../runtime/moomoo-market-rest.mjs';
import { researchMapping } from '../runtime/moomoo-research.mjs';
import { captureCalendarFixture } from '../scripts/export-calendar-fixture.mjs';
import { researchDisplaySchema } from '../src/research-display-schema.mjs';
import { readResearchPage } from '../src/research-page.mjs';

const at = Date.UTC(2026, 10, 24);
function gateway(operation, rows, decimals, metadata = {}) {
  return { status: 'OK', request_id: 'fixture-read', ledger_revision: 2,
    provenance: { provider: 'local-test', source: 'PROVIDER', operation },
    data: { source: 'AUTHENTICATED_ADAPTER', at, rows, decimals, ...metadata } };
}

test('every reviewed research mapping has named columns, units and a readable empty result', async () => {
  const operations = ['read.calendar', ...Object.keys(researchMapping.operations), ...Object.keys(marketRestSpecs)].sort();
  assert.deepEqual(Object.keys(researchDisplaySchema).sort(), operations);
  assert.equal(operations.length, 37);
  for (const name of operations) {
    const schema = researchDisplaySchema[name];
    assert.ok(schema.columns.length && schema.units);
    const page = await readResearchPage(gateway(name, [], [], schema.paged
      ? { pagination: { completed: true, next_cursor: null, total: 0, ...(name === 'read.candle-history' && { next_page_token: null, next_time: null }) } } : {}));
    assert.deepEqual(page.rows, []);
    assert.equal(page.units, schema.units);
  }
});

test('saved candle history distinguishes backward timestamps from opaque tokens and rejects conflicting continuations', async () => {
  const token = '01'.repeat(24);
  const operation = 'read.candle-history';
  const { rows, decimals } = marketPage(marketRestSpecs[operation], { symbol: 'US.QQQ', end: '2026-11-24' },
    JSON.stringify({ ret_code: 0, data: { kline_list: [{ time_key: at, open: 1, high: 2, low: 1, close: 2, volume: 10, turnover: 20 }] },
      pagination: { has_more: false } }));
  const page = (cursor, extra) => readResearchPage(gateway(operation, rows, decimals,
    { pagination: { completed: false, next_cursor: cursor, next_page_token: null, next_time: at, ...extra } }));
  assert.equal((await page(String(at))).pagination.nextTime, at);
  assert.equal((await page(token, { next_page_token: token })).pagination.token, token);
  await assert.rejects(page(String(at), { next_page_token: token }));
  await assert.rejects(page(token, { next_page_token: 'x'.repeat(48) }));
  await assert.rejects(page(null, { completed: true }));
  await assert.rejects(page(String(at + 1), { next_time: at + 1 }));
});

test('the exported Gateway calendar preserves null EPS, date, session and synthetic source', async () => {
  const fixture = await captureCalendarFixture();
  const page = await readResearchPage(fixture);
  const [row] = page.rows;
  assert.equal(page.binding, 'Synthetic calendar export');
  assert.deepEqual([row.earnings_date, row.pub_type, row.eps_actual, row.eps_predict, row.published],
    [fixture.earnings_date, 'AFTER', null, fixture.eps_predict, false]);
  assert.equal(row.earnings_timestamp, fixture.earnings_timestamp);
  assert.equal(row.price, fixture.price);
  await assert.rejects(readResearchPage({ ...fixture, eps_actual: 0 }), /checksum/);
});

test('flow and ranking previews retain source decimals, observation time and opaque continuations', async () => {
  const amountNames = researchMapping.operations['read.capital-flow'].numeric;
  const amounts = Object.fromEntries(amountNames.map(key => [key, '-312.0500']));
  const flow = gateway('read.capital-flow',
    [{ capital_flow_item_time: at, ...Object.fromEntries(amountNames.map(key => [key, -312.05])), EXTRA_PRIVATE: 'discard' }],
    [{ capital_flow_item_time: String(at), ...amounts }], { last_valid_time_ms: at, market: { symbol: 'HK.00700' } });
  const first = await readResearchPage(flow);
  assert.equal(first.rows[0].in_flow, '-312.0500');
  assert.equal(first.rows[0].capital_flow_item_time, String(at));
  assert.equal(first.lastValid, new Date(at).toISOString());
  assert.equal(first.symbol, 'HK.00700');
  assert.equal(JSON.stringify(first).includes('EXTRA_PRIVATE'), false);
  const scores = researchMapping.operations['read.rank'].numeric;
  const rank = gateway('read.rank', [{ code: 'HK.00700', name: 'Example', ...Object.fromEntries(scores.map(key => [key, 1.2])) }],
    [Object.fromEntries(scores.map(key => [key, '1.200']))], { pagination: { completed: false, next_cursor: '2/+=', total: 3 } });
  const second = await readResearchPage(rank);
  assert.equal(second.rows[0].news_heat, '1.200');
  assert.deepEqual(second.pagination, { completed: false, cursor: '2/+=', total: 3 });
  rank.data.decimals[0].news_heat = '1.29';
  await assert.rejects(readResearchPage(rank), /decimal disagrees/);
});

test('nested financial statement and futures rows keep reported units, source text and nulls', async () => {
  const line = { field_id: 123, display_name: 'Reported income', value_type: 'amount', data: '12.3400', yoy: null, qoq: '0.0' };
  const report = { date_time: at, structure: 1, fiscal_year: '2026', financial_type: '1', period_text: 'Q3',
    structure_name: 'Fixture', accounting_standards: 'IFRS', auditor_report: '', currency_code: 'HKD', item_list: [line] };
  const statements = await readResearchPage(gateway('read.financial-statements', [report], [{}],
    { pagination: { completed: true, next_cursor: null } }));
  assert.deepEqual(statements.rows[0].item_list, [line]);
  assert.equal(statements.rows[0].currency_code, 'HKD');
  const curve = { year: null, points: [{ timestamp: 1795478400, close: '1.0200', prev_close: null }] };
  assert.deepEqual((await readResearchPage(gateway('read.futures-seasonality', [curve], [{}]))).rows, [curve]);
});

test('refused, out-of-scope, malformed and incomplete files provide no research page', async () => {
  const empty = gateway('read.rank', [], [], { pagination: { completed: false, next_cursor: 'a' } });
  for (const file of [{ ...empty, status: 'REFUSED' }, { ...empty, provenance: { ...empty.provenance, operation: 'paper.place' } },
    { ...empty, data: { ...empty.data, rows: [{}], decimals: [] } }, { ...empty, data: { ...empty.data, pagination: undefined } },
    { ...empty, data: { ...empty.data, source: 'unknown' } }, { jsonrpc: '2.0', result: { isError: true, structuredContent: empty } }]) {
    await assert.rejects(readResearchPage(file));
  }
});
