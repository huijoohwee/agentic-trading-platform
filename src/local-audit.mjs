import { canonical, digest, evaluateFreshness, limitEvidence, positive, utcMillis } from './rules.mjs';
import { decimalSign, decimalValue, portfolio, readLanding } from './landing.mjs';

const terminal = new Set(['FILLED','CANCELLED','REJECTED','EXPIRED']);
const finite = Number.isFinite;
const validText = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 256 && !/^[=+@-]/.test(s.trimStart());
const limitKeys = ['maxAgeMinutes','maxPositionPct','maxRiskPct','minCashPct','maxPositions','maxDailyLoss','priceBandPct','feePerOrder'];
const validLimit = (key, n) => finite(n) && n >= 0 && (!key.endsWith('Pct') || n <= 100) &&
  (key !== 'maxPositions' || Number.isSafeInteger(n));
const result = condition => condition ? 'PASS' : 'FAIL';
const check = (inputs, condition) => inputs.every(finite) ? result(condition()) : 'UNKNOWN';

function reconcile(ticket, order, fills) {
  if (!order) return ticket.broker_order_id ? 'ORDER_NOT_FOUND' : ticket.submitted_utc ? 'SUBMITTED_WITHOUT_EVIDENCE' : 'UNSUBMITTED';
  if (order.side !== ticket.side) return 'SIDE_DIFF';
  if (order.symbol_key !== ticket.symbol_key) return 'SYMBOL_DIFF';
  const filled = decimalValue(fills.map(fill => [fill.qty]));
  if (filled === null) return 'INSUFFICIENT_EVIDENCE';
  if (order.filled_qty > ticket.qty || filled > ticket.qty) return 'OVERFILL';
  if (fills.some(fill => fill.ccy !== ticket.ccy)) return 'INSUFFICIENT_EVIDENCE';
  if (fills.some(fill => limitEvidence(ticket.side, ticket.limit_price, fill.price) === 'OFF_LIMIT')) return 'PRICE_OUT_OF_LIMIT';
  if (filled !== order.filled_qty || order.qty !== ticket.qty) return 'INSUFFICIENT_EVIDENCE';
  if (order.filled_qty < ticket.qty) return terminal.has(order.status_src) ? 'PARTIAL_CLOSED' : 'PARTIAL_OPEN';
  return 'MATCHED';
}
function stage(ticket, order, match) {
  if (ticket.void === 'VOID') return 'VOID';
  if (match === 'MATCHED' && terminal.has(order?.status_src)) return 'RECONCILED';
  if (order) return order.status_src;
  if (ticket.submitted_utc || ticket.release_state === 'RELEASED') return 'SUBMITTED';
  if (ticket.approved_utc) return 'APPROVED';
  return 'DRAFT';
}
function rules(ticket, input, rows, totals, openTickets) {
  const p = input.policy;
  const price = ticket.limit_price, qty = ticket.qty, stop = ticket.stop_price;
  const quote = rows.IN_Quotes.find(q => q.symbol_key === ticket.symbol_key && q.ccy === ticket.ccy);
  const rate = input.fx[ticket.ccy];
  const fx = positive(rate) ? rate : null;
  const last = quote && quote.quote_ts_utc <= input.evaluated_utc ? quote.last : null;
  const buy = ticket.side === 'BUY';
  const held = totals.openCount === null ? null : totals.positions.find(row => row.symbol === ticket.symbol_key)?.quantity ?? 0;
  const { cash, equity, dayPnl, openCount } = totals;
  const capital = positive(equity) ? equity : null;
  const limit = key => validLimit(key, p[key]) ? p[key] : null;
  const notional = positive(qty) && positive(price) && fx ? decimalValue([[qty, price, fx]]) : null;
  const validOrder = validText(ticket.ticket_id) && validText(ticket.symbol_key) && validText(ticket.rationale) &&
    ticket.account_alias === input.account_alias && ticket.order_type === 'LIMIT' &&
    ['BUY','SELL'].includes(ticket.side) && positive(price) && positive(qty) &&
    utcMillis(ticket.created_utc) !== null && utcMillis(ticket.expiry_utc) !== null &&
    ticket.created_utc <= input.evaluated_utc && input.evaluated_utc < ticket.expiry_utc;
  return {
    R01: evaluateFreshness({ observedAt: quote?.quote_ts_utc, freshness: quote?.delay_class }, p, input.evaluated_utc).state,
    R02: result(validOrder && fx !== null && limitKeys.every(key => limit(key) !== null)),
    R03: buy ? check([held, last, fx, notional, capital, limit('maxPositionPct')],
      () => decimalSign([[held,last,fx,100], [notional,100], [-capital,p.maxPositionPct]]) <= 0) : check([held, qty], () => qty <= held),
    R04: buy ? check([stop, price, qty, fx, capital, limit('maxRiskPct')],
      () => stop > 0 && stop < price && decimalSign([[price,qty,fx,100], [-stop,qty,fx,100], [-capital,p.maxRiskPct]]) <= 0) : 'PASS',
    R05: buy ? check([cash, notional, capital, limit('feePerOrder'), limit('minCashPct')],
      () => decimalSign([[cash,100], [-notional,100], [-p.feePerOrder,100], [-capital,p.minCashPct]]) >= 0) : 'PASS',
    R06: !buy || positive(held) ? 'PASS' : check([openCount, limit('maxPositions')], () => openCount + 1 <= p.maxPositions),
    R07: buy ? check([dayPnl, limit('maxDailyLoss')], () => dayPnl > -p.maxDailyLoss) : 'PASS',
    R08: result(!openTickets.some(other => other.ticket_id !== ticket.ticket_id && other.symbol_key === ticket.symbol_key &&
      other.side === ticket.side && other.qty === qty && other.limit_price === price)),
    R09: check([last, price, limit('priceBandPct')], () => {
      const [high, low] = [Math.max(price,last), Math.min(price,last)];
      return decimalSign([[high,100], [-low,100], [-last,p.priceBandPct]]) <= 0;
    }),
  };
}

// Detective binding for a synthetic approval already recorded by the owner.
export function approvalDigest(ticket, sourceDigest) {
  const { approved_key, submitted_utc, broker_order_id, void: voided, ...bound } = ticket;
  return digest(canonical({ sourceDigest, bound }));
}

const only = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));
const ticketFields = ['ticket_id','account_alias','created_utc','symbol_key','side','order_type','qty','limit_price',
  'stop_price','ccy','expiry_utc','rationale','approved_by','approved_utc','approved_key','approval_nonce',
  'submitted_utc','broker_order_id','supersedes','void','release_state'];
const sensitive = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|(?:ghp_|github_pat_|xox[bap]-)[A-Za-z0-9_-]{16,}/;

export async function auditSnapshot(input) {
  if (input?.schema !== 'trading-local-audit/v1' || input.source !== 'SYNTHETIC' ||
      !['RUN','HALT'].includes(input.halt) || utcMillis(input.evaluated_utc) === null ||
      !validText(input.policy?.revision) || !input.fx || typeof input.fx !== 'object' || Array.isArray(input.fx) ||
      !Array.isArray(input.tickets) || input.tickets.length > 2000 ||
      !Array.isArray(input.executions) || input.executions.length > 5000) throw Error('Invalid local audit envelope');
  if (!only(input,['schema','source','run_id','account_alias','evaluated_utc','halt','policy','fx','tickets',
      'executions','IN_Quotes','IN_Positions','IN_Balance','IN_Orders']) ||
      !only(input.policy,[...limitKeys,'revision','reconGraceMinutes']) ||
      !Object.entries(input.fx).every(([ccy,rate]) => /^[A-Z]{3}$/.test(ccy) && (rate === null || positive(rate))) ||
      !input.tickets.every(t => only(t,ticketFields) && Object.values(t).every(v => v === null || ['number','string'].includes(typeof v))) ||
      sensitive.test(JSON.stringify(input)) || /^\d+$/.test(input.account_alias)) throw Error('Expected alias-only synthetic input fields');
  const rows = readLanding(input);
  const ids = new Set(), bound = new Set();
  const orders = new Map(rows.IN_Orders.map(row => [row.broker_order_id, row]));
  const executions = new Map();
  for (const fill of input.executions) {
    if (!only(fill,['id','broker_order_id','account_alias','run_id','at','price','qty','ccy']) || !validText(fill?.id) || !validText(fill.broker_order_id) || !orders.has(fill.broker_order_id) ||
        fill.account_alias !== input.account_alias || fill.run_id !== input.run_id || !positive(fill.price) ||
        !positive(fill.qty) || utcMillis(fill.at) === null || fill.at > input.evaluated_utc) throw Error('Invalid execution evidence');
    if (executions.has(fill.id) && canonical(executions.get(fill.id)) !== canonical(fill)) throw Error('Conflicting execution identity');
    executions.set(fill.id, fill);
  }
  const fillsByOrder = new Map();
  for (const fill of executions.values()) {
    const group = fillsByOrder.get(fill.broker_order_id) ?? [];
    group.push(fill);
    fillsByOrder.set(fill.broker_order_id, group);
  }
  const stages = input.tickets.map(ticket => {
    if (!validText(ticket?.ticket_id) || ids.has(ticket.ticket_id) || ticket.account_alias !== input.account_alias ||
        (ticket.broker_order_id && bound.has(ticket.broker_order_id))) throw Error('Ambiguous ticket binding');
    ids.add(ticket.ticket_id);
    if (ticket.broker_order_id) bound.add(ticket.broker_order_id);
    const order = orders.get(ticket.broker_order_id), match = reconcile(ticket, order, fillsByOrder.get(ticket.broker_order_id) ?? []);
    return { ticket, match, stage: stage(ticket, order, match) };
  });
  const predecessor = new Map(input.tickets.map(t => [t.ticket_id, t.supersedes]));
  const validated = new Set();
  for (const id of ids) {
    const path = new Set();
    for (let next = id; next && !validated.has(next); next = predecessor.get(next)) {
      if (!ids.has(next) || path.has(next)) throw Error('Invalid supersession');
      path.add(next);
    }
    for (const next of path) validated.add(next);
  }
  const openTickets = stages.filter(s => ['DRAFT','APPROVED','SUBMITTED','PARTIAL','WORKING'].includes(s.stage)).map(s => s.ticket);
  const totals = portfolio(rows, input.fx, input.evaluated_utc);
  const decisions = stages.map(({ ticket, match, stage }) => {
    const checks = rules(ticket, input, rows, totals, openTickets);
    const states = Object.values(checks);
    const outcome = input.halt === 'HALT' ? 'HALT' : states.includes('FAIL') ? 'FAIL' : states.includes('UNKNOWN') ? 'REVIEW' : 'PASS';
    const flags = [];
    if (ticket.approved_utc && outcome !== 'PASS') flags.push('APPROVED_WITH_FAIL');
    if (match === 'ORDER_NOT_FOUND') flags.push(match);
    if (!orders.has(ticket.broker_order_id) && utcMillis(ticket.submitted_utc) !== null &&
        validLimit('reconGraceMinutes', input.policy.reconGraceMinutes) &&
        utcMillis(input.evaluated_utc) - utcMillis(ticket.submitted_utc) > input.policy.reconGraceMinutes * 60_000)
      flags.push('NO_BROKER_EVIDENCE');
    if (ticket.release_state === 'RELEASE_UNKNOWN') flags.push('RELEASE_UNKNOWN');
    return { id: ticket.ticket_id, checks, outcome, reasonCodes: Object.keys(checks).filter(key => checks[key] !== 'PASS'),
      match, stage, flags };
  });
  const sourceDigest = await digest(canonical([input.run_id, input.account_alias, input.IN_Quotes, input.IN_Positions,
    input.IN_Balance, input.IN_Orders, input.executions, input.policy, input.fx, input.evaluated_utc, input.halt]));
  for (const [index, { ticket }] of stages.entries()) {
    if (ticket.approved_utc && (utcMillis(ticket.approved_utc) === null || ticket.approved_utc > input.evaluated_utc ||
        !validText(ticket.approved_by) || !validText(ticket.approval_nonce) ||
        ticket.approved_key !== await approvalDigest(ticket, sourceDigest))) decisions[index].flags.push('EDIT_AFTER_APPROVAL');
  }
  const inputDigest = await digest(canonical(input));
  let head = inputDigest;
  const events = [];
  for (const decision of decisions) {
    const event = { run: input.run_id, evaluated: input.evaluated_utc, policy: input.policy.revision,
      evaluator: 'local-audit/1', previous: head, decision };
    head = await digest(canonical(event));
    events.push({ ...event, hash: head });
  }
  return { inputDigest, sourceDigest, rowsRejected: rows.invalid, totals, decisions, events, witness: { head, count: events.length },
    orphanOrders: [...orders.keys()].filter(id => !bound.has(id)), cost: { source: 'offline-fixture', providerCalls: 0, providerFeesUsd: 0, modelTokens: 0 } };
}

export async function restoreAudit(pack, witness) {
  const audit = await auditSnapshot(pack.input);
  if (canonical(audit) !== canonical(pack.audit) || canonical(audit.witness) !== canonical(witness))
    throw Error('Audit evidence differs from the retained witness');
  return audit;
}
