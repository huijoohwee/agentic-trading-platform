import { statSync } from 'node:fs';
import { join } from 'node:path';
import { publicFeed } from './public-feed.mjs';
import { loadData, partitionInventory } from './research-data.mjs';
import { compatible, composeBars } from './research-signals.mjs';
import { bucket } from '../src/market.mjs';
import { requireThat as need, sha } from './core.mjs';

export function marketLibrary(directory) {
  const live = publicFeed(directory);
  let archive, version;
  function inventory() {
    const manifest = statSync(join(directory, 'partitions', 'manifest.json'), {
      throwIfNoEntry: false,
      bigint: true
    });
    const next = manifest ? [manifest.ino, manifest.mtimeNs, manifest.size].join('/') : 'empty';
    if (archive && version === next) return archive;
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
            ...(p.settlement ? { settlement: p.settlement } : {}),
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
    version = next;
    archive = index;
    return archive;
  }
  return {
    get catalog() {
      const markets = new Map([...inventory()].map(([key, v]) => [key, v.market]));
      for (const m of live.catalog()) markets.set([m.venue, m.marketType, m.symbol].join('/'), m);
      return [...markets.values()];
    },
    market: live.query,
    close: () => live.close(),
    read(input) {
      const entry = inventory().get([input.venue, input.marketType, input.symbol].join('/'));
      const current = live
        .catalog()
        .find((m) => m.venue === input.venue && m.marketType === input.marketType && m.symbol === input.symbol);
      const frameRequested = input.frame ?? entry?.market.frame ?? '1m';
      const hasArchive = entry?.parts.some((p) =>
        compatible(p.frame, frameRequested) && (current?.coverage === 'depth' ||
          (input.before && p.first < input.before && input.before <= bucket(p.last, p.frame, 1)))
      );
      if (current && !hasArchive) return live.query('desk.chart', input);
      need(entry, 'MARKET_BINDING_UNAVAILABLE');
      const { market, parts } = entry,
        frame = input.frame ?? market.frame,
        count = input.count ?? 100;
      const matches = parts.filter((p) => compatible(p.frame, frame));
      need(matches.length, 'INTERVAL_UNAVAILABLE');
      const before = input.before ?? Math.max(...matches.map((p) => bucket(p.last, p.frame, 1)));
      const start = bucket(before - 1, frame, -count + 1);
      const data = loadData(directory, { start, end: before }, { parts: matches, warmup: 0 });
      const series = composeBars([...data.series.values()], frame);
      const bars = (series?.rows ?? []).filter((b) => bucket(b.time, frame, 1) <= before).slice(-count);
      const sources = data.sources;
      const publishers = [...new Map(sources.map((p) => [p.source, p])).values()];
      const first = publishers[0] ?? market;
      const source = {
        id: publishers.length > 1 ? publishers.map((p) => p.source).join(', ') : first.source,
        creator: [...new Set((publishers.length ? publishers : [market]).map((p) => p.creator))].join(', '),
        license: [...new Set((publishers.length ? publishers : [market]).map((p) => p.license))].join(', '),
        ...(publishers.length === 1 && first.upstreamInventorySha256
          ? { upstreamInventorySha256: first.upstreamInventorySha256, licenseUrl: first.licenseUrl }
          : {}),
        sha256: (publishers.length === 1 && first.upstreamSha256) || sha(sources.map((p) => p.sha256))
      };
      return {
        market: { ...market, frame, creator: source.creator, license: source.license, source: source.id },
        source,
        frame,
        bars,
        nextBefore: bars[0]?.time ?? null,
        asOf: bars.length ? bucket(bars.at(-1).time, frame, 1) : null,
        quality: 'historical',
        warnings: ['Archived observations', ...(bars.length < count ? ['Partial candle window'] : [])],
        gaps: series?.gaps ?? 0
      };
    }
  };
}
