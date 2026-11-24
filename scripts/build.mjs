import { deskProvenance, deskQuote, deskDepth, deskTape, deskCandles } from '../src/provider-desk.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gitCommand = (() => {
  const configured = process.env.GIT?.trim();
  const candidates = [
    configured,
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/opt/homebrew/bin/git',
    'git',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'git' || existsSync(candidate)) return candidate;
  }
  return 'git';
})();
export const gitExec = (args, options) => execFileSync(gitCommand, args, options);
const gitMissing = error => error?.code === 'ENOENT' && String(error?.syscall ?? '').startsWith('spawnSync ');
export function readPinnedBytes(repoRoot, revision, path, maxBuffer = 500000) {
  try {
    return gitExec(['show', revision + ':' + path], { cwd: repoRoot, maxBuffer });
  } catch (error) {
    if (!gitMissing(error)) throw error;
    return readFileSync(join(repoRoot, path));
  }
}
const pins = [
  { repo: 'agentic-base', prefix: 'base', revision: '2f891a6193b2f937275bd04f6b28dd8e67a98454',
    digest: 'd34cad984f1eb00fdfd2730d5be836f92368aabea4ec87f6510d53edc75a7614',
    paths: ['LICENSE', ...['index','schema','engine','errors','projectors','query','adapters/indexeddb','adapters/memory'].map(name => 'src/' + name + '.mjs'),
      'packages/views-react/dist/browser-data-view.js', 'packages/views-react/dist/browser-data-view.css'] },
  { repo: 'agentic-sheets', prefix: 'sheets', revision: '349b43ccadbec4edf107cfef9f0c09fc1715f9f2',
    digest: '067f22546a65190f7010830ba6b9d9d66b70dd1a67b1c9a32c504c128fb95c69',
    paths: ['LICENSE', 'sheets/core.mjs', 'sheets/schema.mjs', 'sheets/formula.mjs'] },
  { repo: 'agentic-design-system', prefix: 'design', revision: 'd60b569179c23a14418616abc265d22f2da00e30',
    digest: '7ab1b507fc91793c3df29e2d85e3e9cb04a3e9ed1097b8f6e146cf8c8fc93581',
    paths: ['LICENSE', 'site/favicon.svg', 'site/vendor/shared-ui-profile.css', 'site/collection-layout.css', 'site/dashboard.mjs', 'site/dashboard-range.mjs', 'site/dashboard-range.css', 'site/THIRD-PARTY-NOTICES.txt',
      'site/panel-section.js', 'site/panel-section.css', 'site/toolbar-icons.js', 'site/icons.json', 'site/key-type-value.js', 'site/floating-panel.js', 'site/floating-panel.css', 'site/hover.css',
      'site/skills-commands.js', 'site/skills-commands.css', 'site/collection-layout.js', 'site/toolbar.css'] },
  { repo: 'agentic-os', prefix: 'os', revision: 'eed72ec7597c94c95669cb537dda81c59596a0ed',
    digest: '95ae3322b49b5ae1475b692c477fbf5e9b33e5fafb2d23656b0c76ddc3889869',
    paths: ['LICENSE', 'catalog/invocation.json', 'skills/trading/SKILL.md'] },
];

export function ownerRoot() {
  if (process.env.TRADING_OWNER_ROOT) return resolve(process.env.TRADING_OWNER_ROOT);
  const common = gitExec(['rev-parse','--path-format=absolute','--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  return dirname(dirname(common));
}

export function verifyOwner(repo, sources) {
  const pin = pins.find(item => item.repo === repo);
  const inventory = [...sources.keys()].sort().map(name => name + ' ' + sha(sources.get(name)) + '\n').join('');
  if (!pin || sha(inventory) !== pin.digest) throw new Error('Owner bytes or inventory changed: ' + repo);
}

export function verifyImports(assets) {
  const modules = [...assets].filter(([path]) => /\.m?js$/.test(path)).map(([path, bytes]) => [path, bytes.toString()]);
  // Ask the same Node parser that loads our modules. Parsing never executes the source.
  const inspect = `const {SourceTextModule}=require('node:vm'),fs=require('node:fs');
    const modules=JSON.parse(fs.readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(modules.map(([name,src])=>new SourceTextModule(src,{identifier:name}).dependencySpecifiers)));`;
  const imports = JSON.parse(execFileSync(process.execPath, ['--no-warnings','--experimental-vm-modules','-e',inspect], {
    input: JSON.stringify(modules), maxBuffer: 2000000
  }));
  for (const [index,[path,source]] of modules.entries()) {
    if (/\bimport\s*\(\s*(?!\s*['"])/.test(source)) throw new Error('Computed import in ' + path);
    const dynamic = [...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)].map(match => match[2]);
    for (const ref of [...imports[index],...dynamic]) {
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
    const repoRoot = join(workspace, pin.repo);
    const sources = new Map(pin.paths.map(path => [path, readPinnedBytes(repoRoot, pin.revision, path)]));
    verifyOwner(pin.repo, sources);
    for (const [name, body] of sources) {
      const output = name === 'site/vendor/shared-ui-profile.css' ? 'profile.css' : name;
      assets.set('owners/' + pin.prefix + '/' + output, body);
    }
  }
  const files = ['web/observe.html','src/observer-view.mjs','web/desk.html', 'web/trading.css', 'web/desk.css', ...['desk-lab','research-catalog','desk-actions','landing-tools','contracts','market','market-reads','indicators','chart','experiment','strategy-language','scientific-packages','strategy-example','experiment-worker',
    'practice-account','practice-defaults','practice-cache','predictions','desk','desk-panels','desk-session'].map(name=>'src/'+name+'.mjs'), 'web/index.html', 'web/journal.css', 'src/browser.mjs', 'src/dashboard.mjs', 'src/rules.mjs', 'src/tickets.mjs', 'src/fixture.json',
    'src/audit-view.mjs', 'src/local-audit.mjs', 'src/landing.mjs', 'src/audit-fixture.json',
    'src/forward-schedule.mjs', 'src/forward-rehearsal.mjs', 'src/competition-rules.mjs', 'src/replay.mjs', 'src/rehearsal-view.mjs', 'src/rehearsal-dashboard.mjs', 'src/rehearsal-workbook.mjs', 'src/rehearsal-analysis.mjs', 'src/rehearsal-worksheets.mjs', 'src/rehearsal-tables.mjs', 'src/rehearsal.json', 'src/runtime-view.mjs', 'src/skills-toolbar.mjs', 'src/skills-panel.mjs', 'src/provider-coverage.mjs', 'src/coverage-view.mjs', 'src/provider-capture.mjs', 'src/capture-view.mjs', 'src/provider-hosted.mjs', 'src/hosted-view.mjs', 'src/moomoo-desk-view.mjs', 'src/desk-diagrams.mjs'];
  for (const path of files) assets.set(path.replace(/^web\//, ''), await readFile(join(root, path)));
  assets.set('qualification/moomoo/route-inventory.json',
    await readFile(new URL(import.meta.resolve('agentic-gateway/connectors/moomoo-catalog.json'))));
  const deskRows = { deskProvenance, deskQuote, deskDepth, deskTape, deskCandles };
  assets.set('src/provider-desk.mjs', Buffer.from(Object.entries(deskRows)
    .map(([name, value]) => 'export const ' + name + ' = ' + JSON.stringify(value) + ';').join('\n')));
  const toolbar = await readFile(join(root, 'web/trading-toolbar.html'), 'utf8');
  for (const [document, page] of [['index.html', 'journal'], ['desk.html', 'desk']]) {
    const html = assets.get(document).toString();
    const slot = '<!-- trading-toolbar -->';
    const active = 'data-page="' + page + '"';
    if (!html.includes(slot) || !toolbar.includes(active)) throw new Error('Missing toolbar binding for ' + document);
    assets.set(document, Buffer.from(html.replace(slot, toolbar.trimEnd().replace(active, active + ' aria-current="page"'))));
  }
  if (devDocumentPolicy !== undefined) {
    for (const document of ['index.html','desk.html','observe.html']) {
      const template = assets.get(document).toString();
      const policyTag = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/g;
      if ([...template.matchAll(policyTag)].length !== 1) throw new Error('Expected one document policy');
      // frame-ancestors is HTTP-only. Seal the effective Dev meta policy into the offline build ID.
      const metaPolicy = devDocumentPolicy.split('; ').filter(rule => !rule.startsWith('frame-ancestors ')).join('; ');
      assets.set(document, Buffer.from(template.replace(policyTag, (_, open, close) => open + metaPolicy + close)));
    }
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
