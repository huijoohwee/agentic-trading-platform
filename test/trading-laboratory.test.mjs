import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../runtime/store.mjs';
import { createPaperGuard } from '../runtime/paper-guard.mjs';
import { initialPractice } from '../src/practice-defaults.mjs';
import { mark, history, DAY, bucket } from '../src/market.mjs';
import { portfolio } from '../src/practice-account.mjs';
import { experiment } from '../src/experiment.mjs';
import { deskActions, landingActions, registerActions, validate } from '../src/desk-actions.mjs';
import { observerLink, observerRead, recordActivity, activityScope } from '../runtime/observer.mjs';
import { researchService } from '../runtime/research-service.mjs';
import { runArtifact, readArtifact } from '../runtime/research-artifact.mjs';
import { executeDirectional } from '../runtime/research-engine.mjs';
import { aggregate } from '../runtime/research-signals.mjs';
import { asOf } from '../runtime/research-data.mjs';
import { sha } from '../runtime/core.mjs';
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'desk/' + '1'.repeat(64) };
const at = Date.UTC(2025, 0, 1),
  symbol = 'ALD.USD';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trading-lab-')),
    path = join(directory, 'desk.sqlite');
  let store = openStore(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = openStore(path);
    }
  };
}
test('migrates a populated v1 session, opens, adds, reduces, reverses, settles and flattens with durable receipts', (t) => {
  const f = fixture(t);
  let time = at;
  const saved = initialPractice();
  for (const k of ['contracts', 'funding', 'fundingTotal', 'marketType', 'venue']) delete saved[k];
  Object.assign(saved, {
    schema: 'practice-session/v1',
    cash: 90000,
    positions: { [symbol]: { qty: 5, avg_cost: 31 } },
    orders: [{ id: 'old-limit', symbol, side: 'BUY', type: 'LIMIT', trigger: 1, qty: 2, reserve: 2.002 }],
    fills: [{ id: 'old-fill', symbol, qty: 5, side: 'BUY', at, price: 31 }]
  });
  f.store.transaction(scope, (s) => {
    s.configs.practice = saved;
  });
  const guard = () => createPaperGuard({ mode: 'synthetic-replay', scope, store: f.store, now: () => time });
  const cmd = (kind, args) => guard().apply({ kind, ...args }, guard().read().revision, randomUUID());
  const order = (side, qty, more = {}) =>
    cmd('order', {
      symbol,
      marketType: 'perpetual',
      explicitIntent: true,
      side,
      qty,
      type: 'MARKET',
      leverage: 2,
      ...more
    });
  const initial = guard().read();
  for (const k of ['cash', 'positions', 'orders', 'fills']) assert.deepEqual(initial.session[k], saved[k]);
  cmd('select', { symbol, marketType: 'perpetual' });
  const first = order('BUY', 10);
  time += 60000;
  const added = order('BUY', 5),
    price = mark(symbol, time);
  assert.ok(
    Math.abs(
      added.session.contracts[symbol].average - (first.session.contracts[symbol].average * 10 + price * 5) / 15
    ) < 1e-8
  );
  const rev = guard().read().revision;
  assert.throws(() => order('SELL', 16, { reduceOnly: true }), /REDUCE_ONLY/);
  assert.throws(() => order('BUY', 10000), /LEVERAGE_LIMIT/);
  assert.throws(
    () => cmd('order', { symbol, side: 'BUY', type: 'MARKET', qty: 1, explicitIntent: false }),
    /EXPLICIT_INTENT_REQUIRED/
  );
  assert.equal(guard().read().revision, rev);
  assert.equal(order('SELL', 6, { reduceOnly: true }).session.contracts[symbol].quantity, 9);
  assert.equal(order('SELL', 12).session.contracts[symbol].quantity, -3);
  time = at + 8 * 3600000;
  const funded = guard().read().session;
  assert.equal(funded.funding.length, 1);
  assert.ok(funded.funding[0].payment > 0);
  const total = portfolio(funded, time);
  assert.equal(total.equity, Math.round((funded.cash + total.assets + total.holdings.at(-1).open) * 1e6) / 1e6);
  const key = randomUUID(),
    prior = guard().read().revision,
    close = {
      kind: 'order',
      symbol,
      marketType: 'perpetual',
      qty: 3,
      side: 'BUY',
      type: 'MARKET',
      leverage: 2,
      reduceOnly: true,
      explicitIntent: true
    };
  const done = guard().apply(close, prior, key);
  f.restart();
  assert.deepEqual(guard().apply(close, prior, key), done);
  assert.throws(() => guard().apply({ ...close, qty: 4 }, prior, key), /CONFLICT/);
  assert.deepEqual(done.session.contracts, {});
  assert.equal(done.session.funding.length, 1);
  assert.throws(() => cmd('reset', { confirm: 'reset', explicitIntent: true }), /CONFIRM_RESET/);
});
test('offline scientific imports, named Python functions and worker error bounds', () => {
  const bars = history(symbol, '1m', at, 25);
  const code = [
    'import numpy as np',
    'from statistics import median',
    'import math',
    'def spread(a):',
    '    return math.sqrt(np.mean(np.multiply(a, a)))',
    'def strategy(candles):',
    '    values = np.array([1, 2, 3])',
    '    print(median(values), spread(values))',
    '    return [{"time": candles[-1]["time"], "side": "buy"}]'
  ].join('\n');
  const r = experiment(code, bars);
  assert.equal(r.signals.length, 1);
  assert.match(r.stdout[0], /^2 2\.160/);
  assert.equal(
    experiment(code.replace('median(values), spread(values)', 'np.sum(2 * values + np.array([4,5,6]))'), bars)
      .stdout[0],
    '27'
  );
  assert.throws(() => experiment(code.replace('import math', 'import os'), bars), /Unavailable offline module/);
});
test('WebMCP route lifecycle, strict schemas, annotations and ordinary browser fallback', async () => {
  for (const [actions, count] of [
    [landingActions, 2],
    [deskActions, 23]
  ]) {
    const events = new EventTarget(),
      live = new Map(),
      host = {
        document: {
          modelContext: {
            registerTool(a, { signal }) {
              assert.ok(!live.has(a.name));
              live.set(a.name, a);
              signal.addEventListener('abort', () => live.delete(a.name));
            }
          }
        },
        navigator: {},
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events)
      };
    host.top = host;
    let called = 0;
    const detach = registerActions(actions, () => ++called, host);
    assert.equal(live.size, count);
    for (const a of live.values()) {
      assert.equal(a.annotations.untrustedContentHint, true);
      assert.equal((await a.execute({ surprise: true })).status, 'REFUSED');
    }
    assert.equal(called, 0);
    events.dispatchEvent(new Event('pagehide'));
    assert.equal(live.size, 0);
    events.dispatchEvent(new Event('pageshow'));
    assert.equal(live.size, count);
    detach();
    assert.equal(live.size, 0);
    host.document = {};
    const off = registerActions(actions, () => {}, host);
    off();
    assert.equal(live.size, 0);
  }
});
test('observer digest, newest-first cursor, expiry, redacted fields and context across restart', (t) => {
  const f = fixture(t);
  let time = at;
  const args = { scope, token: 'a'.repeat(64), now: () => time };
  const first = observerLink({ ...args, store: f.store }),
    token = first.path.split('#')[1];
  recordActivity(f.store, scope, {
    actor: 'agent',
    at: time,
    elapsed: 21,
    operation: 'research.save',
    status: 'OK',
    code: 'private-source',
    prompt: 'private-prompt'
  });
  assert.equal(observerLink({ ...args, store: f.store }).path, first.path);
  const read = () => observerRead(f.store, token, 0, time);
  const obs = read();
  assert.equal(obs.activity[0].seq, 1);
  assert.equal(obs.activity[0].actor, 'agent');
  assert.doesNotMatch(
    JSON.stringify(obs),
    /private-source|private-prompt|account_alias|profile|checkpoints|strategy\(candles\)/
  );
  f.store.transaction(scope, (s) => {
    s.configs.practice = { ...initialPractice(), frame: '10m', studies: ['ema20'] };
  });
  f.restart();
  assert.equal(read().context.frame, '10m');
  assert.deepEqual(observerRead(f.store, token, 1, time).activity, []);
  assert.ok(!readFileSync(join(f.directory, 'desk.sqlite')).includes(token));
  time = first.expires;
  assert.throws(read, /OBSERVER_DENIED/);
});
function syntheticPartition(directory) {
  const start = Date.UTC(2021, 0, 1),
    rows = Array.from({ length: 1000 }, (_, i) => {
      const center = 100 + i * 0.1 + 8 * Math.sin(i * 0.25);
      return {
        time: start + i * DAY,
        open: center,
        high: center + 4,
        low: center - 5,
        close: center + 1,
        volume: 20
      };
    });
  const body = JSON.stringify(rows),
    dir = join(directory, 'partitions');
  mkdirSync(dir);
  writeFileSync(join(dir, 'test.json'), body);
  const part = {
    file: 'test.json',
    sha256: sha(body),
    first: rows[0].time,
    last: rows.at(-1).time,
    source: 'independently generated test fixture',
    creator: 'test',
    license: 'CC0-1.0',
    venue: 'test',
    symbol: 'BTC.USDT',
    marketType: 'spot',
    kind: 'ohlcv',
    frame: '1d'
  };
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ schema: 'trading-partitions/v1', timeUnit: 'UTC_ms', partitions: [part] })
  );
  return rows;
}
test('scientific execution uses next open, capped risk, stop first and reproducible compressed results', (t) => {
  const f = fixture(t),
    bars = syntheticPartition(f.directory),
    range = { start: bars[0].time, end: bars.at(-1).time + DAY },
    flat = [
      { time: 0, open: 99, high: 100, low: 98, close: 99 },
      { time: DAY, open: 100, high: 110, low: 89, close: 103 }
    ];
  const manual = executeDirectional(
    flat,
    [{ entry: { side: 1, stop: 90, target: 105, ttl: 3 } }, { entry: null }],
    10000,
    { start: 0, end: 2 * DAY }
  );
  assert.equal(manual.trades[0].qty, 5);
  assert.equal(manual.trades[0].price, 90);
  assert.equal(manual.trades[0].open, 100);
  assert.equal(manual.trades[0].reason, 'stop');
  assert.equal(manual.trades[0].pnl, -50 - (500 + 450) * 0.0006);
  const dir = join(f.directory, 'artifacts'),
    data = {
      input: { venue: 'test', capital: 10000 },
      range,
      artifactDir: dir,
      directory: f.directory,
      id: randomUUID()
    };
  const cold = runArtifact(data),
    warm = runArtifact({ ...data, id: randomUUID() });
  assert.equal(cold.rows.length, 20);
  assert.equal(new Set(cold.rows.map((r) => r.id)).size, 20);
  assert.equal(cold.receipt.scientificHash, warm.receipt.scientificHash);
  assert.equal(warm.receipt.originalRun, data.id);
  assert.equal(warm.receipt.cached, true);
  const row = cold.rows[7];
  assert.notEqual(row.metrics, null);
  assert.equal(row.annual.length, 3);
  assert.equal(row.walkForward.length, 1);
  for (const id of [15, 17, 20]) {
    assert.equal(cold.rows[id - 1].status, 'blocked');
    assert.equal(cold.rows[id - 1].return, null);
  }
  assert.notEqual(
    runArtifact({ ...data, input: { ...data.input, capital: 11 } }).receipt.scientificHash,
    cold.receipt.scientificHash
  );
  writeFileSync(join(dir, cold.receipt.scientificHash + '.json.gz'), 'corrupt');
  assert.throws(() => runArtifact(data), /ARTIFACT_INTEGRITY/);
  assert.equal(
    asOf(
      [
        { time: 5, value: 1 },
        { time: 10, value: 2 }
      ],
      8,
      5
    ).value,
    1
  );
  const five = Array.from({ length: 36 }, (_, i) => ({
    time: at + i * 300000,
    open: i + 1,
    close: i + 2,
    high: i + 3,
    low: i,
    volume: i
  }));
  const ten = aggregate(five, '5m', '10m');
  assert.equal(ten.length, 18);
  assert.deepEqual(ten[5], { time: at + 3000000, open: 11, close: 13, high: 14, low: 10, volume: 21, count: 2 });
  const hours = aggregate(five, '5m', '1h');
  assert.equal(
    aggregate(hours, '1h', '3h')[0].volume,
    five.reduce((s, b) => s + b.volume, 0)
  );
});
test('rolling 30-run quota, idempotent cancellation and isolated paper revision', (t) => {
  const f = fixture(t);
  let time = at;
  const service = researchService({ store: f.store, now: () => time, directory: f.directory });
  try {
    const start = (id) => service.invoke(scope, 'research.suite', {}, id, initialPractice()),
      id = randomUUID(),
      first = start(id);
    assert.deepEqual(start(id), first);
    assert.equal(service.invoke(scope, 'research.cancel', { id: first.id }, randomUUID(), {}).status, 'cancelled');
    for (let i = 1; i < 30; i++) start(randomUUID());
    assert.throws(() => start(randomUUID()), /RESEARCH_QUOTA/);
    time += DAY;
    assert.equal(start(randomUUID()).status, 'queued');
    assert.equal(f.store.read(scope).revision, 0);
  } finally {
    service.close();
  }
});
test('research leases survive restart and isolate failed, partial, blocked and cancelled runs', async (t) => {
  const f = fixture(t);
  let time = at;
  const open = () => researchService({ store: f.store, directory: f.directory, now: () => time });
  let service = open();
  t.after(() => service.close());
  syntheticPartition(f.directory);
  const invoke = (op, inputs, id = randomUUID()) =>
    service.invoke(scope, 'research.' + op, inputs, id, initialPractice());
  const input = { venue: 'test', hypothesis: 8, start: '2021-01-01', end: '2023-02-28', capital: 10000 };
  async function until(id, states) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const run = invoke('get', { id });
      if (states.includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error('Research state deadline');
  }
  const pending = invoke('start', input);
  await until(pending.id, ['running']);
  service.close();
  // Model an abruptly terminated process with a durable unexpired worker lease.
  const job = { ...scope, account_alias: 'research/' + sha(scope.account_alias) };
  f.store.transaction(job, (s) =>
    Object.assign(s.configs.runs[pending.id], { status: 'running', lease: randomUUID(), leaseUntil: time + 100 })
  );
  f.restart();
  time += 101;
  service = open();
  const completed = await until(pending.id, ['partial']);
  assert.equal(completed.trace.at(-1).status, 'partial');
  assert.ok(completed.receipt.scientificHash);
  const cached = invoke('start', input);
  const retained = await until(cached.id, ['partial']);
  assert.equal(retained.receipt.cached, true);
  assert.equal(retained.receipt.originalRun, pending.id);
  assert.notEqual(retained.id, completed.id);
  const blocked = invoke('start', { ...input, hypothesis: 17 });
  assert.equal((await until(blocked.id, ['blocked'])).rows[0].return, null);
  const cancel = invoke('start', input);
  await until(cancel.id, ['running']);
  invoke('cancel', { id: cancel.id });
  assert.equal(invoke('get', { id: cancel.id }).status, 'cancelled');
  writeFileSync(join(f.directory, 'partitions', 'test.json'), 'corrupt');
  const damaged = invoke('start', input);
  assert.equal((await until(damaged.id, ['failed'])).error, 'ARCHIVE_DIGEST_MISMATCH');
  assert.equal(f.store.read(scope).revision, 0);
});
