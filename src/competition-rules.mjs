import { evaluateFreshness, utcMillis } from './rules.mjs';

// Money in the ledger is integral millionths of a USD. Prices in the tape are USD.
export const MICRO = 1_000_000;
export const INITIAL = 100_000 * MICRO;
export const POLICY = 'moomoo-paper/rehearsal-1';
export const EVALUATOR = 'trading-replay/1';
export const positive = value => Number.isFinite(value) && value > 0;
const units = n => Number.isSafeInteger(n) && n >= 0;
export function dollars(value) {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * MICRO))) throw Error('Invalid USD amount');
  return Math.round(value * MICRO);
}

const eastern = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function marketTime(at) {
  if (utcMillis(at) === null) throw Error('Invalid market timestamp');
  const parts = Object.fromEntries(eastern.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { day: [parts.year, parts.month, parts.day].join('-'), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function eligibility(instrument, price, at, calendar) {
  const { day, minute } = marketTime(at);
  if (!instrument || !instrument.listing || !instrument.kind) return 'UNKNOWN_INSTRUMENT';
  if (instrument.listing !== 'US' || !['STOCK','ETF','OPTION'].includes(instrument.kind)) return 'INELIGIBLE';
  const session = calendar[day];
  if (!session || !instrument.session) return 'UNKNOWN_SESSION';
  const regular = instrument.session === 'regular';
  if (!regular && instrument.session !== 'extended') return 'UNKNOWN_SESSION';
  const open = Math.max(240, regular ? session.open : session.early);
  const close = Math.min(1200, regular ? session.close : session.late);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return 'UNKNOWN_SESSION';
  if (minute < open || minute >= close) return 'OUT_OF_SESSION';
  if (!positive(price)) return 'UNKNOWN_PRICE';
  if (instrument.kind === 'ETF') return instrument.fund === true ? 'PASS' : 'UNKNOWN_FUND';
  if (instrument.kind === 'STOCK' && price < 1) return 'PRICE_FLOOR';
  if (!positive(instrument.cap)) return 'UNKNOWN_CAP';
  if (instrument.cap < 500_000_000) return 'CAP_FLOOR';
  if (instrument.kind === 'OPTION' && (!Number.isSafeInteger(instrument.multiplier) || instrument.multiplier <= 0 ||
    !instrument.underlying || !instrument.expiry || !positive(instrument.strike) ||
    !['CALL','PUT'].includes(instrument.right))) return 'UNKNOWN_CONTRACT';
  return 'PASS';
}

// Counts include working reservations. A partial fill consumes its order ID once.
export function capacity({ dailyOrders, positionCount, held, pending, equity, liquidity, riskHalt }, order, asset) {
  const { side, effect, qty, limit } = order;
  if (!['BUY','SELL'].includes(side) || !['OPEN','CLOSE'].includes(effect) ||
      !units(qty) || qty === 0 || !positive(limit) || !Number.isSafeInteger(held) || !units(pending) ||
      !units(dailyOrders) || !units(positionCount)) return 'UNKNOWN_ORDER';
  if (dailyOrders >= 200) return 'DAILY_CAP';
  if (effect === 'CLOSE') {
    const correctSide = held > 0 ? side === 'SELL' : side === 'BUY';
    return correctSide && qty + pending <= Math.abs(held) ? 'PASS' : 'CLOSE_EXCEEDS_HELD';
  }
  if (riskHalt) return 'RISK_HALT';
  if ((held < 0 && side === 'BUY') || (held > 0 && side === 'SELL')) return 'EFFECT_MISMATCH';
  if (!held && !pending && positionCount >= 100) return 'POSITION_CAP';
  const projected = Math.abs(held) + pending + qty;
  if (asset.kind === 'OPTION' && projected > 1000) return 'CONTRACT_CAP';
  if (asset.kind === 'OPTION' && side === 'SELL') return 'UNKNOWN_OPTION_MARGIN';
  if (!positive(equity) || !Number.isFinite(liquidity)) return 'UNKNOWN_BUYING_POWER';
  if (asset.kind !== 'OPTION') {
    if (!positive(order.mark)) return 'UNKNOWN_PRICE';
    const projectedValue = Math.abs(held) * order.mark + pending * Math.max(order.mark, order.reservedPrice ?? limit) +
      qty * Math.max(order.mark, limit);
    if (!Number.isFinite(projectedValue)) return 'UNKNOWN_PRICE';
    if (projectedValue > INITIAL / MICRO * 0.4) return 'INITIAL_CONCENTRATION';
    if (projectedValue > equity * 0.4) return 'CURRENT_CONCENTRATION';
  }
  const requirement = asset.kind === 'OPTION' ? qty * limit * asset.multiplier : margin(qty * limit, side, 'initial');
  return requirement <= liquidity ? 'PASS' : 'INSUFFICIENT_LIQUIDITY';
}

export function margin(value, side, phase) {
  if (!Number.isFinite(value) || value < 0 || !['BUY','SELL'].includes(side) ||
      !['initial','maintenance'].includes(phase)) throw Error('Unknown margin inputs');
  const rates = side === 'BUY' ? { initial: 0.50, maintenance: 0.40 } : { initial: 0.60, maintenance: 0.50 };
  return value * rates[phase];
}
export function interestMicros(financed, borrowed, daysPerYear) {
  if (![financed, borrowed].every(n => Number.isFinite(n) && n >= 0) || !positive(daysPerYear)) return null;
  return dollars((financed * 0.048 + borrowed * 0.060) / daysPerYear);
}

// Commission floors and stock platform fees are per order. Activity is per trade.
export function feeMicros(asset, side, qty, price, charged = { contracts: 0, fills: 0 }) {
  if (!units(qty) || qty === 0 || !positive(price) || !['BUY','SELL'].includes(side)) throw Error('Invalid fee inputs');
  if (asset.kind === 'OPTION') {
    const variable = qty * (price > 0.10 ? 650000 : 150000);
    return { amount: Math.max(1990000, charged.contracts + variable) -
      (charged.fills ? Math.max(1990000, charged.contracts) : 0) + qty * 317790, variable };
  }
  if (asset.kind !== 'STOCK' && !(asset.kind === 'ETF' && asset.stockFees === true)) throw Error('Unknown fee classification');
  return { amount: (charged.fills ? 0 : 990000) + (side === 'SELL' ? Math.min(8300000, qty * 166) : 0), variable: 0 };
}
export function volumeEvidence(volume, qty) {
  if (!units(volume) || !units(qty) || !qty) return 'UNKNOWN_VOLUME';
  return volume * 20 < qty ? 'PARTIAL_POSSIBLE' : 'AWAIT_FILL';
}
export function limitEvidence(side, limit, executionPrice) {
  if (!positive(executionPrice)) return 'UNKNOWN_FILL_PRICE';
  return (side === 'BUY' ? executionPrice <= limit : executionPrice >= limit) ? 'AT_LIMIT_OR_BETTER' : 'OFF_LIMIT';
}
export function expiryOutcome(asset, mark, funded) {
  if (!positive(mark) || !['CALL','PUT'].includes(asset?.right) || !positive(asset.strike)) return 'UNKNOWN_EXPIRY';
  const intrinsic = (mark - asset.strike) * (asset.right === 'CALL' ? 1 : -1);
  if (intrinsic < 0) return 'WORTHLESS';
  if (intrinsic === 0 || typeof funded !== 'boolean') return 'READBACK_REQUIRED';
  return funded ? 'EXERCISE' : 'PARTIAL_OR_LIQUIDATION';
}

export function research(signal, at) {
  const freshness = evaluateFreshness(signal.quote, { maxAgeMinutes: 5 }, at);
  if (freshness.state !== 'PASS') return freshness.reason;
  if (!positive(signal.priorHigh) || !Array.isArray(signal.closes) || signal.closes.length !== 2 ||
      !signal.closes.every(positive)) return 'UNKNOWN_BARS';
  if (!['ENTRY','EXIT'].includes(signal.action)) return 'UNKNOWN_SIGNAL';
  if (signal.action === 'EXIT') return signal.closes.at(-1) <= signal.priorHigh ? 'CANDIDATE' : 'NO_TRADE';
  return signal.closes.every(close => close > signal.priorHigh) ? 'CANDIDATE' : 'NO_TRADE';
}
