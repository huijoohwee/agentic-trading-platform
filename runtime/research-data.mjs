import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sha, requireThat as need } from './core.mjs';
import { frames, bucket } from '../src/market.mjs';

const day = 86400000;
export function dateRange(inputs, now) {
  const month = new Date(now),
    cutoff = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1);
  const parse = (text) => {
    need(typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text), 'INVALID_DATE');
    const n = Date.parse(text + 'T00:00:00Z');
    need(Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === text, 'INVALID_DATE');
    return n;
  };
  const start = parse(inputs.start ?? '2021-01-01');
  const end = inputs.end ? parse(inputs.end) + day : cutoff;
  need(end > start && end <= Math.floor(now / day) * day && end - start <= day * 366 * 20, 'INVALID_DATE_RANGE');
  return { start, end, endExclusive: true, cutoff: end };
}
function localBytes(dir, file, limit) {
  need(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,140}$/.test(file), 'ARCHIVE_PATH');
  const path = join(dir, file),
    info = lstatSync(path);
  need(info.isFile() && !info.isSymbolicLink() && info.size <= limit, 'ARCHIVE_BUDGET');
  return readFileSync(path);
}
const kinds = [
  'ohlcv',
  'funding',
  'openInterest',
  'taker',
  'liquidations',
  'depth',
  'trades',
  'options',
  'liquidity'
];
const finite = Number.isFinite;
function verifyRow(row, part) {
  need(Number.isSafeInteger(row.time) && row.time >= 0, 'ARCHIVE_TIME');
  if (part.kind === 'depth') {
    need(
      part.mapping === 'top10-snapshot/v1' &&
        Number.isSafeInteger(row.sequence) &&
        row.sequence >= 0 &&
        finite(row.tickSize) &&
        row.tickSize > 0,
      'ARCHIVE_DEPTH_MAPPING'
    );
    for (const [key, sign] of [
      ['bids', -1],
      ['asks', 1]
    ])
      need(
        Array.isArray(row[key]) &&
          row[key].length >= 10 &&
          row[key].every(
            (v, i) =>
              Array.isArray(v) &&
              v.length === 2 &&
              v.every((n) => finite(n) && n > 0) &&
              (!i || sign * (v[0] - row[key][i - 1][0]) > 0)
          ),
        'ARCHIVE_DEPTH_MAPPING'
      );
    need(row.asks[0][0] > row.bids[0][0], 'ARCHIVE_CROSSED_BOOK');
  }
  if (part.kind === 'trades')
    need(
      part.mapping === 'aggressor-trade/v1' &&
        ['buyer', 'seller'].includes(row.aggressor) &&
        [row.qty, row.price].every((v) => finite(v) && v > 0),
      'ARCHIVE_TRADE_MAPPING'
    );
  if (part.kind === 'liquidations')
    need(
      part.mapping === 'liquidation-event/v1' && finite(row.notional) && row.notional > 0,
      'ARCHIVE_LIQUIDATION_MAPPING'
    );
  if (part.kind === 'liquidity') need(typeof row.liquid === 'boolean', 'ARCHIVE_LIQUIDITY');
  if (part.kind === 'options')
    need(
      part.mapping === 'option-chain-usd/v1' &&
        Array.isArray(row.quotes) &&
        new Set(row.quotes.map((q) => q.id)).size === row.quotes.length &&
        row.quotes.every(
          (q) =>
            typeof q.id === 'string' &&
            ['call', 'put'].includes(q.kind) &&
            Number.isSafeInteger(q.expiry) &&
            q.expiry > row.time &&
            [q.strike, q.iv, q.ask].every((v) => finite(v) && v > 0) &&
            finite(q.bid) &&
            q.bid >= 0 &&
            q.ask >= q.bid &&
            finite(q.delta) &&
            Math.abs(q.delta) <= 1
        ),
      'ARCHIVE_OPTION_MAPPING'
    );
  if (part.kind === 'ohlcv')
    need(
      [row.open, row.high, row.low, row.close].every((p) => finite(p) && p > 0) &&
        row.high >= Math.max(row.close, row.open) &&
        row.low <= Math.min(row.close, row.open) &&
        finite(row.volume) &&
        row.volume >= 0 &&
        bucket(row.time, part.frame) === row.time,
      'ARCHIVE_OHLCV'
    );
  if (part.kind === 'funding')
    need(
      finite(row.rate) &&
        (row.price === undefined || (finite(row.price) && row.price > 0)) &&
        row.settled === true,
      'ARCHIVE_FUNDING'
    );
  if (part.kind === 'openInterest') need(finite(row.value) && row.value >= 0, 'ARCHIVE_OI');
  if (part.kind === 'taker')
    need(
      [row.buy, row.sell].every((v) => finite(v) && v >= 0),
      'ARCHIVE_TAKER'
    );
}
export function partitionInventory(directory) {
  const dir = join(directory, 'partitions');
  if (!existsSync(join(dir, 'manifest.json'))) return [];
  const manifest = JSON.parse(localBytes(dir, 'manifest.json', 499999));
  need(
    manifest.schema === 'trading-partitions/v1' &&
      manifest.timeUnit === 'UTC_ms' &&
      Array.isArray(manifest.partitions) &&
      manifest.partitions.length <= 4096,
    'ARCHIVE_MANIFEST'
  );
  for (const part of manifest.partitions) {
    need(
      kinds.includes(part.kind) &&
        (['CC0-1.0', 'CC-BY-4.0', 'ODC-PDDL-1.0'].includes(part.license) ||
          (part.license === 'MIT' &&
            part.creator === 'Hyperliquid' &&
            part.venue === 'hyperliquid' &&
            part.source === 'https://registry.opendata.aws/aws-public-blockchain/' &&
            part.upstreamPrefix ===
              'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/hyperliquid/mainnet/' &&
            part.licenseUrl === 'https://github.com/aws-samples/digital-assets-examples/blob/main/LICENSE' &&
            /^[a-f0-9]{64}$/.test(part.upstreamInventorySha256))) &&
        part.creator &&
        part.source &&
        /^[a-f0-9]{64}$/.test(part.sha256) &&
        typeof part.venue === 'string' &&
        /^[A-Z0-9]+\.[A-Z0-9]+$/.test(part.symbol) &&
        ['spot', 'perpetual', 'option'].includes(part.marketType) &&
        Number.isSafeInteger(part.first) &&
        Number.isSafeInteger(part.last) &&
        part.last >= part.first,
      'ARCHIVE_RIGHTS_OR_BINDING'
    );
    if (part.kind === 'ohlcv') need(Object.hasOwn(frames, part.frame), 'ARCHIVE_INTERVAL');
  }
  return manifest.partitions;
}
export function loadData(directory, range, { parts = partitionInventory(directory), warmup = 366 * day } = {}) {
  const dir = join(directory, 'partitions'),
    sources = [],
    series = new Map();
  let bytes = 0;
  for (const part of parts) {
    if (part.last < range.start - warmup || part.first >= range.end) continue;
    const body = localBytes(dir, part.file, 499999);
    bytes += body.length;
    need(bytes <= 96000000, 'RESEARCH_BYTE_LIMIT');
    need(sha(body) === part.sha256, 'ARCHIVE_DIGEST_MISMATCH');
    const rows = JSON.parse(body);
    need(
      Array.isArray(rows) && rows.length > 0 && rows[0].time === part.first && rows.at(-1).time === part.last,
      'ARCHIVE_SPAN'
    );
    const key = [part.venue, part.symbol, part.marketType, part.kind, part.frame ?? ''].join('/');
    let lane = series.get(key);
    if (!lane) series.set(key, (lane = { ...part, rows: [], gaps: 0, duplicates: 0 }));
    for (const row of rows) {
      verifyRow(row, part);
      if (row.time >= range.start - warmup && row.time < range.end) lane.rows.push(row);
    }
    sources.push({ ...part, rows: rows.length, timeUnit: 'UTC_ms' });
  }
  for (const lane of series.values()) {
    lane.rows.sort((a, b) => a.time - b.time || (a.sequence ?? 0) - (b.sequence ?? 0));
    for (let i = 1; i < lane.rows.length; i++) {
      const a = lane.rows[i - 1],
        b = lane.rows[i];
      need(
        a.time !== b.time ||
          (lane.kind === 'trades' &&
            Number.isSafeInteger(a.sequence) &&
            Number.isSafeInteger(b.sequence) &&
            a.sequence >= 0 &&
            b.sequence > a.sequence),
        'ARCHIVE_DUPLICATE'
      );
      if (lane.kind === 'depth') need(b.sequence === a.sequence + 1, 'ARCHIVE_DEPTH_SEQUENCE');
      if (lane.kind === 'ohlcv' && bucket(a.time, lane.frame, 1) !== b.time) lane.gaps++;
    }
  }
  return { sources, series };
}
export function asOf(rows, time, maxAge) {
  if (!rows) return null;
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (rows[m].time <= time) lo = m + 1;
    else hi = m;
  }
  const found = rows[lo - 1];
  return found && time - found.time <= maxAge ? found : null;
}
