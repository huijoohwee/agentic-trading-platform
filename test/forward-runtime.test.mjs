import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { createQcaReadClient, diffConfiguration, exportTelemetry, ingestTelemetry, provenanceProjection,
  QCA_ORIGIN, telemetryCandidate, validateConfiguration } from '../runtime/forward.mjs';

const template = JSON.parse(readFileSync(new URL('../runtime/roles.json', import.meta.url), 'utf8'));
const at = '2026-11-19T09:00:00Z', now = Date.parse(at);
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'local-practice' };
const clone = value => structuredClone(value);
function configuration() {
  const c = clone(template); c.mode = 'BOUND_READ_ONLY';
  c.bindings = { identity_ref: sha('identity'), template_ref: sha('template'), template_version: '900719925474099312345' };
  c.snapshot = { effective_hash: sha('effective'), agent_effective_hash: sha('agent'), session_effective_hash: sha('session'),
    resource_digest: sha('independent-resource-snapshot'), initial_events_version: 4 };
  for (const r of c.roles) {
    r.agent_ref = sha(r.name); r.version = 7;
    r.principal_ref = sha(`${r.name}-principal`); r.runtime_ref = sha(`${r.name}-runtime`);
    r.skills = [{ ref: sha(`${r.name}-skill`), version: '900719925474099312345', digest: sha('skill-body') }];
    r.resources = [{ ref: sha('resource'), digest: sha('resource-body'), access: 'read-only' }];
  }
  for (const child of c.roles[0].children) { child.agent_ref = sha(child.role); child.version = 7; }
  c.reviewer_isolation.evidence_ref = sha('isolation-evidence');
  return c;
}
function observation(stream = 'schedule_run') {
  const source = { provider: 'QCA', origin: QCA_ORIGIN, stream, identity_ref: sha('identity'), template_ref: sha('template'), run_ref: sha('run'),
    session_ref: sha('session'), thread_ref: stream === 'thread' ? sha('child') : null };
  return { source, observed_utc: at, expected_cursor: null, cursor: sha('cursor-1'), current_config: configuration(),
    events: [{ id: sha(`${stream}-event-1`), at, kind: stream, run_ref: source.run_ref, session_ref: source.session_ref,
      thread_ref: source.thread_ref, status: 'completed', push_status: 'failed', initial_events_version: 4 }], threads: [] };
}
const pairs = { operator: generateKeyPairSync('ed25519'), integration: generateKeyPairSync('ed25519') };
const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, { role, principal: `${role}-principal`,
  runtime: `${role}-runtime`, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }]));
function signed(role, payload) {
  return { key_id: role, payload, signature: sign(null, Buffer.from(canonical(payload)), pairs[role].privateKey).toString('base64url') };
}
function envelopes(o) {
  const base = { schema: 'trading-runtime-envelope/v1', scope, candidate: telemetryCandidate(o),
    issued_utc: '2026-11-19T08:59:00Z', expires_utc: '2026-11-19T09:05:00Z' };
  const envelope = signed('integration', { ...base, kind: 'provider-observation', principal: keys.integration.principal,
    runtime: keys.integration.runtime, observation: o });
  const permit = signed('operator', { ...base, kind: 'telemetry', principal: keys.operator.principal, runtime: keys.operator.runtime,
    cost_ref: sha('cost'), rights_ref: sha('rights'),
    proofs: ['cost', 'rights'].map(kind => ({ kind, digest: sha(kind), expires_utc: base.expires_utc })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 2 } });
  return { envelope, permit };
}
function database(t) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'forward-runtime-'));
  const path = join(dir, 'ledger.sqlite'); let store = openStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = openStore(path); return store; } };
}
function ingest(store, o, overrides = {}) {
  return ingestTelemetry({ store, scope, keys, configuration: configuration(), now, ...envelopes(o), ...overrides });
}
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const runBody = () => ({ id: 'run_test', identity_id: 'identity_test', template_id: 'template_test', session_id: 'session_test', status: 'completed',
  push_status: 'failed', attempt: 2, initial_events_version: 4, duration_ms: 12, created_at: at,
  result_payload: 'PRIVATE PROMPT', account_id: 'PRIVATE ACCOUNT', token: 'PRIVATE TOKEN', usage: { total_credits: 999 } });

test('local role template is unbound, non-executable and cannot ingest', t => {
  const v = validateConfiguration(template);
  assert.equal(v.bound, false); assert.equal(v.admissible, false); assert.equal(v.dispatch_allowed, false);
  assert.equal(v.configuration.bindings.identity_ref, null);
  assert.ok(v.reasons.includes('UNBOUND_PROVIDER_VALUES'));
  const o = observation(); o.current_config = template;
  assert.throws(() => ingest(database(t).store, o, { configuration: template }), /UNBOUND_CONFIGURATION/);
});

test('immutable numeric children, opaque Skill precision and all arrays are preserved', () => {
  const c = configuration(), v = validateConfiguration(c);
  assert.equal(v.admissible, true); assert.equal(v.authority, false);
  assert.equal(v.configuration.roles[0].skills[0].version, '900719925474099312345');
  assert.deepEqual(v.configuration, c); assert.ok(Object.isFrozen(v.configuration.roles[0].skills));
  c.roles[0].skills[0].version = 'changed'; assert.notEqual(c.roles[0].skills[0].version, v.configuration.roles[0].skills[0].version);
  for (const invalid of ['latest', '7', 'fixture-v3', 1.2, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const next = configuration(); next.roles[0].children[0].version = invalid;
    assert.throws(() => validateConfiguration(next), /INVALID_PIN|CHILD_BINDING/);
  }
  for (const invalid of ['latest', 'HEAD', 7]) {
    const next = configuration(); next.roles[1].skills[0].version = invalid;
    assert.throws(() => validateConfiguration(next), /INVALID_PIN/);
  }
  const opaque = configuration(); opaque.roles[1].skills[0].version = 'opaque-release:alpha.000001';
  assert.equal(validateConfiguration(opaque).admissible, true);
});

test('read-only per-role allowlists deny generic execution, network and broker writes', () => {
  for (const tool of ['bash', 'Bash', 'http.get', 'network', 'broker.submit', 'order.cancel', 'portfolio.read']) {
    const c = configuration(); c.roles[3].tools.push(tool);
    assert.throws(() => validateConfiguration(c), /TOOL_FORBIDDEN/);
  }
  const c = configuration(); c.roles[0].mcp.push({ ref: sha('mcp'), digest: sha('mcp-digest'), tools: ['bash'] });
  assert.throws(() => validateConfiguration(c), /TOOL_FORBIDDEN/);
  c.roles[0].mcp = []; c.roles[1].resources[0].access = 'write';
  assert.throws(() => validateConfiguration(c), /MUTATION_FORBIDDEN/);
  c.roles[1].resources[0].access = 'read-only'; c.roles[3].constraints.can_submit_orders = true;
  assert.throws(() => validateConfiguration(c), /MUTATION_FORBIDDEN/);
});

test('missing reviewer isolation or shared reviewer principal/runtime means no admission/dispatch', () => {
  for (const mutate of [c => c.reviewer_isolation.evidence_ref = null,
    c => c.roles[2].principal_ref = c.roles[3].principal_ref, c => c.roles[2].runtime_ref = c.roles[0].runtime_ref]) {
    const c = configuration(); mutate(c); const v = validateConfiguration(c);
    assert.equal(v.admissible, false); assert.equal(v.dispatch_allowed, false);
    assert.ok(v.reasons.includes('REVIEWER_ISOLATION_REQUIRED'));
  }
});

test('diff is lossless, treats arrays atomically and marks snapshot/version drift for rebinding', () => {
  const a = configuration(), b = configuration(); b.snapshot.initial_events_version++;
  let diff = diffConfiguration(a, b);
  assert.deepEqual(diff.changed_paths, ['snapshot.initial_events_version']);
  assert.deepEqual(diff.unchanged_arrays, ['roles']); assert.equal(diff.requires_rebinding, true);
  assert.deepEqual(diff.next_configuration.roles, a.roles); assert.equal(diff.next_configuration.snapshot.resource_digest, a.snapshot.resource_digest);
  b.roles[1].skills[0].version = '900719925474099312346'; diff = diffConfiguration(a, b);
  assert.ok(diff.changed_paths.includes('roles')); assert.equal(diff.next_configuration.roles[1].skills[0].version, '900719925474099312346');
  delete b.roles[1].resources; assert.throws(() => diffConfiguration(a, b), /INVALID_CONFIGURATION/);
  const p = provenanceProjection(a); assert.equal(p.authority, false);
  assert.equal(p.roles[1].skills[0].version_digest, sha(a.roles[1].skills[0].version));
  a.raw_prompt = 'secret'; assert.throws(() => provenanceProjection(a), /INVALID_CONFIGURATION/);
});

test('HTTP client sends only authenticated fixed-origin GETs and redacts observations', async () => {
  const requests = [], client = createQcaReadClient({ pat: 'server-only-secret', now: () => now,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return response(runBody()); } });
  const result = await client.readRun({ run_id: 'run_test', identity_id: 'identity_test' });
  assert.equal(requests[0].url, QCA_ORIGIN + '/api/v1/forward/schedule_runs/run_test?include_initial_events=true&identity_id=identity_test');
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer server-only-secret');
  assert.equal(result.authenticated_transport, true); assert.equal(result.authority, false);
  assert.equal(result.data.completed, true); assert.equal(result.data.delivered, false); assert.equal(result.data.initial_events_version, 4);
  assert.deepEqual(result.data.usage, { state: 'unknown', total_credits: null, source: null });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|server-only-secret|run_test|session_test/);
  assert.deepEqual(Object.keys(client).sort(), ['readEffective', 'readRun']);
  assert.throws(() => client.readRun({ run_id: '../orders' }), /INVALID_QCA_ID/);
  assert.throws(() => client.readRun({ run_id: 'https://evil.example' }), /INVALID_QCA_ID/);
});

test('effective GET returns compiled digests, not writable DSL or resource/prompt bodies', async () => {
  const body = { type: 'effective_spec', identity_id: 'identity_test', template_id: 'template_test',
    effective_hash: `sha256:${sha('effective')}`, agent_effective_hash: `sha256:${sha('agent')}`,
    session_effective_hash: `sha256:${sha('session')}`, agent: { system: 'PRIVATE PROMPT', tools: [], skills: [] },
    session: { resources: [{ type: 'file', file_id: 'PRIVATE FILE' }], environment_variables: { PAT: 'PRIVATE TOKEN' } } };
  let requested;
  const client = createQcaReadClient({ pat: 'secret', now: () => now, fetchImpl: async url => { requested = url; return response(body); } });
  const result = await client.readEffective({ identity_id: 'identity_test', template_id: 'template_test' });
  assert.equal(requested, QCA_ORIGIN + '/api/v1/forward/identities/identity_test/templates/template_test/effective');
  assert.equal(result.data.writable_dsl, false); assert.equal(result.data.resource_digest, sha(body.session.resources));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|initial_events_version|enabled|vault/);
});

test('HTTP timeout, status, redirects, hostile content and streamed byte limits fail without secrets', async () => {
  const cases = [
    async () => { throw new Error('secret credential and PRIVATE response'); },
    async () => new Response('PRIVATE', { status: 401 }),
    async () => new Response('PRIVATE', { status: 302, headers: { location: 'https://evil.example' } }),
    async () => ({ redirected: true, status: 200 }),
    async () => new Response('PRIVATE', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('PRIVATE', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('x'.repeat(101), { headers: { 'content-type': 'application/json' } }),
    async () => response({ ...runBody(), initial_events_version: '9007199254740993' }),
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const fetchImpl of cases) {
    const client = createQcaReadClient({ pat: 'secret', timeoutMs: 15, maxBytes: 100, fetchImpl });
    await assert.rejects(client.readRun({ run_id: 'run_test' }), error => {
      assert.match(error.message, /^(QCA_[A-Z_]+|TIMEOUT)$/); assert.doesNotMatch(error.message, /secret|PRIVATE/); return true;
    });
  }
  assert.throws(() => createQcaReadClient({ pat: 'secret\nheader' }), /QCA_AUTH_REQUIRED/);
  assert.throws(() => createQcaReadClient({ pat: 'secret', timeoutMs: 30_001 }), /INVALID_TRANSPORT_LIMIT/);
});

test('run completion, delivery, requires_action and unknown usage remain independent', async () => {
  for (const [status, push_status, completed, delivered, awaiting] of [
    ['completed', 'failed', true, false, false], ['running', 'succeeded', false, true, false],
    ['requires_action', 'succeeded', false, true, true], ['new-provider-status', 'new-push-status', false, false, false]]) {
    const client = createQcaReadClient({ pat: 'secret', now: () => now,
      fetchImpl: async () => response({ ...runBody(), status, push_status, initial_events_version: undefined }) });
    const { data } = await client.readRun({ run_id: 'run_test' });
    assert.equal(data.completed, completed); assert.equal(data.delivered, delivered); assert.equal(data.awaiting_action, awaiting);
    assert.equal(data.initial_events_version, null); assert.equal(data.usage.state, 'unknown'); assert.equal(data.usage.total_credits, null);
  }
});

test('signed telemetry persists redacted source events and cursor atomically across restart', t => {
  const db = database(t), o = observation(); o.events[0].raw_prompt = 'PRIVATE PROMPT'; o.events[0].account_id = 'PRIVATE ACCOUNT';
  o.events[0].token = 'PRIVATE TOKEN';
  const first = ingest(db.store, o); assert.equal(first.appended, 1); assert.equal(first.authority, false);
  assert.equal(ingest(db.store, o).duplicate, true);
  db.restart(); assert.equal(ingest(db.store, o).duplicate, true);
  const next = clone(o); next.expected_cursor = o.cursor; next.cursor = sha('cursor-2');
  assert.equal(ingest(db.store, next).appended, 0);
  const state = db.store.read(scope); assert.equal(state.events.length, 1);
  assert.equal(Object.values(state.checkpoints)[0].cursor, next.cursor);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|raw_prompt|account_id|token|signature/);
  const exported = exportTelemetry({ store: db.store, scope });
  assert.equal(exported.observations[0].latest.completed, true); assert.equal(exported.observations[0].latest.delivered, false);
  assert.equal(exported.observations[0].latest.usage.total_credits, null);
});

test('latest ignores historical duplicates while event time persists across cursor advances and restart', t => {
  const db = database(t), o = observation(); o.events[0].status = 'running';
  o.events[0].at = '2026-11-19T08:59:00Z';
  ingest(db.store, o);
  const completed = clone(o); completed.expected_cursor = o.cursor; completed.cursor = sha('cursor-2');
  completed.events = [{ ...o.events[0], id: sha('completed-event'), at, status: 'completed' }, o.events[0]];
  assert.equal(ingest(db.store, completed).appended, 1);
  const latest = exportTelemetry({ store: db.store, scope }).observations[0].latest;
  assert.equal(latest.status, 'completed'); assert.equal(latest.source_event_ref, sha('completed-event'));
  db.restart();
  const duplicate = clone(o); duplicate.expected_cursor = completed.cursor; duplicate.cursor = sha('cursor-3');
  duplicate.observed_utc = '2026-11-19T09:01:00Z';
  assert.equal(ingest(db.store, duplicate, { now: Date.parse(duplicate.observed_utc) }).appended, 0);
  assert.deepEqual(exportTelemetry({ store: db.store, scope }).observations[0].latest, latest);
  const checkpoint = Object.values(db.store.read(scope).checkpoints)[0];
  assert.equal(checkpoint.cursor, duplicate.cursor); assert.equal(checkpoint.last_event_at, at);
  db.restart();
  const stale = clone(duplicate); stale.expected_cursor = duplicate.cursor; stale.cursor = sha('cursor-4');
  stale.events[0].id = sha('new-but-older-event');
  const before = db.store.read(scope);
  assert.throws(() => ingest(db.store, stale, { now: Date.parse(stale.observed_utc) }), /STALE_EVENT/);
  assert.deepEqual(db.store.read(scope), before);
});

test('new event times must be nondecreasing within a batch, allowing equal timestamps', t => {
  const db = database(t), o = observation();
  o.events.push({ ...o.events[0], id: sha('older-event'), at: '2026-11-19T08:59:59Z', status: 'running' });
  const before = db.store.read(scope);
  assert.throws(() => ingest(db.store, o), /STALE_EVENT/);
  assert.deepEqual(db.store.read(scope), before);
  o.events[1].at = at; o.events[1].status = 'failed';
  assert.equal(ingest(db.store, o).appended, 2);
  assert.equal(exportTelemetry({ store: db.store, scope }).observations[0].latest.source_event_ref, sha('older-event'));
});

test('an initial empty batch has no latest event or event timestamp and accepts a later first event', t => {
  const db = database(t), o = observation(); o.events = [];
  assert.equal(ingest(db.store, o).appended, 0);
  assert.equal(exportTelemetry({ store: db.store, scope }).observations[0].latest, null);
  assert.equal(Object.values(db.store.read(scope).checkpoints)[0].last_event_at, null);
  db.restart();
  const next = observation(); next.expected_cursor = o.cursor; next.cursor = sha('cursor-2');
  next.events[0].at = '2026-11-19T08:59:00Z';
  assert.equal(ingest(db.store, next).appended, 1);
  assert.equal(exportTelemetry({ store: db.store, scope }).observations[0].latest.completed, true);
  assert.equal(Object.values(db.store.read(scope).checkpoints)[0].last_event_at, next.events[0].at);
});

test('input version 4 to 5 rebinding clears cached latest and thread references, retaining immutable history', t => {
  const db = database(t), o = observation('main_session');
  o.threads = [{ thread_ref: sha('main'), session_ref: o.source.session_ref, parent_thread_ref: null, role: 'coordinator',
    cursor: sha('main-cursor'), observed_utc: at, status: 'running', usage: { state: 'unknown' } }];
  ingest(db.store, o);
  const history = db.store.read(scope).events;
  const next = clone(o); next.expected_cursor = o.cursor; next.cursor = sha('cursor-2');
  next.current_config.snapshot.initial_events_version = 5; next.events = []; next.threads = [];
  assert.equal(ingest(db.store, next, { configuration: next.current_config }).appended, 0);
  db.restart();
  const out = exportTelemetry({ store: db.store, scope }), row = out.observations[0];
  assert.equal(row.configuration_digest, validateConfiguration(next.current_config).digest);
  assert.equal(row.latest, null); assert.deepEqual(row.thread_refs, []);
  assert.deepEqual(db.store.read(scope).events, history);
  assert.deepEqual(out.provenance.map(p => p.snapshot.initial_events_version).sort(), [4, 5]);
  assert.equal(Object.values(db.store.read(scope).checkpoints)[0].last_event_at, at);
  const fresh = clone(next); fresh.expected_cursor = next.cursor; fresh.cursor = sha('cursor-3');
  fresh.events = [{ ...o.events[0], id: sha('version-5-event'), initial_events_version: 5, at: '2026-11-19T08:59:59Z' }];
  const before = db.store.read(scope);
  assert.throws(() => ingest(db.store, fresh, { configuration: fresh.current_config }), /STALE_EVENT/);
  assert.deepEqual(db.store.read(scope), before);
  fresh.events[0].at = at;
  assert.equal(ingest(db.store, fresh, { configuration: fresh.current_config }).appended, 1);
  const latest = exportTelemetry({ store: db.store, scope }).observations[0];
  assert.equal(latest.latest.initial_events_version, 5); assert.deepEqual(latest.thread_refs, []);
});

test('conflicting same-ID content and stale cursors roll back the complete batch', t => {
  const db = database(t), o = observation(); ingest(db.store, o);
  const before = db.store.read(scope), conflict = clone(o); conflict.expected_cursor = o.cursor; conflict.cursor = sha('cursor-2');
  conflict.events.unshift({ ...clone(o.events[0]), id: sha('new-event') }); conflict.events[1].raw_prompt = 'changed ignored field';
  assert.throws(() => ingest(db.store, conflict), /CONFLICTING_EVENT/);
  assert.deepEqual(db.store.read(scope), before);
  const stale = clone(o); stale.cursor = sha('cursor-2'); stale.events = [];
  assert.throws(() => ingest(db.store, stale), /STALE_CURSOR/); assert.deepEqual(db.store.read(scope), before);
  const rebound = clone(o); rebound.source.run_ref = rebound.events[0].run_ref = sha('another-run');
  assert.throws(() => ingest(db.store, rebound), /CONFLICTING_EVENT/);
  assert.deepEqual(db.store.read(scope), before);
});

test('signatures, telemetry operator kind, cost and rights are required independently of authenticated transport', t => {
  const db = database(t), o = observation(), valid = envelopes(o);
  const modified = clone(valid.envelope); modified.payload.observation.events[0].status = 'failed';
  assert.throws(() => ingest(db.store, o, { envelope: modified }), /CANDIDATE_BINDING|INVALID_SIGNATURE/);
  for (const mutate of [p => p.kind = 'execute', p => delete p.rights_ref, p => p.proofs = [],
    p => p.cost.remaining_calls = 0, p => p.cost.hard_cap_usd = 1, p => p.cost_ref = sha('unmatched')]) {
    const payload = clone(valid.permit.payload); mutate(payload);
    assert.throws(() => ingest(db.store, o, { permit: signed('operator', payload) }),
      /PRINCIPAL_BINDING|MISSING_TELEMETRY_REFERENCE|MISSING_ADMISSION_PROOF|BUDGET_HALT/);
  }
  assert.throws(() => ingest(db.store, o, { keys: { ...keys, integration: { ...keys.integration, role: 'operator' } } }), /UNTRUSTED_PRINCIPAL/);
  assert.throws(() => ingest(db.store, o, { permit: { authenticated_transport: true, authority: true } }), /INVALID_SIGNATURE/);
  assert.equal(db.store.read(scope).events.length, 0);
});

test('operator and integration aliases cannot share Ed25519 public key material', t => {
  const db = database(t), o = observation(), valid = envelopes(o), before = db.store.read(scope);
  for (const publicKey of [keys.operator.publicKey, keys.operator.publicKey.replace(/\n/g, '\r\n')]) {
    const aliases = { 'operator-alias': keys.operator, 'integration-alias': { ...keys.integration, publicKey } };
    const permit = { ...valid.permit, key_id: 'operator-alias' };
    const envelope = { ...signed('operator', valid.envelope.payload), key_id: 'integration-alias' };
    assert.throws(() => ingest(db.store, o, { keys: aliases, permit, envelope }), /PRINCIPAL_ISOLATION/);
    assert.deepEqual(db.store.read(scope), before);
  }
});

test('signed configuration drift, malformed sources, bad times and counts are rejected before storage', t => {
  const db = database(t);
  const mutations = [
    [o => o.current_config.snapshot.resource_digest = sha('drift'), /CONFIGURATION_DRIFT/],
    [o => o.current_config.roles[1].skills[0].version = '900719925474099312346', /CONFIGURATION_DRIFT/],
    [o => o.source.origin = 'https://evil.example', /INVALID_SOURCE/],
    [o => o.source.identity_ref = sha('wrong-identity'), /SOURCE_BINDING/],
    [o => o.events[0].run_ref = sha('another-run'), /INVALID_SOURCE_EVENT/],
    [o => o.observed_utc = '2026-11-19T09:01:00Z', /INVALID_OBSERVATION_TIME/],
    [o => o.events[0].at = '2026-11-19T08:00:00Z', /INVALID_OBSERVATION_TIME/],
    [o => o.events = Array.from({ length: 201 }, () => o.events[0]), /INVALID_ARRAY/],
    [o => o.events[0].initial_events_version = '4', /INVALID_INPUT_VERSION/],
    [o => o.events[0].initial_events_version = 5, /INPUT_VERSION_DRIFT/],
    [o => o.cursor = 'RAW CURSOR TOKEN', /INVALID_CURSOR/],
  ];
  for (const [mutate, error] of mutations) { const o = observation(); mutate(o); assert.throws(() => ingest(db.store, o), error); }
  assert.equal(db.store.read(scope).revision, 0);
});

test('main stream has no child coverage; explicit thread references and measured/unknown usage remain separate', t => {
  const db = database(t), o = observation('main_session');
  o.events[0].status = 'requires_action'; o.events[0].push_status = 'succeeded';
  o.events[0].usage = { state: 'measured', source: 'thread.usage.total_credits', total_credits: 100 };
  o.threads = [
    { thread_ref: sha('main'), session_ref: o.source.session_ref, parent_thread_ref: null, role: 'coordinator',
      cursor: sha('main-cursor'), observed_utc: at, status: 'running', usage: { credits: 0 }, raw_prompt: 'PRIVATE' },
    { thread_ref: sha('child'), session_ref: o.source.session_ref, parent_thread_ref: sha('main'), role: 'child',
      cursor: sha('child-cursor'), observed_utc: at, status: 'requires_action',
      usage: { state: 'measured', source: 'thread.usage.total_credits', total_credits: 0 } },
  ];
  ingest(db.store, o);
  let out = exportTelemetry({ store: db.store, scope });
  assert.equal(out.observations[0].coverage, 'main_session_only'); assert.equal(out.observations[0].latest.awaiting_action, true);
  assert.equal(out.observations[0].latest.completed, false); assert.equal(out.observations[0].latest.delivered, true);
  assert.equal(out.observations[0].latest.usage.total_credits, null); assert.equal(out.threads.length, 2);
  assert.equal(out.threads[0].usage.total_credits, null); assert.equal(out.threads[1].usage.total_credits, 0);
  assert.equal(out.threads[1].usage.state, 'measured'); assert.doesNotMatch(JSON.stringify(out), /PRIVATE|raw_prompt/);
  const child = observation('thread'); child.events[0].usage = { state: 'measured', source: 'thread.usage.total_credits', total_credits: 1.25 };
  child.threads = [{ ...o.threads[1], cursor: sha('child-cursor-2'), usage: child.events[0].usage }];
  ingest(db.store, child); out = exportTelemetry({ store: db.store, scope });
  assert.equal(out.observations.length, 2); assert.equal(out.observations[1].latest.usage.total_credits, 1.25);
  const invalid = clone(child); invalid.expected_cursor = child.cursor; invalid.cursor = sha('cursor-2');
  invalid.events[0].usage.total_credits = -1; assert.throws(() => ingest(db.store, invalid), /INVALID_USAGE/);
  const conflict = clone(child); conflict.events = []; conflict.expected_cursor = child.cursor; conflict.cursor = sha('cursor-2');
  conflict.threads[0].status = 'running';
  const before = db.store.read(scope); assert.throws(() => ingest(db.store, conflict), /CONFLICTING_THREAD/);
  assert.deepEqual(db.store.read(scope), before);
  conflict.threads = [];
  assert.throws(() => ingest(db.store, conflict), /MISSING_THREAD_REFERENCE/);
});

test('later unchanged-thread polls refresh observation metadata but bind cursor content', t => {
  const db = database(t), o = observation('main_session');
  o.threads = [{ thread_ref: sha('child'), session_ref: o.source.session_ref, parent_thread_ref: sha('main'), role: 'child',
    cursor: sha('child-cursor'), observed_utc: at, status: 'requires_action',
    usage: { state: 'measured', source: 'thread.usage.total_credits', total_credits: 1.25 }, raw_prompt: 'PRIVATE' }];
  ingest(db.store, o); db.restart();
  const next = clone(o); next.expected_cursor = o.cursor; next.cursor = sha('cursor-2'); next.events = [];
  next.observed_utc = next.threads[0].observed_utc = '2026-11-19T09:01:00Z';
  next.threads[0].raw_prompt = 'PRIVATE updated non-projected field';
  const laterNow = Date.parse(next.observed_utc);
  assert.equal(ingest(db.store, next, { now: laterNow }).appended, 0);
  const out = exportTelemetry({ store: db.store, scope });
  assert.equal(out.threads[0].observed_utc, next.observed_utc);
  assert.equal(out.threads[0].source_digest, sha(next.threads[0]));
  assert.equal(out.threads[0].cursor, o.threads[0].cursor);
  assert.equal(out.threads[0].status, o.threads[0].status); assert.equal(out.threads[0].usage.total_credits, 1.25);
  assert.deepEqual(out.observations[0].thread_refs, [sha('child')]);
  assert.equal(out.observations[0].latest.source_event_ref, o.events[0].id);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|raw_prompt/);
  db.restart();
  const before = db.store.read(scope);
  for (const mutate of [t => t.status = 'running', t => t.usage.total_credits = 2,
    t => t.parent_thread_ref = sha('another-parent'), t => { t.role = 'coordinator'; t.parent_thread_ref = null; },
    t => t.session_ref = sha('another-session')]) {
    const conflict = clone(next); conflict.expected_cursor = next.cursor; conflict.cursor = sha('cursor-3');
    conflict.observed_utc = conflict.threads[0].observed_utc = '2026-11-19T09:02:00Z';
    mutate(conflict.threads[0]); conflict.source.session_ref = conflict.threads[0].session_ref;
    if (conflict.source.session_ref !== o.source.session_ref) conflict.expected_cursor = null;
    assert.throws(() => ingest(db.store, conflict, { now: Date.parse(conflict.observed_utc) }), /CONFLICTING_THREAD|THREAD_BINDING/);
    assert.deepEqual(db.store.read(scope), before);
  }
});

test('HTTP rejects unsafe counters and advertised lengths without coercing version strings', async () => {
  for (const value of ['4', Number.MAX_SAFE_INTEGER + 1, -1, 1.1]) {
    const client = createQcaReadClient({ pat: 'secret', now: () => now,
      fetchImpl: async () => response({ ...runBody(), initial_events_version: value }) });
    await assert.rejects(client.readRun({ run_id: 'run_test' }), /QCA_READ_FAILED/);
  }
  const client = createQcaReadClient({ pat: 'secret', maxBytes: 100, fetchImpl: async () =>
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '101' } }) });
  await assert.rejects(client.readRun({ run_id: 'run_test' }), /QCA_RESPONSE_TOO_LARGE/);
});

test('expired or revoked signing authority and evidence cannot persist telemetry', t => {
  const db = database(t), o = observation(), valid = envelopes(o);
  const expired = clone(valid.permit.payload); expired.expires_utc = at;
  assert.throws(() => ingest(db.store, o, { permit: signed('operator', expired) }), /STALE_EVIDENCE/);
  const staleProof = clone(valid.permit.payload); staleProof.proofs[0].expires_utc = at;
  assert.throws(() => ingest(db.store, o, { permit: signed('operator', staleProof) }), /MISSING_ADMISSION_PROOF/);
  assert.throws(() => ingest(db.store, o, { keys: { ...keys, integration: { ...keys.integration, revoked: true } } }), /UNTRUSTED_PRINCIPAL/);
  assert.equal(db.store.read(scope).revision, 0);
});

test('export projects its allowlist again rather than exporting unrelated stored fields', t => {
  const db = database(t), o = observation(); ingest(db.store, o);
  db.store.transaction(scope, state => {
    const row = Object.values(state.telemetry)[0]; row.raw_prompt = 'PRIVATE'; row.latest.token = 'PRIVATE';
    row.latest.usage = { state: 'unknown', total_credits: 0, account_id: 'PRIVATE' };
    state.telemetry.unrelated = { account_id: 'PRIVATE' };
  });
  const out = exportTelemetry({ store: db.store, scope });
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|raw_prompt|token|account_id/);
  assert.equal(out.observations[0].latest.usage.total_credits, null);
});
