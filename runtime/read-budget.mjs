import { requireThat, sha } from './core.mjs';

export const readBudgetScope = scope => ({
  environment: 'SIMULATE', profile: 'practice', account_alias: 'runtime-budget/' + sha(scope.account_alias),
});

// Every provider read charges the same cost proof within the caller's durable transaction.
export function reserveReadCalls(state, grant) {
  const proof = grant.proofs.find(item => item.kind === 'cost').digest;
  const counter = state.telemetry[proof] ?? { limit: grant.cost.remaining_calls, calls: 0 };
  requireThat(counter.limit === grant.cost.remaining_calls && Number.isSafeInteger(counter.calls) && counter.calls >= 0 &&
    counter.calls <= counter.limit - grant.limits.max_calls, 'BUDGET_HALT');
  counter.calls += grant.limits.max_calls;
  state.telemetry[proof] = counter;
}
