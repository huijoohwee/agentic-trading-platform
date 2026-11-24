import { hash, requireThat, sha, utcMillis } from './core.mjs';

export const readBudgetScope = scope => ({
  environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/' + sha(scope.account_alias),
});

function reserve(state, key, limit, amount) {
  const counter = state.telemetry[key] ?? { limit, calls: 0 };
  requireThat(counter.limit === limit && Number.isSafeInteger(counter.calls) && counter.calls >= 0 &&
    counter.calls <= limit - amount, 'BUDGET_HALT');
  counter.calls += amount;
  state.telemetry[key] = counter;
}

export function reserveReadCalls(state, grant) {
  const proof = grant.proofs.find(item => item.kind === 'cost').digest;
  reserve(state, proof, grant.cost.remaining_calls, grant.limits.max_calls);
}

// A token may lose its quota exemption. Every attempt requires a known active target
// or enough room for a first-page charge in the same provider quota observation.
export function reserveHistoryRead(store, budgetScope, grant, symbol, now) {
  requireThat(grant.proofs.filter(item => item.kind === 'history-quota').length === 1, 'MISSING_ADMISSION_PROOF');
  const quota = grant.proofs.find(item => item.kind === 'history-quota');
  const rights = grant.proofs.find(item => item.kind === 'rights');
  requireThat(rights?.scope === 'quote:read' && rights.symbol === symbol && rights.private_ledger === true && rights.display === true, 'SCOPE_DENIED');
  const observed = utcMillis(quota.observed_utc);
  requireThat(quota.symbol === symbol && hash(quota.pool_digest) && quota.deny_at_exhaustion === true &&
    observed !== null && observed <= now && typeof quota.active_target === 'boolean' &&
    Number.isSafeInteger(quota.remaining_targets) && quota.remaining_targets >= 0, 'MISSING_ADMISSION_PROOF');
  const pool = { ...budgetScope, account_alias: 'runtime-budget/history/' + quota.pool_digest };
  const deadline = Math.min(now + grant.limits.timeout_ms, utcMillis(grant.expires_utc));
  store.transactionScopes([budgetScope, pool], ([costState, poolState]) => {
    const previous = poolState.telemetry.observation;
    if (!previous || previous.observed !== observed) {
      requireThat(!previous || (observed > previous.observed && observed >= previous.until), 'STALE_EVIDENCE');
      poolState.telemetry.observation = { observed, until: now };
      poolState.telemetry.targets = { limit: quota.remaining_targets, calls: 0 };
    }
    reserve(poolState, 'targets', quota.remaining_targets, quota.active_target ? 0 : 1);
    reserveReadCalls(costState, grant);
    poolState.telemetry.observation.until = Math.max(poolState.telemetry.observation.until, deadline);
  });
  return deadline;
}
