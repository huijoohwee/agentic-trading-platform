import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = [
  { repo: 'agentic-base', prefix: 'base', revision: '2f891a6193b2f937275bd04f6b28dd8e67a98454',
    digest: 'd34cad984f1eb00fdfd2730d5be836f92368aabea4ec87f6510d53edc75a7614',
    paths: ['LICENSE', ...['index','schema','engine','errors','projectors','query','adapters/indexeddb','adapters/memory'].map(name => 'src/' + name + '.mjs'),
      'packages/views-react/dist/browser-data-view.js', 'packages/views-react/dist/browser-data-view.css'] },
  { repo: 'agentic-sheets', prefix: 'sheets', revision: '349b43ccadbec4edf107cfef9f0c09fc1715f9f2',
    digest: '067f22546a65190f7010830ba6b9d9d66b70dd1a67b1c9a32c504c128fb95c69',
    paths: ['LICENSE', 'sheets/core.mjs', 'sheets/schema.mjs', 'sheets/formula.mjs'] },
  { repo: 'agentic-design-system', prefix: 'design', revision: '83de261f8f3ddf66ed41e5370b6811f498788b40',
    digest: 'c062e4a7ea4d2fac6eade9d7ac3fe71564606c16aaceb3b4af1b644ffc50436b',
    paths: ['LICENSE', 'site/favicon.svg', 'site/vendor/shared-ui-profile.css', 'site/collection-layout.css', 'site/dashboard.mjs', 'site/dashboard-range.mjs', 'site/dashboard-range.css', 'site/THIRD-PARTY-NOTICES.txt',
      'site/panel-section.js', 'site/panel-section.css', 'site/toolbar-icons.js', 'site/icons.json', 'site/key-type-value.js', 'site/floating-panel.js', 'site/floating-panel.css', 'site/hover.css',
      'site/skills-commands.js', 'site/skills-commands.css', 'site/collection-layout.js', 'site/toolbar.css'] },
  { repo: 'agentic-os', prefix: 'os', revision: '11c8fde490e1af2622d465ff2b98e7e1930095c3',
    digest: '18632317fcede344ee147a2dd1e02412359e9832dd91c9bd8714b229d292e7fd',
    paths: ['LICENSE', 'catalog/invocation.json', 'skills/trading/SKILL.md'] },
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
    if (!/\.m?js$/.test(path)) continue;
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
    'src/forward-schedule.mjs', 'src/forward-rehearsal.mjs', 'src/competition-rules.mjs', 'src/replay.mjs', 'src/rehearsal-view.mjs', 'src/rehearsal-dashboard.mjs', 'src/rehearsal-workbook.mjs', 'src/rehearsal-analysis.mjs', 'src/rehearsal-worksheets.mjs', 'src/rehearsal-tables.mjs', 'src/rehearsal.json', 'src/runtime-view.mjs', 'src/skills-panel.mjs'];
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
