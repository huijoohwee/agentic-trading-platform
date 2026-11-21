import { asOf } from './research-data.mjs';
import { hypotheses } from '../src/research-catalog.mjs';
import { frames, DAY, bucket } from '../src/market.mjs';
import { directionalSignals, composeBars } from './research-signals.mjs';
import { portfolioSignals, executePortfolio } from './research-portfolio.mjs';
import { depthReplay, liquidationPlans, optionsReplay } from './research-events.mjs';
import { metrics, periods } from './research-statistics.mjs';
const assumptions = {
  risk: 0.005,
  maxGross: 2,
  fees: 0.0004,
  slippage: 0.0001,
  spread: 0.0001,
  borrow: 0,
  fill: 'next open after a closed signal',
  collision: 'stop first',
  costSource: 'modeled fraction of one-way turnover; zero borrow unless observed'
};
export function executeDirectional(bars, signals, capital, range, cost = assumptions, funding = []) {
  const curve = [],
    trades = [],
    markers = [],
    costs = { fees: 0, spread: 0, slippage: 0, funding: 0, borrow: 0 };
  let cash = capital,
    position = null,
    fundingIndex = 0,
    turnover = 0;
  function friction(value) {
    let total = 0;
    for (const key of ['fees', 'spread', 'slippage']) {
      const fee = Math.abs(value) * cost[key];
      costs[key] += fee;
      total += fee;
    }
    return total;
  }
  function close(price, bar, reason) {
    const p = position,
      notional = p.qty * price,
      fees = friction(notional),
      gross = p.side * p.qty * (price - p.open);
    cash += gross - fees;
    turnover += notional;
    trades.push({
      entry: p.at,
      exit: bar.time,
      side: p.side,
      qty: p.qty,
      open: p.open,
      price,
      stop: p.initialStop,
      target: p.target,
      reason,
      pnl: gross - p.fees - fees - p.funding
    });
    markers.push({ time: bar.time, action: p.side > 0 ? 'sell' : 'cover', price, label: reason });
    position = null;
  }
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < range.start || b.time >= range.end) continue;
    turnover = 0;
    const signal = signals[i - 1];
    while (fundingIndex < funding.length && funding[fundingIndex].time <= b.time) {
      const f = funding[fundingIndex++];
      if (position && f.time > position.at) {
        const payment = position.side * position.qty * (f.price ?? b.open) * f.rate;
        costs.funding += payment;
        position.funding += payment;
        cash -= payment;
      }
    }
    if (position) {
      const p = position;
      if (p.side * (b.open - p.stop) <= 0) close(b.open, b, 'gap stop');
      else if (p.target !== null && p.side * (b.open - p.target) >= 0) close(b.open, b, 'gap target');
      else if (i - p.index >= p.ttl || (p.side > 0 ? signal.exitLong : signal.exitShort))
        close(b.open, b, 'signal or expiry');
    }
    if (!position && signal.entry && cash > 0) {
      const e = signal.entry,
        dist = (b.open - e.stop) * e.side,
        target = e.noTarget ? null : e.target;
      if (dist > 0 && (target === null || e.side * (target - b.open) > 0)) {
        const qty = Math.min(
          (cash * cost.risk) / dist,
          (cash * cost.maxGross) / (b.open * (1 + cost.maxGross * (cost.fees + cost.spread + cost.slippage)))
        );
        const value = qty * b.open,
          fees = friction(value);
        cash -= fees;
        turnover += value;
        position = {
          ...e,
          target,
          initialStop: e.stop,
          open: b.open,
          at: b.time,
          index: i,
          fees,
          qty,
          dist,
          funding: 0
        };
        markers.push(
          { time: b.time, price: b.open, action: e.side > 0 ? 'buy' : 'short', label: 'entry' },
          { time: b.time, price: e.stop, action: 'stop', label: 'stop' }
        );
        if (target !== null) markers.push({ time: b.time, price: target, action: 'target', label: 'target' });
      }
    }
    if (position) {
      const p = position,
        low = p.side > 0 ? b.low : b.high,
        high = p.side > 0 ? b.high : b.low;
      if (p.side * (low - p.stop) <= 0) close(p.stop, b, 'stop');
      else if (p.target !== null && p.side * (high - p.target) >= 0) close(p.target, b, 'target');
      else if (p.trailR && p.side * (b.close - p.open) >= p.dist && signals[i].trail > 0) {
        const next = b.close - p.side * p.trailR * signals[i].trail;
        p.stop = p.side > 0 ? Math.max(next, p.stop) : Math.min(next, p.stop);
      }
    }
    const equity = cash + (position ? position.side * position.qty * (b.close - position.open) : 0);
    curve.push({
      time: b.time,
      equity,
      exposure: position && equity > 0 ? (position.qty * b.close) / equity : 0,
      turnover
    });
  }
  return { curve, trades, signals: markers, costs, rebalances: [] };
}
const warmup = [0, 200, 180, 200, 200, 3, 3, 2, 201, 30, 180, 365, 7, 60, 180, 30, 30, 1, 2, 200, 365];
export function historicalReport({ input, range, data, engine }) {
  const capital = input.capital ?? 100000,
    venue = input.venue ?? 'uniswap-v3-500',
    rows = [];
  const lanes = [...data.series.values()];
  const seriesCache = new Map();
  function find(symbol, type, kind, frame) {
    const candidates = lanes.filter(
      (p) => p.venue === venue && p.symbol === symbol && p.marketType === type && p.kind === kind
    );
    if (kind !== 'ohlcv') return candidates[0];
    const key = [symbol, type, frame].join('/');
    if (seriesCache.has(key)) return seriesCache.get(key);
    const series = composeBars(candidates, frame);
    seriesCache.set(key, series);
    return series;
  }
  for (const strategy of hypotheses.filter((h) => !input.hypothesis || input.hypothesis === h.id)) {
    const { id, requires, base } = strategy,
      symbol =
        input.hypothesis && input.symbol
          ? input.symbol
          : input.basket && [8, 19].includes(id)
            ? input.basket[0]
            : base + '.USDT',
      type = input.hypothesis && input.marketType ? input.marketType : strategy.marketType,
      frame = input.hypothesis && input.frame ? input.frame : strategy.frame,
      quote = symbol.split('.')[1],
      market = { venue, symbol, marketType: type, frame },
      source = find(symbol, type, 'ohlcv', frame);
    const missing = [],
      aux = {},
      markets = {},
      cross = {};
    let report;
    const primary = symbol.split('.')[0];
    if (source?.rows.length) markets[primary] = source.rows;
    else missing.push('venue-bound ' + frame + ' OHLCV');
    const dependencies =
      id === 19 && input.basket ? input.basket.slice(1).map((s) => s.split('.')[0]) : requires.slice(1);
    for (const kind of dependencies) {
      if (['BTC', 'ETH', 'SOL', 'spot'].includes(kind) || id === 19) {
        const field =
          kind === 'spot' ? find(symbol, 'spot', 'ohlcv', frame) : find(kind + '.' + quote, type, 'ohlcv', frame);
        if (field?.rows.length) markets[kind] = field.rows;
        else missing.push(kind + ' matched candles');
      } else if (kind.startsWith('universe')) {
        const size = Number(kind.slice(8)),
          universe = new Set(
            lanes
              .filter(
                (l) =>
                  l.venue === venue &&
                  l.marketType === type &&
                  l.kind === 'ohlcv' &&
                  l.symbol.split('.')[1] === quote
              )
              .map((l) => l.symbol)
          );
        for (const s of universe) {
          const series = find(s, type, 'ohlcv', frame);
          if (series?.rows.length) markets[s.split('.')[0]] = series.rows;
        }
        if (Object.keys(markets).length < size) missing.push('verified ' + size + '-contract universe');
      } else {
        const lane =
          kind === 'options'
            ? (find(symbol, 'option', kind, frame) ?? find(symbol, type, kind, frame))
            : find(symbol, type, kind, frame);
        if (lane?.rows.length) aux[kind] = lane.rows;
        else missing.push(kind);
      }
    }
    if (id === 15) {
      for (const n of Object.keys(markets)) {
        const symbol = n + '.' + quote;
        const oi = find(symbol, type, 'openInterest', frame),
          liq = find(symbol, type, 'liquidations', frame);
        if (
          !oi?.rows.some((r) => r.time >= range.start && r.time < range.end) ||
          !liq?.rows.some(
            (r) => r.time >= range.start && r.time < range.end && asOf(oi.rows, r.time, frames[frame] * 60000)
          )
        )
          missing.push(n + ' liquidation and open-interest mapping');
        else cross[n] = { openInterest: oi.rows, liquidations: liq.rows };
      }
    }
    let incompleteInputs = false;
    for (const [name, observations] of [
      ...Object.entries(aux),
      ...Object.entries(markets).filter(([n]) => n !== primary)
    ]) {
      if (!observations.some((r) => r.time >= range.start && r.time < range.end))
        missing.push(name + ' within requested dates');
      else if (observations[0].time > range.start || observations.at(-1).time + DAY < range.end)
        incompleteInputs = true;
    }
    const actual =
      source?.rows.filter((b) => b.time >= range.start && bucket(b.time, frame, 1) <= range.end) ?? [];
    if (!actual.length && !missing.length) missing.push('observations within requested dates');
    const common = {
      capitalUnit: source?.settlement ?? quote,
      ...(id === 19 ? { basket: Object.keys(markets).map((n) => n + '.' + quote) } : {}),
      id,
      name: strategy.name,
      market,
      version: strategy.version,
      required: requires,
      actual: actual.length ? [actual[0].time, bucket(actual.at(-1).time, frame, 1)] : null
    };
    const blocked = (reason) => ({
      ...common,
      status: 'blocked',
      reason,
      metrics: null,
      return: null,
      profitability: 'unknown',
      signals: [],
      warnings: []
    });
    if (missing.length) {
      rows.push(blocked(missing.join(', ')));
      continue;
    }
    const warnings = incompleteInputs ? ['Partial coverage of required companion data'] : [];
    if (source.gaps) warnings.push('Missing intervals: ' + source.gaps);
    if (actual[0].time > range.start || bucket(actual.at(-1).time, frame, 1) < range.end)
      warnings.push('Partial requested window');
    if (source.rows[0].time > range.start - warmup[id] * DAY) warnings.push('Incomplete indicator warm-up');
    if (id === 19 && Object.values(markets).some((bs) => bs.some((b, i) => i && b.time - bs[i - 1].time !== DAY)))
      warnings.push('Rotation skips incomplete calendar lookbacks');
    if (type === 'perpetual' && !aux.funding) {
      const funding = find(symbol, type, 'funding', frame);
      if (funding) aux.funding = funding.rows;
      else warnings.push('Unobserved funding modeled at zero');
    }
    if (type === 'perpetual') {
      if (aux.funding?.some((r) => r.price === undefined))
        warnings.push('Observed funding rates valued at modeled bar-open prices');
      aux.fundingByAsset = {};
      for (const name of Object.keys(markets).filter((n) => n !== 'spot')) {
        const observations =
          name === primary ? aux.funding : find(name + '.' + quote, type, 'funding', frame)?.rows;
        if (observations) aux.fundingByAsset[name] = observations;
        else if (name !== primary) warnings.push('Unobserved ' + name + ' funding modeled at zero');
      }
    }
    if (id === 14) warnings.push('Fixed-universe selection has survivorship bias');
    if (id === 17) {
      const start = Math.max(range.start, aux.depth[0].time, aux.trades[0].time),
        end = Math.min(range.end, aux.depth.at(-1).time + 1, aux.trades.at(-1).time + 1);
      report = depthReplay(aux, capital, { start, end }, assumptions);
      common.actual = end > start ? [start, end] : null;
      if (report.curve?.length) {
        const gaps = report.curve
          .slice(1)
          .map((p, i) => p.time - report.curve[i].time)
          .sort((a, b) => a - b);
        report.bookMedianIntervalMs = gaps[Math.floor(gaps.length / 2)] ?? null;
        warnings.push(
          'Fills use the next observed book after each latency; median book interval ' +
            report.bookMedianIntervalMs +
            ' ms'
        );
      }
    } else if (id === 20) report = optionsReplay(source.rows, aux.options, capital, range, assumptions);
    else if (id === 15) {
      const histories = Object.values(cross).flatMap((m) => [m.openInterest, m.liquidations]);
      const joined = {
        start: Math.max(range.start, ...histories.map((rows) => rows[0].time)),
        end: Math.min(range.end, ...histories.map((rows) => rows.at(-1).time + 1))
      };
      if (joined.start >= joined.end) {
        rows.push(blocked('No common liquidation and open-interest window across the universe'));
        continue;
      }
      common.actual = [joined.start, joined.end];
      if (joined.start > range.start || joined.end < range.end)
        warnings.push('Partial common liquidation and open-interest window');
      const plans = liquidationPlans(markets, cross, source.rows, frames[frame] * 60000, joined);
      report = executePortfolio(
        source.rows,
        markets,
        plans,
        capital,
        joined,
        assumptions,
        aux,
        frames[frame] * 60000
      );
    } else if ([12, 13, 14, 16, 19].includes(id)) {
      const plans = portfolioSignals(id, markets, source.rows, frames[frame] * 60000, aux);
      report = executePortfolio(
        source.rows,
        markets,
        plans,
        capital,
        range,
        assumptions,
        aux,
        frames[frame] * 60000
      );
    } else {
      const planned = directionalSignals(id, source.rows, frame, aux);
      report = executeDirectional(source.rows, planned, capital, range, assumptions, aux.funding);
    }
    if (report.unavailable) {
      rows.push(blocked(report.unavailable));
      continue;
    }
    if (report.incomplete) warnings.push(report.incomplete);
    const untested =
      !report.trades.length &&
      !report.rebalances.length &&
      actual.at(-1).time - source.rows[0].time < warmup[id] * DAY;
    if (untested) warnings.push('Insufficient history to interpret a no-trade preview');
    const summary = untested ? null : metrics(report.curve, report.trades, capital);
    rows.push({
      ...common,
      status: warnings.length ? 'partial' : 'completed',
      warnings,
      metrics: summary,
      return: summary?.return ?? null,
      profitability: summary ? (summary.return > 0 ? 'gain' : summary.return < 0 ? 'loss' : 'flat') : 'unknown',
      ...periods(untested ? [] : report.curve, report.trades, capital, range),
      ...report
    });
  }
  return {
    schema: 'historical-research/v1',
    engine,
    input,
    range,
    capital,
    assumptions,
    sources: data.sources,
    rows,
    status: rows.every((r) => r.status === 'blocked')
      ? 'blocked'
      : rows.every((r) => r.status === 'completed')
        ? 'completed'
        : 'partial'
  };
}
