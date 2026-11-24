import { readBudgetScope, reserveReadCalls } from './read-budget.mjs';
import { readLanding, portfolio } from '../src/landing.mjs';
import { appendEvent } from './store.mjs';
import { boundedCall, boundedJson, canonical, hash, id, requireProofs, requireThat, scopeKey, sha, utcMillis, verifyEnvelope } from './core.mjs';

export const SHEETS = ['IN_Quotes', 'IN_Positions', 'IN_Balance', 'IN_Orders'];
const moneyFields = { IN_Quotes: ['last', 'prev_close'], IN_Positions: ['qty', 'avg_cost'],
  IN_Balance: ['cash', 'total_assets'], IN_Orders: ['qty', 'limit_price', 'filled_qty', 'avg_fill_price'] };
function decimal(value) {
  requireThat(typeof value === 'string' && value.length <= 64 && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value), 'PRECISION_UNKNOWN');
  const [coefficient, power = '0'] = value.toLowerCase().split('e');
  const fractional = coefficient.split('.')[1]?.length ?? 0;
  let n = BigInt(coefficient.replace('.', '')), exponent = Number(power) - fractional;
  requireThat(Math.abs(exponent) <= 100, 'PRECISION_UNKNOWN');
  if (n === 0n) return '0';
  while (n % 10n === 0n) { n /= 10n; exponent++; }
  return n + 'e' + exponent;
}
function validatePrecision(sheet, rows, decimals) {
  requireThat(Array.isArray(decimals) && decimals.length === rows.length, 'PRECISION_UNKNOWN');
  rows.forEach((row, index) => {
    for (const field of moneyFields[sheet]) {
      if (row[field] === null && sheet === 'IN_Orders' && field === 'avg_fill_price') continue;
      requireThat(Number.isFinite(row[field]) && decimal(decimals[index]?.[field]) === decimal(String(row[field])), 'PRECISION_LOSS');
    }
  });
}
export function recoverReadImport({ store, scope, candidate, keys, permit, now = Date.now() }) {
  const grant = verifyEnvelope(permit, { keys, role: 'operator', kind: 'read-recovery', scope, candidate, now });
  requireThat(id(grant.run_id) && id(grant.nonce) && hash(grant.import_binding), 'INVALID_RECOVERY');
  return store.transaction(scope, state => {
    const checkpoint = state.checkpoints['import:' + grant.run_id];
    requireThat(checkpoint?.status === 'READING' && checkpoint.binding === grant.import_binding, 'RECOVERY_BINDING');
    requireThat(!Object.hasOwn(state.usedApprovals, 'read-recovery:' + grant.nonce), 'GRANT_REPLAY');
    state.usedApprovals['read-recovery:' + grant.nonce] = grant.run_id;
    state.checkpoints['import:' + grant.run_id] = { ...checkpoint, status: 'FAILED', reason: 'OPERATOR_INTERRUPTED', calls: 'UNKNOWN' };
    appendEvent(state, { id: 'recovery:' + grant.run_id, type: 'import-interrupted', at: new Date(now).toISOString(),
      data: { run_id: grant.run_id, binding: grant.import_binding, permit_digest: sha(permit), refunded_calls: 0 } });
    return { status: 'INTERRUPTED', refunded_calls: 0 };
  });
}

export function createReadImporter({ store, scope, candidate, keys, adapter, now = Date.now }) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  const budgetScope = readBudgetScope(scope);
  return async function importSnapshot({ run_id, grant: envelope }) {
    const started = now();
    requireThat(id(run_id), 'INVALID_RUN');
    const grant = verifyEnvelope(envelope, { keys, role: 'operator', kind: 'read', scope, candidate, now: started });
    requireProofs(grant, ['cost', 'rights', 'account'], started);
    requireThat(id(grant.nonce) && Number.isSafeInteger(grant.limits?.max_calls) && grant.limits.max_calls >= 4 && grant.limits.max_calls <= 12 &&
      grant.cost.remaining_calls >= grant.limits.max_calls && Number.isSafeInteger(grant.limits.timeout_ms) &&
      grant.limits.timeout_ms > 0 && grant.limits.timeout_ms <= 600_000, 'BUDGET_HALT');
    requireThat(Array.isArray(grant.tools) && grant.tools.length === 4 && SHEETS.every(sheet => grant.tools.some(tool =>
      tool.sheet === sheet && id(tool.name) && hash(tool.schema_digest) && tool.effect === 'read')), 'SCOPE_DENIED');
    const key = 'import:' + run_id, binding = sha(envelope);
    const reservation = store.transaction(scope, state => {
      const previous = state.checkpoints[key];
      if (previous) { requireThat(previous.binding === binding, 'CONFLICTING_RUN'); return { previous }; }
      requireThat(!state.halted, 'IMPORT_HALTED');
      requireThat(!Object.hasOwn(state.usedApprovals, 'read:' + grant.nonce), 'GRANT_REPLAY');
      requireThat(!Object.values(state.checkpoints).some(value => value?.status === 'READING'), 'IMPORT_BUSY');
      state.usedApprovals['read:' + grant.nonce] = run_id;
      state.checkpoints[key] = { binding, status: 'READING', prior: state.currentSnapshot, reserved_calls: grant.limits.max_calls };
      return { prior: state.currentSnapshot };
    });
    if (reservation.previous) {
      requireThat(reservation.previous.status === 'ACCEPTED', 'INCOMPLETE_IMPORT');
      return store.read(scope).snapshots[run_id];
    }
    let calls = 0, bytes = 0, errors = 0, reservedCalls = 0, setupStarted = false, setupComplete = false;
    const landing = Object.fromEntries(SHEETS.map(sheet => [sheet, []])), evidence = [], precisions = {}, attestations = [];
    const deadline = Math.min(started + 600_000, utcMillis(grant.expires_utc));
    const checkWindow = () => {
      const at = now();
      requireThat(at >= started && at < deadline, 'WINDOW_CLOSED');
      const currentGrant = verifyEnvelope(envelope, { keys, role: 'operator', kind: 'read', scope, candidate, now: at });
      requireProofs(currentGrant, ['cost', 'rights', 'account'], at);
      requireThat(sha(envelope) === binding, 'CONFLICTING_RUN');
      const state = store.read(scope);
      requireThat(!state.halted, 'IMPORT_HALTED');
      requireThat(state.checkpoints[key]?.status === 'READING' && state.checkpoints[key].binding === binding, 'INCOMPLETE_IMPORT');
      for (const { value, kind } of attestations) verifyEnvelope(value, { keys, role: 'integration', kind, scope, candidate, now: at });
    };
    const invoke = fn => {
      checkWindow();
      return boundedCall(signal => { checkWindow(); return fn(signal); }, Math.min(grant.limits.timeout_ms, deadline - now()));
    };
    const observation = (value, kind) => {
      const payload = verifyEnvelope(value, { keys, role: 'integration', kind, scope, candidate, now: now() });
      attestations.push({ value, kind });
      return payload;
    };
    try {
      store.transaction(budgetScope, state => reserveReadCalls(state, grant));
      reservedCalls = grant.limits.max_calls;
      const opened = observation(await invoke(signal => {
        setupStarted = true;
        return adapter.open({ grant, signal, beforeCall: checkWindow });
      }), 'read-capabilities');
      requireThat(opened.tools && canonical(opened.tools) === canonical(grant.tools) &&
        Number.isSafeInteger(opened.calls) && opened.calls >= 0 && opened.calls < grant.limits.max_calls, 'SCHEMA_DRIFT');
      calls = opened.calls; setupComplete = true;
      for (const sheet of SHEETS) {
        let cursor = null;
        const seen = new Set();
        precisions[sheet] = [];
        while (true) {
          checkWindow();
          requireThat(calls < grant.limits.max_calls, 'BUDGET_HALT');
          let page;
          try {
            page = observation(await invoke(signal => {
              calls++;
              return adapter.read({ sheet, cursor, run_id, limit: 50, signal });
            }), 'provider-page');
          } catch (error) {
            if (['SCOPE_DENIED', 'UNTRUSTED_PRINCIPAL', 'INVALID_SIGNATURE', 'SCHEMA_DRIFT', 'TIMEOUT', 'REVOKED',
              'STALE_EVIDENCE', 'MISSING_ADMISSION_PROOF', 'WINDOW_CLOSED', 'IMPORT_HALTED', 'INCOMPLETE_IMPORT', 'CONFLICTING_RUN',
              'CANDIDATE_BINDING', 'PRINCIPAL_BINDING', 'BUDGET_HALT', 'PRECISION_UNKNOWN', 'PRECISION_LOSS'].includes(error.code)) throw error;
            requireThat(++errors < 2, 'TWO_READ_ERRORS');
            continue;
          }
          checkWindow(); errors = 0;
          requireThat(page.run_id === run_id && page.sheet === sheet && page.cursor === cursor &&
            page.schema_digest === grant.tools.find(tool => tool.sheet === sheet).schema_digest && hash(page.response_digest) &&
            utcMillis(page.observed_utc) !== null && utcMillis(page.observed_utc) <= now() &&
            id(page.source_event) && Array.isArray(page.rows) && page.rows.length <= 50 &&
            (page.next === null || (id(page.next) && !seen.has(page.next))), 'INVALID_PAGE');
          validatePrecision(sheet, page.rows, page.decimals);
          bytes += Buffer.byteLength(canonical(page));
          requireThat(bytes <= 480_000, 'INPUT_TOO_LARGE');
          landing[sheet].push(...boundedJson(page.rows));
          precisions[sheet].push(...boundedJson(page.decimals));
          evidence.push({ sheet, source_event: page.source_event, response_digest: page.response_digest,
            schema_digest: page.schema_digest, observed_utc: page.observed_utc, envelope_digest: sha(page) });
          if (page.next === null) break;
          seen.add(page.next); cursor = page.next;
        }
      }
      const evaluated_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
      const input = { run_id, account_alias: scope.account_alias, evaluated_utc, ...landing };
      const rows = readLanding(input, { quoteSource: 'PROVIDER' });
      requireThat(rows.invalid.length === 0, 'INVALID_ROWS');
      const symbols = new Set([...rows.IN_Quotes, ...rows.IN_Positions, ...rows.IN_Orders].map(row => row.symbol_key));
      requireThat(symbols.size <= 50 && rows.IN_Orders.every(row => utcMillis(evaluated_utc) - utcMillis(row.created_utc) <= 30 * 86_400_000), 'SCOPE_DENIED');
      const snapshot = { schema: 'trading-provider-snapshot/v1', source: 'AUTHENTICATED_ADAPTER', scope, candidate,
        run_id, observed_utc: evaluated_utc, input, precisions, evidence, digest: sha({ input, precisions, evidence }),
        cost: { tool_calls: calls, tokens_in: 'UNKNOWN', tokens_out: 'UNKNOWN', provider_fees: 'UNKNOWN' },
        portfolio: portfolio(rows, grant.fx ?? {}, evaluated_utc) };
      store.transaction(scope, state => {
        checkWindow();
        requireThat(!state.halted && state.currentSnapshot === reservation.prior && state.checkpoints[key]?.status === 'READING', 'CONFLICT');
        requireThat(Object.keys(state.snapshots).length < 128, 'SNAPSHOT_CAPACITY');
        for (const event of evidence) appendEvent(state, { id: event.source_event, type: 'provider-read', at: event.observed_utc, data: event });
        state.snapshots[run_id] = snapshot;
        state.currentSnapshot = run_id;
        state.checkpoints[key] = { binding, status: 'ACCEPTED', digest: snapshot.digest };
        appendEvent(state, { id: 'snapshot:' + run_id, type: 'snapshot-accepted', at: evaluated_utc, data: { run_id, digest: snapshot.digest, calls } });
      });
      return snapshot;
    } catch (error) {
      const reason = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'READ_FAILED';
      store.transaction(scope, state => {
        const usage = { calls: setupComplete || !setupStarted ? calls : 'UNKNOWN', reserved_calls: reservedCalls };
        state.checkpoints[key] = { binding, status: 'FAILED', reason, ...usage };
        appendEvent(state, { id: 'failed:' + run_id, type: 'snapshot-rejected', at: new Date(now()).toISOString(), data: { run_id, reason, ...usage } });
      });
      throw Object.assign(new Error(reason), { code: reason });
    }
  };
}
