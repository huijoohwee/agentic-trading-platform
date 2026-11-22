import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../runtime/store.mjs';
import { publicFeed } from '../runtime/public-feed.mjs';
import { createPaperGuard } from '../runtime/paper-guard.mjs';
import { sha } from '../runtime/core.mjs';
import { bucket } from '../src/market.mjs';
const source = 'Local conformance producer',
  license = 'CC0-1.0',
  venue = 'test-venue',
  symbol = 'TEST.USD';
const binding = { venue, symbol, marketType: 'perpetual' };
function samples(time, frame, dt) {
  const t = bucket(time, frame);
  return Array.from({ length: 100 }, (_, i) => ({
    time: t + (i - 99) * dt,
    open: 10 + i,
    high: 12 + i,
    low: 9 + i,
    close: 11 + i,
    volume: i + 1
  }));
}
test('UTC feed aggregation, signed contract marks, trigger re-admission, funding once and stale/refusal readback', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feed-conformance-')),
    dir = join(directory, 'feed');
  mkdirSync(dir, { mode: 0o700 });
  const receipt = Buffer.from('Explicit test-only data grant'),
    rightsDigest = sha(receipt);
  writeFileSync(join(dir, rightsDigest + '.rights'), receipt);
  let time = Date.UTC(2025, 0, 1, 6, 8),
    seq = 0;
  writeFileSync(
    join(dir, 'admission.json'),
    JSON.stringify({
      schema: 'public-market-admission/v1',
      markets: ['spot', 'perpetual'].map((marketType) => ({
        ...binding,
        marketType,
        currency: 'USD',
        settlement: 'USD',
        hardCapUsd: 0,
        allowPublicDisplay: true,
        source,
        license,
        creator: 'test',
        expires: time + 2 * 86400000,
        rightsDigest
      }))
    })
  );
  const feed = publicFeed(directory, () => time),
    store = openStore(join(directory, 'desk.sqlite')),
    scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'desk/' + 'a'.repeat(64) };
  t.after(() => {
    feed.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const guard = createPaperGuard({ mode: 'synthetic-replay', scope, store, now: () => time, market: feed.query });
  function snap(price, events = [], marketType = 'perpetual') {
    return {
      schema: 'public-market-snapshot/v1',
      ...binding,
      marketType,
      currency: 'USD',
      timeUnits: 'UTC_ms',
      sequence: ++seq,
      at: time,
      ticker: { last: price, high: price + 1, low: price - 1, change: 0, volume: 5000 },
      bids: Array.from({ length: 20 }, (_, i) => ({ price: price - (i + 1) * 0.01, amount: i + 1 })),
      asks: Array.from({ length: 20 }, (_, i) => ({ price: price + (i + 1) * 0.01, amount: i + 2 })),
      tape: [
        { time, price, amount: 3, aggressor: 'buyer' },
        { time: time - 20, price, amount: 5, aggressor: 'seller' }
      ],
      candles: { '5m': samples(time, '5m', 300000), '1h': samples(time, '1h', 3600000) },
      funding: { from: time - 86400000, through: time, events }
    };
  }
  const publish = (s) => feed.publish(Buffer.from(JSON.stringify(s)));
  const first = snap(100);
  publish(first);
  assert.equal(publish(first).sequence, first.sequence);
  const corrupt = snap(100);
  corrupt.candles['5m'][0].high = 0;
  assert.throws(() => publish(corrupt), /FEED_CANDLES/);
  assert.equal(feed.query('read.ticker', binding).sequence, first.sequence);
  const query = (op, more = {}) => feed.query(op, { ...binding, ...more });
  const book = query('read.depth');
  assert.equal(book.rows.asks.length, 20);
  assert.ok(book.rows.spread > 0);
  assert.deepEqual(query('read.tape').volumes, { buyer: 3, seller: 5 });
  for (const [frame, from] of [
    ['10m', '5m'],
    ['3h', '1h']
  ]) {
    const a = query('desk.chart', { frame, count: 20 });
    assert.equal(a.bars.length, 20);
    for (const b of a.bars) {
      const group = first.candles[from].filter((c) => bucket(c.time, frame) === b.time);
      assert.deepEqual(
        [b.open, b.high, b.low, b.close, b.volume],
        [
          group[0].open,
          Math.max(...group.map((c) => c.high)),
          Math.min(...group.map((c) => c.low)),
          group.at(-1).close,
          group.reduce((s, c) => s + c.volume, 0)
        ]
      );
    }
    assert.equal(a.forming.time, bucket(time, frame));
  }
  const cmd = (kind, args) => guard.apply({ kind, ...args }, guard.read().revision, randomUUID());
  cmd('select', binding);
  const order = (side, qty, extra = {}) =>
    cmd('order', {
      symbol,
      marketType: 'perpetual',
      side,
      qty,
      type: 'MARKET',
      leverage: 2,
      explicitIntent: true,
      ...extra
    });
  assert.equal(order('BUY', 500).notice, 'FILLED');
  assert.equal(order('BUY', 700, { type: 'STOP', trigger: 120 }).notice, 'WORKING');
  const previous = guard.read().revision;
  const mixed = snap(100);
  mixed.tickerAt = time - 15001;
  mixed.bookAt = time;
  publish(mixed);
  assert.equal(query('read.depth').quality, 'live');
  assert.equal(query('read.ticker').quality, 'stale');
  assert.equal(query('read.ticker').rows.at, mixed.tickerAt);
  assert.throws(() => order('BUY', 1), /FRESH_USD_MARK_REQUIRED/);
  assert.throws(() => publish({ ...mixed, bookAt: time + 1 }), /FEED_OBSERVATION_TIME/);
  publish({ ...snap(100), bookAt: time - 16000, tickerAt: time });
  assert.equal(query('read.depth').quality, 'stale');
  assert.equal(query('read.ticker').quality, 'live');
  assert.throws(() => order('BUY', 1000), /LEVERAGE_LIMIT/);
  assert.equal(guard.read().revision, previous);
  time += 3600000;
  publish(snap(500, [{ time, price: 500, rate: 0.001 }]));
  const checked = cmd('tick', { symbol });
  assert.match(checked.notice, /REJECTED/);
  assert.equal(checked.session.orders.length, 0);
  assert.equal(checked.session.fundingTotal, -250);
  assert.equal(guard.read().session.fundingTotal, -250);
  const prior = guard.read().revision;
  time += 20000;
  assert.equal(query('read.ticker').quality, 'stale');
  assert.throws(() => order('BUY', 1), /FRESH_USD_MARK_REQUIRED/);
  assert.equal(guard.read().revision, prior);
  assert.throws(() => publish(first), /FEED_ROLLBACK/);
  publish(snap(501, [{ time: time - 20000, price: 500, rate: 0.001 }]));
  assert.equal(order('SELL', 500, { reduceOnly: true }).notice, 'FILLED');
  assert.equal(guard.read().session.fundingTotal, -250);
  const admissionFile = join(dir, 'admission.json');
  const admission = JSON.parse(readFileSync(admissionFile));
  admission.markets.find((m) => m.marketType === 'perpetual').coverage = 'depth';
  writeFileSync(admissionFile, JSON.stringify(admission));
  const observation = snap(300);
  const depthOnly = { ...observation, coverage: 'depth', bookAt: time, rightsDigest, upstreamSha256: sha('raw depth') };
  for (const key of ['ticker', 'candles', 'tape', 'funding']) delete depthOnly[key];
  const head = publish(depthOnly);
  assert.throws(() => publish({ ...depthOnly, tape: [] }), /FEED_COVERAGE/);
  assert.throws(() => publish({ ...depthOnly, bookAt: time - 1 }), /FEED_PROVENANCE/);
  assert.throws(() => publish({ ...depthOnly, upstreamSha256: '' }), /FEED_PROVENANCE/);
  assert.throws(() => publish({ ...depthOnly, rightsDigest: sha('other grant') }), /FEED_PROVENANCE/);
  assert.throws(() => query('read.ticker'), /FEED_TICKER_UNAVAILABLE/);
  assert.equal(query('read.depth').sequence, head.sequence);
  assert.equal(query('read.tape').total, null);
  assert.equal(query('desk.chart').quality, 'missing');

});

test('public reader binds its market and normalizes contract amount, aggressor, observation time and stale refusal', () => {
  execFileSync('python3', [fileURLToPath(new URL('./public-collector-oracle.py', import.meta.url))]);
});
