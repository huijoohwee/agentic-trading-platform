import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { settleFill } from '../src/practice-account.mjs';
import { appendEvent } from './store.mjs';
import { boundedJson, canonical, current, hash, id, requireThat, sameScope, scopeKey, sha, utcMillis } from './core.mjs';

const instant = n => new Date(Math.floor(n / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const terminal = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'BLOCKED']);
const clone = structuredClone;

// Operational local paper exchange. It signs account/order observations with an independent
// integration key and keeps simulated state in its own scope so guard revision fences stay intact.
// Fills assume immediate execution at the limit price; this is a labelled paper simulation, never a
// live broker route. Provider account transport remains separately qualified.
export function createPaperBroker({ store, scope, candidate, keys, attestation, market, cash = 100000, fee = 1,
  source = 'MOCK', provider = 'local-paper', now = Date.now }) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/') && !scope.account_alias.startsWith('paper-sim/'), 'ACCOUNT_BINDING');
  requireThat(hash(candidate) && typeof now === 'function', 'CANDIDATE_BINDING');
  requireThat(store?.read && store?.transaction, 'HOST_TRANSPORT_REQUIRED');
  requireThat(id(attestation?.key_id) && id(attestation.principal) && id(attestation.runtime) &&
    keys?.[attestation.key_id]?.role === 'integration', 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(attestation.privateKey);
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'ATTESTATION_REQUIRED');
  const publicKey = createPublicKey(privateKey);
  requireThat(source === 'MOCK' && id(provider), 'INVALID_TRANSPORT');
  requireThat(Number.isFinite(cash) && cash >= 0 && Number.isFinite(fee) && fee >= 0, 'INVALID_TRANSPORT');
  requireThat(Array.isArray(market?.quotes) && market.quotes.length > 0 && market.quotes.length <= 50 &&
    market.quotes.every(q => id(q.symbol_key) && q.ccy === 'USD' && Number.isFinite(q.last) && q.last > 0 &&
      Number.isFinite(q.prev_close) && q.prev_close > 0 && q.freshness === 'realtime' && id(q.source_ref)) &&
    market.instruments && typeof market.instruments === 'object' && market.calendar && typeof market.calendar === 'object', 'INVALID_MARKET');
  const simScope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'paper-sim/' + sha(scope.account_alias) };
  const coordination = { ...scope, profile: 'practice' };
  const observation = (kind, data) => {
    const at = now();
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'provider-observation', scope, candidate,
      principal: attestation.principal, runtime: attestation.runtime, issued_utc: instant(at), expires_utc: instant(at + 120_000),
      observation: kind, data };
    return { key_id: attestation.key_id, payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url') };
  };
  const initial = () => ({ cash, realized: 0, positions: {}, orders: {}, account_envelope: null, account_state: null });
  function localSimulation(state) {
    const sim = state.configs.paperSim ?? initial();
    const matches = row => row?.source === 'MOCK' && row.provider === provider;
    requireThat((!sim.account_envelope || matches(sim.account_envelope.payload?.data)) &&
      Object.values(sim.orders).every(matches), 'PROVIDER_BINDING');
    return sim;
  }
  const stateDigest = sim => sha({ cash: sim.cash, realized: sim.realized, positions: sim.positions, orders: sim.orders });
  function accountData(sim, revision) {
    const at = instant(now());
    const quotes = market.quotes.map(q => ({ ...clone(q), observed_utc: at }));
    const positions = Object.entries(sim.positions).filter(([, p]) => p.qty > 0)
      .map(([symbol_key, p]) => ({ symbol_key, qty: p.qty, avg_cost: p.avg_cost, ccy: 'USD' }));
    const orders = Object.values(sim.orders);
    const equity = sim.cash + positions.reduce((total, p) => total + p.qty * (market.quotes.find(q => q.symbol_key === p.symbol_key)?.last ?? p.avg_cost), 0);
    return { source, provider, snapshot_id: 'paper-sim-' + revision, observed_utc: at, account_type: 'CASH', base_ccy: 'USD',
      margin_debt: 0, short_exposure: 0, cash: sim.cash, equity, day_pnl: sim.realized, daily_orders: 0, fee_per_order: fee,
      positions, quotes, instruments: clone(market.instruments), calendar: clone(market.calendar), fx: { USD: 1 },
      fx_observed_utc: at, fx_source_ref: 'paper-sim-fx', open_orders: orders.filter(o => !terminal.has(o.status)),
      accounted_order_ids: orders.filter(o => terminal.has(o.status)).map(o => o.order_id) };
  }
  return Object.freeze({
    async readAccount({ scope: target, candidate: bound, signal }) {
      requireThat(sameScope(target, scope) && bound === candidate && !signal?.aborted, 'ACCOUNT_BINDING');
      return store.transaction(simScope, state => {
        const sim = localSimulation(state);
        const digest = stateDigest(sim);
        const cached = sim.account_envelope?.payload;
        if (cached && sim.account_state === digest && cached.candidate === candidate &&
          sameScope(cached.scope, scope) && current(cached, now()) &&
          sim.account_envelope.key_id === attestation.key_id && cached.principal === attestation.principal &&
          cached.runtime === attestation.runtime && typeof sim.account_envelope.signature === 'string' &&
          verify(null, Buffer.from(canonical(cached)), publicKey, Buffer.from(sim.account_envelope.signature, 'base64url'))) {
          return clone(sim.account_envelope);
        }
        const envelope = observation('account', accountData(sim, state.revision));
        state.configs.paperSim = { ...sim, account_envelope: envelope, account_state: digest };
        return envelope;
      });
    },
    async submit({ scope: target, candidate: bound, intent_id, ticket, not_after_utc, signal }) {
      requireThat(sameScope(target, scope) && bound === candidate && id(intent_id) && !signal?.aborted, 'ACCOUNT_BINDING');
      requireThat(utcMillis(not_after_utc) !== null && now() < utcMillis(not_after_utc), 'CUTOFF');
      return store.transaction(simScope, state => {
        const sim = localSimulation(state);
        const existing = Object.values(sim.orders).find(o => o.intent_id === intent_id);
        if (existing) return observation('order', clone(existing));
        const at = instant(now()), order_id = 'paper-' + sha({ intent_id, ticket });
        const held = sim.positions[ticket.symbol_key]?.qty ?? 0;
        const cost = ticket.qty * ticket.limit_price;
        if (ticket.side === 'BUY') requireThat(sim.cash >= cost + fee, 'RESERVED_CASH');
        else requireThat(held >= ticket.qty, 'CLOSE_EXCEEDS_HELD');
        const fill = { id: 'paper-fill-' + sha(order_id), qty: ticket.qty, price: ticket.limit_price, ccy: 'USD', at };
        const order = { source, provider, observed_utc: at, intent_id, order_id, symbol_key: ticket.symbol_key, side: ticket.side,
          qty: ticket.qty, limit_price: ticket.limit_price, status: 'FILLED', filled_qty: ticket.qty, fills: [fill] };
        settleFill(sim, ticket.symbol_key, ticket.side, ticket.qty, ticket.limit_price, fee);
        sim.orders[order_id] = order;
        sim.account_state = null;
        state.configs.paperSim = sim;
        appendEvent(state, { id: 'paper-sim:' + order_id, type: 'paper-sim-fill', at, data: { order_id, intent_id, side: ticket.side, qty: ticket.qty, price: ticket.limit_price } });
        return observation('order', clone(order));
      });
    },
    async readOrder({ scope: target, candidate: bound, intent_id, order_id, signal }) {
      requireThat(sameScope(target, scope) && bound === candidate && !signal?.aborted, 'ACCOUNT_BINDING');
      const sim = localSimulation(store.read(simScope));
      const order = (order_id && sim.orders[order_id]) || Object.values(sim.orders).find(o => o.intent_id === intent_id) || null;
      return observation('order', order && clone(order));
    },
  });
}