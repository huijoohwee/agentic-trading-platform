import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from 'agentic-gateway';
import { bindMoomooSnapshot, replayMoomooSnapshot } from 'agentic-gateway/connectors/moomoo';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const read = rel => readFileSync(join(root, rel));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reviewed pin of the exact Gateway tree Trading consumes (E-57). npm seals the tarball with the lock
// integrity; the file digests protect the installed manifest, connector and profile bytes against an
// edited fixture, a forked revision or a local override. No network and no provider call here.
const REVISION = 'd4fa596b459eb7eecb62f4743d3238b6f25fc7c5';
const DEP_URL = 'https://codeload.github.com/huijoohwee/agentic-gateway/tar.gz/' + REVISION;
const LOCK_INTEGRITY = 'sha512-Qwn0Qjd01X7xJs5KzHvs6WFyAs4rBZeRgYryaDlwTcLxA8hmT9xg6PUexzToYR+OKMPgDB0+Pd3qbVtZiY0nMQ==';
const INSTALLED_VERSION = '0.1.0';
const INSTALLED_DIGESTS = {
  'connectors/moomoo-catalog.json': '6953d2136c5eec2cb355867230e9afbbb561d4d35e02389f7353659e32149b77',
  'connectors/profiles.json': 'a7a6277d17d485d8387892c987b00d6b477e0038891309b770d72427b4c7b845',
  'connectors/moomoo.mjs': 'b3f9770be3210d05c6fdd7aabd3254268dc2701bcf1c8c6aa437ef7b6c3b95a3',
  'provider-profiles.mjs': 'dfee64327556cdf48bf3dbcee9d4a86938e010ab07985ea655083226055d1dea',
};

function guardDependency(url) {
  if (typeof url !== 'string' || /^(file|link|workspace):/.test(url)) throw Error('GATEWAY_LOCAL_OVERRIDE');
  if (url !== DEP_URL) throw Error('GATEWAY_FORK_OR_DRIFT');
  return url;
}
function guardLock(entry, url) {
  if (entry?.resolved !== url || entry?.integrity !== LOCK_INTEGRITY) throw Error('GATEWAY_LOCK_DRIFT');
  return entry;
}
function guardBytes(rel, bytes) {
  if (sha256(bytes) !== INSTALLED_DIGESTS[rel]) throw Error('GATEWAY_FIXTURE_DRIFT');
  return sha256(bytes);
}
const guardInstalled = rel => guardBytes(rel, read(join('node_modules/agentic-gateway', rel)));

test('Trading pins the exact reviewed Gateway manifest, lock and installed import', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const url = guardDependency(pkg.dependencies['agentic-gateway']);
  const entry = guardLock(lock.packages['node_modules/agentic-gateway'], url);
  assert.equal(entry.version, INSTALLED_VERSION);
  const installed = JSON.parse(read('node_modules/agentic-gateway/package.json'));
  assert.equal(installed.name, 'agentic-gateway');
  assert.equal(installed.version, INSTALLED_VERSION);
  for (const key of ['.', './connectors/moomoo', './provider-profiles', './connectors/moomoo-catalog.json']) {
    assert.equal(typeof installed.exports[key], 'string');
  }
  for (const rel of Object.keys(INSTALLED_DIGESTS)) guardInstalled(rel);
});

test('an edited Gateway fixture, connector or profile fails the consumer digest guard', () => {
  const profiles = JSON.parse(read('node_modules/agentic-gateway/connectors/profiles.json'));
  profiles[0].features.push('tampered-route');
  assert.throws(() => guardBytes('connectors/profiles.json', Buffer.from(JSON.stringify(profiles))), /GATEWAY_FIXTURE_DRIFT/);
  const connector = read('node_modules/agentic-gateway/connectors/moomoo.mjs');
  assert.throws(() => guardBytes('connectors/moomoo.mjs', Buffer.concat([connector, Buffer.from('\n// edited\n')])), /GATEWAY_FIXTURE_DRIFT/);
  const discovery = read('node_modules/agentic-gateway/provider-profiles.mjs');
  assert.throws(() => guardBytes('provider-profiles.mjs', Buffer.concat([discovery, Buffer.from('\n')])), /GATEWAY_FIXTURE_DRIFT/);
});

test('a forked revision, foreign owner or local override fails closed', () => {
  assert.throws(() => guardDependency('https://codeload.github.com/huijoohwee/agentic-gateway/tar.gz/' + '0'.repeat(40)), /GATEWAY_FORK_OR_DRIFT/);
  assert.throws(() => guardDependency('https://codeload.github.com/someone-else/agentic-gateway/tar.gz/' + REVISION), /GATEWAY_FORK_OR_DRIFT/);
  assert.throws(() => guardDependency('https://github.com/huijoohwee/agentic-gateway.git'), /GATEWAY_FORK_OR_DRIFT/);
  for (const local of ['file:../agentic-gateway', 'link:../agentic-gateway', 'workspace:*']) {
    assert.throws(() => guardDependency(local), /GATEWAY_LOCAL_OVERRIDE/);
  }
  const lock = JSON.parse(read('package-lock.json')).packages['node_modules/agentic-gateway'];
  assert.throws(() => guardLock({ ...lock, resolved: DEP_URL.replace(REVISION, '0'.repeat(40)) }, DEP_URL), /GATEWAY_LOCK_DRIFT/);
  assert.throws(() => guardLock({ ...lock, integrity: 'sha512-AAAA' }, DEP_URL), /GATEWAY_LOCK_DRIFT/);
});

test('the installed connector replays labelled snapshots and refuses drift without a provider call', async () => {
  const fixture = JSON.parse(read('qualification/moomoo/sdk-replay.json'));
  const replay = replayMoomooSnapshot('HK.00700', fixture);
  assert.equal(replay.evidence, 'replay');
  assert.equal(replay.provider, 'moomoo');
  assert.equal(replay.currency, null);
  assert.equal(replay.delayClass, 'unknown');
  assert.equal(replay.pricePrecision, 'provider-double');
  assert.equal(typeof replay.price, 'string');
  for (const side of [replay.bid, replay.ask]) assert.ok(side === null || typeof side === 'string');
  const oneSided = { retType: 0, s2c: { snapshotList: [{ basic: {
    security: { market: 1, code: '00700' }, curPrice: 303, isSuspend: false, bidPrice: null, askPrice: 303.2 } }] } };
  const sides = replayMoomooSnapshot('HK.00700', oneSided);
  assert.equal(sides.bid, null);
  assert.equal(sides.ask, '303.2');
  assert.throws(() => replayMoomooSnapshot('HK.00700', { ...fixture, retType: 1 }), /PROVIDER_REFUSED/);
  assert.throws(() => replayMoomooSnapshot('US.AAPL', fixture), /SECURITY_MISMATCH/);
  assert.throws(() => replayMoomooSnapshot('HK.00700', { ...oneSided, s2c: { snapshotList: [{ basic: { ...oneSided.s2c.snapshotList[0].basic, curPrice: -1 } }] } }), /INVALID_SNAPSHOT/);
  let calls = 0;
  const client = { GetSecuritySnapshot: async () => { calls += 1; return oneSided; } };
  const grant = { symbol: 'HK.00700', costUsd: 0, entitled: true, maxCalls: 1, expiresAt: Date.now() + 60_000 };
  const readOnce = bindMoomooSnapshot(client, grant);
  assert.equal((await readOnce()).evidence, 'sdk-response');
  await assert.rejects(() => readOnce(), /READ_GRANT_EXHAUSTED/);
  assert.equal(calls, 1);
  assert.throws(() => bindMoomooSnapshot(client, { ...grant, costUsd: 1 }), /ENTITLED_ZERO_COST_READ_REQUIRED/);
  assert.throws(() => bindMoomooSnapshot(client, { ...grant, entitled: false }), /ENTITLED_ZERO_COST_READ_REQUIRED/);
  const manifest = JSON.parse(read('runtime/quote-capability.json'));
  assert.equal(validateManifest(manifest).major, 1);
  assert.throws(() => validateManifest({ ...manifest, major: 2 }), /Invalid capability identity/);
  assert.throws(() => validateManifest({ ...manifest, revision: 'not-a-revision' }), /Invalid capability identity/);
  assert.throws(() => validateManifest({ ...manifest, locality: 'cloud' }), /Expected a local qualification route/);
  assert.throws(() => validateManifest({ ...manifest, routes: [] }), /Expected a local qualification route/);
});

test('the consumer refuses a drifted native fixture pin before any binding', async () => {
  const { discoverPortableQuotes } = await import('../runtime/portable-quote.mjs');
  const descriptor = JSON.parse(read('runtime/quote-capability.json'));
  const pin = descriptor.qualifiedBinding;
  const record = { capability_digest: 'fixture-capability', qualification: { status: 'QUALIFIED' },
    adapter_digest: pin.adapterDigest, schema_digest: pin.schemaDigest, mapping_digest: pin.mappingDigest,
    source: 'MOCK', rights: 'MOCK', operations: [descriptor.operation], allowlist: [descriptor.operation],
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true } };
  assert.equal(discoverPortableQuotes([record]).length, 1);
  for (const drift of [{ schema_digest: '0'.repeat(64) }, { adapter_digest: '0'.repeat(64) },
    { mapping_digest: '0'.repeat(64) }, { source: 'PROVIDER' }, { rights: 'LIVE' },
    { cost: { hard_cap_usd: 1, deny_at_exhaustion: true } }]) {
    assert.equal(discoverPortableQuotes([{ ...record, ...drift }]).length, 0);
  }
});
