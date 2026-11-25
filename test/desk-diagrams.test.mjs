import test from 'node:test';
import assert from 'node:assert/strict';
import { candleGeometry, depthGeometry, tapeGeometry } from '../src/desk-diagrams.mjs';
import { deskDepth, deskTape, deskCandles } from '../src/provider-desk.mjs';

test('candle geometry inverts the price axis and keeps bodies inside wicks', () => {
  const g = candleGeometry(deskCandles);
  assert.equal(g.candles.length, deskCandles.length);
  assert.ok(g.hi > g.lo);
  for (const [i, c] of g.candles.entries()) {
    const row = deskCandles[i];
    assert.equal(c.up, Number(row.close) >= Number(row.open));
    assert.ok(c.wickTop <= c.bodyTop && c.bodyTop + c.bodyHeight <= c.wickBottom + 1e-9);
    assert.ok(c.bodyHeight >= 1 && c.bodyWidth > 0);
    assert.equal(c.label, row.date);
  }
  assert.ok(g.yTicks[0].y > g.yTicks[3].y, 'higher price must map to a smaller y');
  assert.ok(g.candles[0].x < g.candles.at(-1).x);
});

test('candles retain exact direction, wicks and distinct price ticks in decimal space', () => {
  for (const [low, close, open, high] of [
    ['1.00000000000000000', '1.00000000000000001', '1.00000000000000002', '1.00000000000000003'],
    ['0.0011', '0.0012', '0.0013', '0.0014'],
    ['9007199254740992', '9007199254740993', '9007199254740994', '9007199254740995'],
    ['-0.00003', '-2e-5', '-0.00001', '0'],
    ['1e-300', '2e-300', '3e-300', '4e-300']
  ]) {
    const { candles: [bar], yTicks, plotLeft } = candleGeometry([{ open, close, high, low }]);
    assert.equal(bar.up, false);
    assert.ok(bar.wickTop < bar.bodyTop && bar.bodyTop + bar.bodyHeight < bar.wickBottom);
    assert.equal(yTicks.length, 4);
    assert.equal(new Set(yTicks.map(tick => tick.label)).size, 4);
    assert.ok(yTicks.every(tick => tick.label.length * 6 < plotLeft));
    assert.equal(yTicks[0].label, low === '1.00000000000000000' ? '1' : low);
    assert.equal(yTicks.at(-1).label, high);
  }
  const flat = candleGeometry([{ open: '01.00', high: '100e-2', low: 1, close: '10e-1' }]);
  assert.deepEqual(flat.yTicks.map(tick => tick.label), ['1']);
  for (const high of ['unknown', '1', '1e999999']) {
    assert.deepEqual(candleGeometry([{ open: '2', close: '1', low: '1', high }]).candles, []);
  }
});

test('depth geometry mirrors bid/ask bars with volume-proportional lengths', () => {
  const g = depthGeometry(deskDepth);
  assert.equal(g.bids.length, 10); assert.equal(g.asks.length, 10);
  assert.equal(g.maxVolume, Math.max(...deskDepth.bid.map(l => l.volume), ...deskDepth.ask.map(l => l.volume)));
  const ratio = g.bids[0].width / g.bids[0].volume;
  for (const bar of [...g.bids, ...g.asks]) {
    assert.ok(Math.abs(bar.width / bar.volume - ratio) < 1e-9);
    assert.ok(bar.height > 0 && bar.width >= 0);
  }
  for (const [i, bid] of g.bids.entries()) {
    assert.ok(Math.abs(bid.x + bid.width - (g.center - 40)) < 1e-9);
    assert.equal(g.asks[i].x, g.center + 40);
    assert.equal(bid.price, deskDepth.bid[i].price);
    assert.equal(g.asks[i].price, deskDepth.ask[i].price);
  }
});

test('tape geometry scales tick volume and colors by direction', () => {
  const g = tapeGeometry(deskTape);
  assert.equal(g.bars.length, deskTape.length);
  assert.equal(g.maxVolume, Math.max(...deskTape.map(t => t.volume)));
  const ratio = g.bars[0].height / g.bars[0].volume;
  for (const [i, bar] of g.bars.entries()) {
    assert.ok(Math.abs(bar.height / bar.volume - ratio) < 1e-9 || bar.height === 1);
    assert.equal(bar.direction, deskTape[i].direction);
    assert.ok(bar.width > 0);
  }
});

test('asymmetric books, zero volume and a flat candle keep finite geometry', () => {
  const level = { price: '12', volume: 0 };
  for (const book of [{ ask: [level], bid: [] }, { ask: [], bid: [level] }]) {
    const g = depthGeometry(book);
    assert.equal([...g.bids, ...g.asks][0].width, 0);
  }
  assert.deepEqual(candleGeometry([]).yTicks, []);
  const flat = candleGeometry([{ open: '12', close: '12', high: '12', low: '12' }]);
  assert.equal(flat.yTicks.length, 1);
  assert.ok(Number.isFinite(flat.candles[0].bodyTop));
  const [tick] = tapeGeometry([{ volume: 0, direction: 'NEUTRAL' }]).bars;
  assert.equal(tick.height, 0);
  assert.equal(tick.direction, 'NEUTRAL');
});
