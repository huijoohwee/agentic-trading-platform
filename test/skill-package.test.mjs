import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync,
  symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inspector = join(root, 'scripts/inspect-skill.py');
const packager = join(root, 'scripts/package-skill.py');
const hash = value => createHash('sha256').update(value).digest('hex');
const py = (code, args = [], input) => spawnSync('python3', ['-B', '-c', code, ...args],
  { encoding: 'utf8', input, maxBuffer: 5_000_000 });
const cli = (script, args) => spawnSync('python3', ['-B', script, ...args],
  { encoding: 'utf8', maxBuffer: 5_000_000 });
const probe = py(`import importlib.util,json
missing=[m for m in ('yaml','markdown_it') if importlib.util.find_spec(m) is None]
if not missing:
 import yaml
 from markdown_it import MarkdownIt
print(json.dumps(missing))`);
assert.equal(probe.status, 0, probe.stderr || String(probe.error));
const missing = JSON.parse(probe.stdout);
const optional = { skip: missing.length ? `Optional libraries genuinely absent: ${missing.join(', ')}` : false };
const good = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
const bad = (result, reason) => {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, reason);
};
const core = (code, args = []) => py(`import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('package_skill',sys.argv[1])
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
${code}`, [packager, ...args]);
function scratch(t) {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'skill-package-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function zip(path, entries, options = {}) {
  const result = py(`import io,json,stat,sys,zipfile
spec=json.loads(sys.stdin.read()); buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED if spec.get('deflated') else zipfile.ZIP_STORED) as z:
 for e in spec['entries']:
  i=zipfile.ZipInfo(e['name']);i.create_system=3;i.compress_type=z.compression
  i.external_attr=e.get('mode',stat.S_IFREG|0o644)<<16
  z.writestr(i,('x'*e['size'] if 'size' in e else e.get('data','fixture')).encode())
body=bytearray(buf.getvalue())
if spec.get('corrupt'):
 offset=30+int.from_bytes(body[26:28],'little')+int.from_bytes(body[28:30],'little')
 body[offset]^=1
with open(sys.argv[1],'xb') as f:f.write(body)
`, [path], JSON.stringify({ entries, ...options }));
  assert.equal(result.status, 0, result.stderr);
}
const skill = (name = 'rehearse', description = 'Local synthetic fixture.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\nNever bypass the safety guard.\n`;
const baseEntries = () => [{ name: 'rehearse/SKILL.md', data: skill() }];
function fixture(t, { external = true } = {}) {
  const dir = scratch(t);
  const source = join(dir, 'source.zip');
  const reviewPath = join(dir, 'review.json');
  const output = join(dir, 'result.zip');
  const entry = 'upstream/skills/rehearse/SKILL.md';
  const before = '../../shared/notice.md';
  const content = skill() + (external ? `Read [safety](${before}).\n` : 'No external resources.\n');
  const files = {
    [entry]: content,
    'upstream/skills/rehearse/scripts/check.py': 'raise RuntimeError("Never execute this fixture")\n',
    'upstream/shared/notice.md': 'Do not trade or infer permission.\n',
  };
  zip(source, Object.entries(files).map(([name, data]) => ({ name, data })));
  const rights = 'Synthetic fixture authored for tests; local packaging allowed.';
  const runtime = 'Synthetic review: no dependencies, credentials, cost, execution or provider effect.';
  writeFileSync(join(dir, 'rights.txt'), rights);
  writeFileSync(join(dir, 'runtime.txt'), runtime);
  const review = {
    schema: 'skill-package-review/v1',
    upstream: { repository: 'synthetic:test-only', revision: '1'.repeat(40) },
    name: 'rehearse', skill_path: 'upstream/skills/rehearse',
    source_sha256: hash(readFileSync(source)),
    source_files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, hash(data)])),
    review: {
      owner: 'synthetic-test-reviewer', observed_at: '2026-11-01T00:00:00Z',
      rights: { decision: 'approved', evidence: [{ path: 'rights.txt', sha256: hash(rights) }] },
      runtime: { decision: 'compatible', transport: 'none:synthetic', authentication: 'none',
        cost: 'reviewed', direct_write: false, dependencies: [],
        evidence: [{ path: 'runtime.txt', sha256: hash(runtime) }] },
    },
    relocations: external ? { 'upstream/shared/notice.md': 'references/notice.md' } : {},
    link_edits: external ? [{ path: entry, offset: Buffer.from(content).indexOf(before),
      before, after: 'references/notice.md' }] : [],
  };
  const save = () => writeFileSync(reviewPath, JSON.stringify(review));
  save();
  const run = (out = output, sourcePath = source, extra = []) => cli(packager,
    ['--source', sourcePath, '--review', reviewPath, '--output', out, ...extra]);
  return { dir, source, reviewPath, output, files, review, save, run, entry };
}
const stageCode = `review,_=p.load_review(Path(sys.argv[3]))
files=p.source_files(Path(sys.argv[2]),None,review)
staged,mapping,diffs=p.stage(files,review)
body=p.zip_bytes(staged)
print(json.dumps(dict(sha256=p.inspector.digest(body),inventory=p.inspector.inventory(staged),
 mapping=mapping,diffs=diffs,bytes=body.hex(),skill=staged['rehearse/SKILL.md'].decode())))`;

test('stdlib staging is deterministic, source-pinned and preserves safety bytes', t => {
  const f = fixture(t);
  const originals = [f.source, f.reviewPath].map(path => readFileSync(path));
  const first = good(core(stageCode, [f.source, f.reviewPath]));
  const second = good(core(stageCode, [f.source, f.reviewPath]));
  assert.deepEqual(first, second);
  assert.equal(first.skill, f.files[f.entry].replace('../../shared/notice.md', 'references/notice.md'));
  assert.equal(first.inventory['rehearse/references/notice.md'], hash(f.files['upstream/shared/notice.md']));
  assert.equal(first.inventory['rehearse/scripts/check.py'], hash(f.files['upstream/skills/rehearse/scripts/check.py']));
  assert.equal(first.diffs.length, 1);
  assert.match(first.diffs[0].diff, /-Read \[safety\].*\n\+Read \[safety\]/);
  [f.source, f.reviewPath].forEach((path, i) => assert.deepEqual(readFileSync(path), originals[i]));
  assert.equal(existsSync(f.output), false);
});

test('review/source gates fail closed without optional parser dependencies', async t => {
  const cases = [
    ['rights absent', f => delete f.review.review.rights, /rights decision/],
    ['rights unknown', f => f.review.review.rights.decision = 'unknown', /rights decision/],
    ['rights bare acceptance', f => f.review.review.rights = { decision: 'approved' }, /review evidence/],
    ['runtime incompatible', f => f.review.review.runtime.decision = 'unknown', /Compatible runtime/],
    ['unsafe direct write', f => f.review.review.runtime.direct_write = true, /direct-write/],
    ['unknown cost', f => f.review.review.runtime.cost = 'unknown', /cost/],
    ['unpinned dependency', f => f.review.review.runtime.dependencies = [{ name: 'cli', version: 'latest' }], /exact dependency/],
    ['missing owner', f => delete f.review.review.owner, /owner/],
    ['missing time zone', f => f.review.review.observed_at = '2026-11-01', /timezone/],
    ['candidate revision', f => f.review.upstream.revision = 'latest', /Exact upstream/],
    ['short revision', f => f.review.upstream.revision = '123abcd', /Exact upstream/],
    ['missing inventory', f => delete f.review.source_files, /inventory/],
    ['source digest drift', f => f.review.source_sha256 = '0'.repeat(64), /source digest mismatch/],
    ['source inventory drift', f => f.review.source_files[f.entry] = '0'.repeat(64), /inventory mismatch/],
    ['unreviewed file', f => delete f.review.source_files['upstream/shared/notice.md'], /inventory mismatch/],
    ['evidence drift', f => writeFileSync(join(f.dir, 'rights.txt'), 'changed'), /evidence digest mismatch/],
    ['evidence traversal', f => f.review.review.rights.evidence[0].path = '../rights.txt', /Unsafe member/],
    ['evidence symlink', f => { rmSync(join(f.dir, 'rights.txt')); symlinkSync('runtime.txt', join(f.dir, 'rights.txt')); }, /symbolic links|Too many levels/i],
    ['missing relocation mapping', f => delete f.review.relocations, /relocation map/],
    ['relocation traversal', f => f.review.relocations['upstream/shared/notice.md'] = '../outside', /Unsafe member/],
    ['unknown relocated source', f => f.review.relocations.unknown = 'references/unknown', /external source/],
    ['colliding relocated target', f => f.review.relocations['upstream/shared/notice.md'] = 'scripts/check.py', /Duplicate/],
    ['unreviewed safety edit', f => { f.review.link_edits[0].offset = 0; f.review.link_edits[0].before = '---'; }, /reviewed link destinations/],
    ['link retargeting', f => f.review.link_edits[0].after = 'scripts/check.py', /preserve the mapped resource/],
    ['remote link rewrite', f => f.review.link_edits[0].after = 'https://example.test/notice', /preserve the mapped resource/],
    ['changed anchor', f => f.review.link_edits[0].after += '#changed', /preserve query and fragment/],
    ['overlapping edits', f => f.review.link_edits.push({ ...f.review.link_edits[0] }), /nonoverlapping/],
  ];
  for (const [name, change, reason] of cases) await t.test(name, t => {
    const f = fixture(t); change(f); f.save();
    bad(f.run(), reason);
    assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(f.output + '.manifest.json'), false);
  });
});

test('unexpected selected files are rejected rather than silently dropped', t => {
  const f = fixture(t);
  f.files['upstream/skills/rehearse/unreviewed.txt'] = 'Do not silently discard source bytes.';
  rmSync(f.source); zip(f.source, Object.entries(f.files).map(([name, data]) => ({ name, data })));
  f.review.source_sha256 = hash(readFileSync(f.source));
  f.review.source_files['upstream/skills/rehearse/unreviewed.txt'] = hash(f.files['upstream/skills/rehearse/unreviewed.txt']);
  f.save(); bad(f.run(), /only SKILL.md and references\/scripts\/assets/);
  assert.equal(existsSync(f.output), false);
});

test('duplicate JSON review keys and missing required CLI arguments are rejected', t => {
  const f = fixture(t);
  writeFileSync(f.reviewPath, '{"schema":"skill-package-review/v1","schema":"skill-package-review/v1"}');
  bad(f.run(), /Duplicate review JSON key/);
  bad(cli(packager, ['--source', f.source, '--output', f.output]), /--review/);
  bad(cli(packager, ['--s', f.source, '--review', f.reviewPath, '--output', f.output]), /required|unrecognized/);
});

test('tree snapshots require retained ZIP and exact complete inventory', t => {
  const f = fixture(t, { external: false });
  const tree = join(f.dir, 'tree'); mkdirSync(tree);
  for (const [name, data] of Object.entries(f.files)) {
    mkdirSync(dirname(join(tree, name)), { recursive: true }); writeFileSync(join(tree, name), data);
  }
  const code = `review,_=p.load_review(Path(sys.argv[4]))
files=p.source_files(Path(sys.argv[2]),Path(sys.argv[3]),review)
print(json.dumps(p.inspector.inventory(files)))`;
  assert.deepEqual(good(core(code, [tree, f.source, f.reviewPath])), f.review.source_files);
  bad(f.run(f.output, tree), /requires retained/);
  bad(f.run(join(tree, 'output.zip'), tree, ['--source-archive', f.source]), /outside source tree/);
  writeFileSync(join(tree, f.entry), 'mutated');
  bad(core(code, [tree, f.source, f.reviewPath]), /tree inventory mismatch/);
  writeFileSync(join(tree, f.entry), f.files[f.entry]);
  symlinkSync(join(tree, f.entry), join(tree, 'linked'));
  bad(core(code, [tree, f.source, f.reviewPath]), /symlink/);
});

test('inspector subprocess rejects hostile ZIP paths, types, secrets and corruption', async t => {
  const cases = [
    ['traversal', { name: 'rehearse/../outside' }, /Unsafe member/],
    ['absolute', { name: '/outside' }, /Unsafe member/],
    ['backslash', { name: 'rehearse\\outside' }, /Unsafe member/],
    ['drive path', { name: 'C:/outside' }, /Unsafe member/],
    ['empty segment', { name: 'rehearse//outside' }, /Unsafe member/],
    ['dot segment', { name: 'rehearse/./outside' }, /Unsafe member/],
    ['control character', { name: 'rehearse/\u0001bad' }, /Unsafe member/],
    ['symlink', { name: 'rehearse/link', mode: 0o120777 }, /member type/],
    ['FIFO', { name: 'rehearse/pipe', mode: 0o010644 }, /member type/],
    ['directory bytes', { name: 'rehearse/dir/', mode: 0o040755 }, /member type/],
    ['duplicate', { name: 'rehearse/SKILL.md' }, /Duplicate/],
    ['case duplicate', { name: 'rehearse/skill.md' }, /Duplicate|Casefold/],
    ['file directory conflict', { name: 'rehearse/SKILL.md/child' }, /file-directory conflict/],
    ['folded directory conflict', { name: 'REHEARSE/other' }, /Casefold/],
    ['git', { name: 'rehearse/.git/config' }, /Git\/OS/],
    ['folded git', { name: 'rehearse/.GIT/config' }, /Git\/OS/],
    ['OS debris', { name: 'rehearse/__MACOSX/metadata' }, /Git\/OS/],
    ['environment', { name: 'rehearse/.env.production' }, /Private file/],
    ['private key file', { name: 'rehearse/private.PEM' }, /Private file/],
    ['credential file', { name: 'rehearse/credentials.json' }, /Private file/],
    ['private key bytes', { name: 'rehearse/notes.txt', data: '-----BEGIN PRIVATE KEY-----' }, /Secret material/],
    ['token bytes', { name: 'rehearse/notes.txt', data: 'ghp_' + 'a'.repeat(32) }, /Secret material/],
    ['embedded credential', { name: 'rehearse/notes.txt', data: 'api_key=' + 'z'.repeat(32) }, /Secret material/],
  ];
  for (const [name, entry, reason] of cases) await t.test(name, t => {
    const path = join(scratch(t), 'unsafe.zip'); zip(path, [...baseEntries(), entry]);
    bad(cli(inspector, [path]), reason);
  });
  await t.test('NUL member path', t => {
    const path = join(scratch(t), 'nul.zip'); zip(path, [{ name: 'rehearse/unsafeXname', data: 'test' }]);
    const body = readFileSync(path), marker = Buffer.from('unsafeXname');
    for (let at = body.indexOf(marker); at !== -1; at = body.indexOf(marker, at + 1)) body[at + 6] = 0;
    writeFileSync(path, body); bad(cli(inspector, [path]), /member type/);
  });
  await t.test('encrypted member flag', t => {
    const path = join(scratch(t), 'encrypted.zip'); zip(path, baseEntries());
    const body = readFileSync(path), central = body.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    body[6] |= 1; body[central + 8] |= 1; writeFileSync(path, body);
    bad(cli(inspector, [path]), /member type/);
  });
  await t.test('multiple skills', t => {
    const path = join(scratch(t), 'multiple.zip');
    zip(path, [...baseEntries(), { name: 'second/SKILL.md', data: skill('second') }]);
    bad(cli(inspector, [path]), /one top-level/);
  });
  await t.test('nested skill', t => {
    const path = join(scratch(t), 'nested.zip');
    zip(path, [...baseEntries(), { name: 'rehearse/nested/SKILL.md', data: skill() }]);
    bad(cli(inspector, [path]), /one SKILL.md/);
  });
  await t.test('CRC corruption', t => {
    const path = join(scratch(t), 'corrupt.zip'); zip(path, baseEntries(), { corrupt: true });
    bad(cli(inspector, [path]), /CRC/);
  });
  await t.test('truncated ZIP', t => {
    const path = join(scratch(t), 'truncated.zip'); writeFileSync(path, 'PK broken');
    bad(cli(inspector, [path]), /not a zip file/);
  });
  await t.test('archive symlink', t => {
    const dir = scratch(t); zip(join(dir, 'original.zip'), baseEntries());
    symlinkSync('original.zip', join(dir, 'link.zip'));
    bad(cli(inspector, [join(dir, 'link.zip')]), /symbolic links|Too many levels/i);
  });
});

test('credential stores are rejected by path even with whitespace-style passwords', async t => {
  const data = 'machine example.test login fixture password synthetic-password\n';
  // This syntax deliberately does not match SECRET; the path gate must reject it.
  assert.equal(good(core(`p.inspector.check_secret(sys.argv[2].encode())
print(json.dumps(True))`, [data])), true);
  const paths = ['.netrc', '_netrc', '.git-credentials', 'references/.NETRC', 'scripts/_NETRC',
    '.dockercfg', '.docker/config.json', '.boto', '.s3cfg', '.pgpass', 'pgpass.conf',
    '.my.cnf', '.mylogin.cnf', '.config/gcloud/application_default_credentials.json',
    '.config/gcloud/credentials.db', '.config/gcloud/access_tokens.db'];
  for (const name of paths) await t.test(name, t => {
    const path = join(scratch(t), 'credential.zip');
    zip(path, [...baseEntries(), { name: `rehearse/${name}`, data }]);
    bad(cli(inspector, [path]), /Private file/);
  });
  await t.test('review inventory rejects credential paths before reading source bytes', t => {
    const f = fixture(t);
    f.review.source_files['upstream/skills/rehearse/references/.netrc'] = hash(data);
    f.save();
    bad(f.run(), /Private file/);
    assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(f.output + '.manifest.json'), false);
  });
  assert.equal(good(core(`for name in ('rehearse/references/authentication.md', 'rehearse/assets/config.json'):
 p.inspector.clean_path(name)
print(json.dumps(True))`)), true);
});

test('inspector enforces compressed, expanded and entry-count boundaries', async t => {
  await t.test('exact compressed limit', t => {
    const path = join(scratch(t), 'large.zip'); writeFileSync(path, Buffer.alloc(50_000_000));
    bad(cli(inspector, [path]), /below byte limit/);
  });
  await t.test('exact expanded limit', t => {
    const path = join(scratch(t), 'large-expanded.zip');
    zip(path, [{ name: 'rehearse/SKILL.md', size: 50_000_000 }], { deflated: true });
    bad(cli(inspector, [path]), /inspection budget/);
  });
  await t.test('too many entries', t => {
    const path = join(scratch(t), 'many.zip');
    zip(path, Array.from({ length: 4097 }, (_, i) => ({ name: `rehearse/file${i}`, data: '' })));
    bad(cli(inspector, [path]), /inspection budget/);
  });
  await t.test('empty archive', t => {
    const path = join(scratch(t), 'empty.zip'); zip(path, []);
    bad(cli(inspector, [path]), /inspection budget/);
  });
});

test('stdlib boundaries accept 4096 entries and strictly sub-limit expanded bytes', t => {
  const dir = scratch(t), entries = join(dir, 'entries.zip'), bytes = join(dir, 'bytes.zip');
  zip(entries, Array.from({ length: 4096 }, (_, i) => ({ name: `rehearse/file${i}`, data: '' })));
  zip(bytes, [{ name: 'rehearse/data', size: 49_999_999 }], { deflated: true });
  const code = `files,_=p.inspector.read_zip(p.inspector.read_local(Path(sys.argv[2])))
print(json.dumps(dict(count=len(files),bytes=sum(map(len,files.values())))))`;
  assert.equal(good(core(code, [entries])).count, 4096);
  assert.equal(good(core(code, [bytes])).bytes, 49_999_999);
});

test('exclusive output pair writes both files with no replacement', t => {
  const output = join(scratch(t), 'new.zip');
  good(core(`sidecar=p.write_pair(Path(sys.argv[2]),b'archive',b'manifest')
print(json.dumps(str(sidecar)))`, [output]));
  assert.equal(readFileSync(output, 'utf8'), 'archive');
  assert.equal(readFileSync(output + '.manifest.json', 'utf8'), 'manifest');
});

test('exclusive output pair never overwrites existing files or follows symlinks', async t => {
  for (const kind of ['archive', 'manifest', 'symlink', 'parent-symlink']) await t.test(kind, t => {
    const dir = scratch(t), output = join(dir, 'new.zip'), sidecar = output + '.manifest.json';
    const target = join(dir, 'original'); writeFileSync(target, 'unchanged');
    let destination = output;
    if (kind === 'archive') writeFileSync(output, 'original archive');
    if (kind === 'manifest') writeFileSync(sidecar, 'original manifest');
    if (kind === 'symlink') symlinkSync(target, output);
    if (kind === 'parent-symlink') {
      mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'alias'));
      destination = join(dir, 'alias', 'new.zip');
    }
    bad(core(`p.write_pair(Path(sys.argv[2]),b'new archive',b'new manifest')`, [destination]),
      /File exists|symbolic links|Not a directory|Too many levels/i);
    assert.equal(readFileSync(target, 'utf8'), 'unchanged');
    if (kind === 'archive') assert.equal(readFileSync(output, 'utf8'), 'original archive');
    if (kind === 'manifest') {
      assert.equal(readFileSync(sidecar, 'utf8'), 'original manifest');
      assert.equal(existsSync(output), false);
    }
  });
});

test('strict YAML and Markdown resource validation through inspector CLI', optional, async t => {
  const cases = [
    ['duplicate keys', '---\nname: rehearse\nname: rehearse\ndescription: test\n---\n', /Duplicate/],
    ['nested duplicate keys', '---\nname: rehearse\ndescription: test\nmeta: {a: 1, a: 2}\n---\n', /Duplicate/],
    ['aliases', '---\nname: &n rehearse\ndescription: *n\n---\n', /aliases/],
    ['unsafe tag', '---\nname: rehearse\ndescription: !!python/object:foo {}\n---\n', /constructor/],
    ['invalid name', skill('Uppercase'), /Invalid skill name/],
    ['long name', skill('a'.repeat(65)), /Invalid skill name/],
    ['numeric name', skill('123'), /Invalid skill name/],
    ['blank description', skill('rehearse', '"   "'), /description/],
    ['long description', skill('rehearse', 'a'.repeat(5121)), /description/],
    ['missing reference', skill() + '[missing](missing.md)', /Unresolved/],
    ['escaped reference', skill() + '[missing](..%2Foutside.md)', /Unresolved/],
    ['absolute reference', skill() + '[bad](/rehearse/SKILL.md)', /Unsafe relative/],
    ['scheme', skill() + '[bad](javascript:alert)', /Unexpected URI/],
    ['authority', skill() + '[bad](//example.test/path)', /Unexpected URI/],
  ];
  for (const [name, content, reason] of cases) await t.test(name, t => {
    const path = join(scratch(t), 'invalid.zip'); zip(path, [{ name: 'rehearse/SKILL.md', data: content }]);
    bad(cli(inspector, [path]), reason);
  });
  await t.test('maximum valid metadata and reference-style links', t => {
    const name = 'a'.repeat(64), path = join(scratch(t), 'valid.zip');
    zip(path, [{ name: `${name}/SKILL.md`, data: skill(name, 'a'.repeat(5120)) + '[local][n]\n\n[n]: references/note.md\n' },
      { name: `${name}/references/note.md`, data: 'Preserved.' }]);
    const result = good(cli(inspector, [path]));
    assert.equal(result.authority, false); assert.equal(result.status, 'PACKAGE_VALIDATED');
  });
});

test('packaging CLI is deterministic, exclusive and leaves originals untouched', optional, t => {
  const f = fixture(t);
  const original = readFileSync(f.source);
  const first = good(f.run());
  const secondPath = join(f.dir, 'second package;not-a-command.zip');
  const second = good(f.run(secondPath));
  assert.equal(first.authority, false); assert.equal(first.runtime_ready, false);
  assert.equal(first.status, 'PACKAGE_VALIDATED'); assert.equal(first.sha256, second.sha256);
  assert.deepEqual(readFileSync(f.output), readFileSync(secondPath));
  assert.deepEqual(readFileSync(f.output + '.manifest.json'), readFileSync(secondPath + '.manifest.json'));
  const sidecar = JSON.parse(readFileSync(first.manifest, 'utf8'));
  assert.equal(sidecar.source_sha256, hash(original)); assert.deepEqual(sidecar.source_files, f.review.source_files);
  assert.deepEqual(sidecar.review, f.review.review); assert.equal(sidecar.relocation_diff.length, 1);
  assert.equal(sidecar.file_sha256['rehearse/references/notice.md'], hash(f.files['upstream/shared/notice.md']));
  const inspected = good(cli(inspector, [f.output]));
  assert.equal(inspected.sha256, first.sha256); assert.deepEqual(inspected.file_sha256, sidecar.file_sha256);
  bad(f.run(), /File exists/); assert.deepEqual(readFileSync(f.source), original);
});

test('missing external relocation is never silently copied', optional, t => {
  const f = fixture(t); f.review.relocations = {}; f.review.link_edits = []; f.save();
  bad(f.run(), /Unresolved relative/); assert.equal(existsSync(f.output), false);
});

test('reviewed link-shaped text in code cannot be rewritten', optional, t => {
  const f = fixture(t);
  f.files[f.entry] = skill() + '```text\n[safety](../../shared/notice.md)\n```\n';
  rmSync(f.source);
  zip(f.source, Object.entries(f.files).map(([name, data]) => ({ name, data })));
  f.review.source_sha256 = hash(readFileSync(f.source));
  f.review.source_files[f.entry] = hash(f.files[f.entry]);
  f.review.link_edits[0].offset = Buffer.from(f.files[f.entry]).indexOf('../../shared/notice.md');
  f.save();
  bad(f.run(), /actual links, not code or safety prose/);
  assert.equal(existsSync(f.output), false);
});

test('every reviewed byte span must independently change a parsed link', async t => {
  const reciprocal = [['references/a.md', './references/a.md'], ['./references/a.md', 'references/a.md']];
  const normalized = [['references/café.md', 'references/caf%C3%A9.md']];
  const cases = [
    ['reciprocal fenced-code edits', true, 'a.md', reciprocal, /actual links, not code or safety prose/],
    ['normalized no-op in fenced code', true, 'café.md', normalized, /change a parsed destination/],
    ['normalized no-op in an actual link', false, 'café.md', normalized, /change a parsed destination/],
    ['reciprocal actual links remain editable', false, 'a.md', reciprocal, null],
  ];
  for (const [name, fenced, resource, edits, reason] of cases) await t.test(name, async t => {
    const f = fixture(t, { external: false });
    let content = skill() + (fenced ? '```text\n' : '');
    let expected = content;
    f.review.link_edits = edits.map(([before, after]) => {
      const offset = Buffer.byteLength(content + '[safety](');
      content += `[safety](${before})\n`;
      expected += `[safety](${after})\n`;
      return { path: f.entry, offset, before, after };
    });
    const ending = fenced ? '```\n' : '';
    f.files[f.entry] = content + ending;
    f.files[`upstream/skills/rehearse/references/${resource}`] = 'Preserved safety reference.\n';
    rmSync(f.source);
    zip(f.source, Object.entries(f.files).map(([name, data]) => ({ name, data })));
    f.review.source_sha256 = hash(readFileSync(f.source));
    f.review.source_files = Object.fromEntries(Object.entries(f.files).map(([name, data]) => [name, hash(data)]));
    f.save();
    // Even without parsers, prove these exact byte edits pass the existing staging
    // gates and preserve mapped resources, so parser regressions cannot pass early.
    const staged = good(core(stageCode, [f.source, f.reviewPath]));
    assert.equal(staged.skill, expected + ending);
    assert.notEqual(staged.skill, f.files[f.entry]);
    assert.equal(staged.diffs.length, 1);
    await t.test('parser-backed final validation', optional, () => {
      if (reason) {
        bad(f.run(), reason);
        assert.equal(existsSync(f.output), false);
        assert.equal(existsSync(f.output + '.manifest.json'), false);
      } else {
        assert.equal(good(f.run()).status, 'PACKAGE_VALIDATED');
      }
    });
  });
});

test('unavailable optional dependencies block final packaging rather than weaken validation',
  { skip: missing.length ? false : 'Both optional libraries are available' }, t => {
    const f = fixture(t); bad(f.run(), /Optional dependencies unavailable/);
    assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(f.output + '.manifest.json'), false);
  });
