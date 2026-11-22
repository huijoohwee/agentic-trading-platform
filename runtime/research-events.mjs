import { DAY } from '../src/market.mjs';
import { asOf } from './research-data.mjs';
import { avg, deviation, quantile } from './research-signals.mjs';
const blank = () => ({
  curve: [],
  trades: [],
  signals: [],
  rebalances: [],
  costs: { fees: 0, funding: 0, spread: 0, slippage: 0, borrow: 0 }
});
const friction = (report, n, rate) => {
  const fee = Math.abs(n) * rate;
  report.costs.fees += fee;
  return fee;
};
function depthScenario(books, tape, latency, capital, range, cost) {
  const r = blank();
  let cash = capital,
    p = null,
    pending = null,
    left = 0,
    right = 0,
    buy = 0,
    sell = 0;
  for (const b of books) {
    const t = b.time;
    while (right < tape.length && tape[right].time <= t) {
      const f = tape[right++];
      if (f.aggressor === 'buyer') buy += f.qty;
      else sell += f.qty;
    }
    while (left < right && tape[left].time < t - 1000) {
      const f = tape[left++];
      if (f.aggressor === 'buyer') buy -= f.qty;
      else sell -= f.qty;
    }
    if (t < range.start || t >= range.end) continue;
    const bid = b.bids[0][0],
      ask = b.asks[0][0],
      tick = b.tickSize;
    let turnover = 0;
    if (pending !== null && t >= pending + latency && !p) {
      const qty = Math.min(
        (cash * cost.risk) / tick,
        (cash * cost.maxGross) / (ask * (1 + cost.fees * cost.maxGross)),
        b.asks[0][1]
      );
      if (qty > 0) {
        const fee = friction(r, ask * qty, cost.fees);
        cash -= fee;
        p = { at: t, price: ask, qty, fee };
        turnover += qty * ask;
        r.signals.push({ time: t, price: ask, action: 'buy', label: 'entry' });
      }
      pending = null;
    }
    if (p && t > p.at && (bid >= p.price + 2 * tick || bid <= p.price - tick || t - p.at >= 15000)) {
      const fee = friction(r, bid * p.qty, cost.fees),
        pnl = (bid - p.price) * p.qty - fee - p.fee;
      cash += (bid - p.price) * p.qty - fee;
      turnover += bid * p.qty;
      r.trades.push({ entry: p.at, exit: t, open: p.price, price: bid, qty: p.qty, pnl });
      r.signals.push({ time: t, price: bid, action: 'sell', label: 'exit' });
      p = null;
    }
    const bidQty = b.bids.slice(0, 10).reduce((s, l) => s + l[1], 0),
      askQty = b.asks.slice(0, 10).reduce((s, l) => s + l[1], 0);
    const micro = (ask * b.bids[0][1] + bid * b.asks[0][1]) / (b.bids[0][1] + b.asks[0][1]);
    if (
      !p &&
      pending === null &&
      Math.abs(ask - bid - tick) < tick * 1e-6 &&
      bidQty / (bidQty + askQty) >= 0.65 &&
      buy / (buy + sell) >= 0.65 &&
      micro > (ask + bid) / 2
    )
      pending = t;
    r.curve.push({
      time: t,
      equity: cash + (p ? (bid - p.price) * p.qty : 0),
      turnover,
      exposure: p ? (p.qty * bid) / cash : 0
    });
  }
  return r;
}
export function depthReplay(aux, capital, range, cost) {
  // A sparse sequence cannot resolve the latency scenarios even when each snapshot has ten levels.
  const simultaneous = aux.depth.some(
    (b, i) =>
      i &&
      b.time >= range.start &&
      b.time < range.end &&
      b.time - aux.depth[i - 1].time < 1000 &&
      asOf(aux.trades, b.time, 1000)
  );
  if (!simultaneous) return { unavailable: 'Overlapping subsecond book updates and aggressor trades required' };
  const [primary, ...rest] = [50, 100, 250, 500].map((latency) => ({
    latency,
    ...depthScenario(aux.depth, aux.trades, latency, capital, range, cost)
  }));
  return {
    ...primary,
    latencyScenarios: [primary, ...rest].map((r) => ({
      latency: r.latency,
      trades: r.trades,
      finalEquity: r.curve.at(-1)?.equity ?? null
    }))
  };
}
export function liquidationPlans(markets, auxiliary, bars, frameMs, range = { start: -Infinity, end: Infinity }) {
  const names = Object.keys(markets),
    maps = Object.fromEntries(names.map((n) => [n, new Map(markets[n].map((b) => [b.time, b]))]));
  const history = Object.fromEntries(names.map((n) => [n, []])),
    held = new Map(),
    plans = [];
  for (const b of bars) {
    const t = b.time + frameMs,
      active = names.filter((n) => maps[n].has(b.time) && maps[n].has(b.time - frameMs));
    const changes = active.map((n) => maps[n].get(b.time).close / maps[n].get(b.time - frameMs).close - 1),
      market = avg(changes);
    let changed = false;
    const liquid = active
      .map((n) => ({ n, notional: maps[n].get(b.time).volume * maps[n].get(b.time).close }))
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 10)
      .map((v) => v.n);
    for (const [idx, n] of active.entries()) {
      const a = auxiliary[n],
        bar = maps[n].get(b.time),
        res = changes[idx] - market;
      const sd = deviation(history[n]),
        mu = avg(history[n]),
        z = (res - mu) / sd,
        old = held.get(n);
      if (old && (t - old.at >= 6 * frameMs || old.side * z >= 0)) {
        held.delete(n);
        changed = true;
      }
      if (!old && liquid.includes(n) && history[n].length >= 168 && Math.abs(z) > 3) {
        const oi = asOf(a.openInterest, t, frameMs),
          prior = asOf(a.openInterest, t - frameMs, frameMs);
        const season = Array.from({ length: 30 }, (_, j) => maps[n].get(b.time - (j + 1) * DAY)?.volume).filter(
          Number.isFinite
        );
        if (
          season.length >= 20 &&
          bar.volume > 3 * quantile(season, 0.5) &&
          oi &&
          prior &&
          oi.value <= 0.95 * prior.value &&
          t >= range.start &&
          t < range.end &&
          asOf(a.liquidations, t, frameMs)
        ) {
          held.set(n, { at: t, side: -Math.sign(z), risk: Math.min(0.2, 0.005 / Math.max(0.001, 3 * sd)) });
          changed = true;
        }
      }
      history[n].push(res);
      if (history[n].length > 24 * 30) history[n].shift();
    }
    plans.push(changed ? Object.fromEntries([...held].map(([n, p]) => [n, p.side * p.risk])) : null);
  }
  return plans;
}
function optionLegs(chain, time) {
  const expiries = [
    ...new Set(
      chain.filter((q) => q.expiry >= time + 30 * DAY && q.expiry <= time + 45 * DAY).map((q) => q.expiry)
    )
  ].sort((a, b) => a - b);
  for (const expiry of expiries) {
    const legs = [];
    for (const [kind, target, side] of [
      ['put', -0.25, -1],
      ['call', 0.25, -1],
      ['put', -0.1, 1],
      ['call', 0.1, 1]
    ]) {
      const q = chain
        .filter((q) => q.kind === kind && q.expiry === expiry && !legs.some((l) => l.id === q.id))
        .sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target))[0];
      if (!q || Math.abs(q.delta - target) > 0.075) break;
      legs.push({ ...q, side });
    }
    if (legs.length === 4 && legs[2].strike < legs[0].strike && legs[3].strike > legs[1].strike) return legs;
  }
  return null;
}
export function optionsReplay(bars, chains, capital, range, cost) {
  const r = blank(),
    vols = [],
    returns = [];
  let cash = capital,
    p = null,
    hedge = 0,
    lastSpot = null,
    priorClose,
    prevPlan,
    lastVolTime;
  let eligible = false;
  for (const b of bars) {
    const t = b.time,
      quotes = asOf(chains, t, DAY),
      chain = quotes && t - quotes.time < DAY ? quotes.quotes.filter((q) => q.bid > 0) : [],
      lookup = new Map(chain.map((q) => [q.id, q]));
    let turnover = 0;
    if (lastSpot !== null) cash += hedge * (b.open - lastSpot);
    lastSpot = b.open;
    if (t >= range.start && t < range.end) {
      if (prevPlan && !p && !prevPlan.legs.every((l) => lookup.has(l.id))) {
        r.incomplete = 'missing executable dated quote at planned entry';
        break;
      }
      if (prevPlan && !p) {
        const legs = prevPlan.legs.map((l) => ({ ...lookup.get(l.id), side: l.side })),
          credit = -legs.reduce((s, l) => s + l.side * (l.side < 0 ? l.bid : l.ask), 0);
        const width = Math.max(legs[0].strike - legs[2].strike, legs[3].strike - legs[1].strike),
          risk = width - credit;
        if (credit > 0 && risk > 0) {
          const qty = Math.min((0.005 * cash) / risk, (2 * cash) / (4 * b.open));
          p = {
            legs: legs.map(({ id, side }) => ({ id, side })),
            expiry: legs[0].expiry,
            qty,
            credit,
            open: cash,
            at: t
          };
          cash += credit * qty;
          for (const l of legs) {
            const value = qty * (l.side < 0 ? l.bid : l.ask);
            cash -= friction(r, value, cost.fees);
            turnover += value;
          }
          r.signals.push({ time: t, action: 'short', price: b.open, label: 'premium entry' });
        }
      }
      let liability = 0;
      if (p) {
        if (!p.legs.every((l) => lookup.has(l.id))) {
          r.incomplete = 'missing dated quote for an open option leg';
          break;
        }
        const legs = p.legs.map((l) => ({ ...lookup.get(l.id), side: l.side }));
        liability = -legs.reduce((s, l) => s + l.side * (l.side < 0 ? l.ask : l.bid), 0);
        const exit = liability <= 0.5 * p.credit || liability >= 2 * p.credit || p.expiry - t <= 7 * DAY;
        const next = exit ? 0 : -p.qty * legs.reduce((s, l) => s + l.side * l.delta, 0);
        if (next !== hedge) {
          const notional = Math.abs(next - hedge) * b.open;
          cash -= friction(r, notional, cost.fees);
          turnover += notional;
          const slip = notional * cost.slippage;
          cash -= slip;
          r.costs.slippage += slip;
          r.rebalances.push({ time: t, hedge: next, price: b.open });
          hedge = next;
        }
        if (exit) {
          cash -= p.qty * liability;
          for (const l of legs) {
            const value = p.qty * (l.side < 0 ? l.ask : l.bid);
            cash -= friction(r, value, cost.fees);
            turnover += value;
          }
          r.trades.push({ entry: p.at, exit: t, qty: p.qty, pnl: cash - p.open });
          r.signals.push({ time: t, action: 'cover', price: b.open, label: 'premium exit' });
          p = null;
        }
      }
      r.curve.push({
        time: t,
        equity: cash - (p ? p.qty * liability : 0),
        exposure: p ? (Math.abs(hedge) * b.open) / cash : 0,
        turnover
      });
    }
    prevPlan = null;
    const legs = optionLegs(chain, t),
      iv = legs ? avg(legs.slice(0, 2).map((l) => l.iv)) : NaN;
    if (priorClose) returns.push(Math.log(b.close / priorClose));
    priorClose = b.close;
    const dated = legs && t - quotes.time < DAY;
    const ready = dated && lastVolTime === t - DAY && vols.length >= 365 && returns.length >= 21;
    if (ready && t >= range.start && t < range.end) eligible = true;
    if (
      ready &&
      iv >= deviation(returns.slice(-21)) * Math.sqrt(365) + 0.12 &&
      iv > quantile(vols.slice(-365), 0.7)
    )
      prevPlan = { legs };
    if (dated && Number.isFinite(iv)) {
      if (lastVolTime !== t - DAY) vols.length = 0;
      vols.push(iv);
      lastVolTime = t;
    }
  }
  if (!eligible)
    return { unavailable: 'Four executable option legs and a year of daily dated IV observations required' };
  return r;
}
