import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deskProvenance, deskDepth, deskTape, deskCandles } from '../src/provider-desk.mjs';

const fixture = JSON.parse(await readFile(new URL('../qualification/moomoo/desktop-mcp-capture.json', import.meta.url), 'utf8'));
const book = fixture.calls.quote_order_book.structuredContent.data[0].books[0];
const side = list => list.map(row => ({ price: String(row.price), volume: row.volume, orders: row.order_count }));
const iso = date => String(date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

test('the curated desk depth ladder is pinned to the captured order book', () => {
  assert.equal(deskDepth.exchange, book.exchange);
  assert.deepEqual(deskDepth.ask, side(book.ask_list));
  assert.deepEqual(deskDepth.bid, side(book.bid_list));
  assert.equal(deskDepth.ask.length, 10); assert.equal(deskDepth.bid.length, 10);
  for (const level of [...deskDepth.ask, ...deskDepth.bid]) {
    assert.equal(typeof level.price, 'string');
    assert.ok(Number.isSafeInteger(level.volume) && Number.isSafeInteger(level.orders));
  }
});

test('the curated desk tape is pinned to the captured ticks and leaves sequence opaque', () => {
  const ticks = fixture.calls.quote_rt_ticker.structuredContent.data.ticker_list;
  assert.deepEqual(deskTape, ticks.map(tick => ({
    time: tick.time, price: String(tick.price), volume: tick.volume,
    turnover: String(tick.turnover), direction: tick.ticker_direction, tick_type: tick.tick_type
  })));
  assert.equal(deskTape.length, 20);
  assert.equal(deskTape.every(row => !('sequence' in row)), true);
  assert.ok(ticks.every(tick => tick.sequence > Number.MAX_SAFE_INTEGER));
});

test('the curated desk candles are pinned to the captured kline with round-trip decimals', () => {
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
  assert.deepEqual(deskProvenance.operations, ['read.depth', 'read.tape', 'read.candles']);
  assert.equal(fixture.provenance.hosted_n3, false);
});