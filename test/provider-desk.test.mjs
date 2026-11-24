import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addQuoteProvenance, quoteChange } from '../src/quote-display.mjs';
import { projectDesktopDesk, deskProvenance, deskQuote, deskDepth, deskTape, deskCandles } from '../src/provider-desk.mjs';

const fixture = JSON.parse(await readFile(new URL('../qualification/moomoo/desktop-mcp-capture.json', import.meta.url), 'utf8'));
const book = fixture.calls.quote_order_book.structuredContent.data[0].books[0];
const side = list => list.map(row => ({ price: String(row.price), volume: row.volume, orders: row.order_count }));
const iso = date => String(date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

test('the desk computes decimal price changes and rounds percentages once', () => {
  for (const [last, previous, text] of [
    ['0.3', '0.2', '+0.1 (+50.00%)'], ['0.2', '0.3', '-0.1 (-33.33%)'],
    ['2.0001', '2', '+0.0001 (+0.01%)'], ['1.9999', '2', '-0.0001 (-0.01%)'],
    ['2e-7', '1e-7', '+0.0000001 (+100.00%)'], ['1e+20', '1', '+99999999999999999999 (+9999999999999999999900.00%)'],
    ['20', '10', '+10 (+100.00%)'], ['1.20', '1.2', '+0 (+0.00%)'], ['2', '0', '+2'],
    ['344', null, 'UNKNOWN'], [null, '10', 'UNKNOWN']
  ]) assert.equal(quoteChange(last, previous).text, text);
  assert.equal(quoteChange('1', '2').accent, 'secondary');
  assert.equal(quoteChange('1', null).accent, 'neutral');
});

test('quote age uses the capture clock and preserves unavailable or inconsistent times', () => {
  const evidence = (market, capture) => {
    const rows = {};
    addQuoteProvenance((label, value) => { rows[label] = value; }, market, capture);
    return rows;
  };
  const market = deskQuote.marketTimeUtc, captured = deskProvenance.captured_utc;
  assert.equal(evidence(market, captured)['Age at capture'], '15 h 9 min 54 s');
  assert.equal(evidence(Date.parse(market), captured)['Quote time (UTC)'], market);
  assert.equal(evidence(market, '2026-11-23T08:07:50.250Z')['Age at capture'], '0 h 0 min 0.25 s');
  assert.match(evidence(captured, market)['Age at capture'], /source time follows capture/);
  assert.equal(evidence(null, captured)['Quote time (UTC)'], 'Unknown');
  assert.equal(evidence('2026-02-30T00:00:00Z', captured)['Age at capture'], 'Unknown');
  assert.equal(evidence(market, null)['Age at capture'], 'Unknown');
});

test('the quote board uses the same captured symbol and preserves absent prior close', () => {
  const row = fixture.calls.quote_stock_quote.structuredContent.data.quote_list[0];
  assert.equal(deskQuote.last, String(row.last_price));
  assert.equal(deskQuote.name, row.name);
  assert.equal(deskQuote.marketTimeUtc, new Date(row.data_time).toISOString());
  const changed = structuredClone(fixture);
  delete changed.calls.quote_stock_quote.structuredContent.data.quote_list[0].prev_close_price;
  assert.equal(projectDesktopDesk(changed).deskQuote.prev_close, null);
  changed.calls.quote_stock_quote.arguments.code_list.push('US.AAPL');
  assert.throws(() => projectDesktopDesk(changed), /DESK_SYMBOL_MISMATCH/);
});

test('the Gateway-projected desk depth ladder is pinned to the captured order book', () => {
  assert.equal(deskDepth.exchange, book.exchange);
  assert.deepEqual(deskDepth.ask, side(book.ask_list));
  assert.deepEqual(deskDepth.bid, side(book.bid_list));
  assert.equal(deskDepth.ask.length, 10); assert.equal(deskDepth.bid.length, 10);
  for (const level of [...deskDepth.ask, ...deskDepth.bid]) {
    assert.equal(typeof level.price, 'string');
    assert.ok(Number.isSafeInteger(level.volume) && Number.isSafeInteger(level.orders));
  }
});

test('the Gateway-projected desk tape is pinned to the captured ticks and leaves sequence opaque', () => {
  const ticks = fixture.calls.quote_rt_ticker.structuredContent.data.ticker_list;
  assert.deepEqual(deskTape, ticks.map(tick => ({
    time: tick.time, price: String(tick.price), volume: tick.volume,
    turnover: String(tick.turnover), direction: tick.ticker_direction, tick_type: tick.tick_type
  })));
  assert.equal(deskTape.length, 20);
  assert.equal(deskTape.every(row => !('sequence' in row)), true);
  assert.ok(ticks.every(tick => tick.sequence > Number.MAX_SAFE_INTEGER));
});

test('the Gateway-projected desk candles are pinned to the captured kline with round-trip decimals', () => {
  const kline = fixture.calls.quote_cur_kline.structuredContent.data.kline_list;
  assert.deepEqual(deskCandles, kline.map(row => ({
    date: iso(row.date), time: row.time_key, open: String(row.open_price), high: String(row.high_price),
    low: String(row.low_price), close: String(row.close_price), volume: row.volume,
    turnover: String(row.turnover), change_rate: String(row.change_rate)
  })));
  assert.equal(deskCandles.length, 5);
  for (const candle of deskCandles) {
    assert.equal(Number(candle.close), kline.find(row => row.time_key === candle.time).close_price);
    assert.match(candle.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('the desk provenance stays read-only, $0 and Desktop-bound', () => {
  assert.equal(deskProvenance.binding, 'desktop-mcp');
  assert.equal(deskProvenance.cost_usd, 0);
  assert.equal(deskProvenance.symbol, fixture.provenance.symbol);
  assert.equal(deskProvenance.captured_utc, fixture.provenance.captured_utc);
  assert.deepEqual(deskProvenance.operations, ['read.ticker', 'read.depth', 'read.tape', 'read.candles']);
  assert.equal(fixture.provenance.hosted_n3, false);
});

test('the desk refuses foreign symbols, failed capture calls and incompatible candle dimensions', () => {
  const reject = (edit, code) => {
    const changed = structuredClone(fixture);
    edit(changed.calls);
    assert.throws(() => projectDesktopDesk(changed), code);
  };
  reject(calls => { calls.quote_order_book.arguments.code = 'US.AAPL'; }, /DESK_SYMBOL_MISMATCH/);
  reject(calls => { calls.quote_rt_ticker.structuredContent.ret_code = -1; }, /DESK_PROVIDER_REFUSED/);
  reject(calls => { calls.quote_cur_kline.structuredContent.data.kline_list[0].code = 'US.AAPL'; }, /DESK_CAPTURE_MISMATCH/);
  reject(calls => { calls.quote_cur_kline.arguments.ktype = 1; }, /DESK_KLINE_DIMENSION/);
  reject(calls => { calls.quote_order_book.structuredContent.data[0].books[0].ask_list[0].price = -1; }, /INVALID_SNAPSHOT/);
});
