import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { openStore } from '../runtime/store.mjs';
import { canonical, sha } from '../runtime/core.mjs';

const iso = n => new Date(Math.floor(n / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const ROLES = ['coordinator', 'research', 'risk', 'executor', 'advisor'];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trading-roles-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = { directory, scope: { environment: 'SIMULATE', profile: 'practice', account_alias: 'roles-alias' }, candidate: sha('roles-candidate') };
  const pair = generateKeyPairSync('ed25519');
  f.privateKey = pair.privateKey;
  f.keys = { operator: { role: 'operator', principal: 'roles-operator', runtime: 'roles-operator-runtime', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) } };
  f.write = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };
  f.configPath = f.write('config.json', { schema: 'trading-runtime-config/v1', candidate: f.candidate, database: 'state.sqlite', keys: f.keys, scope: f.scope });
  f.sign = (kind, fields = {}) => {
    const payload = { schema: 'trading-runtime-envelope/v1', kind, principal: f.keys.operator.principal, runtime: f.keys.operator.runtime,
      scope: f.scope, candidate: f.candidate, issued_utc: iso(Date.now() - 1000), expires_utc: iso(Date.now() + 300_000), ...fields };
    return { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), f.privateKey).toString('base64url') };
  };
  f.proofs = () => ['cost', 'rights'].map(kind => ({ kind, digest: sha('roles-' + kind), expires_utc: iso(Date.now() + 300_000) }));
  f.cost = () => ({ hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 5 });
  f.bindings = {
    bindings: { identity_ref: sha('identity'), template_ref: sha('template'), template_version: 'v1' },
    snapshot: { effective_hash: sha('effective'), agent_effective_hash: sha('agent-effective'), session_effective_hash: sha('session-effective'),
      resource_digest: sha('resources'), initial_events_version: 1 },
    roles: ROLES.map(name => ({ name, agent_ref: sha('agent-' + name), version: 1, principal_ref: sha('principal-' + name), runtime_ref: sha('runtime-' + name),
      skills: [{ ref: sha('skill-' + name), version: 'v1', digest: sha('skill-digest-' + name) }], mcp: [],
      resources: [{ ref: sha('resource-' + name), digest: sha('resource-digest-' + name), access: 'read-only' }] })),
    reviewer_isolation: { evidence_ref: sha('isolation-evidence') },
  };
  f.capture = () => {
    const log = t.mock.method(console, 'log', () => {});
    return () => JSON.parse(log.mock.calls.at(-1).arguments[0]);
  };
  return f;
}

test('bind-roles stores an admissible read-only configuration with no dispatch authority', async t => {
  const f = fixture(t), read = f.capture();
  const permit = f.sign('role-binding', { nonce: 'bind-1', proofs: f.proofs(), cost: f.cost() });
  await runtimeCommand(['bind-roles', f.configPath, f.write('permit.json', permit), f.write('bindings.json', f.bindings)]);
  const result = read();
  assert.equal(result.bound, true); assert.equal(result.admissible, true);
  assert.equal(result.authority, false); assert.equal(result.dispatch_allowed, false);
  const store = openStore(join(f.directory, 'state.sqlite'));
  try {
    const state = store.read(f.scope);
    assert.ok(state.configs['forward:' + result.configuration_digest]);
    assert.ok(state.events.some(event => event.type === 'roles-bound'));
    assert.equal(state.configs['forward:' + result.configuration_digest].mode, 'BOUND_READ_ONLY');
  } finally { store.close(); }
  await assert.rejects(() => runtimeCommand(['bind-roles', f.configPath, f.write('permit2.json', permit), f.write('bindings2.json', f.bindings)]), { code: 'GRANT_REPLAY' });
});

test('bind-roles refuses unbound or non-isolated configurations', async t => {
  const f = fixture(t);
  const permit = f.sign('role-binding', { nonce: 'bind-unbound', proofs: f.proofs(), cost: f.cost() });
  const unbound = structuredClone(f.bindings); unbound.reviewer_isolation.evidence_ref = null;
  await assert.rejects(() => runtimeCommand(['bind-roles', f.configPath, f.write('permit.json', permit), f.write('bindings.json', unbound)]), { code: 'UNBOUND_CONFIGURATION' });
  const shared = structuredClone(f.bindings);
  shared.roles.find(role => role.name === 'risk').principal_ref = shared.roles.find(role => role.name === 'executor').principal_ref;
  const permit2 = f.sign('role-binding', { nonce: 'bind-shared', proofs: f.proofs(), cost: f.cost() });
  await assert.rejects(() => runtimeCommand(['bind-roles', f.configPath, f.write('permit2.json', permit2), f.write('bindings2.json', shared)]), { code: 'UNBOUND_CONFIGURATION' });
});

test('schedule-consent records explicit operator consent without activation authority', async t => {
  const f = fixture(t), read = f.capture();
  const bindPermit = f.sign('role-binding', { nonce: 'bind-for-consent', proofs: f.proofs(), cost: f.cost() });
  await runtimeCommand(['bind-roles', f.configPath, f.write('bind.json', bindPermit), f.write('bindings.json', f.bindings)]);
  const start = Date.now(), stop = start + 86_400_000;
  const consent = f.sign('schedule-consent', { nonce: 'consent-1', identity_ref: f.bindings.bindings.identity_ref, template_ref: f.bindings.bindings.template_ref,
    trigger_policy: { type: 'interval', interval_minutes: 60 }, start_at_utc: iso(start), stop_at_utc: iso(stop), proofs: f.proofs(), cost: f.cost() });
  await runtimeCommand(['schedule-consent', f.configPath, f.write('consent.json', consent)]);
  const result = read();
  assert.equal(result.status, 'CONSENT_RECORDED');
  assert.equal(result.authority, false); assert.equal(result.activated, false); assert.equal(result.can_schedule, false);
  const store = openStore(join(f.directory, 'state.sqlite'));
  try {
    const state = store.read(f.scope);
    assert.equal(state.configs.scheduleConsent.activated, false);
    assert.equal(state.configs.scheduleConsent.trigger_policy.type, 'interval');
    assert.ok(state.events.some(event => event.type === 'schedule-consent-recorded'));
  } finally { store.close(); }
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('consent2.json', consent)]), { code: 'GRANT_REPLAY' });
});

test('schedule-consent refuses unbound identities, invalid policies and windows', async t => {
  const f = fixture(t);
  const start = Date.now(), stop = start + 86_400_000;
  const consent = (fields, nonce) => f.sign('schedule-consent', { nonce, identity_ref: f.bindings.bindings.identity_ref, template_ref: f.bindings.bindings.template_ref,
    trigger_policy: { type: 'interval', interval_minutes: 60 }, start_at_utc: iso(start), stop_at_utc: iso(stop), proofs: f.proofs(), cost: f.cost(), ...fields });
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('c1.json', consent({}, 'consent-unbound'))]), { code: 'UNBOUND_CONFIGURATION' });
  const bindPermit = f.sign('role-binding', { nonce: 'bind-for-refusals', proofs: f.proofs(), cost: f.cost() });
  await runtimeCommand(['bind-roles', f.configPath, f.write('bind.json', bindPermit), f.write('bindings.json', f.bindings)]);
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('c2.json', consent({ identity_ref: sha('other-identity') }, 'consent-other'))]), { code: 'UNBOUND_CONFIGURATION' });
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('c3.json', consent({ trigger_policy: { type: 'interval', interval_minutes: 0 } }, 'consent-bad-policy'))]), { code: 'INVALID_TRIGGER_POLICY' });
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('c4.json', consent({ stop_at_utc: iso(start - 1000) }, 'consent-bad-window'))]), { code: 'INVALID_SCHEDULE_WINDOW' });
  await assert.rejects(() => runtimeCommand(['schedule-consent', f.configPath, f.write('c5.json', consent({ trigger_policy: { type: 'once', at_utc: iso(stop + 1000) } }, 'consent-bad-once'))]), { code: 'INVALID_SCHEDULE_WINDOW' });
});