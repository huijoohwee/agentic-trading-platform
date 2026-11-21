import { publicFeed } from './public-feed.mjs';
import { loadData, partitionInventory } from './research-data.mjs';
import { aggregate } from './research-signals.mjs';
import { bucket, frames } from '../src/market.mjs';
import { requireThat as need, sha } from './core.mjs';

function compatible(from, to) {
  if (!Object.hasOwn(frames, to)) return false;
  return (
    from === to || (frames[from] > 0 && (to === '1M' ? 1440 % frames[from] === 0 : frames[to] % frames[from] === 0))
  );
}
export function marketLibrary(directory) {
  const live = publicFeed(directory);
  let archive;
  function inventory() {
    if (archive) return archive;
    const index = new Map();
    for (const p of partitionInventory(directory).filter((p) => p.kind === 'ohlcv')) {
      const key = [p.venue, p.marketType, p.symbol].join('/');
      let m = index.get(key);
      if (!m) {
        const [base, currency] = p.symbol.split('.');
        m = {
          market: {
            venue: p.venue,
            marketType: p.marketType,
            symbol: p.symbol,
            base,
            currency,
            source: p.source,
            license: p.license,
            creator: p.creator,
            frame: p.frame
          },
          parts: []
        };
        index.set(key, m);
      }
      m.parts.push(p);
    }
    archive = index;
    return archive;
  }
  return {
    get catalog() {
      return [...Array.from(inventory().values(), (v) => v.market), ...live.catalog()];
    },
    market: live.query,
    close: () => live.close(),
    read(input) {
      if (live.catalog().some((m) => m.venue === input.venue)) return live.query('desk.chart', input);
      const entry = inventory().get([input.venue, input.marketType, input.symbol].join('/'));
      need(entry, 'MARKET_BINDING_UNAVAILABLE');
      const { market, parts } = entry,
        frame = input.frame ?? market.frame,
        count = input.count ?? 100;
      const available = [...new Set(parts.map((p) => p.frame))].filter((f) => compatible(f, frame));
      const base = available.includes(frame) ? frame : available.sort((a, b) => frames[b] - frames[a])[0];
      need(base, 'INTERVAL_UNAVAILABLE');
      const matches = parts.filter((p) => p.frame === base);
      const before = input.before ?? bucket(Math.max(...matches.map((p) => p.last)), base, 1);
      const start = bucket(before - 1, frame, -count + 1);
      const data = loadData(directory, { start, end: before }, { parts: matches, warmup: 0 });
      const lane = data.series.values().next().value;
      const source = (lane?.rows ?? []).filter((b) => b.time >= start && bucket(b.time, base, 1) <= before);
      const bars = (frame === base ? source : aggregate(source, base, frame))
        .filter((b) => bucket(b.time, frame, 1) <= before)
        .slice(-count);
      return {
        market: { ...market, frame },
        source: {
          id: market.source,
          license: market.license,
          creator: market.creator,
          sha256: matches[0].upstreamSha256 ?? sha(data.sources.map((p) => p.sha256))
        },
        frame,
        bars,
        nextBefore: bars[0]?.time ?? null,
        asOf: bars.length ? bucket(bars.at(-1).time, frame, 1) : null,
        quality: 'historical',
        warnings: ['Archived observations', ...(bars.length < count ? ['Partial candle window'] : [])],
        gaps: lane?.gaps ?? 0
      };
    }
  };
}
