import { sma, smooth } from './indicators.mjs';
import { compileStrategy, runStrategy } from './strategy-language.mjs';

export { example } from './strategy-example.mjs';

function fail(message) {
  throw Error(message);
}
function moving(fn, series, period) {
  if (
    !Array.isArray(series) ||
    !Number.isInteger(period) ||
    period < 1 ||
    period > 600 ||
    !series.every((v) => v === null || Number.isFinite(v))
  )
    fail('Invalid moving average input');
  return fn(series, period);
}
function crosses(above, a, b, i) {
  if (!Array.isArray(a) || !Array.isArray(b) || !Number.isInteger(i)) fail('Invalid crossover input');
  if (![a[i], b[i], a[i - 1], b[i - 1]].every(Number.isFinite)) return false;
  return above ? a[i - 1] <= b[i - 1] && a[i] > b[i] : a[i - 1] >= b[i - 1] && a[i] < b[i];
}
function range(start, stop, step = 1) {
  if (stop === undefined) {
    stop = start;
    start = 0;
  }
  if (![start, stop, step].every(Number.isSafeInteger) || !step) fail('Invalid range');
  const length = Math.max(0, Math.ceil((stop - start) / step));
  if (length > 1200) fail('Range limit reached');
  return Array.from({ length }, (_, i) => start + i * step);
}
export function experiment(code, bars, stdout = []) {
  if (!Array.isArray(bars) || bars.length < 2 || bars.length > 600) fail('Expected 2–600 candles');
  const observations = new Map();
  const candles = bars.map((bar) => {
    const time = bar.time / 1000;
    observations.set(time, bar);
    return new Map(Object.entries({ ...bar, time }));
  });
  const output = runStrategy(compileStrategy(code), candles, {
    len: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : fail('Expected sequence')),
    range,
    sma: (a, n) => moving(sma, a, n),
    ema: (a, n) => moving(smooth, a, n),
    crossed_above: (...v) => crosses(true, ...v),
    crossed_below: (...v) => crosses(false, ...v),
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    print: (...values) => {
      if (stdout.length < 200)
        stdout.push(
          values
            .map((v) => (v === null ? 'None' : typeof v === 'object' ? '[collection]' : String(v)))
            .join(' ')
            .slice(0, 240)
        );
      return null;
    }
  });
  const signals = [];
  for (const item of output) {
    if (!(item instanceof Map)) fail('Signal must be a dictionary');
    const bar = observations.get(item.get('time')),
      action = String(item.get('side')).toLowerCase();
    if (!bar || !['buy', 'sell', 'short', 'cover'].includes(action)) fail('Invalid signal time or side');
    const price = item.has('price') ? item.get('price') : bar.close;
    if (!Number.isFinite(price) || price <= 0) fail('Invalid signal price');
    signals.push({ time: bar.time, price, action, label: String(item.get('label') ?? action).slice(0, 32) });
    if (signals.length > 1000) fail('Signal limit reached');
  }
  signals.sort((a, b) => a.time - b.time);
  let position,
    net = 0,
    wins = 0,
    count = 0,
    equity = 1,
    peak = 1,
    drawdown = 0;
  for (const s of signals) {
    if (!position && ['buy', 'short'].includes(s.action)) {
      position = s;
      continue;
    }
    if (!position || s.action !== (position.action === 'buy' ? 'sell' : 'cover')) continue;
    const gain = (s.price - position.price) * (position.action === 'buy' ? 1 : -1);
    net += gain;
    wins += Number(gain > 0);
    count++;
    equity *= 1 + gain / position.price;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak);
    position = null;
  }
  return {
    signals,
    stdout,
    stderr: [],
    authority: false,
    report: { count, wins, winRate: count ? wins / count : null, net, return: equity - 1, maxDrawdown: drawdown }
  };
}
