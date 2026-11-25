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
const REVISION = 'da61ed8f0af9d78c33d306311ab8beaa6563cfc8';
const DEP_URL = 'https://codeload.github.com/huijoohwee/agentic-gateway/tar.gz/' + REVISION;
const LOCK_INTEGRITY = 'sha512-I9P7fd5Bij09EurGFblcUGJeZ+WUKQwqh4ob5R7CqQuicQNy4sq2vnAQV7SKvkD7vGzyx+KLUw/Ek1KM0daQmg==';
const INSTALLED_VERSION = '0.1.0';
const INSTALLED_DIGESTS = {
  'transfer/record-export.mjs': '79e108308b536935f48277d956a25a76d0fa9c3fe0a90e2b63cb3645a121c5b8',
  'transfer/browser-files.mjs': '5816be9e6336695bf53e5b4d4d3019e99c1ccb18a8665783ece9471dfa52f595',
  'package.json': 'a97e6a7d58ce3567dd1318e4492b176d14aa515d04ec3b7395a27e93297f3672',
  'connectors/moomoo-securities-history.mjs': '3006992c4c22f3add8b53ab0752ba9fbb864284b02960b5458dc14a2d70f9e2b',
  'vendor/agentic-base/record-links.mjs': 'abe47bd1d080c4522b3f3808c724ddaf7283abb75e6499bba213a1cbfb301b1f',
  'resolver.mjs': '3beccdaaa511086434c8628edab831ad47ebe3a585c04947fc9020b7f66d4116',
  'connectors/moomoo-quote-socket.mjs': 'be9510659679fd40c798867bd359de4eeca77c726b8fae9503511e79dedb7ff8',
  'connectors/moomoo-trade-event.mjs': 'b58d462a0983fbde0bf27c4d5acc8d52640b10fda6182dbd32e89c34f11e694d',
  'connectors/moomoo-crypto-report.mjs': 'c2b3243017953859f0a3bd62488039fd9c9c52d2ce74e0459f7e033929d7cbb1',
  'connectors/moomoo-watchlist.mjs': 'c413faab25621f69dd450d3f31e57d22e5cf4e64122bf60f71f1fa823af135b6',
  'connectors/moomoo-rest-wire.mjs': '741b3c9dfd237f0691a7004e91cd962feb0345c54ef743ec8cbc72f7b182cdc4',
  'connectors/moomoo-capital-flow.mjs': '7e4e3d57007eda2ff44705b9b6e3ee0190ec981fab0ead9ff695e58b58a1cf61',
  'connectors/moomoo-coverage.mjs': '16c0da4603e2b169979a796ce924a6d96ee8a895cd3f7e2dcaeef07fc7f6551c',
  'connectors/moomoo-rank.mjs': 'df8ceb300faf0624332de33d2efeeaf06db0bb0f949fb145cc7bd8c127985375',
  'connectors/moomoo-calendar.mjs': '5b107f499457cc2cb308e8efa18783eb309a98cf5c4c9630b087d6bb3841858f',
  'connectors/moomoo-market-rest.mjs': '28d0193d2bd8e5b0fa6a4bcad2a5ea4fa015c0ae1f52ada3cbf75ffbe3136993',
  'connectors/moomoo-stock-screen.mjs': '637730130ac76d63f7f39c54527716e663694c458cc21612a6590d6db4b3d1a1',
  'connectors/moomoo-fields.json': '5a3adf13c7925ef33884fcbe87b882992a93733933fbd631f572218b6d7c1d13',
  'connectors/moomoo-catalog.json': 'b6046103367e103e9eca1424a1984d35c4cd9ef72ff1813cc1aca3c47dcbfe64',
  'connectors/profiles.json': '795ecdd823357d65438d6a061e05e58b7b11cc3c6e830d9e9eef2c1fc8a69b32',
  'connectors/moomoo.mjs': '22bd38033b876dde4da4fd035681bad57efb3d5afb5639d12c92eb2257faf1e0',
  'provider-profiles.mjs': '243a2445984b0257fb0d8b56baa33a1f93f52d530a7d4fe4ee99daf45edbe77e',
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
  for (const key of ['.', './connectors/moomoo-coverage', './connectors/moomoo', './connectors/moomoo-stock-screen', './connectors/moomoo-market-rest', './connectors/moomoo-trade-event', './connectors/moomoo-quote-socket', './provider-profiles', './connectors/moomoo-catalog.json', './connectors/moomoo-fields.json']) {
    assert.equal(typeof installed.exports[key], 'string');
  }
  for (const rel of Object.keys(INSTALLED_DIGESTS)) guardInstalled(rel);
});

test('an edited Gateway fixture, connector or profile fails the consumer digest guard', () => {
  const profiles = JSON.parse(read('node_modules/agentic-gateway/connectors/profiles.json'));
  profiles[0].features.push('tampered-route');
  assert.throws(() => guardBytes('connectors/profiles.json', Buffer.from(JSON.stringify(profiles))), /GATEWAY_FIXTURE_DRIFT/);
  const fields = read('node_modules/agentic-gateway/connectors/moomoo-fields.json');
  assert.throws(() => guardBytes('connectors/moomoo-fields.json', Buffer.concat([fields, Buffer.from(' ')])), /GATEWAY_FIXTURE_DRIFT/);
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
