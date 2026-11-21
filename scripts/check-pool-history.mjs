// Compare two venue-bound runs with independent calculations from the retained publisher file.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runArtifact } from '../runtime/research-artifact.mjs';
import { dateRange } from '../runtime/research-data.mjs';

const [desk, source] = process.argv.slice(2);
if (!desk || !source) throw Error('Expected practice directory and original hourly Parquet path');
const directory = resolve(desk),
  root = join(directory, 'qualification');
mkdirSync(root, { recursive: true, mode: 0o700 });
const artifactDir = mkdtempSync(join(root, 'pool-'));
const range = dateRange({ start: '2022-01-01', end: '2024-06-30' }, Date.now());
for (const profile of [
  { hypothesis: 8, symbol: 'WETH.USDC', capital: 100000 },
  { hypothesis: 19, symbol: 'WBTC.WETH', basket: ['WBTC.WETH', 'USDC.WETH', 'DAI.WETH'], capital: 100 }
]) {
  const input = { ...profile, frame: '1d', marketType: 'spot', venue: 'uniswap-v3-500' };
  const run = (id) => runArtifact({ id, input, directory, artifactDir, range });
  const id = randomUUID(),
    cold = run(id),
    warm = run(randomUUID());
  if (
    cold.receipt.cached ||
    !warm.receipt.cached ||
    warm.receipt.originalRun !== id ||
    warm.receipt.scientificHash !== cold.receipt.scientificHash
  )
    throw Error('CACHE_PROVENANCE');
  const verifier = profile.hypothesis === 8 ? 'verify-pool-history.py' : 'verify-pool-rotation.py';
  const file = join(artifactDir, cold.receipt.scientificHash + '.json.gz');
  const independent = JSON.parse(
    execFileSync('python3', [fileURLToPath(new URL(verifier, import.meta.url)), resolve(source), file], {
      encoding: 'utf8'
    })
  );
  console.log(
    JSON.stringify({
      id,
      hypothesis: profile.hypothesis,
      quality: cold.status,
      warnings: cold.rows[0].warnings,
      artifact: file,
      cold: cold.receipt,
      warm: warm.receipt,
      independent
    })
  );
}
const suite = runArtifact({
  directory,
  artifactDir,
  id: randomUUID(),
  input: { venue: 'uniswap-v3-500', capital: 100000 },
  range: dateRange({}, Date.now())
});
if (
  suite.rows.length !== 20 ||
  suite.rows.some((r, i) => r.id !== i + 1 || (r.status === 'blocked' && (r.return !== null || !r.reason)))
)
  throw Error('SUITE_QUALIFICATION');
console.log(
  JSON.stringify({
    suite: 20,
    status: suite.status,
    receipt: suite.receipt,
    rows: suite.rows.map(({ id, status, reason }) => ({ id, status, reason }))
  })
);
