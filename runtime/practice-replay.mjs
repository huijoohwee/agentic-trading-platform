import { boundedJson, sha, requireThat as need } from './core.mjs';
import { valueAccount } from './practice-prices.mjs';
import { frames, instrument, mark, SOURCE } from '../src/market.mjs';
import { estimate, portfolio, settleFill, orderTriggers } from '../src/practice-account.mjs';
import { studies } from '../src/indicators.mjs';
import { initialPractice as initial } from '../src/practice-defaults.mjs';
import {
  accrueFunding,
  settleContract,
  contractChange,
  reservedExposure,
  accountKey,
  valuation
} from '../src/contracts.mjs';
import { horizons } from '../src/predictions.mjs';

const commandFields = {
  select: ['symbol', 'marketType', 'frame', 'venue'],
  studies: ['studies'],
  settings: ['frame', 'studies', 'code'],
  order: ['symbol', 'side', 'type', 'qty', 'trigger', 'marketType', 'leverage', 'reduceOnly', 'explicitIntent'],
  tick: ['symbol'],
  cancel: ['id', 'explicitIntent'],
  funds: ['amount', 'explicitIntent'],
  reset: ['confirm', 'explicitIntent'],
  prediction: ['symbol', 'direction', 'horizon', 'confidence', 'note', 'explicitIntent']
};
const fits = (v, max) => Number.isFinite(v) && v > 0 && v <= max;
const boundedUsd = (v) => Math.round(v * 1e6) / 1e6;

function fill(s, o, price, at) {
  const { fee } = estimate(o.qty, price);
  const derivative = o.marketType === 'perpetual';
  if (!derivative && o.side === 'BUY') checkSpotRisk(s, o.qty, price, at);
  const result = derivative ? settleContract(s, o, price, fee, at, portfolio(s, at)) : null;
  const closing = derivative
    ? result.pnl
    : settleFill(s, accountKey(o.venue, o.marketType, o.symbol), o.side, o.qty, price, fee);
  s.fees = boundedUsd(s.fees + fee);
  if (derivative ? result.closing > 0 : o.side === 'SELL') {
    s.closes++;
    if (closing - fee > 0) s.wins++;
  }
  s.fills.push({
    id: o.id,
    at,
    symbol: o.symbol,
    type: o.type,
    marketType: o.marketType ?? 'spot',
    side: o.side,
    qty: o.qty,
    price,
    fee,
    closing,
    venue: o.venue ?? 'synthetic',
    source: s.observedMarks?.[accountKey(o.venue, o.marketType, o.symbol)]?.source ?? SOURCE
  });
  s.fills = s.fills.slice(-1000);
}
function checkSpotRisk(session, quantity, price, at) {
  const totals = portfolio(session, at),
    { notional, fee } = estimate(quantity, price);
  need(totals.available >= boundedUsd(notional + fee), 'RESERVED_CASH');
  need(
    totals.assets + totals.contractExposure + reservedExposure(session) + notional <= 2 * (totals.equity - fee),
    'LEVERAGE_LIMIT'
  );
}
function place(s, c, at, id) {
  need(
    ['BUY', 'SELL'].includes(c.side) &&
      ['LIMIT', 'MARKET', 'STOP'].includes(c.type) &&
      fits(c.qty, 1e8) &&
      Math.abs(c.qty * 1e6 - Math.round(c.qty * 1e6)) < 0.00001,
    'INVALID_TICKET'
  );
  const key = accountKey(s.venue, s.marketType, s.symbol),
    last = valuation(s, key, at),
    trigger = c.type === 'MARKET' ? last : c.trigger;
  need(fits(trigger, 1e7) && s.orders.length < 200, 'INVALID_TRIGGER');
  const { notional, fee } = estimate(c.qty, trigger);
  const order = {
    id,
    venue: s.venue ?? 'synthetic',
    symbol: s.symbol,
    type: c.type,
    side: c.side,
    qty: c.qty,
    trigger,
    at,
    reserve: boundedUsd(notional + fee)
  };
  order.marketType = c.marketType ?? s.marketType;
  need(order.marketType === s.marketType, 'MARKET_CHANGED');
  if (order.marketType === 'perpetual') {
    order.leverage = c.leverage ?? 1;
    order.reduceOnly = c.reduceOnly ?? false;
    need([1, 2].includes(order.leverage) && typeof order.reduceOnly === 'boolean', 'INVALID_LEVERAGE');
    const change = contractChange(s, order, trigger);
    if (orderTriggers(order, last)) {
      fill(s, order, last, at);
      return 'FILLED';
    }
    const opening = order.qty - change.closing;
    order.reserve = boundedUsd((opening * trigger) / order.leverage + fee);
    const totals = portfolio(s, at);
    const gross = reservedExposure(s);
    need(
      !opening || totals.contractExposure + totals.assets + gross + opening * trigger <= 2 * (totals.equity - fee),
      'LEVERAGE_LIMIT'
    );
    need(!opening || totals.available >= order.reserve, 'RESERVED_MARGIN');
    s.orders.push(order);
    return 'WORKING';
  }
  need(!c.reduceOnly && (!c.leverage || c.leverage === 1), 'SPOT_ONLY');
  const held = s.positions[key]?.qty ?? 0,
    pending = s.orders
      .filter(
        (o) =>
          o.marketType !== 'perpetual' &&
          (o.venue ?? 'synthetic') === (s.venue ?? 'synthetic') &&
          o.symbol === s.symbol &&
          o.side === 'SELL'
      )
      .reduce((v, o) => v + o.qty, 0);
  const ready = orderTriggers(order, last);
  if (c.side === 'BUY') {
    checkSpotRisk(s, c.qty, ready ? last : trigger, at);
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
  const price = valuation(s, accountKey(s.venue, s.marketType, s.symbol), at),
    notices = [];
  for (const o of [...s.orders]) {
    if (
      (o.venue ?? 'synthetic') !== (s.venue ?? 'synthetic') ||
      o.symbol !== s.symbol ||
      (o.marketType ?? 'spot') !== s.marketType ||
      !orderTriggers(o, price)
    )
      continue;
    s.orders = s.orders.filter((v) => v.id !== o.id);
    const actual = estimate(o.qty, price);
    if (
      o.marketType !== 'perpetual' &&
      o.side === 'BUY' &&
      portfolio(s, at).available < boundedUsd(actual.notional + actual.fee)
    ) {
      notices.push('REJECTED · insufficient cash at trigger');
      continue;
    }
    try {
      fill(s, o, price, at);
    } catch (error) {
      if (!['RESERVED_MARGIN', 'LEVERAGE_LIMIT', 'REDUCE_ONLY'].includes(error.message)) throw error;
      notices.push('REJECTED · ' + error.message);
      continue;
    }
    notices.push('FILLED · ' + o.side + ' ' + o.qty + ' ' + o.symbol);
  }
  return notices.join(' · ') || 'MONITORING';
}
// Synthetic practice is a closed replay inside the paper guard. It cannot reach an adapter,
// a signed account, provider credentials, or an externally selected price or clock.
export function practiceReplay({ store, scope, now = Date.now, market }) {
  need(
    scope?.environment === 'SIMULATE' &&
      scope.profile === 'practice' &&
      /^desk\/[0-9a-f]{64}$/.test(scope.account_alias),
    'ACCOUNT_BINDING'
  );
  function migrate(saved) {
    if (!saved) return initial();
    if (saved.schema === 'practice-session/v2') return saved;
    need(saved.schema === 'practice-session/v1', 'STORAGE_VERSION');
    return { ...initial(), ...saved, schema: 'practice-session/v2' };
  }
  const projection = (state) => {
    const session = migrate(state.configs.practice);
    valueAccount(session, market, now());
    accrueFunding(session, now());
    return { revision: state.revision, session };
  };
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
            const s = migrate(state.configs.practice),
              at = now();
            if (['order', 'cancel', 'funds', 'reset', 'prediction'].includes(c.kind))
              need(c.explicitIntent === true, 'EXPLICIT_INTENT_REQUIRED');
            const trading = ['order', 'prediction', 'tick'].includes(c.kind);
            if (trading && s.venue && s.venue !== 'synthetic') need(market, 'HISTORICAL_MARKET_READ_ONLY');
            valueAccount(s, market, at, { effect: trading, selected: trading });
            accrueFunding(s, at);
            let notice = 'SAVED';
            switch (c.kind) {
              case 'select':
                const venue = c.venue ?? s.venue ?? 'synthetic';
                need(typeof venue === 'string' && /^[a-z0-9-]{1,45}$/.test(venue), 'UNKNOWN_VENUE');
                if (venue === 'synthetic') instrument(c.symbol);
                else need(/^[A-Z0-9]+\.[A-Z0-9]+$/.test(c.symbol), 'UNKNOWN_INSTRUMENT');
                s.venue = venue;
                if (c.marketType !== undefined) {
                  need(['spot', 'perpetual'].includes(c.marketType), 'INVALID_MARKET_TYPE');
                  s.marketType = c.marketType;
                }
                if (c.frame !== undefined) {
                  need(Object.hasOwn(frames, c.frame), 'UNKNOWN_TIMEFRAME');
                  s.frame = c.frame;
                }
                s.symbol = c.symbol;
                s.watch = [c.symbol, ...s.watch.filter((x) => x !== c.symbol)].slice(0, 20);
                break;
              case 'studies':
                need(
                  Array.isArray(c.studies) &&
                    c.studies.length <= 20 &&
                    c.studies.every((id) => Object.hasOwn(studies, id)),
                  'INVALID_SETTINGS'
                );
                s.studies = [...new Set(c.studies)];
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
                need(c.confirm === 'RESET PAPER SESSION', 'CONFIRM_RESET');
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
                  venue: s.venue ?? 'synthetic',
                  marketType: s.marketType,
                  entry: valuation(s, accountKey(s.venue, s.marketType, s.symbol), at),
                  direction: c.direction,
                  horizon: c.horizon,
                  confidence: c.confidence,
                  note: c.note,
                  source: s.observedMarks?.[accountKey(s.venue, s.marketType, s.symbol)]?.source ?? SOURCE
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
