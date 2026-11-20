import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = [
  { repo: 'agentic-base', prefix: 'base', revision: '1323ed2d223ef0356293baf1c86eb4f28138150a',
    digest: '26495bae8a77de8727b731c1886c0bfc8e8387ad38e022b0306c2d0d4af7398c',
    paths: ['LICENSE', ...['index','schema','engine','errors','projectors','query','adapters/indexeddb','adapters/memory'].map(name => 'src/' + name + '.mjs')] },
  { repo: 'agentic-sheets', prefix: 'sheets', revision: '370b0698523b92ef569f27175a74c34a52c4a3f4',
    digest: 'e4e22c9918554853470984847528440dedbb4f099214e867284fcf2bcd17817d',
    paths: ['LICENSE', 'sheets/core.mjs', 'sheets/schema.mjs', 'sheets/formula.mjs'] },
  { repo: 'agentic-design-system', prefix: 'design', revision: 'cb062fec5d0923f8da74a9fae3dcabb73e608aa1',
    digest: '75975d464ca673dec85be2209c3929981d7cbff49800b37d20212082c3a3460b',
    paths: ['LICENSE', 'site/favicon.svg', 'site/vendor/shared-ui-profile.css', 'site/collection-layout.css', 'site/dashboard.mjs', 'site/THIRD-PARTY-NOTICES.txt'] },
];

export function ownerRoot() {
  if (process.env.TRADING_OWNER_ROOT) return resolve(process.env.TRADING_OWNER_ROOT);
  const common = execFileSync('git', ['rev-parse','--path-format=absolute','--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  return dirname(dirname(common));
}

export function verifyOwner(repo, sources) {
  const pin = pins.find(item => item.repo === repo);
  const inventory = [...sources.keys()].sort().map(name => name + ' ' + sha(sources.get(name)) + '\n').join('');
  if (!pin || sha(inventory) !== pin.digest) throw new Error('Owner bytes or inventory changed: ' + repo);
}

export function verifyImports(assets) {
  for (const [path, bytes] of assets) {
    if (!path.endsWith('.mjs')) continue;
    const source = bytes.toString();
    // The sealed modules use literal ESM specifiers exclusively.
    const references = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g;
    if (/\bimport\s*\(\s*(?!\s*['"])/.test(source)) throw new Error('Computed import in ' + path);
    for (const [, , ref] of source.matchAll(references)) {
      const target = new URL(ref, 'https://fixture.invalid/' + path);
      if (!ref.startsWith('.') || target.origin !== 'https://fixture.invalid' || !assets.has(target.pathname.slice(1))) {
        throw new Error('Unowned module in ' + path + ': ' + ref);
      }
    }
  }
}

export async function assemble({ devDocumentPolicy } = {}) {
  const assets = new Map();
  const workspace = ownerRoot();
  for (const pin of pins) {
    const sources = new Map(pin.paths.map(path => [path, execFileSync('git', ['show', pin.revision + ':' + path],
      { cwd: join(workspace, pin.repo), maxBuffer: 500000 })]));
    verifyOwner(pin.repo, sources);
    for (const [name, body] of sources) {
      const output = name === 'site/vendor/shared-ui-profile.css' ? 'profile.css' : name;
      assets.set('owners/' + pin.prefix + '/' + output, body);
    }
  }
  const files = ['web/index.html', 'web/journal.css', 'src/browser.mjs', 'src/dashboard.mjs', 'src/rules.mjs', 'src/tickets.mjs', 'src/fixture.json',
    'src/audit-view.mjs', 'src/local-audit.mjs', 'src/landing.mjs', 'src/audit-fixture.json',
    'src/forward-schedule.mjs', 'src/forward-rehearsal.mjs', 'src/competition-rules.mjs', 'src/replay.mjs', 'src/rehearsal-view.mjs', 'src/rehearsal.json'];
  for (const path of files) assets.set(path.replace(/^web\//, ''), await readFile(join(root, path)));
  if (devDocumentPolicy !== undefined) {
    const template = assets.get('index.html').toString();
    const policyTag = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/g;
    if ([...template.matchAll(policyTag)].length !== 1) throw new Error('Expected one document policy');
    // frame-ancestors is HTTP-only. Seal the effective Dev meta policy into the offline build ID.
    const metaPolicy = devDocumentPolicy.split('; ').filter(rule => !rule.startsWith('frame-ancestors ')).join('; ');
    assets.set('index.html', Buffer.from(template.replace(policyTag, (_, open, close) => open + metaPolicy + close)));
  }
  verifyImports(assets);
  const template = await readFile(join(root, 'web/sw.js'), 'utf8');
  const digests = Object.fromEntries([...assets].map(([path, bytes]) => [path, sha(bytes)]));
  const id = sha(template + JSON.stringify(digests));
  assets.set('sw.js', Buffer.from(template.replace("'__BUILD_ID__'", JSON.stringify(id)).replace("'__DIGESTS__'", JSON.stringify(digests))));
  assets.set('asset-manifest.json', Buffer.from(JSON.stringify({ id, owners: pins.map(({ repo, revision, digest }) =>
    ({ repo, revision, digest })), files: { ...digests, 'sw.js':sha(assets.get('sw.js')) } }, null, 2)));
  for (const [path, bytes] of assets) if (bytes.length >= 500000) throw new Error('Chunk budget exceeded: ' + path);
  return { id, assets };
}

export async function build() {
  const { id, assets } = await assemble();
  const base = join(root, '.local-build');
  await mkdir(base, { recursive: true });
  const destination = join(base, id);
  const stage = await mkdtemp(join(base, '.stage-'));
  try {
    for (const [name, body] of assets) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await writeFile(join(stage, name), body);
    }
    try { await rename(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const existing = await readdir(destination, { recursive: true, withFileTypes: true });
      if (existing.filter(entry => !entry.isDirectory()).length !== assets.size) throw new Error('Sealed inventory differs');
      for (const [name, body] of assets) {
        if (!body.equals(await readFile(join(destination, name)))) throw new Error('Sealed asset differs: ' + name);
      }
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { id, destination, assets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { destination } = await build();
  console.log(destination);
}
