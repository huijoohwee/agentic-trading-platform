// The fixture is a continuous, deterministic USD tape. All time buckets use the same path.
export const SOURCE = 'synthetic-market/v1';
export const DAY = 86400000;
const MINUTE = 60000;
const names = [
  'Alder',
  'Birch',
  'Cedar',
  'Dogwood',
  'Elm',
  'Fir',
  'Ginkgo',
  'Hazel',
  'Indigo',
  'Juniper',
  'Kauri',
  'Larch',
  'Maple',
  'Nettle',
  'Olive',
  'Pine',
  'Quince',
  'Rowan',
  'Spruce',
  'Teak',
  'Umber',
  'Violet',
  'Willow',
  'Yarrow'
];
export const catalog = Object.freeze(
  names.map((name, i) =>
    Object.freeze({
      symbol: name.slice(0, 3).toUpperCase() + '.USD',
      base: name.slice(0, 3).toUpperCase(),
      name,
      currency: 'USD',
      featured: i < 5,
      index: i + 1
    })
  )
);
export const frames = Object.freeze({
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '3h': 180,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
  '1M': 0
});
export function instrument(symbol) {
  const asset = catalog.find((item) => item.symbol === symbol);
  if (!asset) throw Error('UNKNOWN_INSTRUMENT');
  return asset;
}
export function searchCatalog(query = '') {
  const text = String(query).trim().toLowerCase();
  return catalog.filter((item) =>
    [item.symbol, item.base, item.name].some((value) => value.toLowerCase().includes(text))
  );
}
const round = (n) => Math.round(n * 10000) / 10000;
const cache = new Map();
function dayProfile(asset, day) {
  const key = day * 32 + asset.index;
  if (cache.has(key)) return cache.get(key);
  const ref = 18 + asset.index * 12;
  const open = (d) => ref * (1 + 0.12 * Math.sin(d * 0.075 + asset.index) + 0.06 * Math.sin(d * 0.28));
  const a = open(day),
    b = open(day + 1);
  const high = Math.max(a, b) * (1.016 + 0.013 * Math.sin(day * 0.47)),
    low = Math.min(a, b) * (0.977 + 0.009 * Math.cos(day * 0.37));
  const points = day % 2 ? [a, high, low, b] : [a, low, high, b];
  const data = { points, high, low, rate: (asset.index + 1) * (1.8 + 0.5 * Math.cos(day)) };
  if (cache.size >= 16000) cache.clear();
  cache.set(key, data);
  return data;
}
function atMinute(profile, minute) {
  if (minute >= 1440) return profile.points[3];
  const leg = Math.floor(minute / 480),
    u = (minute % 480) / 480;
  const fraction = u + 0.085 * Math.sin(Math.PI * u) * Math.sin(minute * 0.13);
  return profile.points[leg] + (profile.points[leg + 1] - profile.points[leg]) * fraction;
}
function price(asset, at) {
  const d = Math.floor(at / DAY),
    m = (at - d * DAY) / MINUTE;
  const profile = dayProfile(asset, d),
    whole = Math.floor(m);
  const p = atMinute(profile, whole);
  return round(p + (atMinute(profile, whole + 1) - p) * (m - whole));
}
function validateTime(at) {
  if (!Number.isSafeInteger(at) || at < Date.UTC(2000, 0, 1) || at > Date.UTC(2200, 0, 1))
    throw Error('INVALID_MARKET_TIME');
}
export function bucket(at, frame, offset = 0) {
  if (!Object.hasOwn(frames, frame)) throw Error('UNKNOWN_TIMEFRAME');
  if (frame === '1M') {
    const date = new Date(at);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
  }
  const length = frames[frame] * MINUTE,
    anchor = frame === '1w' ? 4 * DAY : 0;
  return anchor + (Math.floor((at - anchor) / length) + offset) * length;
}
function bar(asset, start, end) {
  const open = price(asset, start),
    close = price(asset, end);
  let high = Math.max(open, close),
    low = Math.min(open, close),
    volume = 0;
  for (let t = start; t < end; ) {
    const day = Math.floor(t / DAY),
      finish = Math.min(end, (day + 1) * DAY),
      profile = dayProfile(asset, day);
    if (t === day * DAY && finish === t + DAY) {
      high = Math.max(high, profile.high);
      low = Math.min(low, profile.low);
    } else {
      for (let m = Math.ceil((t - day * DAY) / MINUTE); m <= (finish - day * DAY) / MINUTE; m++) {
        const v = atMinute(profile, m);
        high = Math.max(high, v);
        low = Math.min(low, v);
      }
    }
    volume += ((finish - t) / MINUTE) * profile.rate;
    t = finish;
  }
  return { time: start, open, high: round(high), low: round(low), close, volume: round(volume) };
}
export function history(symbol, frame, at, count = 256) {
  validateTime(at);
  if (!Number.isInteger(count) || count < 1 || count > 600) throw Error('HISTORY_LIMIT');
  const asset = instrument(symbol);
  return Array.from({ length: count }, (_, i) =>
    bar(asset, bucket(at, frame, i - count + 1), Math.min(at, bucket(at, frame, i - count + 2)))
  );
}
export function quote(symbol, at) {
  validateTime(at);
  const asset = instrument(symbol),
    session = bar(asset, at - DAY, at);
  return {
    symbol,
    at,
    source: SOURCE,
    last: session.close,
    change: round((session.close / session.open - 1) * 100),
    high: session.high,
    low: session.low,
    volume: session.volume
  };
}
export function microstructure(symbol, at) {
  validateTime(at);
  const asset = instrument(symbol),
    last = price(asset, at);
  function levels(sign) {
    let cumulative = 0;
    return Array.from({ length: 20 }, (_, i) => {
      const amount = round(1 + 8 * Math.abs(Math.sin(asset.index + i * 1.7 + Math.floor(at / 2000) * 0.015 + sign)));
      const p = round(last + sign * (i + 1) * 0.01);
      cumulative += amount;
      return { price: p, amount, notional: round(p * amount), cumulative: round(cumulative) };
    });
  }
  const bids = levels(-1),
    asks = levels(1);
  const tape = Array.from({ length: 24 }, (_, i) => {
    const time = Math.floor(at / 2000) * 2000 - i * 2000,
      p = price(asset, time),
      amount = round(1 + 5 * Math.abs(Math.sin(time / 7000)));
    return {
      time,
      price: p,
      amount,
      notional: round(p * amount),
      aggressor: price(asset, time - 2000) <= p ? 'buyer' : 'seller'
    };
  });
  return {
    bids,
    asks,
    tape,
    spread: round(asks[0].price - bids[0].price),
    bidFraction: bids[19].cumulative / (bids[19].cumulative + asks[19].cumulative)
  };
}
export function mark(symbol, at) {
  validateTime(at);
  return price(instrument(symbol), at);
}
