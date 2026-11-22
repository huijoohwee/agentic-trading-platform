import { createPublicKey } from 'node:crypto';
import { boundedCall, boundedJson, canonical, fail, freeze, hash, requireProofs, requireThat, sha, utcMillis, verifyEnvelope } from './core.mjs';
import { appendEvent } from './store.mjs';

export const QCA_ORIGIN = 'https://api.qoder.com';
// Local capabilities, NOT provider tool names or a writable Forward DSL.
export const ROLE_TOOL_ALLOWLIST = freeze({
  coordinator: ['artifact.read', 'config.read', 'telemetry.read'],
  research: ['market.read', 'news.read', 'artifact.read'],
  risk: ['portfolio.read', 'risk.read', 'artifact.read', 'config.read'],
  executor: ['artifact.read', 'decision.read'],
  advisor: ['artifact.read', 'telemetry.read'],
});
const roles = Object.keys(ROLE_TOOL_ALLOWLIST);
const constraints = { read_only: true, can_dispatch: false, can_submit_orders: false, can_schedule: false };
const opaque = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) &&
  !['latest', 'current', 'default', 'main', 'head'].includes(v.toLowerCase());
const integer = v => Number.isSafeInteger(v) && v >= 0;
const version = v => integer(v) && v > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const equal = (a, b) => canonical(a) === canonical(b);
function shape(value, fields, code = 'INVALID_CONFIGURATION') {
  requireThat(object(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','), code);
}
function list(value, max = 64) { requireThat(Array.isArray(value) && value.length <= max, 'INVALID_ARRAY'); }
function distinct(values) { requireThat(new Set(values).size === values.length, 'DUPLICATE_BINDING'); }
function time(value, now, min = now - 300_000) {
  const at = utcMillis(value);
  requireThat(at !== null && at >= min && at <= now, 'INVALID_OBSERVATION_TIME');
  return value;
}

// Compiled hashes and resource snapshots are observations, not update bodies.
export function validateConfiguration(candidate) {
  const c = boundedJson(candidate);
  shape(c, ['schema', 'mode', 'origin', 'bindings', 'snapshot', 'roles', 'reviewer_isolation']);
  requireThat(c.schema === 'trading-forward-configuration/v1' && c.origin === QCA_ORIGIN &&
    ['LOCAL_TEMPLATE', 'BOUND_READ_ONLY'].includes(c.mode), 'INVALID_CONFIGURATION');
  let bound = true;
  function pin(value, check) {
    if (value === null) { bound = false; return; }
    requireThat(check(value), 'INVALID_PIN');
  }
  shape(c.bindings, ['identity_ref', 'template_ref', 'template_version']);
  pin(c.bindings.identity_ref, hash); pin(c.bindings.template_ref, hash); pin(c.bindings.template_version, opaque);
  shape(c.snapshot, ['effective_hash', 'agent_effective_hash', 'session_effective_hash', 'resource_digest', 'initial_events_version']);
  for (const field of ['effective_hash', 'agent_effective_hash', 'session_effective_hash', 'resource_digest']) pin(c.snapshot[field], hash);
  pin(c.snapshot.initial_events_version, version);
  list(c.roles, 5);
  requireThat(c.roles.length === 5 && roles.every(name => c.roles.some(r => r?.name === name)), 'INVALID_ROLES');
  for (const r of c.roles) {
    shape(r, ['name', 'agent_ref', 'version', 'principal_ref', 'runtime_ref', 'tools', 'skills', 'children', 'mcp', 'resources', 'constraints']);
    pin(r.agent_ref, hash); pin(r.version, version); pin(r.principal_ref, hash); pin(r.runtime_ref, hash);
    requireThat(equal(r.constraints, constraints), 'MUTATION_FORBIDDEN');
    const tools = values => {
      list(values); distinct(values);
      requireThat(values.every(t => ROLE_TOOL_ALLOWLIST[r.name].includes(t)), 'TOOL_FORBIDDEN');
    };
    tools(r.tools);
    for (const field of ['skills', 'children', 'mcp', 'resources']) list(r[field]);
    for (const s of r.skills) {
      shape(s, ['ref', 'version', 'digest']); pin(s.ref, hash); pin(s.version, opaque); pin(s.digest, hash);
    }
    for (const child of r.children) {
      shape(child, ['role', 'agent_ref', 'version']);
      requireThat(r.name === 'coordinator' && roles.includes(child.role) && child.role !== r.name, 'INVALID_CHILD');
      pin(child.agent_ref, hash); pin(child.version, version);
      const target = c.roles.find(item => item.name === child.role);
      requireThat(child.agent_ref === target.agent_ref && child.version === target.version, 'CHILD_BINDING');
    }
    distinct(r.children.map(child => child.role));
    if (r.name === 'coordinator') requireThat(r.children.length === 4, 'INVALID_CHILD');
    for (const m of r.mcp) {
      shape(m, ['ref', 'digest', 'tools']); pin(m.ref, hash); pin(m.digest, hash); tools(m.tools);
      requireThat(m.tools.every(t => r.tools.includes(t)), 'TOOL_FORBIDDEN');
    }
    for (const resource of r.resources) {
      shape(resource, ['ref', 'digest', 'access']); pin(resource.ref, hash); pin(resource.digest, hash);
      requireThat(resource.access === 'read-only', 'MUTATION_FORBIDDEN');
    }
    for (const field of ['skills', 'mcp', 'resources']) distinct(r[field].filter(v => v.ref !== null).map(v => v.ref));
  }
  shape(c.reviewer_isolation, ['required', 'reviewer_role', 'evidence_ref']);
  requireThat(c.reviewer_isolation.required === true && c.reviewer_isolation.reviewer_role === 'risk', 'REVIEWER_ISOLATION_REQUIRED');
  requireThat(c.reviewer_isolation.evidence_ref === null || hash(c.reviewer_isolation.evidence_ref), 'INVALID_PIN');
  const reviewer = c.roles.find(r => r.name === 'risk');
  const isolated = hash(c.reviewer_isolation.evidence_ref) && hash(reviewer.principal_ref) && hash(reviewer.runtime_ref) &&
    c.roles.filter(r => r !== reviewer).every(r => r.principal_ref !== reviewer.principal_ref && r.runtime_ref !== reviewer.runtime_ref);
  bound = bound && c.mode === 'BOUND_READ_ONLY';
  return freeze({ configuration: c, digest: sha(c), bound, admissible: bound && isolated, authority: false,
    dispatch_allowed: false, reasons: [...(bound ? [] : ['UNBOUND_PROVIDER_VALUES']), ...(isolated ? [] : ['REVIEWER_ISOLATION_REQUIRED'])] });
}

// Whole arrays are compared atomically, never sorted, merged, defaulted or dropped.
export function diffConfiguration(previous, next) {
  const a = validateConfiguration(previous), b = validateConfiguration(next), changed = [], unchangedArrays = [];
  function walk(x, y, path) {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (equal(x, y)) unchangedArrays.push(path); else changed.push(path);
    } else if (object(x) && object(y)) {
      for (const key of Object.keys(x)) walk(x[key], y[key], path ? `${path}.${key}` : key);
    } else if (!equal(x, y)) changed.push(path);
  }
  walk(a.configuration, b.configuration, '');
  return freeze({ changed: changed.length > 0, changed_paths: changed, unchanged_arrays: unchangedArrays,
    previous_digest: a.digest, next_digest: b.digest, requires_rebinding: changed.length > 0,
    next_configuration: b.configuration, authority: false, dispatch_allowed: false });
}

// Safe material for a future provenance record; never writes AGENTS or returns provider prompts/IDs.
export function provenanceProjection(candidate) {
  const v = validateConfiguration(candidate), c = v.configuration;
  return freeze({ schema: 'trading-forward-provenance/v1', configuration_digest: v.digest, origin: QCA_ORIGIN,
    mode: c.mode, bindings: c.bindings, snapshot: c.snapshot, admissible: v.admissible, authority: false,
    dispatch_allowed: false, roles: c.roles.map(r => ({ name: r.name, agent_ref: r.agent_ref, version: r.version,
      tools: r.tools, skills: r.skills.map(s => ({ ref: s.ref, version_digest: s.version === null ? null : sha(s.version), digest: s.digest })),
      children: r.children, resources: r.resources, mcp: r.mcp })), reviewer_isolation: c.reviewer_isolation });
}

const ref = value => { requireThat(typeof value === 'string' && value.length > 0 && value.length <= 256, 'INVALID_PROVIDER_RESPONSE'); return sha(value); };
const unknownUsage = () => ({ state: 'unknown', total_credits: null, source: null });
const runStatuses = ['pending', 'queued', 'running', 'completed', 'failed', 'skipped', 'requires_action'];
const threadStatuses = ['idle', 'running', 'rescheduling', 'terminated', 'archived', 'requires_action'];
const known = (value, allowed) => allowed.includes(value) ? value : 'unknown';
function statusProjection(value, thread = false) {
  const status = known(value.status, thread ? threadStatuses : runStatuses);
  const push_status = known(value.push_status, ['succeeded', 'failed']);
  return { status, push_status, completed: status === 'completed', delivered: push_status === 'succeeded',
    awaiting_action: status === 'requires_action' };
}
function providerDigest(value) {
  requireThat(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'INVALID_PROVIDER_RESPONSE');
  return value.slice(7);
}
function projectEffective(body, request) {
  requireThat(object(body) && body.type === 'effective_spec' && body.identity_id === request.identity_id &&
    body.template_id === request.template_id && object(body.agent) && object(body.session) &&
    Array.isArray(body.session.resources), 'INVALID_PROVIDER_RESPONSE');
  return { identity_ref: ref(body.identity_id), template_ref: ref(body.template_id),
    effective_hash: providerDigest(body.effective_hash), agent_effective_hash: providerDigest(body.agent_effective_hash),
    session_effective_hash: providerDigest(body.session_effective_hash), resource_digest: sha(body.session.resources),
    agent_snapshot_digest: sha(body.agent), session_snapshot_digest: sha(body.session), writable_dsl: false };
}
function projectRun(body, request, now) {
  requireThat(object(body) && body.id === request.run_id &&
    (request.identity_id === undefined || body.identity_id === request.identity_id), 'INVALID_PROVIDER_RESPONSE');
  const result = { run_ref: ref(body.id), identity_ref: ref(body.identity_id), template_ref: ref(body.template_id),
    session_ref: body.session_id == null ? null : ref(body.session_id),
    ...statusProjection(body), usage: unknownUsage(), initial_events_version: null, attempt: null, duration_ms: null };
  for (const key of ['initial_events_version', 'attempt', 'duration_ms']) {
    if (body[key] != null) {
      requireThat((key === 'duration_ms' ? integer : version)(body[key]), 'INVALID_PROVIDER_RESPONSE'); result[key] = body[key];
    }
  }
  for (const key of ['triggered_at', 'started_at', 'completed_at', 'push_finished_at', 'created_at']) {
    result[key] = body[key] == null ? null : time(body[key], now, 0);
  }
  return result;
}

// Schedule Run usage stays unknown because its documented response has no credit field.
export function createQcaReadClient({ pat, fetchImpl = globalThis.fetch, timeoutMs = 5000, maxBytes = 256_000, now = Date.now } = {}) {
  requireThat(typeof pat === 'string' && /^[\x21-\x7e]{1,4096}$/.test(pat), 'QCA_AUTH_REQUIRED');
  requireThat(typeof fetchImpl === 'function' && typeof now === 'function' && integer(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000 &&
    integer(maxBytes) && maxBytes > 0 && maxBytes <= 1_000_000, 'INVALID_TRANSPORT_LIMIT');
  const pathId = value => { requireThat(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value), 'INVALID_QCA_ID'); return value; };
  async function read(kind, path, request) {
    let reader;
    try {
      return await boundedCall(async signal => {
        const response = await fetchImpl(QCA_ORIGIN + path, { method: 'GET', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' } });
        requireThat(!response.redirected && response.status >= 200 && response.status < 300, 'QCA_HTTP_ERROR');
        if (response.url) requireThat(response.url === QCA_ORIGIN + path, 'QCA_REDIRECT_REJECTED');
        requireThat(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'QCA_INVALID_RESPONSE');
        const length = response.headers.get('content-length');
        requireThat(length === null || (/^\d+$/.test(length) && Number(length) <= maxBytes), 'QCA_RESPONSE_TOO_LARGE');
        requireThat(response.body && typeof response.body.getReader === 'function', 'QCA_INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          requireThat(bytes <= maxBytes, 'QCA_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value));
        }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { fail('QCA_INVALID_RESPONSE'); }
        const at = now(); requireThat(Number.isFinite(at), 'QCA_INVALID_RESPONSE');
        return freeze({ schema: 'qca-transport-observation/v1', source: 'QCA_AUTHENTICATED_READ', origin: QCA_ORIGIN,
          kind, authenticated_transport: true, authority: false, observed_utc: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          data: kind === 'effective' ? projectEffective(body, request) : projectRun(body, request, at) });
      }, timeoutMs);
    } catch (error) {
      const safe = ['TIMEOUT', 'QCA_HTTP_ERROR', 'QCA_REDIRECT_REJECTED', 'QCA_INVALID_RESPONSE', 'QCA_RESPONSE_TOO_LARGE'];
      fail(safe.includes(error?.code) ? error.code : 'QCA_READ_FAILED');
    } finally {
      try { if (reader) void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Never expose cleanup errors. */ }
    }
  }
  return Object.freeze({
    readEffective({ identity_id, template_id }) {
      const path = `/api/v1/forward/identities/${pathId(identity_id)}/templates/${pathId(template_id)}/effective`;
      return read('effective', path, { identity_id, template_id });
    },
    readRun({ run_id, identity_id }) {
      let path = `/api/v1/forward/schedule_runs/${pathId(run_id)}?include_initial_events=true`;
      if (identity_id !== undefined) path += `&identity_id=${pathId(identity_id)}`;
      return read('run', path, { run_id, identity_id });
    },
  });
}

// Extra event fields are excluded from storage but included in conflict detection.
export const telemetryCandidate = observation => sha(boundedJson(observation));
function sourceProjection(source) {
  shape(source, ['provider', 'origin', 'stream', 'identity_ref', 'template_ref', 'run_ref', 'session_ref', 'thread_ref'], 'INVALID_SOURCE');
  requireThat(source.provider === 'QCA' && source.origin === QCA_ORIGIN && hash(source.identity_ref) && hash(source.template_ref) &&
    ['schedule_run', 'main_session', 'thread'].includes(source.stream) && hash(source.run_ref), 'INVALID_SOURCE');
  requireThat(source.session_ref === null || hash(source.session_ref), 'INVALID_SOURCE');
  requireThat(source.stream === 'thread' ? hash(source.thread_ref) && hash(source.session_ref) : source.thread_ref === null, 'INVALID_SOURCE');
  if (source.stream === 'main_session') requireThat(hash(source.session_ref), 'INVALID_SOURCE');
  return source;
}
function usageProjection(usage, isThread) {
  if (usage == null || usage.state === 'unknown') return unknownUsage();
  requireThat(object(usage), 'INVALID_USAGE');
  if (usage.state !== 'measured' || usage.source !== 'thread.usage.total_credits' || !isThread) return unknownUsage();
  requireThat(typeof usage.total_credits === 'number' && Number.isFinite(usage.total_credits) &&
    usage.total_credits >= 0 && usage.total_credits <= 1_000_000_000, 'INVALID_USAGE');
  return { state: 'measured', total_credits: usage.total_credits, source: 'thread.usage.total_credits' };
}
function projectThread(thread, source, now) {
  requireThat(object(thread) && hash(thread.thread_ref) && hash(thread.session_ref) && thread.session_ref === source.session_ref &&
    (thread.parent_thread_ref === null || hash(thread.parent_thread_ref)) && thread.parent_thread_ref !== thread.thread_ref &&
    ['coordinator', 'child'].includes(thread.role) && hash(thread.cursor), 'INVALID_THREAD');
  requireThat(source.stream !== 'thread' || thread.thread_ref === source.thread_ref, 'INVALID_THREAD');
  requireThat(thread.role === 'coordinator' ? thread.parent_thread_ref === null : hash(thread.parent_thread_ref), 'INVALID_THREAD');
  return { thread_ref: thread.thread_ref, session_ref: thread.session_ref, parent_thread_ref: thread.parent_thread_ref,
    source_digest: sha(thread), role: thread.role, cursor: thread.cursor, observed_utc: time(thread.observed_utc, now),
    status: known(thread.status, threadStatuses), usage: usageProjection(thread.usage, true) };
}
const threadContent = ({ observed_utc, source_digest, ...content }) => content;
function projectEvent(event, source, now) {
  requireThat(object(event) && hash(event.id) && event.kind === source.stream && event.run_ref === source.run_ref &&
    event.session_ref === source.session_ref && event.thread_ref === source.thread_ref, 'INVALID_SOURCE_EVENT');
  const result = { source_event_ref: event.id, source_digest: sha({ source, event }), kind: event.kind, run_ref: source.run_ref,
    session_ref: source.session_ref, thread_ref: source.thread_ref, ...statusProjection(event, source.stream === 'thread'),
    usage: usageProjection(event.usage, source.stream === 'thread'), initial_events_version: null };
  if (event.initial_events_version != null) {
    requireThat(version(event.initial_events_version), 'INVALID_INPUT_VERSION'); result.initial_events_version = event.initial_events_version;
  }
  return { id: sha({ provider: source.provider, event: event.id }), type: 'forward.observation', at: time(event.at, now), data: result };
}

export function ingestTelemetry({ store, scope, keys, permit, envelope, configuration, now = Date.now() }) {
  const raw = boundedJson(envelope), observation = raw?.payload?.observation, grant = boundedJson(permit);
  const candidate = telemetryCandidate(observation);
  const operator = verifyEnvelope(grant, { keys, role: 'operator', kind: 'telemetry', scope, candidate, now });
  requireProofs(operator, ['cost', 'rights'], now);
  for (const kind of ['cost', 'rights']) requireThat(hash(operator[`${kind}_ref`]) && operator.proofs.some(p =>
    p.kind === kind && p.digest === operator[`${kind}_ref`] && utcMillis(p.expires_utc) > now), 'MISSING_TELEMETRY_REFERENCE');
  const integration = verifyEnvelope(raw, { keys, role: 'integration', kind: 'provider-observation', scope, candidate, now });
  const operatorKey = createPublicKey(keys[grant.key_id].publicKey).export({ type: 'spki', format: 'der' });
  const integrationKey = createPublicKey(keys[raw.key_id].publicKey).export({ type: 'spki', format: 'der' });
  requireThat(operator.principal !== integration.principal && operator.runtime !== integration.runtime &&
    !operatorKey.equals(integrationKey), 'PRINCIPAL_ISOLATION');
  shape(observation, ['source', 'observed_utc', 'expected_cursor', 'cursor', 'current_config', 'events', 'threads'], 'INVALID_OBSERVATION');
  const expected = validateConfiguration(configuration), current = validateConfiguration(observation.current_config);
  requireThat(expected.bound && current.bound, 'UNBOUND_CONFIGURATION');
  requireThat(expected.digest === current.digest, 'CONFIGURATION_DRIFT');
  const source = sourceProjection(observation.source), sourceKey = `forward:${sha(source)}`;
  requireThat(source.identity_ref === expected.configuration.bindings.identity_ref &&
    source.template_ref === expected.configuration.bindings.template_ref, 'SOURCE_BINDING');
  time(observation.observed_utc, now);
  requireThat((observation.expected_cursor === null || hash(observation.expected_cursor)) && hash(observation.cursor) &&
    observation.cursor !== observation.expected_cursor, 'INVALID_CURSOR');
  list(observation.events, 200); list(observation.threads, 64);
  distinct(observation.events.map(e => e?.id)); distinct(observation.threads.map(t => t?.thread_ref));
  const events = observation.events.map(event => projectEvent(event, source, utcMillis(observation.observed_utc)));
  requireThat(events.every(event => event.data.initial_events_version === null ||
    event.data.initial_events_version === expected.configuration.snapshot.initial_events_version), 'INPUT_VERSION_DRIFT');
  const threads = observation.threads.map(thread => projectThread(thread, source, utcMillis(observation.observed_utc)));
  requireThat(source.stream !== 'thread' || threads.some(t => t.thread_ref === source.thread_ref), 'MISSING_THREAD_REFERENCE');
  // Main-session events never stand in for child streams. Thread readbacks must be separately supplied.
  return store.transaction(scope, state => {
    const checkpoint = Object.hasOwn(state.checkpoints, sourceKey) ? state.checkpoints[sourceKey] : null;
    if (checkpoint?.batch_digest === candidate && checkpoint.cursor === observation.cursor)
      return { duplicate: true, appended: 0, cursor: checkpoint.cursor, authority: false, dispatch_allowed: false };
    requireThat((checkpoint?.cursor ?? null) === observation.expected_cursor, 'STALE_CURSOR');
    requireThat(!checkpoint || utcMillis(observation.observed_utc) >= utcMillis(checkpoint.observed_utc), 'STALE_OBSERVATION');
    const before = state.events.length, previous = state.telemetry[sourceKey];
    const compatible = previous?.configuration_digest === expected.digest ? previous : null;
    let latest = compatible?.latest ?? null, lastEventAt = checkpoint?.last_event_at ?? null;
    for (const event of events) {
      const count = state.events.length;
      appendEvent(state, event);
      if (state.events.length === count) continue;
      requireThat(lastEventAt === null || utcMillis(event.at) >= utcMillis(lastEventAt), 'STALE_EVENT');
      latest = event.data; lastEventAt = event.at;
    }
    for (const thread of threads) {
      const key = `forward-thread:${thread.thread_ref}`, previous = state.telemetry[key];
      requireThat(!previous || previous.session_ref === thread.session_ref, 'THREAD_BINDING');
      requireThat(!previous || utcMillis(thread.observed_utc) >= utcMillis(previous.observed_utc), 'STALE_OBSERVATION');
      requireThat(!previous || previous.cursor !== thread.cursor || equal(threadContent(previous), threadContent(thread)), 'CONFLICTING_THREAD');
      state.telemetry[key] = thread;
    }
    state.configs[`forward:${expected.digest}`] = expected.configuration;
    state.telemetry[sourceKey] = { source, configuration_digest: expected.digest, observed_utc: observation.observed_utc,
      latest, coverage: source.stream === 'main_session' ? 'main_session_only' : source.stream,
      thread_refs: [...new Set([...(compatible?.thread_refs ?? []), ...threads.map(t => t.thread_ref)])],
      authority: false, dispatch_allowed: false };
    state.checkpoints[sourceKey] = { cursor: observation.cursor, batch_digest: candidate, observed_utc: observation.observed_utc,
      last_event_at: lastEventAt };
    return { duplicate: false, appended: state.events.length - before, cursor: observation.cursor,
      configuration_digest: expected.digest, authority: false, dispatch_allowed: false };
  });
}

export function exportTelemetry({ store, scope }) {
  const state = store.read(scope);
  const observations = Object.entries(state.telemetry).filter(([key]) => key.startsWith('forward:')).map(([, row]) => {
    const source = sourceProjection(row.source), at = utcMillis(row.observed_utc);
    requireThat(hash(row.configuration_digest) && at !== null, 'INVALID_STORED_TELEMETRY');
    list(row.thread_refs, 10_000); requireThat(row.thread_refs.every(hash), 'INVALID_STORED_TELEMETRY');
    let latest = null;
    if (row.latest) {
      requireThat(hash(row.latest.source_digest), 'INVALID_STORED_TELEMETRY');
      latest = projectEvent({ ...row.latest, id: row.latest.source_event_ref, at: row.observed_utc }, source, at).data;
      latest.source_digest = row.latest.source_digest;
    }
    return { source, configuration_digest: row.configuration_digest, observed_utc: row.observed_utc, latest,
      coverage: source.stream === 'main_session' ? 'main_session_only' : source.stream,
      thread_refs: row.thread_refs, authority: false, dispatch_allowed: false };
  });
  const threads = Object.entries(state.telemetry).filter(([key]) => key.startsWith('forward-thread:')).map(([, row]) => {
    requireThat(hash(row.source_digest), 'INVALID_STORED_TELEMETRY');
    return { ...projectThread(row, { stream: 'main_session', session_ref: row.session_ref }, utcMillis(row.observed_utc)),
      source_digest: row.source_digest };
  });
  return freeze(boundedJson({ schema: 'trading-forward-telemetry/v1', authority: false, dispatch_allowed: false, observations, threads,
    provenance: Object.entries(state.configs).filter(([key]) => key.startsWith('forward:')).map(([, value]) => provenanceProjection(value)) }, 16_000_000));
}
