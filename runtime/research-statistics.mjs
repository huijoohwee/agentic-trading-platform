const day = 86400000,
  year = 365.2425 * day;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
export function metrics(curve, trades, capital) {
  if (!curve.length) return null;
  let high = capital,
    dd = 0,
    turnover = 0,
    exposure = 0;
  const daily = new Map();
  for (const point of curve) {
    high = Math.max(high, point.equity);
    dd = Math.max(dd, (high - point.equity) / high);
    exposure += point.exposure;
    turnover += point.turnover ?? 0;
    daily.set(Math.floor(point.time / day), point.equity);
  }
  let prior = capital;
  const rets = [];
  for (const equity of daily.values()) {
    if (prior > 0) rets.push(equity / prior - 1);
    prior = equity;
  }
  const avg = mean(rets),
    std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - avg) ** 2, 0) / (rets.length - 1)) : null;
  const downside = rets.length ? Math.sqrt(rets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / rets.length) : null;
  const end = curve.at(-1),
    elapsed = end.time - curve[0].time,
    ret = end.equity / capital - 1;
  const raw = elapsed >= day && ret > -1 ? (1 + ret) ** (year / elapsed) - 1 : null,
    cagr = Number.isFinite(raw) ? raw : null;
  const wins = trades.filter((t) => t.pnl > 0),
    profit = wins.reduce((s, t) => s + t.pnl, 0),
    loss = -trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  return {
    return: ret,
    cagr,
    exposure: exposure / curve.length,
    turnover: turnover / capital,
    maxDrawdown: dd,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    expectancy: mean(trades.map((t) => t.pnl)),
    profitFactor: loss ? profit / loss : null,
    sharpe: std ? (avg / std) * Math.sqrt(365) : null,
    sortino: downside ? (avg / downside) * Math.sqrt(365) : null,
    calmar: dd && cagr !== null ? cagr / dd : null
  };
}
const month = (t, n) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
};
export function periods(curve, trades, capital, range) {
  function period(start, end) {
    const sub = curve.filter((p) => p.time >= start && p.time < end),
      prior = curve.findLast((p) => p.time < start);
    return {
      start,
      end,
      actual: sub.length ? [sub[0].time, sub.at(-1).time] : null,
      metrics: metrics(
        sub,
        trades.filter((t) => t.exit >= start && t.exit < end),
        prior?.equity ?? capital
      )
    };
  }
  const annual = [],
    walkForward = [];
  for (let y = new Date(range.start).getUTCFullYear(); Date.UTC(y, 0, 1) < range.end; y++)
    annual.push(period(Math.max(range.start, Date.UTC(y, 0, 1)), Math.min(range.end, Date.UTC(y + 1, 0, 1))));
  const anchor = month(range.start, 0) === range.start ? range.start : month(range.start, 1);
  for (let warm = anchor; month(warm, 30) <= range.end; warm = month(warm, 6)) {
    const start = month(warm, 24),
      end = month(warm, 30);
    walkForward.push({ training: [warm, start], ...period(start, end) });
  }
  return { annual, walkForward };
}
