import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalog, frames, history, bucket, mark, quote, microstructure, searchCatalog, DAY } from '../src/market.mjs';
import { studies, calculateStudies } from '../src/indicators.mjs';
import { experiment, example } from '../src/experiment.mjs';
import { createPaperGuard } from '../runtime/paper-guard.mjs';
import { openStore } from '../runtime/store.mjs';
import { assessPrediction } from '../src/predictions.mjs';
import { portfolio, journalCsv, estimate } from '../src/practice-account.mjs';

const at = Date.UTC(2026, 10, 19, 15, 10, 22),
  symbol = catalog[0].symbol;
test('eleven UTC frames aggregate one price path, including forming monthly and custom candles', () => {
  for (const frame of Object.keys(frames)) {
    const bars = history(symbol, frame, at, 6);
    assert.equal(bars.at(-1).close, mark(symbol, at));
    assert.equal(bars.at(-1).time, bucket(at, frame));
    for (const [i, b] of bars.entries()) {
      assert.ok(b.high >= Math.max(b.close, b.open) && b.low <= Math.min(b.close, b.open));
      if (i) assert.equal(b.open, bars[i - 1].close);
    }
  }
  assert.equal(bucket(Date.UTC(2024, 1, 29), '1M', 1), Date.UTC(2024, 2, 1));
  const end = bucket(at, '3h') - 1,
    b = history(symbol, '3h', end, 1)[0],
    mins = history(symbol, '1m', end, 180);
  assert.equal(Math.max(...mins.map((v) => v.high)), b.high);
  assert.equal(Math.min(...mins.map((v) => v.low)), b.low);
  assert.ok(Math.abs(b.volume - mins.reduce((s, v) => s + v.volume, 0)) < 0.01);
  assert.equal(searchCatalog('ald')[0].symbol, symbol);
  assert.equal(searchCatalog('unlisted').length, 0);
  const q = quote(symbol, at),
    m = microstructure(symbol, at);
  assert.equal(q.last, barsLast());
  assert.ok(q.high >= q.last && q.volume > 0);
  assert.equal(m.bids.length, 20);
  assert.equal(m.asks.length, 20);
  assert.ok(m.spread > 0 && m.bidFraction > 0 && m.bidFraction < 1);
  assert.ok(m.bids.every((v, i) => !i || (v.price < m.bids[i - 1].price && v.cumulative > m.bids[i - 1].cumulative)));
  assert.ok(m.tape.every((t) => t.time <= at && ['buyer', 'seller'].includes(t.aggressor)));
  function barsLast() {
    return history(symbol, '1m', at, 1)[0].close;
  }
});
test('indicator warm-ups, displacements and analytically known values', () => {
  const bars = Array.from({ length: 256 }, (_, i) => ({
    time: at + i * 60000,
    open: i + 1,
    close: i + 1,
    high: i + 2,
    low: i,
    volume: 1
  }));
  const lines = calculateStudies(bars, Object.keys(studies));
  const series = (name) => lines.find((l) => l.name === name).values;
  assert.equal(series('EMA 20')[18], null);
  assert.equal(series('EMA 20')[19], 10.5);
  assert.equal(series('SMA 200')[199], 100.5);
  assert.equal(series('ATR')[13], 2);
  assert.equal(series('RSI')[14], 100);
  assert.equal(series('ADX')[27], 100);
  assert.equal(series('Span B')[76], null);
  assert.equal(series('Span B')[77], 26.5);
  assert.equal(series('VWAP')[1], 1.5);
  assert.equal(series('MACD').at(-1), 7);
  for (const { values } of lines) assert.ok(values.every((v) => v === null || Number.isFinite(v)));
});
test('worker language supports long/short round trips, Python helpers and bounded output with no order transport', () => {
  const bars = history(symbol, '5m', at, 100);
  const result = experiment(example, bars);
  assert.equal(result.authority, false);
  const code = `def strategy(candles):
    out = []
    actions = ["short", "cover", "buy", "sell"]
    for i in range(len(actions)):
        out.append({"time": candles[i]["time"], "side": actions[i], "price": 10 + i})
        print(i)
    return out`;
  const report = experiment(code, bars);
  assert.equal(report.report.count, 2);
  assert.equal(report.report.wins, 1);
  assert.equal(report.report.net, 0);
  assert.equal(report.stdout.length, 4);
  for (const bad of [
    'import sys',
    'return [{"side":"buy","time":0}]',
    'return range(99999999)',
    'return fetch("test")'
  ]) {
    assert.throws(() => experiment('def strategy(candles):\n    ' + bad, bars));
  }
});
test('practice sessions use a single transaction for triggers, costs, revisions, resets and research records', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'market-desk-'));
  const file = join(directory, 'ledger.sqlite');
  let time = at,
    db = openStore(file),
    seq = 0;
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'desk/' + 'a'.repeat(64) };
  const bind = () => createPaperGuard({ scope, store: db, mode: 'synthetic-replay', now: () => time });
  let guard = bind();
  const apply = (cmd) => guard.apply(cmd, guard.read().revision, 'command-number-' + ++seq);
  const order = (side, type, qty, trigger) => apply({ kind: 'order', symbol, side, type, qty, trigger });
  assert.equal(guard.read().session.cash, 100000);
  assert.throws(() => createPaperGuard({ scope, store: db, mode: 'synthetic-replay', broker: {} }), /REPLAY_ISOLATION/);
  assert.throws(
    () =>
      createPaperGuard({ scope: { ...scope, account_alias: 'signed-account' }, store: db, mode: 'synthetic-replay' }),
    /ACCOUNT_BINDING/
  );
  assert.throws(() => order('SELL', 'MARKET', 1), /CLOSE_EXCEEDS_HELD/);
  const first = order('BUY', 'MARKET', 3),
    p = mark(symbol, time),
    cost = estimate(3, p);
  assert.equal(first.session.cash, Math.round((100000 - cost.notional - cost.fee) * 1e6) / 1e6);
  assert.equal(first.session.positions[symbol].avg_cost, p);
  assert.throws(() => guard.apply({ kind: 'reset', confirm: true }, 0, 'different-request'), /CONFLICT/);
  const prediction = apply({
    kind: 'prediction',
    symbol,
    direction: 'up',
    confidence: 60,
    horizon: '5m',
    note: 'manual observation'
  }).session.predictions[0];
  assert.equal(prediction.entry, p);
  assert.equal(assessPrediction(prediction, time).state, 'Tracking');
  assert.equal(assessPrediction(prediction, time + DAY).price, mark(symbol, time + 300000));
  const last = mark(symbol, time),
    limit = order('BUY', 'LIMIT', 2, last * 0.8);
  assert.equal(limit.notice, 'WORKING');
  assert.ok(portfolio(limit.session, time).available < limit.session.cash);
  apply({ kind: 'cancel', id: limit.session.orders[0].id });
  const future = Array.from({ length: 120 }, (_, i) => time + (i + 1) * 60000).find(
    (t) => mark(symbol, t) > last + 0.001
  );
  assert.ok(future);
  const trigger = (mark(symbol, future) + last) / 2;
  const stop = order('BUY', 'STOP', 1, trigger);
  assert.equal(stop.notice, 'WORKING');
  time = future;
  const filled = apply({ kind: 'tick', symbol });
  assert.equal(filled.session.orders.length, 0);
  assert.equal(filled.session.fills.length, 2);
  assert.equal(apply({ kind: 'tick', symbol }).session.fills.length, 2);
  assert.equal(order('SELL', 'MARKET', 1).session.closes, 1);
  assert.match(journalCsv(guard.read().session.fills), /synthetic-market\/v1/);
  // Cross the retention boundary without 1,000 redundant disk commits.
  db.transaction(scope, (state) => {
    const active = state.configs.practice;
    const original = active.fills[0];
    active.fills = Array.from({ length: 1000 }, (_, i) => ({ ...original, id: 'retained-' + i }));
    active.samples = Array.from({ length: 1000 }, (_, i) => ({ at: at + i, equity: 100000 }));
  });
  const capped = order('BUY', 'MARKET', 1).session;
  assert.equal(capped.fills.length, 1000);
  assert.equal(capped.fills[0].id, 'retained-1');
  assert.equal(capped.samples.length, 1000);
  assert.equal(capped.samples[0].at, at + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 480000);
  const before = guard.read();
  db.close();
  db = openStore(file);
  guard = bind();
  assert.deepEqual(guard.read(), before);
  const cmd = { kind: 'funds', amount: 12 };
  const readback = guard.apply(cmd, before.revision, 'same-command-id');
  assert.deepEqual(guard.apply(cmd, before.revision, 'same-command-id'), readback);
  for (const a of catalog) apply({ kind: 'select', symbol: a.symbol });
  const redelivered = guard.apply(cmd, before.revision, 'same-command-id');
  assert.equal(redelivered.receiptRevision, readback.revision);
  assert.equal(redelivered.session.cash, readback.session.cash);
  assert.throws(() => guard.apply(cmd, guard.read().revision, 'same-command-id'), /CONFLICT/);
  assert.equal(guard.read().session.watch.length, 20);
  assert.equal(guard.read().session.watch[0], catalog.at(-1).symbol);
  assert.throws(
    () =>
      apply({
        kind: 'prediction',
        symbol: catalog.at(-1).symbol,
        direction: 'up',
        horizon: '1d',
        confidence: 100,
        note: 'x'.repeat(241)
      }),
    /INVALID_PREDICTION/
  );
  assert.throws(() => apply({ kind: 'reset', confirm: false }), /CONFIRM_RESET/);
  assert.equal(apply({ kind: 'reset', confirm: true }).session.cash, 100000);
});
