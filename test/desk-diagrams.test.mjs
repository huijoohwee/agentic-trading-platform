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
    assert.equal(bar.up, deskTape[i].direction === 'BUY');
    assert.ok(bar.width > 0);
  }
});