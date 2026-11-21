import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { serveAssets } from './local-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifests = await readFile(join(root, 'asset-manifest.json'));
const { files } = JSON.parse(manifests),
  assets = new Map([['asset-manifest.json', manifests]]);
for (const [name, digest] of Object.entries(files)) {
  if (name.split('/').some((part) => !part || part === '.' || part === '..') || name.includes('\\'))
    throw Error('Invalid asset path');
  const data = await readFile(join(root, name));
  if (createHash('sha256').update(data).digest('hex') !== digest) throw Error('Sealed asset changed: ' + name);
  assets.set(name, data);
}
const policy = JSON.parse(await readFile(join(root, 'server-policy.json'), 'utf8'));
const server = await serveAssets(Number(process.env.PORT ?? 4181), {
  assets,
  documentPolicy: policy,
  resourcePolicy: policy,
  practiceDirectory: join(root, '.runtime-private', 'desk')
});
console.log('Offline paper desk · http://127.0.0.1:' + server.address().port + '/desk.html');
