import { mark } from './market.mjs';

export const roundCash = (n) => Math.round(n * 1e6) / 1e6;
export const accountKey = (venue, type, symbol) =>
  !venue || venue === 'synthetic' ? symbol : [venue, type ?? 'spot', symbol].join('/');
export function valuation(session, key, at) {
  if (!key.includes('/')) return mark(key, at);
  const value = session.observedMarks?.[key]?.price;
  if (!Number.isFinite(value) || value <= 0) throw Error('MARK_UNAVAILABLE');
  return value;
}
const interval = 8 * 3600000;
export function contractRisk(session, at) {
  let margin = 0,
    exposure = 0,
    pnl = 0;
  const holdings = [];
  for (const [symbol, position] of Object.entries(session.contracts ?? {})) {
    const price = valuation(session, symbol, at),
      open = roundCash((price - position.average) * position.quantity);
    const value = roundCash(Math.abs(price * position.quantity));
    margin += value / position.leverage;
    exposure += value;
    pnl += open;
    holdings.push({
      symbol: symbol.split('/').at(-1),
      venue: symbol.includes('/') ? symbol.split('/')[0] : 'synthetic',
      marketType: 'perpetual',
      quantity: position.quantity,
      average: position.average,
      mark: price,
      value,
      open,
      leverage: position.leverage
    });
  }
  return { margin: roundCash(margin), exposure: roundCash(exposure), pnl: roundCash(pnl), holdings };
}

// The replay venue settles its fixed funding rate on eight-hour UTC boundaries.
export function accrueFunding(session, at) {
  const through = Math.floor(at / interval) * interval;
  for (const [symbol, position] of Object.entries(session.contracts ?? {})) {
    if (symbol.includes('/')) {
      const obs = session.observedMarks?.[symbol];
      if (obs && !obs.stale) {
        for (const f of obs.payments ?? [])
          if (f.time > position.fundedThrough) {
            const payment = roundCash(-position.quantity * f.price * f.rate);
            session.cash = roundCash(session.cash + payment);
            session.realized = roundCash(session.realized + payment);
            session.fundingTotal = roundCash(session.fundingTotal + payment);
            session.funding.push({ symbol, at: f.time, price: f.price, rate: f.rate, payment });
          }
        position.fundedThrough = Math.max(position.fundedThrough, obs.fundedThrough ?? position.fundedThrough);
      }
      continue;
    }
    if (through - position.fundedThrough > 10000 * interval) throw Error('FUNDING_RECOVERY_REQUIRED');
    for (let time = position.fundedThrough + interval; time <= through; time += interval) {
      const price = mark(symbol, time),
        rate = 0.0001;
      const payment = roundCash(-position.quantity * price * rate);
      session.cash = roundCash(session.cash + payment);
      session.realized = roundCash(session.realized + payment);
      session.fundingTotal = roundCash(session.fundingTotal + payment);
      session.funding.push({ symbol, at: time, price, rate, payment });
    }
    position.fundedThrough = Math.max(through, position.fundedThrough);
  }
  session.funding = session.funding.slice(-1000);
}
export function contractChange(session, order, price) {
  const prior = session.contracts[accountKey(order.venue, order.marketType, order.symbol)],
    held = prior?.quantity ?? 0;
  const delta = order.qty * (order.side === 'BUY' ? 1 : -1);
  const next = roundCash(held + delta);
  const closing = held * delta < 0 ? Math.min(Math.abs(held), order.qty) : 0;
  if (order.reduceOnly && closing !== order.qty) throw Error('REDUCE_ONLY');
  const pnl = roundCash(closing * Math.sign(held) * (price - (prior?.average ?? price)));
  const average =
    !held || held * next < 0
      ? price
      : closing
        ? prior.average
        : (Math.abs(held) * prior.average + order.qty * price) / Math.abs(next);
  let leverage = order.leverage;
  if (closing && held * next > 0) leverage = prior.leverage;
  else if (held * delta > 0)
    leverage = Math.abs(next) / (Math.abs(held) / prior.leverage + order.qty / order.leverage);
  return { next, average, leverage, pnl, closing, held };
}
export function reservedExposure(session) {
  return session.orders.reduce((sum, order) => {
    if (order.marketType === 'perpetual') return sum + (order.reduceOnly ? 0 : order.qty * order.trigger);
    return sum + (order.side === 'BUY' ? order.qty * order.trigger : 0);
  }, 0);
}
export function settleContract(session, order, price, fee, at, totals) {
  const key = accountKey(order.venue, order.marketType, order.symbol);
  const { next, average, leverage, pnl, closing, held } = contractChange(session, order, price);
  const reservedGross = reservedExposure(session);
  const gross = totals.assets + totals.contractExposure - Math.abs(held * price) + Math.abs(next * price);
  const oldMargin = held ? Math.abs(held * price) / session.contracts[key].leverage : 0;
  const newMargin = Math.abs(next * price) / leverage;
  if (Math.abs(next) > Math.abs(held) || held * next < 0) {
    if (gross + reservedGross > 2 * (totals.equity - fee)) throw Error('LEVERAGE_LIMIT');
    if (totals.available + oldMargin < newMargin + fee) throw Error('RESERVED_MARGIN');
  }
  session.cash = roundCash(session.cash + pnl - fee);
  session.realized = roundCash(session.realized + pnl - fee);
  if (!next) delete session.contracts[key];
  else
    session.contracts[key] = {
      quantity: next,
      average,
      leverage,
      fundedThrough: key.includes('/') ? session.observedMarks[key].at : Math.floor(at / interval) * interval
    };
  return { pnl, closing };
}
