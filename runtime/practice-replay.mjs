import { boundedJson, sha, requireThat as need } from './core.mjs';
import { frames, instrument, mark, SOURCE } from '../src/market.mjs';
import { estimate, portfolio, settleFill, orderTriggers } from '../src/practice-account.mjs';
import { studies } from '../src/indicators.mjs';
import { initialPractice as initial } from '../src/practice-defaults.mjs';
import { horizons } from '../src/predictions.mjs';

const commandFields = {
  select: ['symbol'],
  settings: ['frame', 'studies', 'code'],
  order: ['symbol', 'side', 'type', 'qty', 'trigger'],
  tick: ['symbol'],
  cancel: ['id'],
  funds: ['amount'],
  reset: ['confirm'],
  prediction: ['symbol', 'direction', 'horizon', 'confidence', 'note']
};
const fits = (v, max) => Number.isFinite(v) && v > 0 && v <= max;
const boundedUsd = (v) => Math.round(v * 1e6) / 1e6;

function fill(s, o, price, at) {
  const { fee } = estimate(o.qty, price),
    closing = settleFill(s, o.symbol, o.side, o.qty, price, fee);
  s.fees = boundedUsd(s.fees + fee);
  if (o.side === 'SELL') {
    s.closes++;
    if (closing - fee > 0) s.wins++;
  }
  s.fills.push({
    id: o.id,
    at,
    symbol: o.symbol,
    type: o.type,
    side: o.side,
    qty: o.qty,
    price,
    fee,
    closing,
    source: SOURCE
  });
  s.fills = s.fills.slice(-1000);
}
function place(s, c, at, id) {
  need(
    ['BUY', 'SELL'].includes(c.side) &&
      ['LIMIT', 'MARKET', 'STOP'].includes(c.type) &&
      fits(c.qty, 1e8) &&
      Math.abs(c.qty * 1e6 - Math.round(c.qty * 1e6)) < 0.00001,
    'INVALID_TICKET'
  );
  const last = mark(s.symbol, at),
    trigger = c.type === 'MARKET' ? last : c.trigger;
  need(fits(trigger, 1e7) && s.orders.length < 200, 'INVALID_TRIGGER');
  const { notional, fee } = estimate(c.qty, trigger);
  const order = {
    id,
    symbol: s.symbol,
    type: c.type,
    side: c.side,
    qty: c.qty,
    trigger,
    at,
    reserve: boundedUsd(notional + fee)
  };
  const held = s.positions[s.symbol]?.qty ?? 0,
    pending = s.orders.filter((o) => o.symbol === s.symbol && o.side === 'SELL').reduce((v, o) => v + o.qty, 0);
  const ready = orderTriggers(order, last);
  if (c.side === 'BUY') {
    const actual = estimate(c.qty, ready ? last : trigger);
    need(
      actual.notional > 0 && portfolio(s, at).available >= boundedUsd(actual.notional + actual.fee),
      'RESERVED_CASH'
    );
  } else need(boundedUsd(held - pending) >= c.qty, 'CLOSE_EXCEEDS_HELD');
  if (ready) {
    fill(s, order, last, at);
    return 'FILLED';
  }
  s.orders.push(order);
  return 'WORKING';
}
function monitor(s, at) {
  const price = mark(s.symbol, at),
    notices = [];
  for (const o of [...s.orders]) {
    if (o.symbol !== s.symbol || !orderTriggers(o, price)) continue;
    s.orders = s.orders.filter((v) => v.id !== o.id);
    const actual = estimate(o.qty, price);
    if (o.side === 'BUY' && portfolio(s, at).available < boundedUsd(actual.notional + actual.fee)) {
      notices.push('REJECTED · insufficient cash at trigger');
      continue;
    }
    fill(s, o, price, at);
    notices.push('FILLED · ' + o.side + ' ' + o.qty + ' ' + o.symbol);
  }
  return notices.join(' · ') || 'MONITORING';
}
// Synthetic practice is a closed replay inside the paper guard. It cannot reach an adapter,
// a signed account, provider credentials, or an externally selected price or clock.
export function practiceReplay({ store, scope, now = Date.now }) {
  need(
    scope?.environment === 'SIMULATE' &&
      scope.profile === 'practice' &&
      /^desk\/[0-9a-f]{64}$/.test(scope.account_alias),
    'ACCOUNT_BINDING'
  );
  const projection = (state) => ({ revision: state.revision, session: state.configs.practice ?? initial() });
  return {
    read: () => projection(store.read(scope)),
    apply(command, expectedRevision, requestId) {
      const c = boundedJson(command, 16000);
      need(
        Number.isSafeInteger(expectedRevision) &&
          expectedRevision >= 0 &&
          typeof requestId === 'string' &&
          /^[a-zA-Z0-9-]{12,64}$/.test(requestId),
        'INVALID_REQUEST'
      );
      need(
        c &&
          Object.hasOwn(commandFields, c.kind) &&
          Object.keys(c).every((k) => k === 'kind' || commandFields[c.kind].includes(k)),
        'UNSUPPORTED'
      );
      const key = 'practice:' + requestId,
        binding = sha([expectedRevision, c]);
      function replay(state) {
        const prior = state.checkpoints[key];
        if (!prior) return null;
        need(prior.binding === binding, 'CONFLICT');
        return { ...projection(state), receiptRevision: prior.revision, notice: prior.notice };
      }
      const previous = replay(store.read(scope));
      if (previous) return previous;
      try {
        return store.transaction(
          scope,
          (state) => {
            need(Object.keys(state.checkpoints).length < 10000, 'RECEIPT_CAPACITY');
            const s = state.configs.practice ?? initial(),
              at = now();
            let notice = 'SAVED';
            switch (c.kind) {
              case 'select':
                instrument(c.symbol);
                s.symbol = c.symbol;
                s.watch = [c.symbol, ...s.watch.filter((x) => x !== c.symbol)].slice(0, 20);
                break;
              case 'settings':
                need(
                  Object.hasOwn(frames, c.frame) &&
                    Array.isArray(c.studies) &&
                    c.studies.length <= 20 &&
                    c.studies.every((id) => Object.hasOwn(studies, id)) &&
                    typeof c.code === 'string' &&
                    c.code.length <= 8192,
                  'INVALID_SETTINGS'
                );
                s.frame = c.frame;
                s.studies = [...new Set(c.studies)];
                s.code = c.code;
                break;
              case 'order':
                need(c.symbol === s.symbol, 'SYMBOL_CHANGED');
                notice = place(s, c, at, requestId);
                break;
              case 'tick':
                need(c.symbol === s.symbol, 'SYMBOL_CHANGED');
                notice = monitor(s, at);
                break;
              case 'cancel':
                need(
                  s.orders.some((o) => o.id === c.id),
                  'UNKNOWN_ORDER'
                );
                s.orders = s.orders.filter((o) => o.id !== c.id);
                notice = 'CANCELLED';
                break;
              case 'funds':
                need(fits(c.amount, 1e8) && s.cash + c.amount <= 1e9 && boundedUsd(c.amount) > 0, 'INVALID_FUNDS');
                s.cash = boundedUsd(s.cash + c.amount);
                break;
              case 'reset':
                need(c.confirm === true, 'CONFIRM_RESET');
                Object.assign(s, initial());
                notice = 'RESET';
                break;
              case 'prediction':
                need(
                  c.symbol === s.symbol &&
                    ['up', 'down'].includes(c.direction) &&
                    Object.hasOwn(horizons, c.horizon) &&
                    Number.isInteger(c.confidence) &&
                    c.confidence >= 0 &&
                    c.confidence <= 100 &&
                    typeof c.note === 'string' &&
                    c.note.length <= 240,
                  'INVALID_PREDICTION'
                );
                need(s.predictions.length < 500, 'PREDICTION_CAPACITY');
                s.predictions.push({
                  id: requestId,
                  symbol: s.symbol,
                  at,
                  entry: mark(s.symbol, at),
                  direction: c.direction,
                  horizon: c.horizon,
                  confidence: c.confidence,
                  note: c.note,
                  source: SOURCE
                });
                break;
              default:
                throw Error('UNSUPPORTED');
            }
            if (['order', 'funds', 'tick'].includes(c.kind) && notice !== 'MONITORING') {
              s.samples.push({ at, equity: portfolio(s, at).equity });
              s.samples = s.samples.slice(-1000);
            }
            boundedJson(s, 480000);
            state.configs.practice = s;
            const revision = state.revision + 1;
            state.checkpoints[key] = { binding, revision, notice };
            return { revision, receiptRevision: revision, session: s, notice };
          },
          expectedRevision
        );
      } catch (error) {
        if (error.code === 'CONFLICT') {
          const retained = replay(store.read(scope));
          if (retained) return retained;
        }
        throw error;
      }
    }
  };
}
