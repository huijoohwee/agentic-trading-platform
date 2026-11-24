import { boundedCall, boundedJson, canonical, hash, id, requireProofs, requireThat, scopeKey, sha, utcMillis, verifyEnvelope } from './core.mjs';
import { MARKET_READ_OPERATIONS } from './mcp-market-read.mjs';

// Operation-shaped provider reads share the snapshot importer's single durable $0 counter: the
// budget scope and cost-proof-digest key are identical, so admission reserves calls once across
// both read paths and deny_at_exhaustion holds. The gateway checkpoint owns request idempotency.
export function createMarketReadBoundary({ store, scope, candidate, keys, adapter, now = Date.now }) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  const budgetScope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/' + sha(scope.account_alias) };
  return async function readMarket({ operation, inputs, grant: envelope }) {
    const started = now();
    requireThat(MARKET_READ_OPERATIONS.includes(operation), 'UNSUPPORTED');
    const grant = verifyEnvelope(envelope, { keys, role: 'operator', kind: 'read', scope, candidate, now: started });
    requireProofs(grant, ['cost', 'rights', 'account'], started);
    requireThat(id(grant.nonce) && Number.isSafeInteger(grant.limits?.max_calls) && grant.limits.max_calls >= 3 && grant.limits.max_calls <= 12 &&
      grant.cost.remaining_calls >= grant.limits.max_calls && Number.isSafeInteger(grant.limits.timeout_ms) &&
      grant.limits.timeout_ms > 0 && grant.limits.timeout_ms <= 600_000, 'BUDGET_HALT');
    requireThat(Array.isArray(grant.tools) && grant.tools.length > 0 && grant.tools.every(tool =>
      id(tool.name) && hash(tool.schema_digest) && tool.effect === 'read' && MARKET_READ_OPERATIONS.includes(tool.operation)), 'SCOPE_DENIED');
    const allowed = grant.tools.find(tool => tool.operation === operation);
    requireThat(allowed, 'SCOPE_DENIED');
    adapter.validateInputs?.(operation, inputs, allowed);
    if (operation === 'read.stock-screen' || allowed.inputs_digest !== undefined) {
      const { grant: envelopeInput, ...parameters } = boundedJson(inputs);
      requireThat(allowed.inputs_digest === sha(parameters), 'SCOPE_DENIED');
    }
    store.transaction(budgetScope, state => {
      const proofDigest = grant.proofs.find(proof => proof.kind === 'cost').digest;
      const counter = state.telemetry[proofDigest] ?? { limit: grant.cost.remaining_calls, calls: 0 };
      requireThat(counter.limit === grant.cost.remaining_calls && Number.isSafeInteger(counter.calls) && counter.calls >= 0 &&
        counter.calls <= counter.limit - grant.limits.max_calls, 'BUDGET_HALT');
      counter.calls += grant.limits.max_calls;
      state.telemetry[proofDigest] = counter;
    });
    const deadline = Math.min(started + 600_000, utcMillis(grant.expires_utc));
    const invoke = fn => boundedCall(signal => {
      requireThat(now() >= started && now() < deadline, 'WINDOW_CLOSED');
      return fn(signal);
    }, Math.min(grant.limits.timeout_ms, deadline - now()));
    const opened = verifyEnvelope(await invoke(signal => adapter.open({ grant, signal })),
      { keys, role: 'integration', kind: 'read-capabilities', scope, candidate, now: now() });
    requireThat(opened.tools && canonical(opened.tools) === canonical(grant.tools) &&
      Number.isSafeInteger(opened.calls) && opened.calls >= 0 && opened.calls < grant.limits.max_calls, 'SCHEMA_DRIFT');
    const page = verifyEnvelope(await invoke(signal => adapter.read({ operation, inputs: boundedJson(inputs), signal })),
      { keys, role: 'integration', kind: 'provider-market-page', scope, candidate, now: now() });
    requireThat(page.operation === operation && page.schema_digest === allowed.schema_digest && hash(page.response_digest) &&
      utcMillis(page.observed_utc) !== null && utcMillis(page.observed_utc) <= now() && id(page.source_event) &&
      page.rows !== undefined && Array.isArray(page.decimals), 'INVALID_PAGE');
    const rows = boundedJson(page.rows), decimals = boundedJson(page.decimals);
    const precision = {};
    if (Object.hasOwn(page, 'price_source')) {
      requireThat(operation === 'read.ticker' && decimals.length === 1 && typeof decimals[0]?.price === 'string' &&
        ['decimal-string', 'json-number'].includes(page.price_source), 'INVALID_PAGE');
      precision.price_source = page.price_source;
    }
    const metadata = {};
    if (Object.hasOwn(page, 'last_valid_time_ms')) metadata.last_valid_time_ms = page.last_valid_time_ms;
    if (page.pagination) metadata.pagination = boundedJson(page.pagination);
    return { operation, source: 'AUTHENTICATED_ADAPTER', rows, decimals, ...metadata, ...precision, observed_utc: page.observed_utc,
      response_digest: page.response_digest, digest: sha({ rows, decimals, response_digest: page.response_digest, ...precision }),
      cost: { tool_calls: opened.calls + 1, tokens_in: 'UNKNOWN', tokens_out: 'UNKNOWN', provider_fees: 'UNKNOWN' } };
  };
}
