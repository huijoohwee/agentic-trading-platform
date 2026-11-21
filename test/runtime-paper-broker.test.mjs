import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../runtime/gateway.mjs';
import { createPaperGuard, PAPER_EVALUATOR_DIGEST } from '../runtime/paper-guard.mjs';
import { createPaperBroker } from '../runtime/paper-broker.mjs';
import { openStore } from '../runtime/store.mjs';
import { canonical, sha } from '../runtime/core.mjs';

// Operational local paper exchange through the shared gateway: real guard, real signed broker
// observations, single durable $0 counter. Labelled MOCK paper simulation; no live broker route.
const BASE = Date.parse('2026-11-19T15:00:00Z');
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
const AUDIENCE = 'gateway-audience-token-0123456789abcdef';
const AUTH = 'Bearer ' + AUDIENCE;
const clone = structuredClone;

function fixture(t) {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.runtime-paper-'));
  const path = join(directory, 'state.sqlite'), stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  const f = { time: BASE, candidate: sha('paper-candidate'), scope: { environment: 'SIMULATE', profile: 'practice', account_alias: 'paper-alias' },
    keys: {}, privateKeys: {} };
  f.coordination = f.scope;
  f.budgetScope = { ...f.scope, account_alias: 'runtime-budget/' + sha(f.scope.account_alias) };
  f.simScope = { ...f.scope, account_alias: 'paper-sim/' + sha(f.scope.account_alias) };
  for (const role of ['operator', 'risk', 'research', 'integration']) {
    const pair = generateKeyPairSync('ed25519'); f.privateKeys[role] = pair.privateKey;
    f.keys[role] = { role, principal: `paper-${role}`, runtime: `paper-${role}-runtime`, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  f.sign = (key, kind, fields = {}) => {
    const actor = f.keys[key], payload = { schema: 'trading-runtime-envelope/v1', kind,
      principal: actor.principal, runtime: actor.runtime, scope: f.scope, candidate: f.candidate,
      issued_utc: iso(f.time - 1000), expires_utc: iso(f.time + 300_000), ...fields };
    return { key_id: key, payload, signature: sign(null, Buffer.from(canonical(payload)), f.privateKeys[key]).toString('base64url') };
  };
  f.db = () => { const s = openStore(path); stores.push(s); return s; };
  f.store = f.db();
  f.market = { quotes: [{ symbol_key: 'US.AAPL', ccy: 'USD', last: 100, prev_close: 100, freshness: 'realtime', source_ref: 'fixture-quote' }],
    instruments: { 'US.AAPL': { kind: 'STOCK', listing: 'US', session: 'regular', cap: 1000000000, lot_size: 1, tick_size: 0.01, ccy: 'USD' } },
    calendar: { '2026-11-19': { open: 570, close: 960, early: 240, late: 1200 } } };
  f.attestation = { key_id: 'integration', principal: f.keys.integration.principal, runtime: f.keys.integration.runtime,
    privateKey: f.privateKeys.integration.export({ type: 'pkcs8', format: 'pem' }) };
  f.broker = (store = f.store) => createPaperBroker({ store, scope: f.scope, candidate: f.candidate, keys: f.keys,
    attestation: f.attestation, market: f.market, cash: 100000, fee: 1, source: 'MOCK', provider: 'local-paper', now: () => f.time });
  f.capability = { provider: 'local-paper', adapter_version: '1', adapter_digest: sha('paper-adapter'), transport: 'LOCAL',
    protocol: null, schema_digest: sha('paper-schema'), mapping_digest: sha('paper-mapping'), mode: 'account', source: 'MOCK',
    operations: ['release', 'reconcile', 'halt'], allowlist: [], rights: 'paper', delay: 'realtime',
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 20 },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('paper-receipt'), expires_utc: iso(BASE + 300_000) } };
  f.capDigest = sha(f.capability);
  f.stack = (store = f.store) => {
    const broker = f.broker(store);
    const guard = createPaperGuard({ store, scope: f.scope, candidate: f.candidate, keys: f.keys, broker, now: () => f.time });
    const gateway = createGateway({ store, scope: f.scope, candidate: f.candidate, capabilities: [f.capability],
      readers: {}, guard, keys: f.keys, audienceToken: AUDIENCE, now: () => f.time });
    return { broker, guard, gateway };
  };
  f.request = async (intentId = 'intent-1', mutate = () => {}, grantFields = {}) => {
    const envelope = await f.broker().readAccount({ scope: f.scope, candidate: f.candidate });
    const intent = { intent_id: intentId, scope: clone(f.scope), research: { principal: f.keys.research.principal, runtime: f.keys.research.runtime },
      input_digest: sha(envelope.payload.data), evaluator_digest: PAPER_EVALUATOR_DIGEST,
      policy: { revision: 'paper-policy-v1', maxAgeMinutes: 1, maxPositionPct: 20, maxRiskPct: 2, minCashPct: 10,
        maxPositions: 10, maxDailyLoss: 1000, priceBandPct: 5, feePerOrder: 1, reconGraceMinutes: 1 },
      ticket: { ticket_id: intentId, account_alias: f.scope.account_alias, created_utc: iso(BASE), symbol_key: 'US.AAPL',
        side: 'BUY', order_type: 'LIMIT', qty: 10, limit_price: 100, stop_price: 95, ccy: 'USD', expiry_utc: iso(BASE + 240_000), rationale: 'paper bounded risk' } };
    mutate(intent);
    intent.strategy = { revision: 'paper-strategy-v1', policy_digest: sha(intent.policy) };
    const bindings = { intent_digest: sha(intent), input_digest: intent.input_digest, policy_digest: sha(intent.policy),
      strategy_digest: sha(intent.strategy), evaluator_digest: PAPER_EVALUATOR_DIGEST };
    const grant = f.sign('operator', 'paper', { bindings, provider: 'local-paper', source: 'MOCK', actions: ['BUY_OPEN', 'SELL_CLOSE'],
      cutoff_utc: iso(BASE + 180_000), timeout_ms: 1000, max_order_notional: 10000,
      proofs: ['cost', 'rights', 'account', 'isolation'].map(kind => ({ kind, digest: sha('paper-' + kind), expires_utc: iso(BASE + 300_000) })),
      cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 20 }, ...grantFields });
    const review = f.sign('risk', 'risk', { verdict: 'APPROVE', bindings, nonce: 'nonce-' + intentId });
    return clone({ intent, grant, review });
  };
  f.admit = (gateway, operation, inputs, requestId) => gateway.admit({ contract_version: '1', request_id: requestId,
    capability_digest: f.capDigest, operation, scope: clone(f.scope), inputs, deadline_utc: iso(f.time + 60_000) }, AUTH);
  return f;
}

test('operational paper cycle: signed release fills, reconciles, closes and halts through one gateway ledger', async t => {
  const f = fixture(t), { gateway } = f.stack();
  const first = await f.request('intent-1');
  const released = await f.admit(gateway, 'release', first, 'req-release-1');
  assert.equal(released.status, 'OK');
  assert.equal(released.data.status, 'FILLED');
  assert.equal(released.data.provider, 'local-paper');
  assert.equal(released.data.fill_ids.length, 1);
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[sha('paper-cost')], { limit: 20, calls: 2 });
  const record = f.store.read(f.coordination).intents['intent-1'];
  assert.equal(record.status, 'FILLED'); assert.equal(record.reserved, false);
  assert.equal(record.audit.decisions[0].outcome, 'PASS');
  const sim = f.store.read(f.simScope).configs.paperSim;
  assert.equal(Object.keys(sim.orders).length, 1);
  assert.equal(sim.positions['US.AAPL'].qty, 10);
  assert.equal(sim.cash, 98999);
  const retry = await f.admit(gateway, 'release', first, 'req-release-1');
  assert.deepEqual(retry, released);
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[sha('paper-cost')], { limit: 20, calls: 2 }, 'idempotent retry never re-fills');
  const reconciled = await f.admit(gateway, 'reconcile', { intent_id: 'intent-1', grant: first.grant }, 'req-reconcile-1');
  assert.equal(reconciled.status, 'OK'); assert.equal(reconciled.data.status, 'FILLED');
  const second = await f.request('intent-2');
  assert.equal((await f.admit(gateway, 'release', second, 'req-release-2')).data.status, 'FILLED');
  assert.equal(f.store.read(f.simScope).configs.paperSim.positions['US.AAPL'].qty, 20);
  const close = await f.request('intent-3', i => { i.ticket.side = 'SELL'; i.ticket.qty = 10; });
  const closed = await f.admit(gateway, 'release', close, 'req-release-3');
  assert.equal(closed.data.status, 'FILLED');
  assert.equal(f.store.read(f.simScope).configs.paperSim.positions['US.AAPL'].qty, 10);
  const halted = await f.admit(gateway, 'halt', { grant: first.grant, reason: 'OPERATOR_HALT' }, 'req-halt');
  assert.equal(halted.status, 'OK'); assert.equal(halted.data.status, 'HALTED');
  const blocked = await f.admit(gateway, 'release', await f.request('intent-4'), 'req-after-halt');
  assert.equal(blocked.status, 'REFUSED'); assert.equal(blocked.error.code, 'HALTED');
});

test('gateway refuses under-proofed grants before the paper guard spends any call', async t => {
  const f = fixture(t), { gateway } = f.stack();
  const request = await f.request('intent-1');
  const noIsolation = clone(request);
  noIsolation.grant.payload.proofs = noIsolation.grant.payload.proofs.filter(p => p.kind !== 'isolation');
  noIsolation.grant = f.sign('operator', 'paper', noIsolation.grant.payload);
  const refused = await f.admit(gateway, 'release', noIsolation, 'req-no-isolation');
  assert.equal(refused.status, 'REFUSED'); assert.equal(refused.error.code, 'UNQUALIFIED');
  assert.deepEqual(f.store.read(f.budgetScope).telemetry, {});
  assert.deepEqual(f.store.read(f.coordination).intents, {});
});

test('independent risk veto and digest binding hold through the gateway', async t => {
  const f = fixture(t), { gateway } = f.stack();
  const vetoed = await f.request('intent-veto');
  vetoed.review = f.sign('risk', 'risk', { ...vetoed.review.payload, verdict: 'REJECT' });
  const result = await f.admit(gateway, 'release', vetoed, 'req-veto');
  assert.equal(result.status, 'OK');
  assert.equal(result.data.status, 'BLOCKED'); assert.equal(result.data.reason, 'RISK_VETO');
  assert.deepEqual(f.store.read(f.budgetScope).telemetry, {});
  const tampered = await f.request('intent-tamper');
  tampered.intent.ticket.qty = 11;
  const blocked = await f.admit(gateway, 'release', tampered, 'req-tamper');
  assert.equal(blocked.data.status, 'BLOCKED'); assert.equal(blocked.data.reason, 'DIGEST_BINDING');
});

test('shared $0 allowance exhausts durably across gateway requests', async t => {
  const f = fixture(t), { gateway } = f.stack();
  const first = await f.request('intent-1', () => {}, { cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 2 } });
  assert.equal((await f.admit(gateway, 'release', first, 'req-budget-1')).data.status, 'FILLED');
  const second = await f.request('intent-2');
  second.grant = f.sign('operator', 'paper', { ...second.grant.payload, cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 2 } });
  const exhausted = await f.admit(gateway, 'release', second, 'req-budget-2');
  assert.equal(exhausted.data.status, 'BLOCKED'); assert.equal(exhausted.data.reason, 'BUDGET_HALT');
  assert.deepEqual(f.store.read(f.budgetScope).telemetry[sha('paper-cost')], { limit: 2, calls: 2 });
});

test('paper state survives restart; unresolved releases fence the gateway until signed readback', async t => {
  const f = fixture(t), { gateway } = f.stack();
  const first = await f.request('intent-1');
  assert.equal((await f.admit(gateway, 'release', first, 'req-restart-1')).data.status, 'FILLED');
  f.store.close();
  const reopened = f.db(); f.store = reopened;
  const restarted = f.stack(reopened);
  const reconciled = await f.admit(restarted.gateway, 'reconcile', { intent_id: 'intent-1', grant: first.grant }, 'req-restart-reconcile');
  assert.equal(reconciled.data.status, 'FILLED');
  const next = await f.request('intent-2');
  assert.equal((await f.admit(restarted.gateway, 'release', next, 'req-restart-2')).data.status, 'FILLED');
  reopened.transaction(f.coordination, s => { s.intents['intent-2'].status = 'RELEASING'; });
  const fenced = f.stack(f.db());
  assert.equal(f.store.read(f.coordination).intents['intent-2'].status, 'RELEASE_UNKNOWN');
  const refused = await f.admit(fenced.gateway, 'release', await f.request('intent-3'), 'req-fenced');
  assert.equal(refused.status, 'REFUSED'); assert.equal(refused.error.code, 'RELEASE_UNKNOWN');
});