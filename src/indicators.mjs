export const indicatorVersion = 'technical-studies/v1';
export const presets = {
  Starter: ['ema20', 'volume', 'rsi'],
  Trend: ['ema50', 'ema200', 'hull', 'supertrend', 'ichimoku', 'adx'],
  Momentum: ['rsi', 'macd', 'stoch'],
  Volatility: ['bands', 'atr', 'vwap'],
  Clear: []
};
export const studies = {
  volume: 'Volume',
  ema20: 'EMA 20',
  ema50: 'EMA 50',
  ema200: 'EMA 200',
  sma50: 'SMA 50',
  sma200: 'SMA 200',
  hull: 'Hull ribbon 55',
  supertrend: 'Supertrend 10 × 3',
  ichimoku: 'Ichimoku 9/26/52 (+26)',
  vwap: 'UTC session VWAP',
  bands: 'Bollinger 20 × 2',
  atr: 'ATR 14',
  rsi: 'RSI 14',
  macd: 'MACD 12/26/9',
  stoch: 'StochRSI 14/14/3/3',
  adx: 'ADX / DMI 14'
};
export function rolling(xs, n, reduce) {
  return xs.map((_, i) => {
    if (i < n - 1) return null;
    const window = xs.slice(i + 1 - n, i + 1);
    return window.every(Number.isFinite) ? reduce(window) : null;
  });
}
const sum = (xs) => xs.reduce((total, value) => total + value, 0);
export const sma = (xs, n) => rolling(xs, n, (values) => sum(values) / n);
export function smooth(xs, n, alpha = 2 / (n + 1)) {
  let prior = null,
    seed = [];
  return xs.map((value) => {
    if (!Number.isFinite(value)) {
      seed = [];
      prior = null;
      return null;
    }
    if (prior === null) {
      seed.push(value);
      if (seed.length < n) return null;
      prior = sum(seed) / n;
    } else prior += alpha * (value - prior);
    return prior;
  });
}
const wma = (xs, n) =>
  rolling(xs, n, (values) => values.reduce((total, value, i) => total + value * (i + 1), 0) / ((n * (n + 1)) / 2));
const zip = (a, b, fn) => a.map((x, i) => (Number.isFinite(x) && Number.isFinite(b[i]) ? fn(x, b[i]) : null));
const delta = (xs) => xs.map((v, i) => (i ? v - xs[i - 1] : null));
export function calculateStudies(bars, selection) {
  const close = bars.map((b) => b.close),
    high = bars.map((b) => b.high),
    low = bars.map((b) => b.low);
  const lines = [];
  const add = (name, values, pane = 'price', style = 'line') => lines.push({ name, values, pane, style });
  const tr = bars.map((b, i) =>
    Math.max(b.high - b.low, i ? Math.abs(b.high - close[i - 1]) : 0, i ? Math.abs(b.low - close[i - 1]) : 0)
  );
  const wild = (xs, n) => smooth(xs, n, 1 / n);
  const change = delta(close);
  function rsi() {
    return zip(
      wild(
        change.map((v) => (v === null ? null : Math.max(0, v))),
        14
      ),
      wild(
        change.map((v) => (v === null ? null : Math.max(0, -v))),
        14
      ),
      (gain, loss) => (gain + loss === 0 ? 50 : (100 * gain) / (gain + loss))
    );
  }
  const middle = (n) =>
    zip(
      rolling(high, n, (v) => Math.max(...v)),
      rolling(low, n, (v) => Math.min(...v)),
      (h, l) => (h + l) / 2
    );
  for (const id of new Set(selection)) {
    if (!Object.hasOwn(studies, id)) throw Error('UNKNOWN_INDICATOR');
    if (id === 'volume')
      add(
        'Volume',
        bars.map((b) => b.volume),
        'volume',
        'bars'
      );
    else if (/^[es]ma\d+$/.test(id)) add(studies[id], (id.startsWith('e') ? smooth : sma)(close, Number(id.slice(3))));
    else if (id === 'atr') add('ATR', wild(tr, 14), 'atr');
    else if (id === 'rsi') add('RSI', rsi(), 'rsi');
    else if (id === 'hull') {
      const hull = wma(
        zip(wma(close, 27), wma(close, 55), (a, b) => 2 * a - b),
        7
      );
      add('Hull', hull);
      add(
        'Hull lag',
        hull.map((_, i) => hull[i - 2] ?? null)
      );
    } else if (id === 'bands') {
      const mean = sma(close, 20),
        dev = rolling(close, 20, (w) => {
          const avg = sum(w) / 20;
          return Math.sqrt(sum(w.map((x) => (x - avg) ** 2)) / 20);
        });
      add('BB mid', mean);
      add(
        'BB upper',
        zip(mean, dev, (m, d) => m + 2 * d)
      );
      add(
        'BB lower',
        zip(mean, dev, (m, d) => m - 2 * d)
      );
    } else if (id === 'macd') {
      const macd = zip(smooth(close, 12), smooth(close, 26), (a, b) => a - b),
        signal = smooth(macd, 9);
      add('MACD', macd, id);
      add('Signal', signal, id);
      add(
        'Difference',
        zip(macd, signal, (a, b) => a - b),
        id,
        'bars'
      );
    } else if (id === 'ichimoku') {
      const a = middle(9),
        b = middle(26),
        future = (xs) => Array(26).fill(null).concat(xs);
      add('Conversion', a);
      add('Base', b);
      add('Span A', future(zip(a, b, (x, y) => (x + y) / 2)));
      add('Span B', future(middle(52)));
      add('Lagging close', close.slice(26).concat(Array(26).fill(null)));
    } else if (id === 'vwap') {
      let day,
        volume = 0,
        value = 0;
      add(
        'VWAP',
        bars.map((b) => {
          const key = Math.floor(b.time / 86400000);
          if (key !== day) {
            day = key;
            volume = 0;
            value = 0;
          }
          volume += b.volume;
          value += (b.volume * (b.high + b.low + b.close)) / 3;
          return volume ? value / volume : null;
        })
      );
    } else if (id === 'supertrend') {
      let upper, lower, line;
      add(
        'Supertrend',
        wild(tr, 10).map((atr, i) => {
          if (atr === null) return null;
          const mid = (high[i] + low[i]) / 2,
            top = mid + 3 * atr,
            bottom = mid - 3 * atr,
            prev = close[i - 1];
          const nextTop = upper === undefined || top < upper || prev > upper ? top : upper;
          const nextBottom = lower === undefined || bottom > lower || prev < lower ? bottom : lower;
          const wasAbove = upper === undefined || line === upper;
          line = wasAbove ? (close[i] > nextTop ? nextBottom : nextTop) : close[i] < nextBottom ? nextTop : nextBottom;
          upper = nextTop;
          lower = nextBottom;
          return line;
        })
      );
    } else if (id === 'stoch') {
      const rs = rsi(),
        raw = rolling(rs, 14, (w) => {
          const l = Math.min(...w),
            h = Math.max(...w);
          return h === l ? 0 : (100 * (w.at(-1) - l)) / (h - l);
        });
      const k = sma(raw, 3);
      add('%K', k, id);
      add('%D', sma(k, 3), id);
    } else if (id === 'adx') {
      const up = delta(high),
        down = delta(low).map((x) => (x === null ? null : -x));
      const ranges = wild(
        tr.map((v, i) => (i ? v : null)),
        14
      );
      const di = (a, b) =>
        zip(
          wild(
            a.map((v, i) => (v === null ? null : v > 0 && v > b[i] ? v : 0)),
            14
          ),
          ranges,
          (d, r) => (r ? (100 * d) / r : 0)
        );
      const plus = di(up, down),
        minus = di(down, up);
      add('+DI', plus, id);
      add('−DI', minus, id);
      add(
        'ADX',
        wild(
          zip(plus, minus, (p, m) => (p + m ? (100 * Math.abs(p - m)) / (p + m) : 0)),
          14
        ),
        id
      );
    }
  }
  return lines;
}
