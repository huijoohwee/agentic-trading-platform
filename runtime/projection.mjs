import { sha, sameScope } from './core.mjs';

const amount = value => Number.isFinite(value) ? value : null;
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/.test(value) &&
  !/(?:ghp_|github_pat_|xox[bap]-|bearer|token|password)/i.test(value) ? value : 'UNKNOWN';
const status = value => typeof value === 'string' && /^[A-Z_a-z-]{1,48}$/.test(value) ? value : 'UNKNOWN';
export function projectRuntime(state, candidate, now = Date.now(), coordination = state) {
  const snapshot = state.currentSnapshot ? state.snapshots[state.currentSnapshot] : null;
  const snapshots = Object.values(state.snapshots).sort((a, b) => a.observed_utc.localeCompare(b.observed_utc));
  let peak = null, maxDrawdown = null;
  const curve = snapshots.map(item => {
    const equity = amount(item.portfolio?.equity);
    if (equity !== null && equity > 0) peak = Math.max(peak ?? equity, equity);
    const drawdown = equity !== null && peak > 0 ? (peak - equity) / peak : null;
    if (drawdown !== null) maxDrawdown = Math.max(maxDrawdown ?? 0, drawdown);
    return { at: item.observed_utc, equity, drawdown };
  });
  const positions = snapshot?.portfolio?.positions ?? [];
  const orders = snapshot?.input?.IN_Orders ?? [];
  const decisions = (coordination.decisions ?? []).filter(row => row.scope && sameScope(row.scope, state.scope));
  const eventTimes = new Map(coordination.events.map(event => [event.id, event.at]));
  const telemetry = Object.entries(state.telemetry ?? {}).filter(([key]) => key.startsWith('forward:')).map(([, row]) => row);
  const threads = Object.entries(state.telemetry ?? {}).filter(([key]) => key.startsWith('forward-thread:')).map(([, row]) => row);
  const data = {
    schema: 'trading-runtime-view/v1', candidate: snapshot?.candidate ?? candidate, configured_candidate: candidate, revision: state.revision,
    source: snapshot?.source === 'AUTHENTICATED_ADAPTER' ? snapshot.source : 'NO_PROVIDER_OBSERVATION', readiness: 'UNQUALIFIED',
    account_alias: label(state.scope.account_alias), profile: state.scope.profile, environment: 'SIMULATE',
    observed_utc: snapshot?.observed_utc ?? null, retrieved_utc: new Date(now).toISOString(),
    snapshot_digest: snapshot?.digest ?? null, halted: state.halted || coordination.halted,
    halt_reason: status(state.halted ? state.haltReason : coordination.haltReason),
    equity: amount(snapshot?.portfolio?.equity), cash: amount(snapshot?.portfolio?.cash),
    day_pnl: amount(snapshot?.portfolio?.dayPnl), max_drawdown: maxDrawdown, curve,
    counts: { positions: positions.length, orders: orders.length, decisions: decisions.length, runs: telemetry.length, threads: threads.length },
    positions: positions.slice(0, 50).map(row => ({ symbol: label(row.symbol), quantity: amount(row.quantity), value: amount(row.value),
      flags: Array.isArray(row.flags) ? row.flags.map(status) : [] })),
    orders: orders.slice(0, 50).map(row => ({ reference: 'order-' + sha(String(row.broker_order_id)).slice(0, 16),
      symbol: label(row.symbol_key), side: status(row.side), quantity: amount(row.qty), filled: amount(row.filled_qty), status: status(row.status_src) })),
    decisions: decisions.slice(-50).map((row, index) => ({ reference: 'decision-' + (decisions.length - Math.min(decisions.length, 50) + index + 1),
      at: eventTimes.get(row.event_id) ?? null, result: status(row.status), reason: status(row.reason) })),
    runs: telemetry.slice(-50).map(row => ({ reference: 'run-' + sha(String(row.source?.run_ref)).slice(0, 16),
      stream: status(row.source?.stream), status: status(row.latest?.status), delivery: status(row.latest?.push_status),
      usage: amount(row.latest?.usage?.total_credits), threads: Array.isArray(row.thread_refs) ? row.thread_refs.length : null })),
    threads: threads.slice(-50).map(row => ({ reference: 'thread-' + sha(String(row.thread_ref)).slice(0, 16),
      role: status(row.role), status: status(row.status), usage: amount(row.usage?.total_credits) })),
  };
  return { ...data, digest: sha(data) };
}
