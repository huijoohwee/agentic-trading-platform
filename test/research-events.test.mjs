import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY } from '../src/market.mjs';
import { depthReplay, optionsReplay, liquidationPlans } from '../runtime/research-events.mjs';
import { portfolioSignals, executePortfolio } from '../runtime/research-portfolio.mjs';

const cost = { fees: 0.0004, slippage: 0.0001, spread: 0.0001, risk: 0.005, maxGross: 2 };
test('tick-level book and aggressor fixtures admit at each latency and exit on the next executable quote', () => {
  const time = 1700000000000;
  const levels = (t, bid) => ({
    time: time + t,
    tickSize: 1,
    bids: Array.from({ length: 10 }, (_, i) => [bid - i, 4]),
    asks: Array.from({ length: 10 }, (_, i) => [bid + i + 1, 1])
  });
  const books = [0, 50, 100, 250, 500, 600].map((t) => levels(t, t === 600 ? 103 : 100));
  const result = depthReplay(
    { depth: books, trades: [{ time, qty: 4, aggressor: 'buyer' }] },
    1000,
    { start: time, end: time + 1000 },
    cost
  );
  for (const trial of result.latencyScenarios) {
    const first = trial.trades[0];
    assert.equal(first.entry, time + trial.latency);
    assert.ok(first.exit > first.entry);
    assert.equal(first.open, 101);
  }
  assert.equal(result.latencyScenarios.at(-1).trades[0].price, 103);
  const none = depthReplay(
    { depth: books, trades: [{ time, qty: 4, aggressor: 'seller' }] },
    1000,
    { start: time, end: time + 1000 },
    cost
  );
  assert.equal(none.trades.length, 0);
  const sparse = depthReplay(
    { depth: [levels(0, 100), levels(2000, 100)], trades: [{ time, qty: 4, aggressor: 'buyer' }] },
    1000,
    { start: time, end: time + 3000 },
    cost
  );
  assert.match(sparse.unavailable, /subsecond/);
});
test('carry sizes its liquidity screen from both legs at the signal close', () => {
  const hour = 3600000, t = Date.UTC(2025, 4, 12);
  const candle = (close) => ({ time: t, close });
  const markets = { BTC: [candle(102)], spot: [candle(100)] };
  const decision = (spotTurnover, perpetualTurnover, at, capital) => {
    const carry = { start: t, end: t + hour, capital, observations: 0, turnoverObservations: 0 };
    const aux = { funding: [{ time: t, rate: 0.001, settlementHours: 8 }],
      liquidity: [{ time: at, spotTurnover, perpetualTurnover }] };
    const [plan] = portfolioSignals(12, markets, markets.BTC, hour, aux, carry);
    return [plan, carry.observations];
  };
  assert.deepEqual(decision(100000, 100000, t + hour, 1000), [{ spot: 1, BTC: -1 }, 1]);
  assert.deepEqual(decision(100000, 99999, t + hour, 1000), [null, 1]);
  assert.deepEqual(decision(99999, 100000, t + hour, 1000), [null, 1]);
  assert.deepEqual(decision(100000, 100000, t + hour, 1001), [null, 1]);
  assert.deepEqual(decision(100000, 100000, t, 1000), [null, 0]);
  assert.deepEqual(decision(100000, 100000, t + hour + 1, 1000), [null, 0]);
});
test('carry hedges equal notionals, credits shorts at observed funding, and flattens negative basis at next open', () => {
  const step = 3600000,
    start = Date.UTC(2022, 0, 1),
    px = (v, i) => ({ time: start + i * step, open: v, high: v + 1, low: v - 1, close: v, volume: 8 });
  const markets = { BTC: [101, 101, 102, 99, 98, 98].map(px), spot: [100, 100, 100, 100, 100, 100].map(px) };
  const funding = [
    { time: start, rate: 0.001, settlementHours: 8 },
    { time: start + 3 * step, rate: 0.002, price: 102, settlementHours: 8 }
  ];
  const aux = {
    funding,
    liquidity: markets.BTC.map((b) => ({ time: b.time, liquid: true })),
    fundingByAsset: { BTC: funding }
  };
  const plans = portfolioSignals(12, markets, markets.BTC, step, aux);
  const withInterval = (settlementHours) => portfolioSignals(12, markets, markets.BTC, step,
    { ...aux, funding: [{ time: start, rate: 0.0001, settlementHours }] });
  assert.deepEqual(withInterval(1)[0], { spot: 1, BTC: -1 });
  assert.equal(withInterval(8)[0], null);
  assert.equal(withInterval(undefined)[0], null);
  assert.deepEqual(plans[0], { spot: 1, BTC: -1 });
  assert.deepEqual(plans[3], {});
  const result = executePortfolio(
    markets.BTC,
    markets,
    plans,
    10000,
    { start, end: start + 6 * step },
    cost,
    aux,
    step
  );
  assert.equal(result.rebalances.length, 2);
  assert.equal(result.rebalances[0].time, start + step);
  const qty = 10000 / 101,
    turnover = 20000 + qty * 98 + 10000,
    credit = qty * 0.002 * 102;
  const expected = 10000 + qty * 3 + credit - turnover * 0.0006;
  assert.ok(Math.abs(result.curve.at(-1).equity - expected) < 1e-8);
  assert.ok(Math.abs(result.costs.funding + credit) < 1e-9);
});
test('dated four-leg chain uses independent bid/ask credit, wing risk, daily hedge and half-credit close', () => {
  const start = Date.UTC(2021, 0, 1),
    bars = [],
    chains = [];
  for (let i = 0; i < 369; i++) {
    const time = start + i * DAY,
      exp = start + (Math.floor(i / 32) * 32 + 75) * DAY;
    const legs = (expiry, prefix, iv) =>
      [
        ['put', 90, -0.25],
        ['call', 110, 0.25],
        ['put', 80, -0.1],
        ['call', 120, 0.1]
      ].map(([kind, strike, delta], j) => ({
        id: prefix + '-' + j,
        kind,
        strike,
        expiry,
        iv,
        delta: delta + (i === 367 && j === 0 ? 0.02 : 0),
        bid: j < 2 ? (i >= 368 ? 1 : 4) : 0.8,
        ask: j < 2 ? (i >= 368 ? 1.2 : 4.1) : 1
      }));
    // Each signal day sees a fresh expiry and the prior dates' still-tradable legs.
    const quotes = [];
    for (let k = Math.max(0, i - 10); k <= i; k++)
      quotes.push(...legs(start + (k + 30) * DAY, String(k), k >= 365 ? 0.8 : 0.3));
    bars.push({ time, open: 100, high: 101, low: 99, close: 100, volume: 1 });
    chains.push({ time, quotes });
  }
  const r = optionsReplay(bars, chains, 10000, { start, end: start + 369 * DAY }, cost);
  const sparse = optionsReplay(
    bars,
    chains.filter((_, i) => i !== 35),
    10000,
    { start, end: start + 369 * DAY },
    cost
  );
  assert.match(sparse.unavailable, /year of daily/);
  const noBids = structuredClone(chains);
  for (const quote of noBids[366].quotes) quote.bid = 0;
  const noEntry = optionsReplay(bars, noBids, 10000, { start, end: start + 369 * DAY }, cost);
  assert.match(noEntry.incomplete, /executable dated quote/);
  assert.equal(noEntry.trades.length, 0);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entry, start + 366 * DAY);
  assert.equal(r.trades[0].exit, start + 368 * DAY);
  assert.ok(r.trades[0].pnl > 0);
  assert.ok(r.rebalances.some((v) => v.hedge !== 0));
  assert.equal(r.rebalances.at(-1).hedge, 0);
});
test('liquidation reversal requires contemporaneous liquidation, seasonal volume and open-interest decline', () => {
  const start = Date.UTC(2021, 0, 1),
    step = 3600000,
    markets = {},
    cross = {},
    shock = 24 * 30 + 2;
  for (let j = 0; j < 10; j++) {
    const name = 'A' + j;
    markets[name] = Array.from({ length: shock + 9 }, (_, i) => {
      const p = 100 + (i % 13) * 0.001 * j + (i === shock && j === 0 ? -20 : 0);
      return {
        time: start + i * step,
        open: p,
        high: p + 1,
        low: p - 1,
        close: p,
        volume: i === shock && j === 0 ? 50 : 10
      };
    });
    cross[name] = {
      liquidations: j === 0 ? [{ time: start + (shock + 1) * step, notional: 1000 }] : [],
      openInterest: markets[name].map((b, i) => ({ time: b.time + step, value: i === shock ? 90 : 100 }))
    };
  }
  const plans = liquidationPlans(markets, cross, markets.A0, step);
  assert.ok(plans[shock]?.A0 > 0);
  assert.deepEqual(plans[shock + 1], {});
  cross.A0.liquidations = [];
  assert.equal(liquidationPlans(markets, cross, markets.A0, step)[shock], null);
});
