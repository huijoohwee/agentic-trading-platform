import { practiceReplay } from './practice-replay.mjs';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditSnapshot } from '../src/local-audit.mjs';
import { capacity, eligibility, marketTime } from '../src/competition-rules.mjs';
import { decimalSign, decimalValue } from '../src/landing.mjs';
import { evaluateFreshness, limitEvidence } from '../src/rules.mjs';
import { appendEvent } from './store.mjs';
import { boundedCall, boundedJson, canonical, hash, id, requireThat as need, sameScope, scopeKey,
  sha, utcMillis, verifyEnvelope } from './core.mjs';
import { requireProofs } from './core.mjs';

export const PAPER_EVALUATOR_DIGEST = sha(Object.fromEntries([
  './paper-guard.mjs', './core.mjs', './store.mjs', '../src/local-audit.mjs', '../src/competition-rules.mjs', '../src/landing.mjs', '../src/rules.mjs',
].map(path => [path, sha(readFileSync(new URL(path, import.meta.url)))])));
const terminal = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'BLOCKED']);
const unresolved = r => ['RELEASING', 'RELEASE_UNKNOWN'].includes(r.status);
const positive = n => Number.isFinite(n) && n > 0;
const units = n => Number.isSafeInteger(n) && n >= 0;
const instant = n => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
const own = (o, k) => Object.hasOwn(o ?? {}, k) ? o[k] : undefined;
const fingerprint = key => sha(createPublicKey(key.publicKey).export({ type: 'spki', format: 'der' }));
const records = s => Object.values(s.intents).filter(r => r.guard === 'paper/v1');
const only = (o, fields) => o && typeof o === 'object' && !Array.isArray(o) &&
  Object.keys(o).every(k => fields.split(',').includes(k));
const exact = (n, step) => {
  if (!positive(n) || !positive(step)) return false;
  const scale = v => { const [m, e = '0'] = String(v).split('e'); return [BigInt(m.replace('.', '')), Number(e) - (m.split('.')[1]?.length ?? 0)]; };
  const [a, x] = scale(n), [b, y] = scale(step), e = Math.min(x, y);
  return (a * 10n ** BigInt(x - e)) % (b * 10n ** BigInt(y - e)) === 0n;
};

export function createPaperGuard({ store, scope, candidate, keys, broker, now = Date.now, mode, market }) {
  if (mode === 'synthetic-replay') {
    need(!broker && !keys && !candidate, 'REPLAY_ISOLATION');
    return practiceReplay({ store, scope, now,market });
  }
  need(mode === undefined && !scope?.account_alias?.startsWith('desk/'), 'ACCOUNT_BINDING');
  scope = boundedJson(scope); scopeKey(scope);
  need(hash(candidate) && typeof now === 'function', 'CANDIDATE_BINDING');
  need(store?.read && store?.transaction && ['readAccount', 'readOrder', 'submit'].every(k => typeof broker?.[k] === 'function'), 'HOST_TRANSPORT_REQUIRED');
  need(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  const coordination = { ...scope, profile: 'practice' };
  const budgetScope = { ...coordination, account_alias: `runtime-budget/${sha(scope.account_alias)}` };
  const signed = (e, role, kind, at) => {
    need(e && typeof e === 'object', 'INVALID_SIGNATURE');
    const p = verifyEnvelope(e, { keys, role, kind, scope, candidate, now: at });
    need(p.revoked !== true, 'REVOKED'); return p;
  };
  const view = s => sameScope(scope, coordination) ? s : store.read(scope);
  const event = (s, type, data) => {
    const entry = { id: `paper:${sha([s.revision, s.events.length, type, data])}`, type, at: instant(now()), data };
    appendEvent(s, entry); s.decisions.push({ ...data, event_id: entry.id });
  };
  const receipt = r => ({ intent_id: r.intent.intent_id, status: r.status, reason: r.reason ?? null,
    source: r.source, provider: r.provider, candidate: r.candidate, scope: r.intent.scope,
    bindings: r.grant.payload.bindings, reviewer: { principal: r.review.payload.principal, runtime: r.review.payload.runtime },
    order_id: r.order?.order_id ?? null,
    fill_ids: r.order?.fills.map(f => f.id) ?? [] });
  const existing = (s, intent) => {
    const r = own(s.intents, intent.intent_id);
    if (!r) return null;
    need(r.guard === 'paper/v1' && r.intent_digest === sha(intent), 'CONFLICTING_INTENT'); return r;
  };
  function independentIntegration(key) {
    const publicKey = fingerprint(key);
    need(!Object.values(keys).some(k => ['operator', 'risk', 'research'].includes(k.role) &&
      (k.principal === key.principal || k.runtime === key.runtime || fingerprint(k) === publicKey)), 'INDEPENDENT_INTEGRATION_REQUIRED');
  }
  function auth(grant, review, intent, at, s, consumed = false) {
    const g = signed(grant, 'operator', 'paper', at);
    requireProofs(g, ['cost', 'rights', 'account', 'isolation'], at);
    need(g.proofs.length === 4 && new Set(g.proofs.map(p => p.kind)).size === 4 &&
      g.proofs.every(p => p.revoked !== true) && id(g.provider) && ['MOCK', 'PROVIDER'].includes(g.source), 'ADMISSION_PROOF');
    need(Array.isArray(g.actions) && positive(g.max_order_notional) && units(g.timeout_ms) && g.timeout_ms > 0 && g.timeout_ms <= 60_000, 'GRANT_LIMITS');
    const revocations = [...(s.configs.paper?.revoked ?? []), ...(view(s).configs.paper?.revoked ?? [])];
    need(!revocations.includes(sha(grant.payload)) && g.proofs.every(p => !revocations.includes(p.digest)), 'REVOKED');
    if (!intent) return { g };
    for (const key of Object.values(keys)) if (key.role === 'integration' && key.revoked !== true) independentIntegration(key);
    const r = signed(review, 'risk', 'risk', at), research = intent.research;
    need(id(r.nonce) && id(research?.principal) && id(research?.runtime), 'REVIEW_IDENTITY');
    need(Object.values(keys).some(k => k.role === 'research' && k.revoked !== true && k.principal === research.principal && k.runtime === research.runtime), 'RESEARCH_IDENTITY');
    need(!Object.values(keys).some(k => k.role === 'research' && (k.principal === r.principal || k.runtime === r.runtime)) &&
      r.principal !== g.principal && r.runtime !== g.runtime && g.principal !== research.principal && g.runtime !== research.runtime, 'INDEPENDENT_RISK_REQUIRED');
    const riskKey = fingerprint(keys[review.key_id]), operatorKey = fingerprint(keys[grant.key_id]);
    need(riskKey !== operatorKey && !Object.values(keys).some(k => k.role === 'research' &&
      [riskKey, operatorKey].includes(fingerprint(k))), 'INDEPENDENT_RISK_REQUIRED');
    const bindings = { intent_digest: sha(intent), input_digest: intent.input_digest, policy_digest: sha(intent.policy),
      strategy_digest: sha(intent.strategy), evaluator_digest: PAPER_EVALUATOR_DIGEST };
    need(canonical(g.bindings) === canonical(bindings) && canonical(r.bindings) === canonical(bindings), 'DIGEST_BINDING');
    need(![r.nonce, sha(review.payload), ...Object.values(bindings)].some(d => revocations.includes(d)), 'REVOKED');
    const nonce = `paper:${sha(r.nonce)}`, used = own(s.usedApprovals, nonce);
    need(consumed ? used === intent.intent_id : used === undefined, 'APPROVAL_REPLAY');
    need(utcMillis(g.cutoff_utc) !== null && at < utcMillis(g.cutoff_utc), 'CUTOFF');
    need(utcMillis(intent.ticket.created_utc) <= at && at < utcMillis(intent.ticket.expiry_utc), 'INTENT_EXPIRED');
    need(r.verdict === 'APPROVE', 'RISK_VETO');
    return { g, r, nonce };
  }
  function spend(g, operation) {
    store.transaction(budgetScope, s => {
      const proof = g.proofs.find(p => p.kind === 'cost').digest;
      const counter = s.telemetry[proof] ?? { limit: g.cost.remaining_calls, calls: 0 };
      need(counter.limit === g.cost.remaining_calls && counter.calls < counter.limit, 'BUDGET_HALT');
      counter.calls++; s.telemetry[proof] = counter;
      event(s, 'PAPER_CALL_RESERVED', { scope, candidate, source: g.source, proof, operation, calls: counter.calls });
    });
  }
  function admissionState(s) {
    const actual = view(s);
    need(!s.halted && !actual.halted, 'HALTED');
    for (const state of [s, actual]) need(!state.configs.paper?.candidate || state.configs.paper.candidate === candidate, 'CANDIDATE_BINDING');
    need(!records(s).some(unresolved), 'UNRESOLVED_RELEASE');
  }
  function intentShape(i) {
    need(only(i, 'intent_id,scope,research,input_digest,policy,strategy,evaluator_digest,ticket') && id(i.intent_id) && sameScope(i.scope, scope), 'INVALID_INTENT');
    need(hash(i.input_digest) && i.evaluator_digest === PAPER_EVALUATOR_DIGEST &&
      only(i.strategy, 'revision,policy_digest') && id(i.strategy.revision) && i.strategy.policy_digest === sha(i.policy), 'STRATEGY_BINDING');
    const t = i.ticket;
    need(only(t, 'ticket_id,account_alias,created_utc,symbol_key,side,order_type,qty,limit_price,stop_price,ccy,expiry_utc,rationale') &&
      t.ticket_id === i.intent_id && t.account_alias === scope.account_alias && id(t.symbol_key) && t.ccy === 'USD' &&
      t.order_type === 'LIMIT' && ['BUY', 'SELL'].includes(t.side) && units(t.qty) && t.qty > 0 && positive(t.limit_price) &&
      utcMillis(t.created_utc) !== null && utcMillis(t.expiry_utc) !== null, 'CASH_LIMIT_ONLY');
  }
  function observation(envelope, g, type, at) {
    const p = signed(envelope, 'integration', 'provider-observation', at), d = p.data;
    independentIntegration(keys[envelope.key_id]);
    need(p.observation === type && d?.source === g.source && d.provider === g.provider && d.revoked !== true, 'OBSERVATION_BINDING');
    need(evaluateFreshness({ observedAt: d.observed_utc, freshness: 'realtime' }, { maxAgeMinutes: 1 }, instant(at)).state === 'PASS', 'STALE_OBSERVATION');
    return d;
  }
  function facts(envelope, g, i, s, at) {
    const a = observation(envelope, g, 'account', at), t = i.ticket, p = i.policy;
    need(sha(a) === i.input_digest, 'INPUT_BINDING');
    need(a.account_type === 'CASH' && a.margin_debt === 0 && a.short_exposure === 0 && a.base_ccy === 'USD', 'CASH_ONLY');
    need(id(a.snapshot_id) && units(a.daily_orders) && Number.isFinite(a.cash) && a.cash >= 0 && positive(a.equity) && Number.isFinite(a.day_pnl), 'ACCOUNT_INPUT');
    need(Number.isFinite(a.fee_per_order) && a.fee_per_order >= 0 && Number.isFinite(p.feePerOrder) && p.feePerOrder >= a.fee_per_order, 'UNKNOWN_FEES');
    need(a.fx?.USD === 1 && Object.keys(a.fx).length === 1 && id(a.fx_source_ref), 'MISSING_FX');
    const fresh = ts => evaluateFreshness({ observedAt: ts, freshness: 'realtime' }, p, instant(at)).state === 'PASS';
    need(Number.isFinite(p?.maxAgeMinutes) && p.maxAgeMinutes >= 0 && p.maxAgeMinutes <= 1 && fresh(a.observed_utc) && fresh(a.fx_observed_utc), 'STALE_INPUT');
    need(Array.isArray(a.quotes) && Array.isArray(a.positions) && Array.isArray(a.open_orders) && Array.isArray(a.accounted_order_ids), 'MISSING_INPUT');
    need(new Set(a.quotes.map(q => q.symbol_key)).size === a.quotes.length && new Set(a.positions.map(q => q.symbol_key)).size === a.positions.length, 'DUPLICATE_INPUT');
    for (const q of a.quotes) need(id(q.source_ref) && q.ccy === 'USD' && positive(q.last) && positive(q.prev_close) &&
      q.freshness === 'realtime' && fresh(q.observed_utc), 'MISSING_SOURCE_PRICE');
    for (const pos of a.positions) need(pos.ccy === 'USD' && units(pos.qty) && Number.isFinite(pos.avg_cost) && pos.avg_cost >= 0 &&
      ['STOCK', 'ETF'].includes(own(a.instruments, pos.symbol_key)?.kind) && a.quotes.some(q => q.symbol_key === pos.symbol_key), 'POSITION_INPUT');
    const asset = own(a.instruments, t.symbol_key), q = a.quotes.find(q => q.symbol_key === t.symbol_key);
    need(asset && ['STOCK', 'ETF'].includes(asset.kind) && asset.ccy === 'USD', 'CASH_LIMIT_ONLY');
    need(q && units(asset.lot_size) && asset.lot_size > 0 && exact(t.qty, asset.lot_size) && exact(t.limit_price, asset.tick_size) &&
      (t.side !== 'BUY' || exact(t.stop_price, asset.tick_size)), 'LOT_TICK');
    need(a.calendar && eligibility(asset, q.last, instant(at), a.calendar) === 'PASS', 'INELIGIBLE');
    need(g.actions.includes(t.side === 'BUY' ? 'BUY_OPEN' : 'SELL_CLOSE') &&
      decimalSign([[t.qty, t.limit_price], [-g.max_order_notional]]) <= 0, 'GRANT_LIMITS');
    const all = records(s), active = all.filter(r => !terminal.has(r.status));
    need(!active.some(r => r.provider !== a.provider || r.source !== a.source), 'PROVIDER_BINDING');
    need(new Set(a.open_orders.map(o => o.order_id)).size === a.open_orders.length, 'DUPLICATE_ORDER');
    for (const o of a.open_orders) {
      const r = active.find(r => r.order?.order_id === o.order_id);
      need(r && canonical(r.order) === canonical(o), 'UNTRACKED_ORDER');
    }
    for (const r of active) need(a.open_orders.some(o => o.order_id === r.order?.order_id), 'ORDER_READBACK_REQUIRED');
    for (const r of all.filter(r => terminal.has(r.status) && r.order)) need(a.accounted_order_ids.includes(r.order.order_id) &&
      utcMillis(a.observed_utc) >= utcMillis(r.order.observed_utc), 'SETTLEMENT_READBACK_REQUIRED');
    const reserved = active.map(r => r.intent.ticket), held = a.positions.find(p => p.symbol_key === t.symbol_key)?.qty ?? 0;
    const pending = reserved.filter(x => x.symbol_key === t.symbol_key && x.side === t.side).reduce((n, x) => n + x.qty, 0);
    const cash = decimalValue([[a.cash], ...active.map(r => [-r.reservation.cash])]);
    need(cash !== null && cash >= 0, 'RESERVED_CASH');
    const daily = all.filter(r => r.day === marketTime(instant(at)).day).length + a.daily_orders;
    const positionCount = new Set([...a.positions.filter(p => p.qty > 0).map(p => p.symbol_key), ...reserved.filter(t => t.side === 'BUY').map(t => t.symbol_key)]).size;
    const verdict = capacity({ dailyOrders: daily, positionCount, held, pending, equity: a.equity, liquidity: cash, riskHalt: false },
      { side: t.side, effect: t.side === 'BUY' ? 'OPEN' : 'CLOSE', qty: t.qty, limit: t.limit_price, mark: q.last,
        reservedPrice: Math.max(t.limit_price, ...reserved.filter(x => x.symbol_key === t.symbol_key).map(x => x.limit_price)) }, asset);
    need(verdict === 'PASS', verdict);
    // Keep signed source evidence separate from the synthetic audit projection.
    const positions = structuredClone(a.positions), quotes = structuredClone(a.quotes);
    for (const x of reserved.filter(x => x.side === 'BUY')) {
      let pos = positions.find(p => p.symbol_key === x.symbol_key);
      if (!pos) { pos = { symbol_key: x.symbol_key, qty: 0, avg_cost: 0, ccy: 'USD' }; positions.push(pos); }
      pos.qty += x.qty;
      need(quotes.some(q => q.symbol_key === x.symbol_key), 'MISSING_SOURCE_PRICE');
    }
    const run = a.snapshot_id, common = { run_id: run, account_alias: scope.account_alias };
    const input = { schema: 'trading-local-audit/v1', source: 'SYNTHETIC', ...common, evaluated_utc: instant(at), halt: 'RUN', policy: p, fx: a.fx,
      tickets: [t, ...reserved], executions: [], IN_Orders: [],
      IN_Quotes: quotes.map(q => ({ run_id: run, symbol_key: q.symbol_key, market: 'US', ccy: q.ccy, last: q.last, prev_close: q.prev_close,
        quote_ts_utc: q.observed_utc, source_id: 'MANUAL', delay_class: q.freshness })),
      IN_Positions: positions.map(p => ({ ...common, ...p, as_of_utc: a.observed_utc })),
      IN_Balance: [{ ...common, ccy: 'USD', cash, total_assets: a.equity, as_of_utc: a.observed_utc }] };
    const riskProducts = [[t.limit_price, t.qty, 100], [-t.stop_price, t.qty, 100], [-a.equity, p.maxRiskPct],
      ...active.filter(r => r.intent.ticket.side === 'BUY').map(r => [r.reservation.risk, 100])];
    need(t.side !== 'BUY' || (positive(t.stop_price) && t.stop_price < t.limit_price && decimalSign(riskProducts) <= 0), 'STRATEGY_RISK');
    need(t.side !== 'BUY' || a.day_pnl > -p.maxDailyLoss, 'DAILY_LOSS');
    // Signed equity prevents reservations or fees from inflating strategy limits.
    need(t.side !== 'BUY' || decimalSign([[held, q.last, 100], [t.qty, t.limit_price, 100], [-a.equity, p.maxPositionPct],
      ...reserved.filter(x => x.symbol_key === t.symbol_key && x.side === 'BUY').map(x => [x.qty, Math.max(q.last, x.limit_price), 100])]) <= 0, 'STRATEGY_POSITION');
    need(t.side !== 'BUY' || decimalSign([[cash, 100], [-t.qty, t.limit_price, 100], [-p.feePerOrder, 100], [-a.equity, p.minCashPct]]) >= 0, 'STRATEGY_CASH');
    const reservation = { cash: t.side === 'BUY' ? decimalValue([[t.qty, t.limit_price], [p.feePerOrder]]) : p.feePerOrder,
      risk: t.side === 'BUY' ? decimalValue([[t.qty, t.limit_price], [-t.qty, t.stop_price]]) : 0, qty: t.qty };
    need([reservation.cash, reservation.risk].every(n => Number.isFinite(n) && n >= 0) && cash >= reservation.cash, 'RESERVATION_INPUT');
    return { a, input, reservation };
  }
  function orderEvidence(e, g, r, at) {
    const o = observation(e, g, 'order', at), t = r.intent.ticket;
    need(id(o.order_id) && o.intent_id === r.intent.intent_id && o.symbol_key === t.symbol_key && o.side === t.side &&
      o.qty === t.qty && o.limit_price === t.limit_price && units(o.filled_qty) && o.filled_qty <= t.qty &&
      ['WORKING', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.status) && Array.isArray(o.fills), 'ORDER_BINDING');
    need((o.status !== 'WORKING' || o.filled_qty === 0) && (o.status !== 'PARTIAL' || (o.filled_qty > 0 && o.filled_qty < t.qty)) &&
      (o.status !== 'FILLED' || o.filled_qty === t.qty) && (o.status !== 'REJECTED' || o.filled_qty === 0), 'ORDER_STATUS');
    need(new Set(o.fills.map(f => f.id)).size === o.fills.length && o.fills.every(f => id(f.id) && units(f.qty) && f.qty > 0 &&
      f.ccy === t.ccy && positive(f.price) && limitEvidence(t.side, t.limit_price, f.price) === 'AT_LIMIT_OR_BETTER' &&
      utcMillis(f.at) !== null && utcMillis(f.at) >= utcMillis(t.created_utc) && utcMillis(f.at) <= utcMillis(o.observed_utc)) &&
      decimalValue(o.fills.map(f => [f.qty])) === o.filled_qty, 'FILL_EVIDENCE');
    if (r.order) need(o.order_id === r.order.order_id && o.filled_qty >= r.order.filled_qty &&
      utcMillis(o.observed_utc) >= utcMillis(r.order.observed_utc) &&
      r.order.fills.every(old => o.fills.some(f => canonical(f) === canonical(old))) &&
      (!terminal.has(r.order.status) || canonical(o) === canonical(r.order)), 'UNSTABLE_ORDER');
    return o;
  }
  function finish(intentId, envelope, grant) {
    return store.transaction(coordination, s => {
      const r = own(s.intents, intentId), { g } = auth(grant, null, null, now(), s);
      need(r && sameScope(r.intent.scope, scope) && r.candidate === candidate, 'UNKNOWN_INTENT');
      const o = orderEvidence(envelope, g, r, now());
      need(!records(s).some(x => x !== r && (x.order?.order_id === o.order_id || x.order?.fills.some(f => o.fills.some(n => n.id === f.id)))), 'REUSED_BROKER_ID');
      r.order = o; r.order_envelope = envelope; r.status = o.status; r.reason = null;
      r.reserved = !terminal.has(o.status);
      if (s.haltReason === 'RELEASE_UNKNOWN' && !records(s).some(unresolved)) { s.halted = false; s.haltReason = null; }
      event(s, 'PAPER_RECONCILED', receipt(r)); return receipt(r);
    });
  }
  function uncertain(intentId, reason) {
    return store.transaction(coordination, s => {
      const r = own(s.intents, intentId); need(r, 'UNKNOWN_INTENT');
      if (!terminal.has(r.status)) { r.status = 'RELEASE_UNKNOWN'; r.reason = reason; r.reserved = true; }
      if (!s.halted) { s.halted = true; s.haltReason = 'RELEASE_UNKNOWN'; }
      event(s, 'PAPER_UNCERTAIN', receipt(r)); return receipt(r);
    });
  }
  // Fence RELEASING on startup because a crashed sender is indistinguishable from an active one.
  if (records(store.read(coordination)).some(r => r.status === 'RELEASING')) store.transaction(coordination, s => {
    for (const r of records(s).filter(r => r.status === 'RELEASING')) { r.status = 'RELEASE_UNKNOWN'; r.reason = 'RECOVERY_READBACK_REQUIRED'; }
    if (!s.halted) { s.halted = true; s.haltReason = 'RELEASE_UNKNOWN'; }
    event(s, 'PAPER_RECOVERY', { candidate, scope, status: 'RELEASE_UNKNOWN' });
  });
  async function release(request) {
    let i, grant, review, reserved = false, dispatched = false;
    try {
      ({ intent: i, grant, review } = boundedJson(request)); intentShape(i);
      let before = store.read(coordination), old = existing(before, i);
      if (old) return receipt(old);
      admissionState(before);
      const actualRevision = view(before).revision, { g } = auth(grant, review, i, now(), before);
      need(g.cost.remaining_calls >= 2, 'BUDGET_HALT');
      const envelope = boundedJson(await boundedCall(signal => {
        const current = store.read(coordination); admissionState(current); auth(grant, review, i, now(), current);
        spend(g, 'readAccount'); return broker.readAccount({ scope: structuredClone(scope), candidate, signal });
      }, g.timeout_ms));
      const f = facts(envelope, g, i, before, now()), audit = await auditSnapshot(f.input);
      const decision = audit.decisions.find(d => d.id === i.intent_id);
      need(audit.rowsRejected.length === 0 && decision?.outcome === 'PASS', `RULE_${decision?.reasonCodes.join('_') || 'INPUT'}`);
      const record = store.transaction(coordination, s => {
        old = existing(s, i); if (old) return old;
        need(s.revision === before.revision && view(s).revision === actualRevision, 'CONFLICT'); admissionState(s);
        const { g, nonce } = auth(grant, review, i, now(), s), current = facts(envelope, g, i, s, now());
        need(canonical({ ...current.input, evaluated_utc: f.input.evaluated_utc }) === canonical(f.input), 'INPUT_BINDING');
        const r = { guard: 'paper/v1', intent: i, intent_digest: sha(i), candidate, source: g.source, provider: g.provider,
          status: 'RELEASING', reason: null, reserved: true, reservation: current.reservation, day: marketTime(instant(now())).day,
          admission_revision: s.revision + 1, account_envelope: envelope, grant, review, audit };
        s.intents[i.intent_id] = r; s.usedApprovals[nonce] = i.intent_id;
        event(s, 'PAPER_RESERVED', receipt(r)); reserved = true; return r;
      });
      if (!reserved) return receipt(record);
      const response = await boundedCall(signal => {
        spend(g, 'submit');
        const s = store.read(coordination), r = own(s.intents, i.intent_id);
        need(s.revision >= record.admission_revision && (sameScope(scope, coordination) || view(s).revision === actualRevision), 'CONFLICT');
        need(!s.halted && !view(s).halted && r.status === 'RELEASING' && !records(s).some(x => x !== r && unresolved(x)), 'HALTED');
        auth(grant, review, i, now(), s, true);
        need(!s.configs.paper?.candidate || s.configs.paper.candidate === candidate, 'CANDIDATE_BINDING');
        facts(envelope, g, i, { ...s, intents: Object.fromEntries(Object.entries(s.intents).filter(([key]) => key !== i.intent_id)) }, now());
        auth(grant, review, i, now(), s, true);
        const deadline = Math.min(...[g.cutoff_utc, g.expires_utc, review.payload.expires_utc, i.ticket.expiry_utc,
          envelope.payload.expires_utc, ...g.proofs.map(p => p.expires_utc)].map(utcMillis),
          ...[f.a.observed_utc, f.a.fx_observed_utc, ...f.a.quotes.map(q => q.observed_utc)].map(ts => utcMillis(ts) + i.policy.maxAgeMinutes * 60_000));
        // Enforce this deadline at wire handoff so queued transport cannot release stale authority.
        const not_after_utc = instant(deadline);
        need(now() < utcMillis(not_after_utc), 'CUTOFF');
        dispatched = true;
        return broker.submit({ scope: structuredClone(scope), candidate, intent_id: i.intent_id, ticket: structuredClone(i.ticket), not_after_utc, signal });
      }, g.timeout_ms);
      return finish(i.intent_id, boundedJson(response), grant);
    } catch (error) {
      if (dispatched) return uncertain(i.intent_id, error.code ?? 'SUBMIT_AMBIGUOUS');
      return store.transaction(coordination, s => {
        const r = i && own(s.intents, i.intent_id);
        if (reserved && r?.status === 'RELEASING') { r.status = 'BLOCKED'; r.reason = error.code ?? 'INVALID_INPUT'; r.reserved = false; }
        if (reserved && r) { event(s, 'PAPER_BLOCKED', receipt(r)); return receipt(r); }
        if (!r && error.code === 'RISK_VETO') {
          const veto = { guard: 'paper/v1', intent: i, intent_digest: sha(i), candidate, source: grant.payload.source,
            provider: grant.payload.provider, status: 'BLOCKED', reason: 'RISK_VETO', reserved: false, grant, review };
          s.intents[i.intent_id] = veto; s.usedApprovals[`paper:${sha(review.payload.nonce)}`] = i.intent_id;
          event(s, 'PAPER_VETOED', receipt(veto)); return receipt(veto);
        }
        const result = { intent_id: id(i?.intent_id) ? i.intent_id : null, status: 'BLOCKED', reason: error.code ?? 'INVALID_INPUT', source: 'UNVERIFIED' };
        event(s, 'PAPER_BLOCKED', { ...result, candidate, scope }); return result;
      });
    }
  }
  async function reconcile({ intent_id, grant }) {
    need(id(intent_id), 'INVALID_INTENT'); grant = boundedJson(grant);
    const s = store.read(coordination), r = own(s.intents, intent_id), { g } = auth(grant, null, null, now(), s);
    need(r && sameScope(r.intent.scope, scope) && r.candidate === candidate && g.provider === r.provider && g.source === r.source, 'UNKNOWN_INTENT');
    if (terminal.has(r.status)) return receipt(r);
    try {
      const e = await boundedCall(signal => {
        auth(grant, null, null, now(), store.read(coordination)); spend(g, 'readOrder');
        return broker.readOrder({ scope: structuredClone(scope), candidate, intent_id, order_id: r.order?.order_id ?? null, signal });
      }, g.timeout_ms);
      return finish(intent_id, boundedJson(e), grant);
    } catch (error) { return uncertain(intent_id, error.code ?? 'READBACK_AMBIGUOUS'); }
  }
  function halt({ grant, reason = 'OPERATOR_HALT' }) {
    need(id(reason) && reason !== 'RELEASE_UNKNOWN', 'INVALID_REASON');
    return store.transaction(coordination, s => {
      auth(grant, null, null, now(), s); s.halted = true; s.haltReason = reason;
      event(s, 'PAPER_HALTED', { scope, candidate, reason }); return { status: 'HALTED', reason };
    });
  }
  return Object.freeze({ release, reconcile, halt });
}
