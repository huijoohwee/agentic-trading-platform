import { calculateStudies, smooth, sma } from '../src/indicators.mjs';
import { bucket, frames, DAY } from '../src/market.mjs';
import { asOf } from './research-data.mjs';
export const quantile = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b),
    k = (s.length - 1) * p;
  return s[Math.floor(k)] + (s[Math.ceil(k)] - s[Math.floor(k)]) * (k % 1);
};
export const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
export const deviation = (xs) => {
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
};
export function aggregate(bars, sourceFrame, target) {
  const output = [];
  let group;
  for (const b of bars) {
    const time = bucket(b.time, target);
    if (group?.time !== time) {
      group = { time, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, count: 0 };
      output.push(group);
    }
    group.high = Math.max(group.high, b.high);
    group.low = Math.min(group.low, b.low);
    group.close = b.close;
    group.volume += b.volume;
    group.count++;
  }
  return output.filter((b) => b.count === (bucket(b.time, target, 1) - b.time) / (frames[sourceFrame] * 60000));
}
export function compatible(from, to) {
  if (!Object.hasOwn(frames, to)) return false;
  return (
    from === to ||
    (frames[from] > 0 && (to === '1M' ? 1440 % frames[from] === 0 : frames[to] % frames[from] === 0))
  );
}
// Prefer native observations at each UTC boundary, then fill only complete buckets from finer intervals.
export function composeBars(lanes, frame) {
  const choices = lanes
    .filter((lane) => compatible(lane.frame, frame))
    .sort((a, b) => (b.frame === frame) - (a.frame === frame) || frames[b.frame] - frames[a.frame]);
  if (!choices.length) return null;
  const byTime = new Map();
  for (const lane of choices) {
    const rows = lane.frame === frame ? lane.rows : aggregate(lane.rows, lane.frame, frame);
    for (const bar of rows) if (!byTime.has(bar.time)) byTime.set(bar.time, bar);
  }
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
  const gaps = rows.filter((b, i) => i && bucket(rows[i - 1].time, frame, 1) !== b.time).length;
  return { ...choices[0], frame, rows, gaps };
}
function indexed(bars, frame) {
  const close = bars.map((b) => b.close),
    keys = [20, 50, 100, 200],
    av = Object.fromEntries(keys.map((k) => [k, smooth(close, k)]));
  const lines = Object.fromEntries(calculateStudies(bars, ['atr', 'adx', 'rsi']).map((l) => [l.name, l.values]));
  return bars.map((b, i) => ({
    ...b,
    time: bucket(b.time, frame, 1),
    ema20: av[20][i],
    ema50: av[50][i],
    ema100: av[100][i],
    ema200: av[200][i],
    slope20: i && av[20][i - 1] !== null ? av[20][i] - av[20][i - 1] : null,
    slope100: i >= 20 && av[100][i - 20] !== null ? av[100][i] - av[100][i - 20] : null,
    atr: lines.ATR[i],
    adx: lines.ADX[i],
    rsi: lines.RSI[i]
  }));
}
export function directionalSignals(id, bars, frame, lanes) {
  const dt = frames[frame] * 60000,
    close = bars.map((b) => b.close),
    x = indexed(bars, frame),
    daily = indexed(aggregate(bars, frame, '1d'), '1d'),
    four = dt <= 14400000 ? indexed(aggregate(bars, frame, '4h'), '4h') : [],
    hours = dt <= 3600000 ? indexed(aggregate(bars, frame, '1h'), '1h') : [],
    ma200 = sma(close, 200),
    ma5 = sma(close, 5);
  const gain = close.map((c, i) => (i ? Math.max(0, c - close[i - 1]) : null)),
    loss = close.map((c, i) => (i ? Math.max(0, close[i - 1] - c) : null));
  const g = smooth(gain, 2, 0.5),
    l = smooth(loss, 2, 0.5),
    rsi2 = g.map((v, i) => (v === null || l[i] === null ? null : v + l[i] ? (100 * v) / (v + l[i]) : 50));
  const widths = [],
    squeeze = [],
    result = [];
  let utcDay,
    sv = 0,
    sv2 = 0,
    v = 0,
    priorZ = 0,
    orbDay,
    breakout = null,
    cumulative = 0;
  const flow = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i],
      a = x[i],
      p = bars[i - 1],
      prev = x[i - 1],
      t = b.time + dt,
      d = asOf(daily, t, DAY),
      h = asOf(hours, t, 3600000),
      f = asOf(four, t, 14400000);
    const window = (n, skip = 0) => bars.slice(Math.max(0, i - n + 1 - skip), i + 1 - skip);
    const extreme = (w, k, high) => (w.length ? (high ? Math.max : Math.min)(...w.map((b) => b[k])) : NaN);
    const med = (n) =>
      quantile(
        window(n, 1).map((b) => b.volume),
        0.5
      );
    const recent = window(20).map((b) => b.close),
      m = avg(recent),
      sigma = deviation(recent);
    widths.push(recent.length === 20 ? (4 * sigma) / m : NaN);
    squeeze.push(a.atr > 0 && a.ema20 > 0 && Math.abs(m - a.ema20) + 2 * sigma < 1.5 * a.atr);
    const epoch = Math.floor(b.time / DAY);
    if (epoch !== utcDay) {
      utcDay = epoch;
      sv = 0;
      sv2 = 0;
      v = 0;
      priorZ = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    v += b.volume;
    sv += b.volume * typical;
    sv2 += b.volume * typical ** 2;
    const vw = sv / v,
      sd = Math.sqrt(Math.max(0, sv2 / v - vw * vw)),
      z = sd ? (b.close - vw) / sd : 0,
      z0 = priorZ;
    priorZ = z;
    const funding = asOf(lanes.funding, t, 8 * 3600000),
      oi = asOf(lanes.openInterest, t, dt),
      taker = asOf(lanes.taker, t, dt - 1);
    if (taker) cumulative += taker.buy - taker.sell;
    flow.push(cumulative);
    let entry = null,
      exitLong = false,
      exitShort = false,
      trail = null;
    const enter = (side, stop, target, ttl, extra = {}) => {
      if (
        Number.isFinite(stop) &&
        Number.isFinite(target) &&
        side * (b.close - stop) > 0 &&
        side * (target - b.close) > 0
      )
        entry = { side, stop, target, ttl, ...extra };
    };
    if (p && a.atr > 0) {
      if (
        id === 1 &&
        d?.ema200 > 0 &&
        a.adx > 20 &&
        a.adx > prev.adx &&
        prev.adx > x[i - 2]?.adx &&
        b.volume > med(20)
      ) {
        const s =
          a.ema20 > a.ema50 && prev.ema20 <= prev.ema50 && a.rsi > 55 && d.close > d.ema200
            ? 1
            : a.ema20 < a.ema50 && prev.ema20 >= prev.ema50 && a.rsi < 45 && d.close < d.ema200
              ? -1
              : 0;
        if (s) enter(s, b.close - s * 1.5 * a.atr, b.close + s * 3 * a.atr, 48);
      }
      if (id === 2 && d?.ema100 > 0 && Number.isFinite(d.slope100) && i >= 180 * 6) {
        if (widths[i - 1] <= quantile(widths.slice(i - 180 * 6, i - 1).filter(Number.isFinite), 0.2)) {
          for (const s of [1, -1])
            if (
              s * (b.close - extreme(window(20, 1), s === 1 ? 'high' : 'low', s === 1)) > 0 &&
              s * d.slope100 > 0 &&
              s * (d.close - d.ema100) > 0
            )
              enter(s, b.close - s * 2 * a.atr, b.close + s * 1000 * a.atr, 20, {
                channelExit: true,
                noTarget: true
              });
        }
        exitLong = b.close < extreme(window(10, 1), 'low', false);
        exitShort = b.close > extreme(window(10, 1), 'high', true);
      }
      if (
        id === 3 &&
        d?.ema200 > 0 &&
        d.ema50 > d.ema200 &&
        f?.slope20 > 0 &&
        p.low <= prev.ema20 &&
        p.low >= prev.ema50 &&
        prev.rsi <= 50 &&
        a.rsi > 50 &&
        b.close > p.high
      ) {
        const stop = Math.min(extreme(window(5), 'low', false), b.close - 1.5 * a.atr);
        enter(1, stop, b.close + 1000 * a.atr, Infinity, { noTarget: true, trailR: 2.5 });
      }
      if (id === 3) trail = a.atr;
      if (id === 4 && d?.ema200 > 0 && d.close > d.ema200 && i >= 168) {
        if (
          breakout &&
          i - breakout.i <= 12 &&
          b.low <= breakout.level &&
          b.close >= breakout.level &&
          b.volume >= 1.5 * med(20)
        ) {
          const stop = b.low - 1.25 * a.atr;
          enter(1, stop, b.close + 3 * (b.close - stop), Infinity);
          breakout = null;
        }
        const high = extreme(window(168, 1), 'high', true);
        if (b.close > high) breakout = { level: high, i };
      }
      if (id === 5 && i >= 30) {
        if (squeeze.slice(i - 8, i).every(Boolean) && b.volume > 1.5 * med(30)) {
          for (const s of [1, -1])
            if (
              prev.ema50 > 0 &&
              s * (b.close - m) > 2 * sigma &&
              s * (b.close - a.ema20) > 1.5 * a.atr &&
              s * (a.ema50 - prev.ema50) > 0
            )
              enter(s, b.close - s * 1.5 * a.atr, b.close + s * 4.5 * a.atr, Infinity);
        }
        exitLong = b.close < a.ema20;
        exitShort = b.close > a.ema20;
      }
      if (id === 6 && h?.adx !== null && h?.adx < 18 && sd > 0)
        for (const s of [1, -1]) if (z0 * s < -2.5 && z * s >= -2) enter(s, vw - s * 3.5 * sd, vw, 24);
      if (id === 7) {
        const prior = asOf(daily, epoch * DAY, 0);
        if (prior && i >= 21 && Math.abs(b.close - b.open) > 0)
          for (const s of [1, -1]) {
            const isLong = s === 1,
              k = isLong ? 'low' : 'high',
              level = prior[k],
              w = window(20, 1);
            const idx = w.findIndex((r) => r[k] === extreme(w, k, !isLong));
            const wick = isLong ? Math.min(b.close, b.open) - b.low : b.high - Math.max(b.close, b.open);
            if (
              s * (b[k] - level) < 0 &&
              s * (b.close - level) > 0 &&
              wick >= 1.5 * Math.abs(b.close - b.open) &&
              s * (b[k] - w[idx][k]) < 0 &&
              s * (a.rsi - x[i - 20 + idx].rsi) > 0
            ) {
              const targets = [vw, (prior.high + prior.low) / 2]
                .filter((v) => s * (v - b.close) > 0)
                .sort((a, b) => s * (a - b));
              enter(s, b[k] - s * 0.5 * a.atr, targets[0], Infinity);
            }
          }
      }
      if (id === 8) {
        if (
          i >= 200 &&
          ma200[i] > ma200[i - 1] &&
          b.close > ma200[i] &&
          b.close < p.close &&
          p.close < close[i - 2] &&
          close[i - 2] < close[i - 3] &&
          rsi2[i] < 5
        )
          enter(1, b.close - 2 * a.atr, b.close + 1000 * a.atr, 5, { noTarget: true });
        exitLong = rsi2[i] > 70 || b.close > ma5[i];
      }
      if (id === 9 && i >= 30 * 96 && orbDay !== epoch) {
        const slot = (b.time % DAY) / dt,
          range = bars.slice(i - slot, i - slot + 4);
        if (slot >= 4 && slot < 32 && range.length === 4 && range[0].time === epoch * DAY) {
          const high = extreme(range, 'high', true),
            low = extreme(range, 'low', false),
            typ = quantile(
              Array.from({ length: 30 }, (_, j) => bars[i - (j + 1) * 96].volume),
              0.5
            );
          for (const s of [1, -1])
            if (b.volume >= 2 * typ && (s === 1 ? b.close > high : b.close < low)) {
              enter(s, (high + low) / 2, b.close + s * 2 * (high - low), Math.max(1, 96 - slot));
              orbDay = epoch;
            }
        }
      }
      if (id === 10 && funding && oi) {
        const prior = asOf(lanes.openInterest, t - DAY, dt),
          rates = (lanes.funding ?? []).filter((r) => r.time <= t && r.time >= t - 180 * DAY);
        if (
          prior?.value > 0 &&
          rates[0]?.time <= t - 179 * DAY &&
          funding.rate <=
            quantile(
              rates.map((r) => r.rate),
              0.05
            ) &&
          oi.value <= prior.value * 0.9 &&
          p.close < p.open &&
          p.high - p.low > 2 * prev.atr &&
          p.close >= p.low + 0.6 * (p.high - p.low) &&
          b.close > p.high
        )
          enter(1, p.low, b.close + 2.5 * (b.close - p.low), 48);
      }
      if (id === 11 && funding && oi) {
        const rates = (lanes.funding ?? []).filter((r) => r.time <= t && r.time >= t - 365 * DAY),
          interests = (lanes.openInterest ?? [])
            .filter((r) => r.time <= t && r.time >= t - 30 * DAY)
            .map((r) => r.value);
        if (
          rates[0]?.time <= t - 364 * DAY &&
          funding.rate >
            quantile(
              rates.map((r) => r.rate),
              0.95
            ) &&
          oi.value > avg(interests) + 2 * deviation(interests) &&
          i >= 120 &&
          extreme(window(12, 1), 'high', true) >= extreme(window(120, 1), 'high', true) &&
          b.volume > med(20) &&
          b.close < a.ema20
        ) {
          const stop = extreme(window(12), 'high', true);
          enter(-1, stop, b.close - 3 * (stop - b.close), Infinity);
        }
        exitShort =
          funding.rate <=
          quantile(
            rates.map((r) => r.rate),
            0.5
          );
      }
      if (id === 18 && oi && taker && i >= 12) {
        const mid = i - 2,
          prevOi = asOf(lanes.openInterest, t - 5 * dt, dt);
        for (const s of [1, -1]) {
          const k = s === 1 ? 'low' : 'high',
            swing = bars[mid],
            prior = bars.slice(i - 11, i - 4);
          const extremePrior = extreme(prior, k, s === -1),
            idx = prior.findIndex((r) => r[k] === extremePrior) + i - 11;
          if (
            prevOi &&
            oi.value < prevOi.value &&
            s * (swing[k] - extremePrior) < 0 &&
            s * (flow[mid] - flow[idx]) > 0 &&
            swing[k] === extreme(bars.slice(mid - 2, mid + 3), k, s === -1) &&
            s * (b.close - (s === 1 ? p.high : p.low)) > 0
          )
            enter(
              s,
              swing[k],
              s * (vw - b.close) > 0 ? vw : b.close + s * 2.5 * Math.abs(b.close - swing[k]),
              Infinity
            );
        }
      }
    }
    result.push({ entry, exitLong, exitShort, trail });
  }
  return result;
}
