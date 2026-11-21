import { readFileSync, existsSync, lstatSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.mjs';
import { join } from 'node:path';
import { bucket, frames } from '../src/market.mjs';
import { aggregate } from './research-signals.mjs';
import { requireThat as need, sha } from './core.mjs';
// A market collector can replace its published index atomically after writing immutable partitions.
// An owner-admitted source declares display rights, expiry and a zero-cost collection boundary.
function read(directory, file, max) {
  need(/^[A-Za-z0-9._-]+$/.test(file), 'FEED_PATH');
  const path = join(directory, file),
    info = lstatSync(path);
  need(info.isFile() && !info.isSymbolicLink() && info.size <= max, 'FEED_BUDGET');
  return readFileSync(path);
}
const price = (v) => Number.isFinite(v) && v > 0;
const amounts = (v) => Number.isFinite(v) && v >= 0;
const binding = (a, b) => a.venue === b.venue && a.symbol === b.symbol && a.marketType === b.marketType;
function verifySeries(base, series, at) {
  need(
    Object.hasOwn(frames, base) && Array.isArray(series) && series.length > 0 && series.length <= 3000,
    'INTERVAL_UNAVAILABLE'
  );
  for (const [i, b] of series.entries())
    need(
      Number.isSafeInteger(b.time) &&
        b.time === bucket(b.time, base) &&
        b.time <= at &&
        (!i || b.time > series[i - 1].time) &&
        [b.open, b.high, b.low, b.close].every(price) &&
        b.high >= Math.max(b.open, b.close) &&
        b.low <= Math.min(b.open, b.close) &&
        amounts(b.volume),
      'FEED_CANDLES'
    );
}
export function publicFeed(directory, clock = Date.now) {
  const dir = join(directory, 'feed'),
    manifest = join(dir, 'admission.json');
  let db;
  const storage = () => (db ??= openStore(join(dir, 'head.sqlite')));
  const marketScope = (a) => ({
    environment: 'SIMULATE',
    profile: 'practice',
    account_alias: 'feed/' + sha([a.venue, a.symbol, a.marketType])
  });
  function sources() {
    if (!existsSync(manifest)) return [];
    const m = JSON.parse(read(dir, 'admission.json', 200000));
    need(
      m.schema === 'public-market-admission/v1' && Array.isArray(m.markets) && m.markets.length <= 1000,
      'FEED_ADMISSION'
    );
    for (const a of m.markets) {
      need(
        /^[a-z0-9-]{1,45}$/.test(a.venue) &&
          !['synthetic', 'uniswap-v3-500'].includes(a.venue) &&
          /^[A-Z0-9]+\.[A-Z0-9]+$/.test(a.symbol) &&
          a.symbol.split('.')[1] === a.currency &&
          ['spot', 'perpetual'].includes(a.marketType) &&
          (a.marketType !== 'perpetual' || ['USD', 'USDC', 'USDT'].includes(a.settlement)) &&
          (a.coverage === undefined || a.coverage === 'depth') &&
          a.hardCapUsd === 0 &&
          a.allowPublicDisplay === true &&
          typeof a.creator === 'string' &&
          typeof a.source === 'string' &&
          typeof a.license === 'string' &&
          Number.isSafeInteger(a.expires) &&
          a.expires > clock() &&
          /^[a-f0-9]{64}$/.test(a.rightsDigest) &&
          sha(read(dir, a.rightsDigest + '.rights', 65536)) === a.rightsDigest,
        'FEED_RIGHTS_REQUIRED'
      );
    }
    return m.markets;
  }
  function snapshot(input, provided) {
    const a = sources().find((m) => binding(m, input));
    need(a, 'FEED_BINDING');
    const index = provided ? { sha256: sha(provided) } : storage().read(marketScope(a)).configs.head;
    need(/^[a-f0-9]{64}$/.test(index?.sha256), 'FEED_DIGEST');
    const bytes = provided ?? read(dir, index.sha256 + '.json', 499999);
    need(bytes.length < 500000 && sha(bytes) === index.sha256, 'FEED_DIGEST');
    const d = JSON.parse(bytes);
    need(
      d.schema === 'public-market-snapshot/v1' &&
        d.coverage === a.coverage &&
        binding(a, d) &&
        Number.isSafeInteger(d.at) &&
        d.at >= 0 && d.at <= clock() &&
        Number.isSafeInteger(d.sequence) &&
        d.sequence >= 0 &&
        d.timeUnits === 'UTC_ms' &&
        d.currency === a.currency,
      'FEED_BINDING'
    );
    for (const field of ['bookAt', 'tickerAt']) {
      if (Object.hasOwn(d, field))
        need(Number.isSafeInteger(d[field]) && d[field] >= 0 && d[field] <= d.at, 'FEED_OBSERVATION_TIME');
    }
    if (a.coverage === 'depth') {
      need(d.bookAt === d.at && d.rightsDigest === a.rightsDigest && /^[a-f0-9]{64}$/.test(d.upstreamSha256), 'FEED_PROVENANCE');
      need(['ticker', 'tickerAt', 'candles', 'tape', 'funding'].every((k) => !Object.hasOwn(d, k)), 'FEED_COVERAGE');
    } else need(
      d.ticker &&
        [d.ticker.last, d.ticker.high, d.ticker.low].every(price) &&
        d.ticker.high >= d.ticker.low &&
        amounts(d.ticker.volume) &&
        Number.isFinite(d.ticker.change),
      'FEED_TICKER'
    );
    for (const [k, sign] of [
      ['bids', -1],
      ['asks', 1]
    ])
      need(
        Array.isArray(d[k]) &&
          d[k].length >= 20 &&
          d[k].length <= 200 &&
          d[k].every(
            (v, i) => price(v.price) && price(v.amount) && (!i || sign * (v.price - d[k][i - 1].price) > 0)
          ),
        'FEED_DEPTH'
      );
    need(d.asks[0].price > d.bids[0].price, 'FEED_DEPTH');
    if (a.coverage !== 'depth') need(
      Array.isArray(d.tape) &&
        d.tape.length <= 500 &&
        d.tape.every(
          (t) =>
            Number.isSafeInteger(t.time) &&
            t.time <= d.at &&
            price(t.price) &&
            price(t.amount) &&
            ['buyer', 'seller'].includes(t.aggressor)
        ),
      'FEED_TAPE'
    );
    if (d.funding)
      need(
        Number.isSafeInteger(d.funding.from) &&
          Number.isSafeInteger(d.funding.through) &&
          d.funding.from <= d.funding.through &&
          d.funding.through <= d.at &&
          Array.isArray(d.funding.events) &&
          d.funding.events.every(
            (f, i) =>
              Number.isSafeInteger(f.time) &&
              f.time >= d.funding.from &&
              f.time <= d.funding.through &&
              (!i || f.time > d.funding.events[i - 1].time) &&
              Number.isFinite(f.rate) &&
              price(f.price)
          ),
        'FEED_FUNDING'
      );
    const warnings = clock() - d.at > 15000 ? ['Stale public snapshot'] : [];
    return {
      d,
      a,
      warnings,
      source: {
        id: a.source,
        creator: a.creator,
        ...(a.coverage === 'depth' ? { upstreamSha256: d.upstreamSha256, timestampSource: 'publisher' } : {}),
        license: a.license,
        rightsDigest: a.rightsDigest,
        sha256: index.sha256,
        hardCapUsd: 0
      },
      market: {
        venue: a.venue,
        symbol: a.symbol,
        marketType: a.marketType,
        currency: a.currency,
        frame: input.frame ?? '1m'
      },
      quality: warnings.length ? 'stale' : 'live'
    };
  }
  function query(operation, input) {
    const { d, a, ...meta } = snapshot(input),
      count = input.count ?? 100,
      offset = input.offset ?? 0;
    const at = operation === 'read.ticker' ? d.tickerAt ?? d.at : operation === 'read.depth' ? d.bookAt ?? d.at : d.at;
    const header = { ...meta, at, asOf: at, sequence: d.sequence };
    if (clock() - at > 15000 && header.quality !== 'stale') {
      header.quality = 'stale';
      header.warnings.push('Stale public observation');
    }
    if (a.coverage === 'depth' && operation !== 'read.depth') {
      need(operation !== 'read.ticker', 'FEED_TICKER_UNAVAILABLE');
      const missing = { ...header, quality: 'missing', warnings: ['Source supplies order book only'] };
      if (operation === 'read.tape') return { ...missing, rows: [], volumes: null, total: null };
      return { ...missing, bars: [], forming: null, nextBefore: null, frame: input.frame ?? '1m' };
    }
    if (operation === 'read.ticker')
      return { ...header, rows: { ...d.ticker, at, symbol: a.symbol }, funding: d.funding ?? null };
    if (operation === 'read.tape') {
      const rows = [...d.tape].sort((a, b) => b.time - a.time).map((t) => ({ ...t, notional: t.price * t.amount }));
      const volumes = { buyer: 0, seller: 0 };
      for (const t of rows) volumes[t.aggressor] += t.amount;
      return { ...header, rows: rows.slice(offset, offset + count), volumes, total: rows.length };
    }
    if (operation === 'read.depth') {
      function levels(k) {
        let cumulative = 0;
        return d[k].map((v) => ({
          price: v.price,
          amount: v.amount,
          notional: v.price * v.amount,
          cumulative: (cumulative += v.amount)
        }));
      }
      const bids = levels('bids'),
        asks = levels('asks'),
        bv = bids.slice(0, 20).at(-1).cumulative,
        av = asks.slice(0, 20).at(-1).cumulative;
      return {
        ...header,
        rows: {
          bids: bids.slice(offset, offset + count),
          asks: asks.slice(offset, offset + count),
          spread: asks[0].price - bids[0].price,
          bidFraction: bv / (av + bv),
          imbalance: (bv - av) / (bv + av)
        }
      };
    }
    const frame = input.frame ?? '1m',
      preferred = frame === '10m' ? '5m' : frame === '3h' ? '1h' : frame;
    need(Object.hasOwn(frames, frame), 'INTERVAL_UNAVAILABLE');
    const limit = frames[preferred] || 1440;
    const base = d.candles[preferred]
      ? preferred
      : Object.keys(d.candles)
          .filter((f) => frames[f] > 0 && frames[f] <= limit && limit % frames[f] === 0)
          .sort((a, b) => frames[b] - frames[a])[0];
    const series = d.candles[base];
    verifySeries(base, series, d.at);
    const cutoff = Math.min(input.before ?? d.at, d.at),
      closed = series.filter((b) => bucket(b.time, base, 1) <= cutoff);
    const bars = (base === frame ? closed : aggregate(closed, base, frame))
      .filter((b) => bucket(b.time, frame, 1) <= cutoff)
      .slice(-count);
    const current = series.filter((b) => b.time >= bucket(cutoff, frame) && b.time <= cutoff);
    const forming =
      current.length && !input.before
        ? {
            time: bucket(cutoff, frame),
            open: current[0].open,
            close: current.at(-1).close,
            high: Math.max(...current.map((b) => b.high)),
            low: Math.min(...current.map((b) => b.low)),
            volume: current.reduce((v, b) => v + b.volume, 0)
          }
        : null;
    if (bars.length < count) header.warnings.push('Partial candle window');
    return { ...header, bars, forming, nextBefore: bars[0]?.time ?? null, frame };
  }
  function publish(bytes) {
    need(Buffer.isBuffer(bytes) && bytes.length < 500000, 'FEED_BUDGET');
    const binding = JSON.parse(bytes),
      { d, a, source } = snapshot(binding, bytes);
    if (a.coverage !== 'depth') {
      need(
        d.candles && typeof d.candles === 'object' && !Array.isArray(d.candles) && Object.keys(d.candles).length > 0,
        'FEED_CANDLES'
      );
      for (const [frame, series] of Object.entries(d.candles)) verifySeries(frame, series, d.at);
    }
    const path = join(dir, source.sha256 + '.json'),
      tmp = path + '.' + randomUUID();
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      try {
        linkSync(tmp, path);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        need(sha(read(dir, source.sha256 + '.json', 499999)) === source.sha256, 'FEED_DIGEST');
      }
    } finally {
      unlinkSync(tmp);
    }
    return storage().transaction(marketScope(a), (s) => {
      const old = s.configs.head;
      if (old?.sha256 === source.sha256) return old;
      need(!old || (d.sequence > old.sequence && d.at >= old.at), 'FEED_ROLLBACK');
      return (s.configs.head = { sha256: source.sha256, at: d.at, sequence: d.sequence });
    });
  }
  return {
    publish,
    admission(input) {
      const a = sources().find((m) => binding(m, input));
      need(a, 'FEED_BINDING');
      return a;
    },
    close: () => db?.close(),
    catalog: () =>
      sources().map(({ venue, symbol, currency, marketType, source, license, creator, coverage }) => ({
        venue,
        symbol,
        base: symbol.split('.')[0],
        currency,
        marketType,
        source,
        license,
        creator,
        ...(coverage ? { coverage } : {}),
        live: true
      })),
    query
  };
}
