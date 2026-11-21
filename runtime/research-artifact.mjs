import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, linkSync, unlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha, canonical, requireThat as need } from './core.mjs';
import { loadData, partitionInventory } from './research-data.mjs';
import { historicalReport } from './research-engine.mjs';
const sources = [
  './research-engine.mjs',
  './research-events.mjs',
  './research-signals.mjs',
  './research-portfolio.mjs',
  './research-statistics.mjs',
  './research-data.mjs',
  '../src/research-catalog.mjs',
  '../src/indicators.mjs',
  '../src/market.mjs'
];
export const engine = sha(sources.map((p) => [p, sha(readFileSync(new URL(p, import.meta.url)))]));
const max = 128000000;
function atomic(path, bytes) {
  const tmp = path + '.' + randomUUID();
  writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  } finally {
    unlinkSync(tmp);
  }
}
function bounded(path, limit) {
  const s = lstatSync(path);
  need(s.isFile() && !s.isSymbolicLink() && s.size <= limit, 'ARTIFACT_INTEGRITY');
  return readFileSync(path);
}
export function verifiedBytes(dir, receipt) {
  need(
    /^[a-f0-9]{64}$/.test(receipt?.scientificHash) && /^[a-f0-9]{64}$/.test(receipt?.compressedHash),
    'ARTIFACT_INTEGRITY'
  );
  const zipped = bounded(join(dir, receipt.scientificHash + '.json.gz'), max);
  need(sha(zipped) === receipt.compressedHash, 'ARTIFACT_INTEGRITY');
  return zipped;
}
export function readArtifact(dir, receipt) {
  need(
    /^[a-f0-9]{64}$/.test(receipt?.scientificHash) && /^[a-f0-9]{64}$/.test(receipt?.compressedHash),
    'ARTIFACT_INTEGRITY'
  );
  try {
    const zipped = verifiedBytes(dir, receipt);
    const bytes = gunzipSync(zipped, { maxOutputLength: max });
    need(sha(bytes) === receipt.scientificHash, 'ARTIFACT_INTEGRITY');
    const parsed = JSON.parse(bytes);
    need(parsed.inputHash === receipt.inputHash, 'ARTIFACT_INTEGRITY');
    return parsed;
  } catch {
    throw Error('ARTIFACT_INTEGRITY');
  }
}
export function runArtifact({ directory, artifactDir, input, range, id }) {
  const venue = input.venue ?? 'uniswap-v3-500';
  const parts = partitionInventory(directory).filter(
    (p) => p.venue === venue || (p.venue === input.spotVenue && p.marketType === 'spot' && p.kind === 'ohlcv')
  );
  const data = loadData(directory, range, { parts }),
    inputHash = sha({ engine, input, range, sources: data.sources });
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const index = join(artifactDir, inputHash + '.index');
  let cached = existsSync(index);
  if (!cached) {
    const artifact = { inputHash, ...historicalReport({ input, range, data, engine }) },
      bytes = Buffer.from(canonical(artifact));
    need(bytes.length <= max, 'ARTIFACT_BYTE_LIMIT');
    const scientificHash = sha(bytes),
      zipped = gzipSync(bytes, { level: 6 }),
      compressedHash = sha(zipped);
    atomic(join(artifactDir, scientificHash + '.json.gz'), zipped);
    cached = !atomic(index, JSON.stringify({ inputHash, scientificHash, compressedHash, originalRun: id }));
  }
  const receipt = JSON.parse(bounded(index, 2048));
  need(receipt.inputHash === inputHash, 'ARTIFACT_INTEGRITY');
  const artifact = readArtifact(artifactDir, receipt);
  return {
    receipt: { ...receipt, cached, engine },
    status: artifact.status,
    rows: artifact.rows.map(({ curve, trades, signals, rebalances, latencyScenarios, ...summary }) => ({
      ...summary,
      ...(latencyScenarios
        ? {
            latencyScenarios: latencyScenarios.map(({ latency, trades, finalEquity }) => ({
              latency,
              tradeCount: trades.length,
              finalEquity
            }))
          }
        : {}),
      signals: signals.length,
      curvePoints: curve?.length ?? 0,
      rebalances: rebalances?.length ?? 0
    }))
  };
}
