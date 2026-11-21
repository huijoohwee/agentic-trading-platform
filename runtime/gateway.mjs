import { createHash, timingSafeEqual } from 'node:crypto';
import { appendEvent } from './store.mjs';
import { boundedCall, boundedJson, hash, id, requireProofs, requireThat, sameScope, scopeKey, sha, utcMillis, verifyEnvelope } from './core.mjs';

const digest = text => createHash('sha256').update(text).digest();
const instant = n => new Date(Math.floor(n / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const REQUEST_KEYS = 'contract_version,request_id,capability_digest,operation,scope,inputs,deadline_utc';
const WRITE_OPERATIONS = new Set(['release', 'reconcile', 'halt']);
const REFUSALS = new Set(['UNSUPPORTED', 'UNQUALIFIED', 'UNAUTHORIZED', 'SCHEMA_DRIFT', 'PRECISION_UNKNOWN', 'STALE',
  'BUDGET_HALT', 'RELEASE_UNKNOWN', 'HALTED', 'CONFLICT', 'CONFLICTING_EVENT']);
const REFUSAL_MAP = {
  ACCOUNT_BINDING: 'UNAUTHORIZED', SCOPE_DENIED: 'UNAUTHORIZED', UNTRUSTED_PRINCIPAL: 'UNAUTHORIZED',
  PRINCIPAL_BINDING: 'UNAUTHORIZED', CANDIDATE_BINDING: 'UNAUTHORIZED', INVALID_SIGNATURE: 'UNAUTHORIZED',
  MISSING_ADMISSION_PROOF: 'UNQUALIFIED', REVOKED: 'UNQUALIFIED', PROTOCOL_UNQUALIFIED: 'UNQUALIFIED',
  ADMISSION_PROOF: 'UNQUALIFIED', GRANT_LIMITS: 'UNQUALIFIED', RISK_VETO: 'UNQUALIFIED',
  STALE_EVIDENCE: 'STALE', STALE_OBSERVATION: 'STALE', STALE_INPUT: 'STALE', WINDOW_CLOSED: 'STALE',
  INTENT_EXPIRED: 'STALE', CUTOFF: 'STALE', PRECISION_LOSS: 'PRECISION_UNKNOWN',
};
const refusalCode = code => REFUSALS.has(code) ? code : (REFUSAL_MAP[code] ?? 'UNQUALIFIED');
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.split(',').includes(key));

// One admission boundary shared by every frontend. Readers map semantic reads to reviewed provider
// adapters; the single injected guard owns approved writes. The gateway never proxies raw tools or
// endpoints, never forwards incoming credentials downstream and never falls back across accounts.
export function createGateway({ store, scope, candidate, capabilities, readers = {}, guard = null, keys = null, audienceToken, now = Date.now, practice = null }) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  requireThat(hash(candidate) && typeof now === 'function', 'CANDIDATE_BINDING');
  requireThat(typeof audienceToken === 'string' && audienceToken.length >= 32 && !/\s/.test(audienceToken), 'VIEWER_CREDENTIAL_REQUIRED');
  requireThat(store?.read && store?.transaction, 'HOST_TRANSPORT_REQUIRED');
  const expectedAudience = digest('Bearer ' + audienceToken);
  const records = (Array.isArray(capabilities) ? capabilities : []).map(record => {
    const body = boundedJson(record);
    requireThat(id(body.provider) && id(body.adapter_version) && hash(body.adapter_digest) && hash(body.schema_digest) &&
      hash(body.mapping_digest) && ['MOCK', 'PROVIDER'].includes(body.source) && ['account', 'public'].includes(body.mode) &&
      Array.isArray(body.operations) && body.operations.length > 0 && body.operations.every(id) &&
      Array.isArray(body.allowlist) && body.cost?.hard_cap_usd === 0 && body.cost?.deny_at_exhaustion === true &&
      body.qualification && id(body.qualification.status) && hash(body.qualification.receipt_digest), 'INVALID_CAPABILITY');
    return Object.freeze({ ...body, capability_digest: sha(body) });
  });
  if (practice) requireThat(/^desk\/[0-9a-f]{64}$/.test(scope.account_alias) && scope.profile==='practice' && records.length===1 &&
    records[0].capability_digest===practice.capability_digest && records[0].source==='MOCK' && records[0].provider==='local-practice' &&
    !records[0].operations.some(op=>WRITE_OPERATIONS.has(op)) && !keys && !guard && typeof practice.invoke==='function','ACCOUNT_BINDING');
  const byDigest = new Map(records.map(record => [record.capability_digest, record]));
  const authenticate = authorization => timingSafeEqual(expectedAudience, digest(typeof authorization === 'string' ? authorization : ''));
  const provenance = (record, operation) => ({ capability_digest: record.capability_digest, provider: record.provider,
    adapter_version: record.adapter_version, source: record.source, operation, schema_digest: record.schema_digest,
    mapping_digest: record.mapping_digest, observed_utc: instant(now()) });
  const key = request => 'gateway:' + request.request_id;

  const wellFormed = body => only(body, REQUEST_KEYS) && body.contract_version === '1' && id(body.request_id) &&
    hash(body.capability_digest) && id(body.operation) && body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs);

  function resolveCapability(body) {
    requireThat(utcMillis(body.deadline_utc) !== null && utcMillis(body.deadline_utc) > now() &&
      utcMillis(body.deadline_utc) <= now() + 600_000, 'STALE');
    const record = byDigest.get(body.capability_digest);
    requireThat(record, 'UNQUALIFIED');
    requireThat(record.mode === 'account', 'UNSUPPORTED');
    requireThat(sameScope(body.scope, scope), 'UNAUTHORIZED');
    requireThat(record.operations.includes(body.operation), 'UNSUPPORTED');
    requireThat(record.qualification.status === 'QUALIFIED', 'UNQUALIFIED');
    requireThat(utcMillis(record.qualification.expires_utc) !== null && now() < utcMillis(record.qualification.expires_utc), 'STALE');
    requireThat(practice || (WRITE_OPERATIONS.has(body.operation) ? guard : typeof readers[body.operation] === 'function'), 'UNSUPPORTED');
    return record;
  }

  async function dispatch({ body, record }) {
    const timeoutMs = Math.max(1, Math.min(600_000, utcMillis(body.deadline_utc) - now()));
    if (WRITE_OPERATIONS.has(body.operation)) {
      const method = { release: 'release', reconcile: 'reconcile', halt: 'halt' }[body.operation];
      return await boundedCall(() => guard[method](boundedJson(body.inputs)), timeoutMs);
    }
    return await boundedCall(signal => readers[body.operation]({ capability: record, inputs: boundedJson(body.inputs), signal }), timeoutMs);
  }

  const refused = (request_id, code) => ({ request_id, status: 'REFUSED', error: { code }, provenance: null, ledger_revision: null });

  async function admit(request, authorization) {
    requireThat(authenticate(authorization), 'UNAUTHORIZED');
    let body;
    try { body = boundedJson(request); } catch { return refused(null, 'UNQUALIFIED'); }
    if (!wellFormed(body)) return refused(id(body?.request_id) ? body.request_id : null, 'UNQUALIFIED');
    if (practice) {
      try {
        const record=resolveCapability(body);
        const {data,revision}=await practice.invoke(body);
        return {request_id:body.request_id,status:'OK',data,ledger_revision:revision,provenance:provenance(record,body.operation)};
      } catch(error) {
        const code=error.code??error.message;
        return refused(body.request_id,/^[A-Z][A-Z0-9_]{1,50}$/.test(code)?code:'UNQUALIFIED');
      }
    }
    const binding = sha(body), checkpointKey = key(body), request_id = body.request_id;
    try {
      const reserved = store.transaction(scope, state => {
        const previous = state.checkpoints[checkpointKey];
        if (previous) {
          requireThat(previous.binding === binding, 'CONFLICTING_EVENT');
          if (previous.status === 'FINAL') return { cached: previous.result };
          requireThat(false, 'CONFLICT');
        }
        state.checkpoints[checkpointKey] = { binding, status: 'ADMITTED' };
        appendEvent(state, { id: 'gateway-admit:' + request_id, type: 'gateway-admitted', at: instant(now()),
          data: { request_id, capability_digest: body.capability_digest, operation: body.operation, binding } });
        return { reserved: true };
      });
      if (reserved.cached) return reserved.cached;
      let result, authority = null;
      try {
        const record = resolveCapability(body);
        const halted = store.read(scope);
        requireThat(!halted.halted, halted.haltReason === 'RELEASE_UNKNOWN' ? 'RELEASE_UNKNOWN' : 'HALTED');
        // Connected reads and every write carry a signed operator grant; the domain boundary owns the
        // single durable $0 counter, so admission verifies authority without charging a second ledger.
        if (record.source === 'PROVIDER' || WRITE_OPERATIONS.has(body.operation)) {
          requireThat(keys && typeof keys === 'object' && !Array.isArray(keys), 'UNQUALIFIED');
          const write = WRITE_OPERATIONS.has(body.operation);
          authority = verifyEnvelope(body.inputs.grant, { keys, role: 'operator', kind: write ? 'paper' : 'read', scope, candidate, now: now() });
          requireProofs(authority, write ? ['cost', 'rights', 'account', 'isolation'] : ['cost', 'rights', 'account'], now());
          if (!write) requireThat(authority.mapping_digest === record.mapping_digest && Array.isArray(authority.tools) &&
            authority.tools.length > 0 && authority.tools.every(tool => id(tool.name) && tool.effect === 'read' &&
              record.allowlist.includes(tool.name)), 'SCOPE_DENIED');
        }
        const data = boundedJson(await dispatch({ body, record }));
        result = { request_id, status: 'OK', data, provenance: provenance(record, body.operation) };
      } catch (error) {
        result = { request_id, status: 'REFUSED', error: { code: refusalCode(error.code ?? '') }, provenance: null };
      }
      return store.transaction(scope, state => {
        const checkpoint = state.checkpoints[checkpointKey];
        requireThat(checkpoint?.binding === binding && checkpoint.status === 'ADMITTED', 'CONFLICT');
        const finalized = { ...result, ledger_revision: state.revision + 1 };
        state.checkpoints[checkpointKey] = { binding, status: 'FINAL', result: finalized };
        appendEvent(state, { id: 'gateway-final:' + request_id, type: 'gateway-finalized', at: instant(now()),
          data: { request_id, status: finalized.status, code: finalized.error?.code ?? null, ledger_revision: finalized.ledger_revision,
            cost_proof: authority?.proofs.find(proof => proof.kind === 'cost')?.digest ?? null,
            charged_calls: Number.isSafeInteger(finalized.data?.cost?.tool_calls) ? finalized.data.cost.tool_calls : null } });
        return finalized;
      });
    } catch (error) {
      return refused(request_id, refusalCode(error.code ?? ''));
    }
  }

  // Discovery exposes reviewed metadata only; it grants no admission, dispatch or write authority.
  function discover() {
    return records.map(record => ({ capability_digest: record.capability_digest, provider: record.provider,
      adapter_version: record.adapter_version, adapter_digest: record.adapter_digest, transport: record.transport ?? null,
      protocol: record.protocol ?? null, schema_digest: record.schema_digest, mapping_digest: record.mapping_digest,
      mode: record.mode, source: record.source, operations: [...record.operations], allowlist: [...record.allowlist],
      rights: record.rights ?? null, delay: record.delay ?? null, cost: { hard_cap_usd: record.cost.hard_cap_usd, deny_at_exhaustion: record.cost.deny_at_exhaustion },
      qualification: { status: record.qualification.status, expires_utc: record.qualification.expires_utc } }));
  }

  return Object.freeze({ admit, discover, authenticate });
}