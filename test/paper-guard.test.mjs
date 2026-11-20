import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaperGuard, PAPER_EVALUATOR_DIGEST } from '../runtime/paper-guard.mjs';
import { openStore } from '../runtime/store.mjs';
import { canonical, sha } from '../runtime/core.mjs';

// MOCK transport only. These receipts do not qualify a provider, credentials or agent isolation.
const BASE = Date.parse('2026-11-19T15:00:00Z');
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
const clone = structuredClone;
function fixture(t, profile = 'competition') {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.paper-guard-'));
  const path = join(directory, 'state.sqlite'), stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  const f = { time: BASE, candidate: sha('MOCK-candidate'), scope: { environment: 'SIMULATE', profile, account_alias: 'paper-alias' },
    keys: {}, privateKeys: {}, calls: { account: 0, submit: 0, order: 0 } };
  f.db = () => { const s = openStore(path); stores.push(s); return s; };
  f.store = f.db(); f.coordination = { ...f.scope, profile: 'practice' };
  f.budgetScope = { ...f.coordination, account_alias: `runtime-budget/${sha(f.scope.account_alias)}` };
  for (const role of ['operator', 'risk', 'research', 'integration']) {
    const pair = generateKeyPairSync('ed25519'); f.privateKeys[role] = pair.privateKey;
    f.keys[role] = { role, principal: `MOCK-${role}`, runtime: `MOCK-${role}-runtime`, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  f.sign = (key, kind, fields = {}) => {
    const actor = f.keys[key], payload = { schema: 'trading-runtime-envelope/v1', kind,
      principal: actor.principal, runtime: actor.runtime, scope: f.scope, candidate: f.candidate,
      issued_utc: iso(f.time - 1000), expires_utc: iso(f.time + 300_000), ...fields };
    return { key_id: key, payload, signature: sign(null, Buffer.from(canonical(payload)), f.privateKeys[key]).toString('base64url') };
  };
  f.resign = (envelope, fields = {}, key = envelope.key_id) => f.sign(key, envelope.payload.kind, { ...envelope.payload, ...fields });
  f.account = { source: 'MOCK', provider: 'mock-broker', snapshot_id: 'MOCK-snapshot', observed_utc: iso(BASE), account_type: 'CASH',
    base_ccy: 'USD', margin_debt: 0, short_exposure: 0, cash: 100000, equity: 100000, day_pnl: 0, daily_orders: 0, fee_per_order: 1,
    positions: [], quotes: [{ symbol_key: 'US.AAPL', ccy: 'USD', last: 100, prev_close: 100, observed_utc: iso(BASE), freshness: 'realtime', source_ref: 'MOCK-quote' }],
    instruments: { 'US.AAPL': { kind: 'STOCK', listing: 'US', session: 'regular', cap: 1000000000, lot_size: 1, tick_size: 0.01, ccy: 'USD' } },
    calendar: { '2026-11-19': { open: 570, close: 960, early: 240, late: 1200 } }, fx: { USD: 1 },
    fx_observed_utc: iso(BASE), fx_source_ref: 'MOCK-fx', open_orders: [], accounted_order_ids: [] };
  f.request = (intentId = 'intent-1', adjust = () => {}) => {
    const intent = { intent_id: intentId, scope: f.scope, research: { principal: f.keys.research.principal, runtime: f.keys.research.runtime },
      input_digest: sha(f.account), evaluator_digest: PAPER_EVALUATOR_DIGEST,
      policy: { revision: 'MOCK-policy-v1', maxAgeMinutes: 1, maxPositionPct: 20, maxRiskPct: 2, minCashPct: 10,
        maxPositions: 10, maxDailyLoss: 1000, priceBandPct: 5, feePerOrder: 1, reconGraceMinutes: 1 },
      ticket: { ticket_id: intentId, account_alias: f.scope.account_alias, created_utc: iso(BASE), symbol_key: 'US.AAPL',
        side: 'BUY', order_type: 'LIMIT', qty: 10, limit_price: 100, stop_price: 95, ccy: 'USD', expiry_utc: iso(BASE + 240_000), rationale: 'MOCK bounded risk' } };
    adjust(intent);
    intent.strategy = { revision: 'MOCK-strategy-v1', policy_digest: sha(intent.policy) };
    const bindings = { intent_digest: sha(intent), input_digest: intent.input_digest, policy_digest: sha(intent.policy),
      strategy_digest: sha(intent.strategy), evaluator_digest: PAPER_EVALUATOR_DIGEST };
    const grant = f.sign('operator', 'paper', { bindings, provider: 'mock-broker', source: 'MOCK', actions: ['BUY_OPEN', 'SELL_CLOSE'],
      cutoff_utc: iso(BASE + 180_000), timeout_ms: 1000, max_order_notional: 10000,
      proofs: ['cost', 'rights', 'account', 'isolation'].map(kind => ({ kind, digest: sha(`MOCK-${kind}`), expires_utc: iso(BASE + 300_000) })),
      cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 20 } });
    const review = f.sign('risk', 'risk', { verdict: 'APPROVE', bindings, nonce: `nonce-${intentId}` });
    return clone({ intent, grant, review });
  };
  f.order = (intent, fields = {}) => ({ source: 'MOCK', provider: 'mock-broker', observed_utc: iso(f.time), intent_id: intent.intent_id,
    order_id: `MOCK-order-${intent.intent_id}`, symbol_key: intent.ticket.symbol_key, side: intent.ticket.side,
    qty: intent.ticket.qty, limit_price: intent.ticket.limit_price, status: 'WORKING', filled_qty: 0, fills: [], ...fields });
  f.observation = (observation, data) => f.sign('integration', 'provider-observation', { observation, data: clone(data) });
  f.broker = {
    async readAccount(args) { f.calls.account++; assert.deepEqual(args.scope, f.scope); return f.readHook ? f.readHook(args) : f.observation('account', f.account); },
    async submit(args) {
      f.calls.submit++; assert.equal(args.not_after_utc, iso(BASE + 60_000));
      assert.equal(f.store.read(f.coordination).intents[args.intent_id].status, 'RELEASING');
      assert.equal(f.store.read(f.coordination).intents[args.intent_id].reserved, true);
      if (f.submitHook) return f.submitHook(args);
      return f.observation('order', f.order({ intent_id: args.intent_id, ticket: args.ticket }));
    },
    async readOrder(args) { f.calls.order++; return f.orderHook ? f.orderHook(args) : f.observation('order', f.readback); },
  };
  f.guard = store => createPaperGuard({ store: store ?? f.store, scope: f.scope, candidate: f.candidate, keys: f.keys, broker: f.broker, now: () => f.time });
  return f;
}

for (const profile of ['practice', 'competition']) test(`MOCK ${profile}: authenticated cash LIMIT, audit and no browser broker exposure`, async t => {
  const f = fixture(t, profile), guard = f.guard(), request = f.request();
  assert.deepEqual(Object.keys(guard).sort(), ['halt', 'reconcile', 'release']);
  assert.equal((await guard.release(request)).status, 'WORKING');
  const state = f.store.read(f.coordination), record = state.intents['intent-1'];
  assert.equal(record.source, 'MOCK'); assert.equal(record.account_envelope.payload.data.source, 'MOCK');
  assert.deepEqual(Object.values(record.audit.decisions[0].checks), Array(9).fill('PASS'));
  assert.equal(record.reservation.cash, 1001); assert.equal(record.reservation.risk, 50);
  assert.ok(state.events.length >= 2); assert.equal(f.calls.submit, 1);
  assert.deepEqual(await guard.release(request), await f.guard(f.db()).release(request));
  const different = clone(request); different.intent.ticket.qty++;
  assert.equal((await guard.release(different)).reason, 'CONFLICTING_INTENT');
  assert.equal(f.calls.submit, 1);
});

test('MOCK two DB clients overlap reads: one admission, one revision conflict', async t => {
  const f = fixture(t), a = f.guard(), b = f.guard(f.db());
  let reads = 0, wake;
  const barrier = new Promise(resolve => { wake = resolve; });
  f.readHook = async () => { if (++reads === 2) wake(); await barrier; return f.observation('account', f.account); };
  const results = await Promise.all([a.release(f.request('first')), b.release(f.request('second'))]);
  assert.equal(results.filter(r => r.status === 'WORKING').length, 1);
  assert.equal(results.filter(r => r.status === 'BLOCKED' && r.reason === 'CONFLICT').length, 1);
  assert.equal(f.calls.submit, 1); assert.equal(Object.keys(f.store.read(f.coordination).intents).length, 1);
});

test('MOCK simultaneous equivalent intents return stored outcome and never submit twice', async t => {
  const f = fixture(t), a = f.guard(), b = f.guard(f.db()), request = f.request();
  const receipts = await Promise.all([a.release(request), b.release(request)]);
  assert.ok(receipts.every(r => ['RELEASING', 'WORKING'].includes(r.status))); assert.equal(f.calls.submit, 1);
  assert.equal((await b.release(request)).status, 'WORKING');
});

const rejected = [
  ['risk veto', (f, r) => { r.review = f.resign(r.review, { verdict: 'REJECT' }); }, 'RISK_VETO'],
  ['risk unknown', (f, r) => { r.review = f.resign(r.review, { verdict: 'UNKNOWN' }); }, 'RISK_VETO'],
  ['research-authored review', (f, r) => { r.review = f.sign('research', 'risk', r.review.payload); }, 'UNTRUSTED_PRINCIPAL'],
  ['forged role label', (f, r) => { r.review.payload.principal = 'fabricated-risk'; }, 'INVALID_SIGNATURE'],
  ['tampered signature', (f, r) => { r.review.signature = 'a'.repeat(86); }, 'INVALID_SIGNATURE'],
  ['expired review', (f, r) => { r.review = f.resign(r.review, { expires_utc: iso(BASE) }); }, 'STALE_EVIDENCE'],
  ['revoked reviewer key', f => { f.keys.risk.revoked = true; }, 'UNTRUSTED_PRINCIPAL'],
  ['revoked verdict', (f, r) => { r.review = f.resign(r.review, { revoked: true }); }, 'REVOKED'],
  ['research runtime reused by risk', (f, r) => { f.keys.risk.runtime = f.keys.research.runtime; r.review = f.resign(r.review, { runtime: f.keys.risk.runtime }); }, 'INDEPENDENT_RISK_REQUIRED'],
  ['research principal reused by operator', (f, r) => { f.keys.operator.principal = f.keys.research.principal; r.grant = f.resign(r.grant, { principal: f.keys.operator.principal }); }, 'INDEPENDENT_RISK_REQUIRED'],
  ['risk principal reused by operator', (f, r) => { f.keys.operator.principal = f.keys.risk.principal; r.grant = f.resign(r.grant, { principal: f.keys.operator.principal }); }, 'INDEPENDENT_RISK_REQUIRED'],
  ['missing reviewer', (f, r) => { delete r.review; }, 'INVALID_SIGNATURE'],
  ['tampered intent', (f, r) => { r.intent.ticket.qty = 11; }, 'DIGEST_BINDING'],
  ['tampered policy', (f, r) => { r.intent.policy.maxRiskPct = 100; }, 'STRATEGY_BINDING'],
  ['wrong evaluator', (f, r) => { r.intent.evaluator_digest = sha('wrong'); }, 'STRATEGY_BINDING'],
  ['wrong strategy', (f, r) => { r.intent.strategy.revision = 'wrong'; }, 'DIGEST_BINDING'],
  ['wrong candidate', (f, r) => { r.grant = f.resign(r.grant, { candidate: sha('wrong') }); }, 'CANDIDATE_BINDING'],
  ['practice grant for competition', (f, r) => { r.grant = f.resign(r.grant, { scope: { ...f.scope, profile: 'practice' } }); }, 'CANDIDATE_BINDING'],
  ['live grant', (f, r) => { r.grant = f.resign(r.grant, { scope: { ...f.scope, environment: 'LIVE' } }); }, 'ACCOUNT_BINDING'],
  ['wrong alias', (f, r) => { r.review = f.resign(r.review, { scope: { ...f.scope, account_alias: 'other' } }); }, 'CANDIDATE_BINDING'],
  ['missing isolation proof', (f, r) => { r.grant = f.resign(r.grant, { proofs: r.grant.payload.proofs.filter(p => p.kind !== 'isolation') }); }, 'MISSING_ADMISSION_PROOF'],
  ['revoked rights proof', (f, r) => { r.grant.payload.proofs[1].revoked = true; r.grant = f.resign(r.grant); }, 'MISSING_ADMISSION_PROOF'],
  ['unknown cost', (f, r) => { r.grant = f.resign(r.grant, { cost: { hard_cap_usd: null } }); }, 'BUDGET_HALT'],
  ['cutoff equal now', (f, r) => { r.grant = f.resign(r.grant, { cutoff_utc: iso(BASE) }); }, 'CUTOFF'],
  ['revoked input digest', (f, r) => { f.store.transaction(f.coordination, s => { s.configs.paper = { revoked: [r.intent.input_digest] }; }); }, 'REVOKED'],
];
for (const [label, mutate, reason] of rejected) test(`MOCK denies ${label}`, async t => {
  const f = fixture(t), request = f.request(); mutate(f, request);
  const result = await f.guard().release(request);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, reason); assert.equal(f.calls.submit, 0);
});

const badAccounts = [
  ['missing source', a => { delete a.quotes[0].source_ref; }],
  ['missing price', a => { delete a.quotes[0].last; }],
  ['missing FX', a => { delete a.fx.USD; }],
  ['unknown fees', a => { delete a.fee_per_order; }],
  ['fees exceed strategy reserve', a => { a.fee_per_order = 2; }],
  ['missing FX source', a => { delete a.fx_source_ref; }],
  ['stale FX', a => { a.fx_observed_utc = iso(BASE - 61_000); }],
  ['stale quote', a => { a.quotes[0].observed_utc = iso(BASE - 61_000); }],
  ['future quote', a => { a.quotes[0].observed_utc = iso(BASE + 1000); }],
  ['delayed quote', a => { a.quotes[0].freshness = 'delayed'; }],
  ['stale account', a => { a.observed_utc = iso(BASE - 61_000); }],
  ['unknown account type', a => { delete a.account_type; }],
  ['margin account', a => { a.account_type = 'MARGIN'; }],
  ['margin debt', a => { a.margin_debt = 1; }],
  ['short exposure', a => { a.short_exposure = 1; }],
  ['option instrument', a => { a.instruments['US.AAPL'].kind = 'OPTION'; }],
  ['lot mismatch', a => { a.instruments['US.AAPL'].lot_size = 3; }],
  ['tick mismatch', a => { a.instruments['US.AAPL'].tick_size = 0.03; }],
  ['missing cap', a => { delete a.instruments['US.AAPL'].cap; }],
  ['non US listing', a => { a.instruments['US.AAPL'].listing = 'HK'; }],
  ['unknown calendar', a => { a.calendar = {}; }],
  ['daily cap', a => { a.daily_orders = 200; }],
  ['realized daily loss', a => { a.day_pnl = -1000; }],
  ['unknown working order', a => { a.open_orders = [{ order_id: 'external' }]; }],
  ['negative cash', a => { a.cash = -1; }],
];
for (const [label, mutate] of badAccounts) test(`MOCK current signed observation denies ${label}`, async t => {
  const f = fixture(t); mutate(f.account);
  assert.equal((await f.guard().release(f.request())).status, 'BLOCKED'); assert.equal(f.calls.submit, 0);
});

for (const [label, mutate] of [
  ['R02 incomplete policy', i => { delete i.policy.priceBandPct; }],
  ['R03 concentration', i => { i.policy.maxPositionPct = 0.1; }],
  ['R04 strategy risk', i => { i.policy.maxRiskPct = 0.001; }],
  ['R05 cash floor', i => { i.policy.minCashPct = 100; }],
  ['R06 position cap', i => { i.policy.maxPositions = 0; }],
  ['R07 loss policy', i => { i.policy.maxDailyLoss = 0; }],
  ['R09 price band', i => { i.ticket.limit_price = 102; i.policy.priceBandPct = 1; }],
  ['short order', i => { i.ticket.side = 'SELL'; }],
  ['market order', i => { i.ticket.order_type = 'MARKET'; }],
  ['fractional share', i => { i.ticket.qty = 0.1; }],
  ['binary rounding off tick', i => { i.ticket.limit_price = 100.00000000000001; }],
  ['off tick stop', i => { i.ticket.stop_price = 95.001; }],
]) test(`MOCK guard recomputes ${label}, ignoring caller approval`, async t => {
  const f = fixture(t), result = await f.guard().release(f.request('intent-1', mutate));
  assert.equal(result.status, 'BLOCKED'); assert.equal(f.calls.submit, 0);
});

test('MOCK exact decimal tick and cash ETF subset pass', async t => {
  const f = fixture(t), asset = f.account.instruments['US.AAPL']; asset.kind = 'ETF'; asset.fund = true;
  f.account.quotes[0].last = 100.05;
  assert.equal((await f.guard().release(f.request('etf', i => { i.ticket.limit_price = 100.05; }))).status, 'WORKING');
});

for (const [label, change] of [
  ['halt', f => f.store.transaction(f.coordination, s => { s.halted = true; })],
  ['revision', f => f.store.transaction(f.coordination, s => { s.telemetry.other = 1; })],
  ['review revocation', f => { f.keys.risk.revoked = true; }],
  ['operator revocation', f => { f.keys.operator.revoked = true; }],
  ['integration revocation', f => { f.keys.integration.revoked = true; }],
  ['review expiry', f => { f.time += 300_000; }],
  ['source freshness', f => { f.time += 61_000; }],
  ['candidate change', f => f.store.transaction(f.scope, s => { s.configs.paper = { candidate: sha('next') }; })],
]) test(`MOCK asynchronous account read race rechecks ${label}`, async t => {
  const f = fixture(t), request = f.request();
  f.readHook = () => { const e = f.observation('account', f.account); change(f); return e; };
  assert.equal((await f.guard().release(request)).status, 'BLOCKED'); assert.equal(f.calls.submit, 0);
});

test('MOCK current observation cannot silently substitute approved inputs or signer', async t => {
  const f = fixture(t), request = f.request(); f.account.cash--;
  assert.equal((await f.guard().release(request)).reason, 'INPUT_BINDING');
  f.readHook = () => f.sign('research', 'provider-observation', { observation: 'account', data: f.account });
  assert.equal((await f.guard().release(f.request('second'))).reason, 'UNTRUSTED_PRINCIPAL');
  f.readHook = () => { const e = f.observation('account', f.account); e.payload.data.cash++; return e; };
  assert.equal((await f.guard().release(f.request('third'))).reason, 'INVALID_SIGNATURE');
  assert.equal(f.calls.submit, 0);
});

for (const mode of ['throw', 'timeout', 'unsigned', 'absent', 'wrong-order', 'forged-order']) test(`MOCK ${mode} submit stays uncertain through restart; never resubmits`, async t => {
  const f = fixture(t), request = f.request(); request.grant = f.resign(request.grant, { timeout_ms: 10 });
  f.submitHook = () => {
    if (mode === 'throw') throw Error('transport lost');
    if (mode === 'timeout') return new Promise(() => {});
    if (mode === 'unsigned') return { order_id: 'maybe-accepted' };
    if (mode === 'absent') return f.observation('order', null);
    if (mode === 'wrong-order') return f.observation('order', f.order(request.intent, { qty: 999 }));
    const e = f.observation('order', f.order(request.intent)); e.signature = 'a'.repeat(86); return e;
  };
  assert.equal((await f.guard().release(request)).status, 'RELEASE_UNKNOWN');
  assert.equal(f.store.read(f.coordination).halted, true);
  f.store.close(); f.store = f.db(); const guard = f.guard();
  assert.equal((await guard.release(request)).status, 'RELEASE_UNKNOWN');
  assert.equal((await guard.release(f.request('other'))).status, 'BLOCKED');
  f.orderHook = () => f.observation('order', null);
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'RELEASE_UNKNOWN');
  assert.equal(f.store.read(f.coordination).halted, true);
  f.readback = f.order(request.intent); f.orderHook = null;
  const receipt = await guard.reconcile({ intent_id: 'intent-1', grant: request.grant });
  assert.equal(receipt.status, 'WORKING'); assert.equal(receipt.source, 'MOCK');
  assert.equal(f.store.read(f.coordination).intents['intent-1'].reserved, true);
  assert.equal(f.store.read(f.coordination).halted, false); assert.equal(f.calls.submit, 1);
});

test('MOCK crash after durable reservation fences both profiles and is recoverable only by signed IDs', async t => {
  const f = fixture(t), request = f.request(); let submitted;
  const reached = new Promise(resolve => { submitted = resolve; }); let respond;
  f.submitHook = () => { submitted(); return new Promise(resolve => { respond = resolve; }); };
  const pending = f.guard().release(request); await reached;
  assert.equal(f.store.read(f.coordination).intents['intent-1'].status, 'RELEASING');
  const restarted = f.guard(f.db());
  assert.equal(f.store.read(f.coordination).intents['intent-1'].status, 'RELEASE_UNKNOWN');
  const practice = createPaperGuard({ store: f.db(), scope: f.coordination, candidate: f.candidate, keys: f.keys, broker: f.broker, now: () => f.time });
  const cross = f.request('practice'); cross.intent.scope = f.coordination;
  assert.equal((await practice.release(cross)).reason, 'HALTED');
  f.readback = f.order(request.intent);
  assert.equal((await restarted.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'WORKING');
  respond(f.observation('order', f.readback)); assert.equal((await pending).status, 'WORKING'); assert.equal(f.calls.submit, 1);
});

test('MOCK working partials keep full reservations; stable terminal IDs release them', async t => {
  const f = fixture(t), guard = f.guard(), request = f.request(); await guard.release(request);
  const fill = { id: 'MOCK-fill-1', qty: 4, price: 100, ccy: 'USD', at: iso(BASE) };
  f.readback = f.order(request.intent, { status: 'PARTIAL', filled_qty: 4, fills: [fill] });
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'PARTIAL');
  let r = f.store.read(f.coordination).intents['intent-1']; assert.equal(r.reserved, true); assert.equal(r.reservation.cash, 1001);
  f.account.open_orders = [clone(r.order)];
  const duplicate = await guard.release(f.request('duplicate')); assert.equal(duplicate.status, 'BLOCKED'); assert.match(duplicate.reason, /R08/);
  f.readback = f.order(request.intent, { status: 'CANCELLED', filled_qty: 4, fills: [fill] });
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'CANCELLED');
  r = f.store.read(f.coordination).intents['intent-1']; assert.equal(r.reserved, false);
  f.account.open_orders = [];
  assert.equal((await guard.release(f.request('unsettled'))).reason, 'SETTLEMENT_READBACK_REQUIRED');
  f.account.accounted_order_ids = [r.order.order_id];
  f.account.positions = [{ symbol_key: 'US.AAPL', qty: 4, avg_cost: 100, ccy: 'USD' }]; f.account.cash = 99600;
  assert.equal((await guard.release(f.request('settled'))).status, 'WORKING'); assert.equal(f.calls.submit, 2);
});

test('MOCK one-use approval nonce persists across restart and new signed intent', async t => {
  const f = fixture(t), first = f.request(); await f.guard().release(first);
  f.account.open_orders = [clone(f.store.read(f.coordination).intents['intent-1'].order)];
  const second = f.request('new-id', i => { i.ticket.qty = 11; }); second.review = f.resign(second.review, { nonce: first.review.payload.nonce });
  assert.equal((await f.guard(f.db()).release(second)).reason, 'APPROVAL_REPLAY'); assert.equal(f.calls.submit, 1);
});

for (const [label, mutate] of [
  ['changed order ID', o => { o.order_id = 'different'; }],
  ['missing fill ID', o => { delete o.fills[0].id; }],
  ['duplicate fill ID', o => { o.fills.push(clone(o.fills[0])); }],
  ['overfill', o => { o.filled_qty = 11; }],
  ['off-limit fill', o => { o.fills[0].price = 101; }],
  ['wrong fill currency', o => { o.fills[0].ccy = 'HKD'; }],
  ['missing fill history', o => { o.fills = []; }],
]) test(`MOCK readback rejects ${label} and holds halt`, async t => {
  const f = fixture(t), request = f.request(), guard = f.guard(); await guard.release(request);
  f.readback = f.order(request.intent, { status: 'PARTIAL', filled_qty: 4, fills: [{ id: 'fill-1', qty: 4, price: 100, ccy: 'USD', at: iso(BASE) }] });
  mutate(f.readback);
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'RELEASE_UNKNOWN');
  assert.equal(f.store.read(f.coordination).halted, true); assert.equal(f.calls.submit, 1);
});

test('MOCK manual halt survives signed readback; cutoff does not prohibit reconciliation', async t => {
  const f = fixture(t), request = f.request(), guard = f.guard(); await guard.release(request);
  guard.halt({ grant: request.grant }); f.time += 181_000; f.readback = f.order(request.intent);
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'WORKING');
  assert.equal(f.store.read(f.coordination).halted, true); assert.equal(f.store.read(f.coordination).haltReason, 'OPERATOR_HALT');
  assert.equal((await guard.release(f.request('new'))).status, 'BLOCKED'); assert.equal(f.calls.submit, 1);
});

test('MOCK cutoff is checked after reservation immediately before submit', async t => {
  const f = fixture(t), request = f.request(), underlying = f.store;
  const wrapped = { read: underlying.read, transaction(scope, fn, expected) {
    const result = underlying.transaction(scope, fn, expected);
    if (result?.status === 'RELEASING') f.time = BASE + 180_000;
    return result;
  } };
  const result = await f.guard(wrapped).release(request);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'CUTOFF'); assert.equal(f.calls.submit, 0);
  assert.equal(f.store.read(f.coordination).intents['intent-1'].reserved, false);
  assert.equal((await f.guard().release(request)).status, 'BLOCKED');
});

test('MOCK veto is final for an intent, even if a later signed review says APPROVE', async t => {
  const f = fixture(t), request = f.request(), guard = f.guard();
  request.review = f.resign(request.review, { verdict: 'REJECT' });
  assert.equal((await guard.release(request)).reason, 'RISK_VETO');
  request.review = f.resign(request.review, { verdict: 'APPROVE', nonce: 'another-nonce' });
  assert.equal((await f.guard(f.db()).release(request)).reason, 'RISK_VETO');
  assert.equal(f.calls.account, 0); assert.equal(f.calls.submit, 0);
});

test('MOCK differently labelled roles cannot share a research signing key', async t => {
  const f = fixture(t); f.keys.risk.publicKey = f.keys.research.publicKey; f.privateKeys.risk = f.privateKeys.research;
  assert.equal((await f.guard().release(f.request())).reason, 'INDEPENDENT_RISK_REQUIRED'); assert.equal(f.calls.submit, 0);
});

for (const role of ['operator', 'risk', 'research']) for (const field of ['publicKey', 'principal', 'runtime']) {
  test(`MOCK integration cannot reuse ${role} ${field} before account read`, async t => {
    const f = fixture(t);
    f.keys.integration[field] = f.keys[role][field];
    if (field === 'publicKey') {
      f.privateKeys.integration = f.privateKeys[role];
      f.keys.integration.publicKey = f.keys.integration.publicKey.replaceAll('\n', '\r\n');
    }
    const result = await f.guard().release(f.request());
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'INDEPENDENT_INTEGRATION_REQUIRED');
    assert.deepEqual(f.calls, { account: 0, submit: 0, order: 0 });
    assert.deepEqual(f.store.read(f.budgetScope).telemetry, {});
  });

  test(`MOCK observed integration signer cannot reuse unused ${role} ${field}`, async t => {
    const f = fixture(t), request = f.request();
    f.keys['unused-authority'] = { ...f.keys[role], principal: 'unused-authority', runtime: 'unused-runtime' };
    f.readHook = () => {
      f.keys['observed-integration'] = { ...f.keys.integration, [field]: f.keys['unused-authority'][field] };
      f.privateKeys['observed-integration'] = f.privateKeys[field === 'publicKey' ? role : 'integration'];
      return f.sign('observed-integration', 'provider-observation', { observation: 'account', data: f.account });
    };
    const result = await f.guard().release(request);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'INDEPENDENT_INTEGRATION_REQUIRED');
    assert.deepEqual(f.calls, { account: 1, submit: 0, order: 0 });
    assert.deepEqual(f.store.read(f.coordination).intents, {});
  });
}

test('MOCK integration authority collision after reservation blocks wire submission', async t => {
  const f = fixture(t), underlying = f.store;
  const wrapped = { read: underlying.read, transaction(scope, fn, expected) {
    const result = underlying.transaction(scope, fn, expected);
    if (result?.status === 'RELEASING') f.keys['new-operator'] = { ...f.keys.operator, publicKey: f.keys.integration.publicKey };
    return result;
  } };
  const result = await f.guard(wrapped).release(f.request());
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'INDEPENDENT_INTEGRATION_REQUIRED');
  assert.deepEqual(f.calls, { account: 1, submit: 0, order: 0 });
  assert.equal(f.store.read(f.coordination).intents['intent-1'].reserved, false);
});

for (const operation of ['submit', 'readOrder']) test(`MOCK ${operation} cannot manufacture fills using an approval key`, async t => {
  const f = fixture(t), request = f.request(), guard = f.guard();
  const forgedFill = () => {
    f.keys['forged-integration'] = { ...f.keys.integration, publicKey: f.keys.operator.publicKey };
    f.privateKeys['forged-integration'] = f.privateKeys.operator;
    return f.sign('forged-integration', 'provider-observation', { observation: 'order', data: f.order(request.intent, {
      status: 'FILLED', filled_qty: 10, fills: [{ id: 'forged-fill', qty: 10, price: 100, ccy: 'USD', at: iso(BASE) }],
    }) });
  };
  let result;
  if (operation === 'submit') {
    f.submitHook = forgedFill; result = await guard.release(request);
  } else {
    assert.equal((await guard.release(request)).status, 'WORKING'); f.orderHook = forgedFill;
    result = await guard.reconcile({ intent_id: request.intent.intent_id, grant: request.grant });
  }
  assert.equal(result.status, 'RELEASE_UNKNOWN'); assert.equal(result.reason, 'INDEPENDENT_INTEGRATION_REQUIRED');
  assert.deepEqual(result.fill_ids, []);
  const state = f.store.read(f.coordination);
  assert.equal(state.halted, true); assert.equal(state.intents['intent-1'].reserved, true);
  assert.deepEqual(f.calls, { account: 1, submit: 1, order: operation === 'readOrder' ? 1 : 0 });
});

test('MOCK durable cost allowance is shared across clients and restart; no read or submit on exhaustion', async t => {
  const f = fixture(t), request = f.request();
  request.grant = f.resign(request.grant, { cost: { ...request.grant.payload.cost, remaining_calls: 2 } });
  assert.equal((await f.guard().release(request)).status, 'WORKING');
  const restarted = f.guard(f.db()); f.readback = f.order(request.intent);
  const blocked = await restarted.reconcile({ intent_id: 'intent-1', grant: request.grant });
  assert.equal(blocked.status, 'RELEASE_UNKNOWN'); assert.equal(blocked.reason, 'BUDGET_HALT');
  assert.deepEqual(f.calls, { account: 1, submit: 1, order: 0 });
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[sha('MOCK-cost')], { limit: 2, calls: 2 });
  const proofs = clone(request.grant.payload.proofs); proofs.find(p => p.kind === 'cost').digest = sha('MOCK-new-cost-proof');
  const renewed = f.resign(request.grant, { proofs });
  assert.equal((await restarted.reconcile({ intent_id: 'intent-1', grant: renewed })).status, 'WORKING');
  await restarted.release(request); assert.deepEqual(f.calls, { account: 1, submit: 1, order: 1 });
});

for (const profile of ['practice', 'competition']) {
  for (const alias of ['runtime-budget/', `runtime-budget/${sha('paper-alias')}`]) {
    test(`MOCK ${profile} rejects reserved account alias ${alias}`, t => {
      const f = fixture(t, profile); f.scope.account_alias = alias;
      assert.throws(() => f.guard(), { code: 'ACCOUNT_BINDING' });
      assert.deepEqual(f.calls, { account: 0, submit: 0, order: 0 });
    });
  }

  for (const reservedCalls of [4, 5, 6]) test(`MOCK ${profile} paper shares ${reservedCalls}-call ingestion reservation across restart`, async t => {
    const f = fixture(t, profile), request = f.request(), proof = sha('MOCK-cost');
    request.grant = f.resign(request.grant, { cost: { ...request.grant.payload.cost, remaining_calls: 6 } });
    f.store.transaction(f.budgetScope, s => { s.telemetry[proof] = { limit: 6, calls: reservedCalls }; });
    f.store.close(); f.store = f.db();
    const result = await f.guard().release(request);
    assert.equal(result.status, reservedCalls === 4 ? 'WORKING' : 'BLOCKED');
    assert.equal(result.reason, reservedCalls === 4 ? null : 'BUDGET_HALT');
    assert.deepEqual(f.calls, { account: reservedCalls < 6 ? 1 : 0, submit: reservedCalls === 4 ? 1 : 0, order: 0 });
    assert.deepEqual(f.store.read(f.budgetScope).telemetry[proof], { limit: 6, calls: 6 });
    assert.deepEqual(f.store.read({ ...f.coordination, account_alias: `paper-budget/${sha(f.scope.account_alias)}` }).telemetry, {});
    if (reservedCalls === 5) assert.equal(f.store.read(f.coordination).intents['intent-1'].reserved, false);
  });
}

for (const limit of [5, 7]) test(`MOCK paper cannot change shared proof allowance from 6 to ${limit}`, async t => {
  const f = fixture(t), request = f.request(), proof = sha('MOCK-cost');
  request.grant = f.resign(request.grant, { cost: { ...request.grant.payload.cost, remaining_calls: limit } });
  f.store.transaction(f.budgetScope, s => { s.telemetry[proof] = { limit: 6, calls: 4 }; });
  const result = await f.guard(f.db()).release(request);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'BUDGET_HALT');
  assert.deepEqual(f.calls, { account: 0, submit: 0, order: 0 });
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[proof], { limit: 6, calls: 4 });
});

test('MOCK failed paper account read still charges one shared call', async t => {
  const f = fixture(t), proof = sha('MOCK-cost');
  f.store.transaction(f.budgetScope, s => { s.telemetry[proof] = { limit: 20, calls: 4 }; });
  f.readHook = () => { throw Error('MOCK read failure'); };
  assert.equal((await f.guard().release(f.request())).status, 'BLOCKED');
  assert.deepEqual(f.calls, { account: 1, submit: 0, order: 0 });
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[proof], { limit: 20, calls: 5 });
});

test('MOCK working orders reserve aggregate strategy risk', async t => {
  const f = fixture(t), guard = f.guard();
  const first = f.request('first', i => { i.policy.maxRiskPct = 0.075; });
  assert.equal((await guard.release(first)).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  const next = f.request('next', i => { i.policy.maxRiskPct = 0.075; i.ticket.qty = 6; });
  assert.equal((await guard.release(next)).reason, 'STRATEGY_RISK'); assert.equal(f.calls.submit, 1);
});

test('MOCK working cash and fee reservations preserve the full strategy cash floor', async t => {
  const f = fixture(t), guard = f.guard(); f.account.cash = f.account.equity = 2000;
  const limits = i => { i.policy.minCashPct = 60; i.policy.maxPositionPct = 100; i.policy.maxRiskPct = 100; };
  assert.equal((await guard.release(f.request('first', i => { limits(i); i.ticket.qty = 5; }))).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  assert.equal((await guard.release(f.request('next', i => { limits(i); i.ticket.qty = 3; }))).reason, 'STRATEGY_CASH');
  assert.equal(f.calls.submit, 1);
});

test('MOCK working orders consume strategy position capacity', async t => {
  const f = fixture(t), guard = f.guard();
  assert.equal((await guard.release(f.request('first', i => { i.policy.maxPositions = 1; }))).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  f.account.quotes.push({ ...f.account.quotes[0], symbol_key: 'US.MSFT' });
  f.account.instruments['US.MSFT'] = clone(f.account.instruments['US.AAPL']);
  const next = f.request('next', i => { i.policy.maxPositions = 1; i.ticket.symbol_key = 'US.MSFT'; });
  assert.match((await guard.release(next)).reason, /R06/); assert.equal(f.calls.submit, 1);
});

test('MOCK working reservations count towards competition daily capacity', async t => {
  const f = fixture(t), guard = f.guard(); f.account.daily_orders = 199;
  assert.equal((await guard.release(f.request('first'))).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  assert.equal((await guard.release(f.request('next', i => { i.ticket.qty++; }))).reason, 'DAILY_CAP'); assert.equal(f.calls.submit, 1);
});

test('MOCK reservations never alter the source price used for the price-band rule', async t => {
  const f = fixture(t), guard = f.guard();
  assert.equal((await guard.release(f.request('first', i => { i.ticket.limit_price = 104; }))).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  const next = f.request('next', i => { i.ticket.limit_price = 109; });
  assert.match((await guard.release(next)).reason, /R09/); assert.equal(f.calls.submit, 1);
});

test('MOCK close-only SELL reserves held quantity, never pending BUY shares', async t => {
  const f = fixture(t), guard = f.guard(); f.account.positions = [{ symbol_key: 'US.AAPL', qty: 10, avg_cost: 100, ccy: 'USD' }];
  f.account.cash = 99000;
  const first = f.request('first', i => { i.ticket.side = 'SELL'; i.ticket.qty = 6; });
  assert.equal((await guard.release(first)).status, 'WORKING');
  f.account.open_orders = [clone(f.store.read(f.coordination).intents.first.order)];
  const next = f.request('next', i => { i.ticket.side = 'SELL'; i.ticket.qty = 5; });
  assert.equal((await guard.release(next)).reason, 'CLOSE_EXCEEDS_HELD'); assert.equal(f.calls.submit, 1);
});

test('MOCK authenticated fill IDs cannot be rewritten between readbacks', async t => {
  const f = fixture(t), request = f.request(), guard = f.guard(); await guard.release(request);
  f.readback = f.order(request.intent, { status: 'PARTIAL', filled_qty: 4, fills: [{ id: 'fill', qty: 4, price: 100, ccy: 'USD', at: iso(BASE) }] });
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).status, 'PARTIAL');
  f.readback.fills[0].price = 99;
  assert.equal((await guard.reconcile({ intent_id: 'intent-1', grant: request.grant })).reason, 'UNSTABLE_ORDER');
  assert.equal(f.calls.submit, 1);
});

for (const [label, scope] of [['practice', { profile: 'practice' }], ['live', { environment: 'LIVE' }], ['other alias', { account_alias: 'elsewhere' }]])
  test(`MOCK provider ${label} observation cannot satisfy competition scope`, async t => {
    const f = fixture(t);
    f.readHook = () => f.resign(f.observation('account', f.account), { scope: { ...f.scope, ...scope } });
    assert.equal((await f.guard().release(f.request())).status, 'BLOCKED'); assert.equal(f.calls.submit, 0);
  });

test('MOCK caller booleans and JSON transport configuration confer no authority', async t => {
  const f = fixture(t), request = f.request(); request.intent.ticket.margin = false; request.intent.riskApproved = true;
  assert.equal((await f.guard().release(request)).status, 'BLOCKED'); assert.equal(f.calls.submit, 0);
  assert.throws(() => createPaperGuard({ store: f.store, scope: f.scope, candidate: f.candidate, keys: f.keys,
    broker: { submit: 'https://broker.invalid/orders', readAccount: true, readOrder: true } }), /HOST_TRANSPORT_REQUIRED/);
});
