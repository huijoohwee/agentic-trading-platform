import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function pinnedOwner(root, manifest) {
  if (!root) throw new Error('Supply the path to the pinned native checkout');
  const cwd = resolve(root);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (revision !== manifest.revision || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Native checkout drift');
  const schemaDigest = createHash('sha256').update(readFileSync(resolve(cwd, manifest.schemaSource))).digest('hex');
  if (schemaDigest !== manifest.schemaDigest) throw new Error('Native schema drift');
  return { revision, schemaDigest, offline: true, costUsd: 0 };
}
