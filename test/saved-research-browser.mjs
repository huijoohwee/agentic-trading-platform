import assert from 'node:assert/strict';

export async function verifySavedResearch(page, calendar) {
  const view = page.locator('#research-page-inspector');
  await view.locator(':scope > summary').click();
  const file = view.getByLabel('Research result JSON file');
  await view.getByRole('button', { name: 'Open example calendar' }).click();
  await view.getByText('Synthetic example · read.calendar', { exact: true }).waitFor();
  await view.getByText('Rows 1–3 of 3', { exact: true }).waitFor();
  const select = data => file.setInputFiles({ name: 'research.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await select(calendar);
  await view.getByText('Local file · read.calendar · origin unverified', { exact: true }).waitFor();
  await view.getByText(calendar.code + ' · ' + calendar.earnings_date, { exact: true }).click();
  await view.getByText('Unknown', { exact: true }).waitFor();
  await view.getByText('AFTER', { exact: true }).waitFor();
  const { code, name, earnings_date, earnings_timestamp, pub_type, period_text, price, published } = calendar;
  const calendarRow = { code, name, earnings_date, earnings_timestamp, pub_type, period_text, price: Number(price),
    published, eps_actual: 0, eps_predict: null };
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'calendar-fixture', operation: 'read.calendar' },
    data: { source: 'AUTHENTICATED_ADAPTER', at: 1800000000000, rows: [calendarRow], decimals: [{ price, earnings_timestamp: String(earnings_timestamp) }] } });
  await view.getByText('calendar-fixture · PROVIDER', { exact: true }).waitFor();
  await view.getByText(code + ' · ' + earnings_date, { exact: true }).click();
  assert.equal(await view.getByText('Estimated EPS', { exact: true }).evaluate(dt => dt.nextElementSibling.textContent), 'Unknown');
  assert.equal(await view.getByText('Actual EPS', { exact: true }).evaluate(dt => dt.nextElementSibling.textContent), '0');
  const holding = { code: '', holding_name: 'Unmapped holding', holding_rate: 1.5, disclosure_time_ms: 1800000000000 };
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'etf-fixture', operation: 'read.etf' },
    data: { source: 'AUTHENTICATED_ADAPTER', at: 1800000000000, rows: [holding], decimals: [{ holding_rate: '1.500' }] } });
  await view.getByText('Unmapped holding', { exact: true }).click();
  await view.getByText('Empty text', { exact: true }).waitFor();
  await view.getByText('1.500', { exact: true }).waitFor();
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'session-fixture', operation: 'read.trading-days' },
    data: { source: 'AUTHENTICATED_ADAPTER', at: 1800000000000, decimals: [{}],
      rows: [{ market: 'HK', market_date: '2025-12-24', trade_date_type: 'MORNING', trade_second: 14400 }] } });
  await view.getByRole('heading', { name: 'Reported trading seconds · 1 of 1 days' }).waitFor();
  await view.getByText('HK · 2025-12-24', { exact: true }).click();
  await view.getByText('MORNING', { exact: true }).waitFor();
  const state = { symbol: 'US.DIA', market_state: 'OVERNIGHT', broker_id: null, time_date: null, stock_name: null, sc_name: null,
    tc_name: null, traded_seconds: null, total_seconds: null, trade_section: null, broker_ids: null };
  await select({ status: 'OK', ledger_revision: 3, provenance: { source: 'PROVIDER', provider: 'session-fixture', operation: 'read.market-state' },
    data: { source: 'AUTHENTICATED_ADAPTER', at: 1800000000000, decimals: [{}], rows: [state] } });
  await view.getByRole('table', { name: 'Market sessions · 1 of 1 rows' }).getByText('OVERNIGHT').waitFor();
  const book = { symbol: 'HK.00700', name: 'Example', time_ms: 1800000000000, volume_precision: 2, bid_flag: 1, ask_flag: 0,
    bids: [{ price: '340.00', raw_volume: '120', volume: '1.20', order_count: 1 }], asks: [] };
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'book-fixture', operation: 'read.depth' },
    data: { at: book.time_ms, source: 'AUTHENTICATED_ADAPTER', rows: [{ ...book, exchange: 'SEHK' }, { ...book, exchange: '' }], decimals: [{}, {}] } });
  await view.getByRole('img', { name: /Order book depth diagram/ }).waitFor();
  await view.getByLabel('Exchange book').selectOption('1');
  await view.getByRole('heading', { name: /Aggregated book · First 10 levels/ }).waitFor();
  const bar = { symbol: 'US.QQQ', time_ms: 1780469195226, market_date: null, utc_offset_minutes: null, ktype: 110,
    autype: 1, extended_time: 0, pred_side: 0, open: '12.0', high: '13', low: '11', close: '12.30001',
    raw_volume: '9007199254740993', volume_precision: null, volume: null, turnover: '34000', prev_close: null,
    turnover_rate_pct: null, change_pct: null, pe_ratio: null, open_interest: null, reported_settle_price: null,
    implied_volatility_pct: null, name: null, sc_name: null, tc_name: null };
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'history-fixture', operation: 'read.candle-history' },
    data: { at: bar.time_ms + 1, source: 'AUTHENTICATED_ADAPTER', rows: [bar], decimals: [{}],
      pagination: { completed: false, next_cursor: String(bar.time_ms), next_page_token: null, next_time: bar.time_ms } } });
  await view.getByRole('img', { name: /US.QQQ.*candles in file order/ }).waitFor();
  await view.getByText('Volume scale unavailable. Raw quantities are shown in the rows.').waitFor();
  await view.getByText('Backward cursor (Unix ms)', { exact: true }).waitFor();
  const flow = { symbol: 'US.QQQ', period_type: 'WEEK', capital_flow_item_time: bar.time_ms, in_flow: '-9007199254740993.1000',
    main_in_flow: '10.000', super_in_flow: '3.00', big_in_flow: '7', mid_in_flow: '0', sml_in_flow: '-2' };
  await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'flow-fixture', operation: 'read.capital-flow-history' },
    data: { at: bar.time_ms + 1, source: 'AUTHENTICATED_ADAPTER', rows: [flow], decimals: [{}],
      pagination: { completed: false, next_cursor: String(bar.time_ms), next_time: bar.time_ms } } });
  await view.getByText('US.QQQ · ' + bar.time_ms, { exact: true }).click();
  await view.getByText(flow.in_flow, { exact: true }).waitFor();
  const rows = Array.from({ length: 11 }, (_, i) => ({ symbol: 'HK.' + i, name: 'Example ' + i,
    factors: [{ factor: 'market_cap', raw: '9007199254740993', value: '9007199254740.993' }] }));
  const result = { status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'screen-fixture', operation: 'read.stock-screen' },
    data: { at: 1800000000000, source: 'AUTHENTICATED_ADAPTER', rows, decimals: rows.map(() => ({})),
      pagination: { total: 32, completed: false, next_cursor: '17' } } };
  await select({ jsonrpc: '2.0', result: { isError: false, structuredContent: result } });
  await view.getByText('Rows 1–10 of 11', { exact: true }).waitFor();
  await view.getByRole('button', { name: 'Next rows' }).click();
  await view.getByText('HK.10', { exact: true }).click();
  await view.getByText('market_cap · 9007199254740.993', { exact: true }).click();
  await view.getByText('9007199254740993', { exact: true }).waitFor();
  await view.getByText('17', { exact: true }).waitFor();
  for (const [operation, row, summary, exact] of [
    ['read.dividend-calendar', { code: 'US.AAPL', name: 'Example', ex_date: '2026-10-16', record_date: null,
      dividend_payable_date: '', statement: 'USD 0.1000' }, 'US.AAPL · 2026-10-16', 'USD 0.1000'],
    ['read.economic-calendar', { article_id: 'economic-1', title: 'Rate announcement', item_type: 'ECONOMIC_DATA',
      timestamp: 1792108800, star: 5, country: 'US', previous: '2.1000%', actual: '' }, 'Rate announcement', '2.1000%'],
  ]) {
    await select({ status: 'OK', ledger_revision: 2, provenance: { source: 'PROVIDER', provider: 'calendar-fixture', operation },
      data: { at: 1800000000000, source: 'AUTHENTICATED_ADAPTER', rows: [row], decimals: [{}],
        pagination: { total: 2, completed: false, next_cursor: 'next/2' } } });
    await view.locator('summary').filter({ hasText: summary }).click();
    await view.getByText(exact, { exact: true }).waitFor();
    await view.getByText('next/2', { exact: true }).waitFor();
  }
  await select({ ...calendar, eps_actual: 0 });
  await view.getByText(/calendar fixture checksum does not match/).waitFor();
  assert.equal(await view.getByText('9007199254740993', { exact: true }).count(), 0);
  await view.getByRole('button', { name: 'Clear preview' }).click();
  assert.equal(await file.inputValue(), '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await view.locator(':scope > summary').click();
}
