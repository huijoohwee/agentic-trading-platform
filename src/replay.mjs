import { utcMillis } from './rules.mjs';
import { capacity, dollars, eligibility, EVALUATOR, expiryOutcome, feeMicros, INITIAL, interestMicros,
  limitEvidence, margin, marketTime, MICRO, POLICY, positive, research, volumeEvidence } from './competition-rules.mjs';

export const FIXTURE_SHA = '6d888fb97d5c1c39f141ff164e78d805e122040b1d5c3696204f22386c51f338';
export const MAX_ARCHIVE = 180_000;
const encoder = new TextEncoder();
const verifiedFixtures = new WeakSet();
export async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(value) {
  return JSON.stringify(value, (_, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}
function requireThat(ok, msg) { if (!ok) throw Error(msg); }
export async function readRehearsal(text) {
  requireThat(await digest(text) === FIXTURE_SHA, 'Unrecognized rehearsal source');
  function freeze(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  const fixture = freeze(JSON.parse(text));
  verifiedFixtures.add(fixture);
  return fixture;
}

const remaining = order => order.qty - order.filled;
const active = order => order?.status === 'WORKING';
const factor = asset => asset.kind === 'OPTION' ? asset.multiplier : 1;
function valuation(book, assets) {
  let equity = book.cash;
  for (const [symbol, p] of Object.entries(book.positions)) {
    equity += p.qty * dollars(book.marks[symbol]) * factor(assets[symbol]);
  }
  requireThat(Number.isSafeInteger(equity), 'Missing mark or invalid valuation');
  return equity;
}
function trade(book, symbol, delta, price, asset, fees = 0) {
  const p = book.positions[symbol] ?? { qty: 0, basis: 0 };
  const gross = delta * dollars(price) * factor(asset);
  requireThat(Number.isSafeInteger(gross) && positive(price) && Number.isSafeInteger(delta), 'Invalid observed trade');
  if (p.qty && Math.sign(delta) !== Math.sign(p.qty)) {
    requireThat(Math.abs(delta) <= Math.abs(p.qty), 'Crossing position needs separate execution legs');
    p.basis = Math.round(p.basis * (p.qty + delta) / p.qty);
  } else p.basis += gross;
  book.cash -= gross + fees;
  p.qty += delta;
  if (p.qty) book.positions[symbol] = p;
  else delete book.positions[symbol];
  book.marks[symbol] ??= price;
}
function inspectOrder(state, event, assets, calendar) {
  const asset = assets[event.symbol];
  if (state.ambiguous || (state.halt && event.effect === 'OPEN')) return 'RISK_HALT';
  const result = eligibility(asset, event.quote.price, event.at, calendar);
  if (result !== 'PASS') return result;
  if (state.delisted[event.symbol]) return 'DELISTED';
  const working = Object.values(state.orders).filter(active);
  const same = working.filter(o => o.symbol === event.symbol);
  if (same.some(o => o.side === event.side && o.qty === event.qty && o.limit === event.limit)) return 'WORKING_DUPLICATE';
  if (same.some(o => o.side !== event.side || o.effect !== event.effect)) return 'CONFLICTING_RESERVATION';
  const day = marketTime(event.at).day;
  const daily = new Set([...state.executions.filter(x => x.day === day).map(x => x.order), ...working.map(o => o.id)]);
  const names = new Set([...Object.keys(state.book.positions), ...working.filter(o => o.effect === 'OPEN').map(o => o.symbol)]);
  const reserved = working.filter(o => o.effect === 'OPEN').reduce((total, o) => {
    const gross = remaining(o) * o.limit * factor(assets[o.symbol]);
    return total + (assets[o.symbol].kind === 'OPTION' ? gross : margin(gross, o.side, 'initial'));
  }, 0);
  const pending = same.reduce((n, o) => n + remaining(o), 0);
  const reservedPrice = pending ? same.reduce((n, o) => n + remaining(o) * o.limit, 0) / pending : 0;
  const available = state.liquidity === null ? null : state.liquidity - reserved;
  return capacity({ dailyOrders: daily.size, positionCount: names.size, held: state.book.positions[event.symbol]?.qty ?? 0,
    pending, equity: valuation(state.book, assets) / MICRO, liquidity: available, riskHalt: state.halt },
    { ...event, mark: event.quote.price, reservedPrice }, asset);
}

function decision(state, event, tape, fixture) {
  const key = event.trigger;
  requireThat(typeof key === 'string' && key.length > 0, 'Missing trigger');
  // Trigger identity is independent of delivery ID and delivery timestamp.
  const { id, ...intent } = event;
  const binding = canonical(intent);
  if (Object.hasOwn(state.triggers, key)) {
    requireThat(state.triggers[key] === binding, 'Conflicting trigger');
    return 'ALREADY_PROCESSED';
  }
  state.triggers[key] = binding;
  let reason = research(event, event.at);
  if (reason !== 'CANDIDATE') return reason;
  const fields = ['trigger','at','symbol','side','effect','qty','limit','action','priorHigh','closes','quote','volume'];
  const expectedBinding = [tape.id, tape.environment, tape.account, tape.strategy, POLICY, EVALUATOR, ...fields.map(k => event[k])];
  if (canonical(event.review?.binding) !== canonical(expectedBinding) || utcMillis(event.review?.expiresAt) === null ||
      event.review.expiresAt < event.at) return 'UNBOUND_REVIEW';
  if (event.review?.actor !== tape.roles.risk || event.review?.intent !== key ||
      event.review?.account !== tape.account || tape.roles.risk === tape.roles.research) return 'UNBOUND_REVIEW';
  if (event.review.verdict !== 'APPROVE') return 'RISK_VETO';
  reason = inspectOrder(state, event, fixture.assets, fixture.calendar);
  if (reason !== 'PASS') return reason;
  reason = volumeEvidence(event.volume, event.qty);
  if (reason === 'UNKNOWN_VOLUME') return reason;
  state.orders[id] = { id, trigger: key, symbol: event.symbol, qty: event.qty, side: event.side,
    limit: event.limit, effect: event.effect, filled: 0, fills: 0, contracts: 0, status: 'WORKING' };
  return reason;
}

function executeFill(state, e, fixture) {
  const o = state.orders[e.order];
  requireThat(o && active(o) && Number.isSafeInteger(e.qty) && e.qty > 0 && e.qty <= remaining(o), 'Invalid fill or closed order');
  requireThat(positive(e.price) && Number.isSafeInteger(e.feeMicros) && e.feeMicros >= 0, 'Missing execution details');
  const asset = fixture.assets[o.symbol];
  const fee = feeMicros(asset, o.side, e.qty, e.price, o);
  const result = limitEvidence(o.side, o.limit, e.price);
  trade(state.book, o.symbol, (o.side === 'BUY' ? 1 : -1) * e.qty, e.price, asset, e.feeMicros);
  o.filled += e.qty;
  o.fills++;
  o.contracts += fee.variable;
  if (!remaining(o)) o.status = 'FILLED';
  state.fees += e.feeMicros;
  if (state.liquidity !== null) {
    const gross = e.qty * e.price * factor(asset);
    const addedMargin = asset.kind === 'OPTION' ? gross : margin(gross, o.side, 'initial');
    state.liquidity -= (o.effect === 'OPEN' ? addedMargin : 0) + e.feeMicros / MICRO;
  }
  state.executions.push({ id: e.id, order: o.id, day: marketTime(e.at).day, qty: e.qty, price: e.price,
    expectedFee: fee.amount, recordedFee: e.feeMicros, result });
  if (fee.amount !== e.feeMicros || result === 'OFF_LIMIT') state.halt = true;
  return fee.amount !== e.feeMicros ? 'FEE_MISMATCH' : result;
}
function settleOption(state, e, fixture) {
  const asset = fixture.assets[e.symbol];
  const { day, minute } = marketTime(e.at);
  const held = state.book.positions[e.symbol]?.qty ?? 0;
  requireThat(state.ranked === null && asset?.kind === 'OPTION' && held > 0 && asset.expiry === day && minute >= fixture.calendar[day].close,
    'Expiry requires an observed closing event');
  const outcome = expiryOutcome(asset, e.close, e.funded);
  if (['UNKNOWN_EXPIRY','READBACK_REQUIRED'].includes(outcome)) { state.halt = true; return outcome; }
  requireThat(Number.isSafeInteger(e.exercised) && e.exercised >= 0 && e.exercised <= held &&
    (outcome !== 'WORTHLESS' || e.exercised === 0) && (outcome !== 'EXERCISE' || e.exercised === held), 'Expiry readback disagrees');
  const closeMark = state.finalBook?.marks[asset.underlying];
  if (closeMark !== undefined) requireThat(closeMark === e.close, 'Expiry disagrees with final closing mark');
  requireThat(['cash','physical'].includes(asset.settlement), 'Unknown settlement mechanics');
  if (asset.settlement === 'cash') {
    const intrinsic = Math.max(0, (e.close - asset.strike) * (asset.right === 'CALL' ? 1 : -1));
    requireThat(e.creditMicros === dollars(intrinsic) * asset.multiplier * e.exercised, 'Cash settlement mismatch');
  }
  const settle = book => {
    delete book.positions[e.symbol];
    if (asset.settlement === 'cash') book.cash += e.creditMicros;
    else if (e.exercised) {
      const delta = e.exercised * asset.multiplier * (asset.right === 'CALL' ? 1 : -1);
      trade(book, asset.underlying, delta, asset.strike, fixture.assets[asset.underlying]);
      book.marks[asset.underlying] = e.close;
    }
  };
  settle(state.book);
  if (state.finalBook) settle(state.finalBook);
  if (outcome === 'PARTIAL_OR_LIQUIDATION') state.halt = true;
  return outcome;
}
function action(state, e, fixture) {
  const book = state.book;
  const p = book.positions[e.symbol];
  const { day } = marketTime(e.at);
  requireThat(p && fixture.calendar[day], 'Corporate event missing position or session');
  switch (e.type) {
    case 'dividend':
      requireThat(positive(e.perShare), 'Invalid dividend');
      book.cash += p.qty * dollars(e.perShare); return 'DIVIDEND';
    case 'split':
      requireThat(positive(e.ratio) && Number.isSafeInteger(p.qty * e.ratio), 'Fractional split needs readback');
      p.qty *= e.ratio; book.marks[e.symbol] /= e.ratio; return 'SPLIT';
    case 'rename':
      requireThat(fixture.assets[e.to] && !book.positions[e.to] && !Object.values(state.orders).some(o => active(o) && o.symbol === e.symbol),
        'Unreconciled rename');
      book.positions[e.to] = p; delete book.positions[e.symbol];
      book.marks[e.to] = book.marks[e.symbol]; state.delisted[e.symbol] = { successor: e.to }; return 'RENAMED';
    case 'delist':
      requireThat(positive(e.lastClose) && !state.delisted[e.symbol], 'Missing last close or duplicate delisting');
      state.delisted[e.symbol] = { day, lastClose: e.lastClose }; return 'DELISTED';
    case 'delistCredit': {
      const delist = state.delisted[e.symbol];
      const due = Object.keys(fixture.calendar).filter(date => date > delist?.day).sort()[1];
      requireThat(day === due && e.amount === p.qty * delist.lastClose, 'Delisting credit disagrees');
      book.cash += dollars(e.amount); delete book.positions[e.symbol]; return 'DELIST_CREDIT';
    }
  }
}
function observe(state, e, tape, fixture) {
  const b = state.book;
  const { day, minute } = marketTime(e.at);
  switch (e.type) {
    case 'signal': return decision(state, e, tape, fixture);
    case 'fill': return executeFill(state, e, fixture);
    case 'average':
      requireThat(active(state.orders[e.order]), 'Unknown working order');
      return limitEvidence(state.orders[e.order].side, state.orders[e.order].limit, null);
    case 'amend': {
      const order = state.orders[e.order];
      requireThat(active(order) && Number.isSafeInteger(e.qty) && e.qty > order.filled && e.qty <= order.qty &&
        e.limit === order.limit, 'Increased or repriced amendment needs a new review');
      order.qty = e.qty;
      return 'AMENDED';
    }
    case 'cancel':
      requireThat(active(state.orders[e.order]), 'Unknown working order');
      state.orders[e.order].status = 'CANCELLED'; return 'REMAINDER_RELEASED';
    case 'ambiguous':
      requireThat(active(state.orders[e.order]), 'Unbound ambiguous effect');
      state.ambiguous = true; state.halt = true; return 'AMBIGUOUS_HALT';
    case 'liquidity':
      requireThat(Number.isFinite(e.available), 'Missing buying power');
      state.liquidity = e.available;
      if (e.available < 0) state.halt = true;
      return e.available < 0 ? 'NEGATIVE_LIQUIDITY' : 'BUYING_POWER';
    case 'readback':
      requireThat(Number.isFinite(e.available) && e.available >= 0 && e.cashMicros === b.cash &&
        canonical(e.working) === canonical(Object.keys(state.orders).filter(id => active(state.orders[id]))) &&
        canonical(e.positions) === canonical(Object.fromEntries(Object.entries(b.positions).map(([s,p]) => [s,p.qty]))), 'Readback mismatch');
      state.ambiguous = false; state.halt = false; state.liquidity = e.available; return 'RECONCILED';
    case 'liquidation': {
      const held = b.positions[e.symbol]?.qty;
      requireThat(state.halt && Number.isSafeInteger(e.qty) && e.qty > 0 && e.qty <= Math.abs(held) &&
        Number.isSafeInteger(e.feeMicros) && e.feeMicros >= 0, 'Invalid liquidation readback');
      trade(b, e.symbol, -Math.sign(held) * e.qty, e.price, fixture.assets[e.symbol], e.feeMicros);
      state.fees += e.feeMicros; return 'FORCED_LIQUIDATION';
    }
    case 'charge': {
      requireThat(minute >= fixture.calendar[day]?.close, 'Interest needs a closing observation');
      const expected = interestMicros(e.financed, e.borrowed, e.daysPerYear);
      if (expected === null) { state.halt = true; return 'UNKNOWN_ACCRUAL'; }
      requireThat(e.chargeMicros === expected, 'Charge mismatch');
      b.cash -= e.chargeMicros;
      if (state.liquidity !== null) state.liquidity -= e.chargeMicros / MICRO;
      state.interest += e.chargeMicros; return 'INTEREST';
    }
    case 'expiry': return settleOption(state, e, fixture);
    case 'dividend': case 'split': case 'rename': case 'delist': case 'delistCredit': return action(state, e, fixture);
    case 'mark':
    case 'weekly':
    case 'finalClose': {
      for (const [symbol, price] of Object.entries(e.prices)) {
        requireThat(fixture.assets[symbol] && Number.isFinite(price) && (price > 0 || (price === 0 && fixture.assets[symbol].kind === 'OPTION')), 'Invalid closing mark');
        b.marks[symbol] = price;
      }
      if (e.type === 'mark') return 'MARK';
      requireThat(Object.keys(b.positions).every(s => Object.hasOwn(e.prices,s)), 'Incomplete valuation marks');
      if (e.type === 'weekly') {
        requireThat(new Date(day+'T12:00:00Z').getUTCDay() === 5 && minute === 1320, 'Wrong weekly cut-off');
        state.weekly = valuation(b, fixture.assets); return 'WEEKLY_MARK';
      }
      requireThat(day === tape.finalDay && minute === fixture.calendar[day].close && !state.finalBook, 'Wrong final close');
      state.finalBook = structuredClone(b); return 'FINAL_CLOSE';
    }
    case 'settlement':
      requireThat(tape.profile === 'competition' && state.finalBook && state.ranked === null &&
        !Object.keys(state.finalBook.positions).some(s => fixture.assets[s].kind === 'OPTION' && fixture.assets[s].expiry <= day) &&
        e.equityMicros === valuation(state.finalBook, fixture.assets), 'Scored settlement mismatch');
      state.ranked = e.equityMicros; return 'SYNTHETIC_SETTLEMENT';
    default: throw Error('Unsupported event');
  }
}

export function replay(fixture, runId, deliveries) {
  const tape = fixture.runs.find(run => run.id === runId);
  requireThat(tape && tape.environment === 'SIMULATE' && tape.account === 'fixture-' + tape.profile &&
    ['practice','competition'].includes(tape.profile) && fixture.policy === POLICY && fixture.evaluator === EVALUATOR, 'Unknown rehearsal binding');
  const b = { cash: INITIAL, positions: {}, marks: {} };
  const state = { book: b, orders: {}, executions: [], delisted: {}, triggers: {}, fees: 0, interest: 0,
    halt: false, ambiguous: false, liquidity: null, finalBook: null, ranked: null, weekly: null };
  let last = '', peak = INITIAL, maxDrawdown = 0;
  const seen = new Map(), receipts = [], curve = [];
  for (const e of deliveries ?? tape.events) {
    requireThat(/^[a-z][a-z0-9-]{0,45}$/.test(e.id) && e.account === tape.account && utcMillis(e.at) !== null, 'Invalid event binding');
    const bytes = canonical(e);
    if (seen.has(e.id)) { requireThat(seen.get(e.id) === bytes, 'Conflicting event ID'); continue; }
    requireThat(e.at >= last && e.at <= tape.importedAt, 'Out-of-order observation');
    seen.set(e.id, bytes); last = e.at;
    const reason = observe(state, e, tape, fixture);
    const equity = valuation(b, fixture.assets);
    peak = Math.max(peak, equity);
    const drawdown = (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({ at: last, event: e.id, equity, drawdown });
    receipts.push({ id: e.id, at: last, type: e.type, order: e.order ?? (e.type === 'signal' ? e.id : null), reason });
  }
  const equity = valuation(b, fixture.assets);
  return { run: tape.id, environment: tape.environment, profile: tape.profile, account: tape.account, at: last,
    importedAt: tape.importedAt, currency: tape.currency, policy: POLICY, evaluator: EVALUATOR, strategy: tape.strategy, roles: tape.roles, source: fixture.source,
    cash: b.cash, equity, net: equity - INITIAL, maxDrawdown, drawdown: curve.at(-1)?.drawdown ?? 0,
    fees: state.fees, interest: state.interest, weekly: state.weekly, ranked: state.ranked, halt: state.halt,
    positions: b.positions, marks: b.marks, orders: Object.values(state.orders), executions: state.executions, receipts, curve };
}

// The archive format includes only the reviewed synthetic tape. Restore rebuilds every output
// from the installed fixture before accepting an archive, including its run-specific history.
export async function archive(fixture, runId) {
  requireThat(verifiedFixtures.has(fixture), 'Archive requires the pinned fixture');
  const { snapshot, verifiedBoundaries } = verifyRun(fixture, runId);
  const tape = fixture.runs.find(run => run.id === runId);
  const data = { format: 'trading-rehearsal/1', fixture: FIXTURE_SHA, calendar: fixture.calendar, assets: fixture.assets, verifiedBoundaries, tape, snapshot };
  return { ...data, sha256: await digest(canonical(data)) };
}
export async function restore(fixture, text) {
  requireThat(typeof text === 'string' && encoder.encode(text).length <= MAX_ARCHIVE, 'Archive exceeds limit');
  const candidate = JSON.parse(text);
  const expected = await archive(fixture, candidate?.snapshot?.run);
  requireThat(canonical(candidate) === canonical(expected), 'Archive integrity or binding mismatch');
  return expected;
}


function boundaryResult(probe, fixture) {
  const i = probe.input;
  const asset = { ...fixture.assets[i.symbol ?? 'TEST'], ...i.asset };
  switch (probe.rule) {
    case 'eligibility': return eligibility(asset, i.price ?? 25, i.at ?? '2026-11-04T15:00:00Z', fixture.calendar);
    case 'capacity': return capacity({ dailyOrders: 0, positionCount: 0, held: 0, pending: 0,
      equity: 100000, liquidity: 100000, riskHalt: false, ...i.state },
      { side: 'BUY', effect: 'OPEN', qty: 1, limit: 25, mark: 25, ...i.order }, asset);
    case 'interest': return interestMicros(...i);
    case 'margin': return margin(...i);
    case 'volume': return volumeEvidence(...i);
    case 'fee': return feeMicros(fixture.assets[i[0]], ...i.slice(1)).amount;
    case 'expiry': return expiryOutcome(fixture.assets[i[0]], ...i.slice(1));
    default: throw Error('Unknown boundary check');
  }
}
export function verifyRun(fixture, runId) {
  for (const probe of fixture.boundaries) {
    requireThat(boundaryResult(probe, fixture) === probe.expected, 'Boundary mismatch: ' + probe.name);
  }
  const snapshot = replay(fixture, runId);
  const actual = { ...snapshot,
    positions: Object.fromEntries(Object.entries(snapshot.positions).map(([s,p]) => [s,p.qty])),
    working: snapshot.orders.filter(active).map(o => o.id), reasons: snapshot.receipts.map(r => r.reason) };
  for (const [name, expected] of Object.entries(fixture.expected[runId])) {
    requireThat(canonical(expected) === canonical(actual[name]), 'Run ' + runId + ' mismatch: ' + name);
  }
  return { snapshot, verifiedBoundaries: fixture.boundaries.length };
}
