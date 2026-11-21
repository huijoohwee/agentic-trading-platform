import { avg, deviation, quantile } from './research-signals.mjs';
import { asOf } from './research-data.mjs';
import { DAY } from '../src/market.mjs';
const covariance = (a, b) => {
  const x = avg(a),
    y = avg(b);
  return avg(a.map((n, i) => (n - x) * (b[i] - y)));
};
const returns = (prices) => prices.slice(1).map((v, i) => Math.log(v / prices[i]));
function hedge(x, y) {
  const beta = covariance(x, y) / covariance(x, x),
    intercept = avg(y) - beta * avg(x);
  return { beta, res: y.map((n, i) => n - intercept - beta * x[i]) };
}
const normalize = (weights, gross = 1) => {
  const sum = Object.values(weights).reduce((s, n) => s + Math.abs(n), 0);
  return Object.fromEntries(Object.entries(weights).map(([s, n]) => [s, sum ? (n / sum) * gross : 0]));
};
export function portfolioSignals(id, markets, bars, frameMs, aux) {
  const names = Object.keys(markets),
    base = names[0],
    byName = {};
  for (const n of names) byName[n] = new Map(markets[n].map((b) => [b.time, b]));
  const state = Object.fromEntries(names.map((n) => [n, []])),
    plans = [];
  let held = {},
    entered = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i],
      t = b.time + frameMs,
      day = Math.floor(t / DAY),
      prior = bars[i - 1],
      aligned = names.every((n) => byName[n].has(b.time));
    for (const n of names) state[n].push(byName[n].get(b.time)?.close ?? NaN);
    let weights = null;
    if (!aligned) {
      plans.push(null);
      continue;
    }
    if (id === 12) {
      const spot = state.spot.at(-1),
        rate = asOf(aux.funding, t, 8 * 3600000),
        liquid = asOf(aux.liquidity, t, frameMs),
        rates = (aux.funding ?? []).filter((r) => r.time <= t && r.time > t - 7 * DAY).map((r) => r.rate);
      if (
        rate &&
        liquid?.liquid === true &&
        b.close > spot &&
        rate.rate * 1095 > 0.2 &&
        (!held.spot || day !== Math.floor((prior.time + frameMs) / DAY))
      )
        weights = { spot: 1, [base]: -1 };
      if (held.spot && (b.close < spot || (rates.length >= 20 && quantile(rates, 0.5) * 1095 < 0.05))) weights = {};
    }
    if (id === 13 && i >= 360) {
      const btc = state.BTC.slice(-361, -1).map(Math.log),
        eth = state[base].slice(-361, -1).map(Math.log);
      const { beta, res } = hedge(btc, eth),
        lag = res.slice(0, -1),
        diff = res.slice(1).map((v, j) => v - lag[j]);
      const reg = hedge(lag, diff),
        lagMean = avg(lag),
        sum = lag.reduce((s, x) => s + (x - lagMean) ** 2, 0),
        se = Math.sqrt(reg.res.reduce((s, x) => s + x * x, 0) / (lag.length - 2) / sum),
        half = (-Math.log(2) / Math.log(1 + reg.beta)) * 4;
      const z = (Math.log(b.close) - avg(eth) - beta * (Math.log(state.BTC.at(-1)) - avg(btc))) / deviation(res);
      if (
        !Object.keys(held).length &&
        reg.beta / se < -3.34 &&
        half >= 6 &&
        half <= 120 &&
        Math.abs(z) > 2.25 &&
        Math.abs(z) < 3.5
      )
        weights = normalize({ [base]: -Math.sign(z), BTC: Math.sign(z) * beta });
      else if (Object.keys(held).length && (Math.abs(z) <= 0.5 || Math.abs(z) >= 3.5 || t - entered >= 10 * DAY))
        weights = {};
    }
    if (id === 14 && i >= 180 && new Date(t).getUTCDay() === 1) {
      const ranked = names
        .map((n) => {
          const prices = state[n],
            r = returns(prices.slice(-91, -1)),
            vols = markets[n]
              .filter((bar) => bar.time <= b.time && bar.time > b.time - 30 * DAY)
              .map((bar) => bar.volume * bar.close);
          const bench = returns(state[base].slice(-91, -1));
          return {
            n,
            liq: quantile(vols, 0.5),
            vol: deviation(r),
            beta: covariance(bench, r) / covariance(bench, bench),
            rank: Math.log(prices.at(-2) / prices.at(-91)) / deviation(r)
          };
        })
        .filter((e) => Number.isFinite(e.rank) && e.vol > 0)
        .sort((a, b) => b.liq - a.liq)
        .slice(0, 20)
        .sort((a, b) => b.rank - a.rank);
      if (ranked.length === 20) {
        const side = (rs, sign) => normalize(Object.fromEntries(rs.map((r) => [r.n, sign / r.vol])), 0.5);
        const longs = side(ranked.slice(0, 5), 1),
          shorts = side(ranked.slice(-5), -1);
        const beta = (w) => Object.entries(w).reduce((s, [n, v]) => s + v * ranked.find((r) => r.n === n).beta, 0);
        const adjustment = -beta(longs) / beta(shorts);
        if (adjustment > 0 && Number.isFinite(adjustment))
          weights = normalize({
            ...longs,
            ...Object.fromEntries(Object.entries(shorts).map(([n, v]) => [n, v * adjustment]))
          });
      }
    }
    if (id === 16 && i >= 8642) {
      const p = state[base],
        impulse = p.at(-1) / p.at(-4) - 1,
        old = p.slice(-75, -3),
        s = Math.sign(impulse),
        barrier = s > 0 ? Math.max(...old) : Math.min(...old);
      if (
        !Object.keys(held).length &&
        Math.abs(impulse) > 0.01 &&
        s * (b.close - barrier) > 0 &&
        s * (p.at(-2) - barrier) > 0
      ) {
        const r = returns(p.slice(-8642, -2));
        let best;
        for (const name of ['ETH', 'SOL']) {
          const q = state[name],
            beta = covariance(r, returns(q.slice(-8642, -2))) / covariance(r, r),
            lag = s * (beta * impulse - (q.at(-1) / q.at(-4) - 1));
          if (lag >= 0.0075 && (!best || lag > best.lag)) best = { name, lag };
        }
        if (best) weights = { [best.name]: s };
      } else if (Object.keys(held).length) {
        const n = Object.keys(held)[0],
          entry = asOf(markets[n], entered, frameMs),
          current = byName[n].get(b.time);
        if (
          entry &&
          (t - entered >= 45 * 60000 ||
            (held[n] * (current.close - entry.close)) / entry.close >= 0.0075 ||
            held[n] * (current.close - entry.close) <
              -avg(markets[n].slice(Math.max(0, i - 14), i).map((v) => v.high - v.low)))
        )
          weights = {};
      }
    }
    if (id === 19 && i >= 200 && new Date(t).getUTCDate() === 1) {
      const ranked = names
        .map((n) => {
          const q = Array.from({ length: 201 }, (_, j) => byName[n].get(b.time - (200 - j) * DAY)?.close);
          if (!q.every(Number.isFinite)) return { n, rank: NaN };
          const vol = deviation(returns(q.slice(-91))) * Math.sqrt(365);
          return {
            n,
            vol,
            rank: (q.at(-1) / q.at(-91) - 1) / vol,
            trend: q.at(-1) > avg(q.slice(-200)) && avg(q.slice(-200)) > avg(q.slice(-201, -1))
          };
        })
        .filter((v) => Number.isFinite(v.rank))
        .sort((a, b) => b.rank - a.rank);
      const top = ranked[0];
      if (ranked.length === names.length) weights = top.trend ? { [top.n]: Math.min(1, 0.15 / top.vol) } : {};
    }
    if (weights !== null) {
      if (Object.keys(weights).length && !Object.keys(held).length) entered = t;
      held = weights;
    }
    plans.push(weights);
  }
  return plans;
}
export function executePortfolio(bars, markets, plans, capital, range, cost, aux, frameMs) {
  const maps = Object.fromEntries(
    Object.entries(markets).map(([n, bs]) => [n, new Map(bs.map((b) => [b.time, b]))])
  );
  let cash = capital,
    qty = {},
    lastEquity = capital,
    prevTime;
  let missingMarks = 0;
  const curve = [],
    trades = [],
    signals = [],
    rebalances = [],
    costs = { fees: 0, funding: 0, spread: 0, slippage: 0, borrow: 0 };
  const clocks = Object.entries(aux.fundingByAsset ?? {}).map(([name, events]) => ({ name, events, index: 0 }));
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < range.start || b.time >= range.end) continue;
    const prices = Object.fromEntries(Object.keys(maps).map((n) => [n, maps[n].get(b.time)]));
    if (Object.values(prices).some((p) => !p)) {
      missingMarks++;
      continue;
    }
    const equityAt = (k) => cash + Object.entries(qty).reduce((s, [n, q]) => s + q * prices[n][k], 0);
    const weights = bars[i - 1].time + frameMs === b.time ? plans[i - 1] : null;
    let turnover = 0;
    for (const clock of clocks) {
      while (clock.index < clock.events.length && clock.events[clock.index].time <= b.time) {
        const f = clock.events[clock.index++];
        if (prevTime !== undefined && f.time > prevTime && qty[clock.name]) {
          const charge = qty[clock.name] * (f.price ?? prices[clock.name].open) * f.rate;
          cash -= charge;
          costs.funding += charge;
        }
      }
    }
    const openEquity = equityAt('open');
    if (weights !== null && weights !== undefined) {
      for (const n of Object.keys(prices)) {
        const price = prices[n].open,
          next = ((weights[n] ?? 0) * openEquity) / price,
          delta = next - (qty[n] ?? 0),
          value = Math.abs(delta * price);
        turnover += value;
        cash -= delta * price;
        qty[n] = next;
        for (const k of ['fees', 'spread', 'slippage']) {
          const charge = value * cost[k];
          cash -= charge;
          costs[k] += charge;
        }
        if (value > 1e-9)
          signals.push({ time: b.time, symbol: n, action: delta > 0 ? 'buy' : 'sell', price, label: 'rebalance' });
      }
      if (turnover > 0) {
        const equity = equityAt('open');
        if (rebalances.length) {
          trades.push({ entry: rebalances.at(-1).time, exit: b.time, pnl: equity - lastEquity });
          lastEquity = equity;
        }
        rebalances.push({ time: b.time, weights, turnover, equity });
      }
    }
    const equity = equityAt('close'),
      gross = Object.entries(qty).reduce((s, [n, q]) => s + Math.abs(q * prices[n].close), 0);
    curve.push({ time: b.time, equity, turnover, exposure: equity > 0 ? gross / equity : 0 });
    prevTime = b.time;
  }
  return {
    curve,
    trades,
    signals,
    rebalances,
    costs,
    ...(missingMarks ? { incomplete: missingMarks + ' intervals lacked simultaneous market marks' } : {})
  };
}
