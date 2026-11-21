import { actionFor, deskActions } from '../src/desk-actions.mjs';
import { searchCatalog, history, bucket, SOURCE, frames } from '../src/market.mjs';
import { marketRead } from '../src/market-reads.mjs';
import { activityScope } from './observer.mjs';
import { requireThat as need } from './core.mjs';
export function deskRead(op, input, { s, archive, at, store, scope }) {
  const context = { venue: s.venue ?? 'synthetic', symbol: s.symbol, marketType: s.marketType, frame: s.frame };
  const binding = {
    ...context,
    ...Object.fromEntries(Object.entries(input).filter(([k]) => Object.hasOwn(context, k)))
  };
  const page = (a) => a.slice(input.offset ?? 0, (input.offset ?? 0) + (input.count ?? 100));
  if (op === 'desk.describe')
    return {
      versions: { trading: '0.14.0', skills: '0.10.0' },
      actions: deskActions,
      frames: Object.keys(frames),
      sources: [
        { id: SOURCE, venue: 'synthetic', quality: 'synthetic', hardCapUsd: 0 },
        ...(archive?.catalog ?? []).map((m) => ({
          id: m.source,
          venue: m.venue,
          marketType: m.marketType,
          quality: m.live ? 'public feed' : 'historical'
        }))
      ],
      context,
      resetPhrase: 'RESET PAPER SESSION'
    };
  if (op === 'read.catalog') {
    const synthetic = searchCatalog(input.query).flatMap((item) =>
      (input.marketType ? [input.marketType] : ['spot', 'perpetual']).map((marketType) => ({
        ...item,
        venue: 'synthetic',
        marketType
      }))
    );
    const historical = archive
      ? archive.catalog.filter(
          (m) =>
            (!input.marketType || input.marketType === m.marketType) &&
            m.symbol.toLowerCase().includes((input.query ?? '').toLowerCase())
        )
      : [];
    const rows =
      input.venue === 'synthetic'
        ? synthetic
        : input.venue
          ? historical.filter((m) => m.venue === input.venue)
          : [...synthetic, ...historical];
    return { rows: page(rows), total: rows.length, at, source: 'local catalog', warnings: [] };
  }
  const meta = store.read(activityScope(scope)).configs,
    overlay = meta.overlay;
  if (op === 'desk.history') return { rows: page([...s.fills].reverse()), total: s.fills.length };
  if (op === 'desk.activity')
    return {
      activity: [...(meta.activity ?? [])].reverse(),
      tab: meta.tab ?? 'market',
      research: meta.research ?? null
    };
  if (op === 'desk.chart') {
    const markers = overlay && Object.entries(binding).every(([k, v]) => overlay[k] === v) ? overlay.markers : [];
    if (binding.venue !== 'synthetic') {
      need(archive, 'ARCHIVE_REQUIRED');
      return { ...archive.read({ ...binding, ...input }), markers, studies: s.studies };
    }
    const before = input.before ?? at,
      count = input.count ?? 100;
    need(before <= at, 'INVALID_CURSOR');
    const closedThrough = bucket(before, binding.frame),
      bars = history(binding.symbol, binding.frame, closedThrough - 1, count);
    return {
      market: binding,
      source: SOURCE,
      bars,
      forming: input.before ? null : history(binding.symbol, binding.frame, at, 1)[0],
      nextBefore: bars[0].time,
      markers,
      studies: s.studies,
      at,
      warnings: ['Synthetic replay']
    };
  }
  if (['read.depth', 'read.tape', 'read.ticker'].includes(op)) {
    if (archive?.catalog.some((m) => m.venue === binding.venue && m.live))
      return archive.market(op, { ...binding, ...input });
    need(binding.venue === 'synthetic', 'ARCHIVE_MICROSTRUCTURE_UNAVAILABLE');
    const result = marketRead(op, binding, at);
    if (op === 'read.tape') {
      result.volumes = { buyer: 0, seller: 0 };
      for (const t of result.rows) result.volumes[t.aggressor] += t.amount;
      result.rows = page(result.rows);
    } else if (op === 'read.depth') {
      result.rows.bids = page(result.rows.bids);
      result.rows.asks = page(result.rows.asks);
    }
    return { ...result, market: binding, warnings: ['Synthetic replay'] };
  }
  throw Error('UNSUPPORTED');
}
