import { dollars, MICRO } from './competition-rules.mjs';
import { contractRisk, valuation } from './contracts.mjs';
import { mark, SOURCE } from './market.mjs';

export function orderTriggers(order, price) {
  if (order.type === 'MARKET') return true;
  const below = order.type === 'LIMIT' ? order.side === 'BUY' : order.side === 'SELL';
  return below ? price <= order.trigger : price >= order.trigger;
}

export const feeRate = 0.001;
const money = (value) => dollars(value) / MICRO;
export function estimate(qty, price) {
  const notional = money(qty * price);
  return { notional, fee: money(notional * feeRate) };
}
// Shared by the local broker and the deterministic practice replay.
export function settleFill(account, symbol, side, qty, price, fee) {
  if (
    !['BUY', 'SELL'].includes(side) ||
    ![qty, price].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isFinite(fee) ||
    fee < 0
  )
    throw Error('INVALID_FILL');
  const p = account.positions[symbol] ?? { qty: 0, avg_cost: 0 },
    notional = money(qty * price);
  if (side === 'BUY' && account.cash < money(notional + fee)) throw Error('RESERVED_CASH');
  if (side === 'SELL' && p.qty < qty) throw Error('CLOSE_EXCEEDS_HELD');
  const closing = side === 'SELL' ? money((price - p.avg_cost) * qty) : 0;
  const next = money(p.qty + (side === 'BUY' ? qty : -qty));
  const avg_cost = side === 'BUY' ? (p.qty * p.avg_cost + notional) / next : p.avg_cost;
  account.cash = money(account.cash + (side === 'BUY' ? -notional : notional) - fee);
  account.realized = money(account.realized + closing - fee);
  account.positions[symbol] = { qty: next, avg_cost: next ? avg_cost : 0 };
  return closing;
}
export function portfolio(account, at) {
  let value = 0,
    unrealized = 0;
  const holdings = Object.entries(account.positions)
    .filter(([, p]) => p.qty > 0)
    .map(([symbol, p]) => {
      const price = valuation(account, symbol, at),
        marketValue = money(p.qty * price),
        open = money((price - p.avg_cost) * p.qty);
      value += marketValue;
      unrealized += open;
      return {
        symbol: symbol.split('/').at(-1),
        venue: symbol.includes('/') ? symbol.split('/')[0] : 'synthetic',
        marketType: 'spot',
        quantity: p.qty,
        average: p.avg_cost,
        mark: price,
        value: marketValue,
        open
      };
    });
  const risk = contractRisk(account, at);
  const reserved = account.orders
    .filter((o) => o.marketType === 'perpetual' || o.side === 'BUY')
    .reduce((s, o) => s + o.reserve, 0);
  unrealized += risk.pnl;
  return {
    holdings: [...holdings, ...risk.holdings],
    contractExposure: risk.exposure,
    margin: risk.margin,
    funding: account.fundingTotal ?? 0,
    source: SOURCE,
    at,
    equity: money(account.cash + value + risk.pnl),
    available: money(account.cash + Math.min(0, risk.pnl) - reserved - risk.margin),
    cash: account.cash,
    assets: money(value),
    realized: account.realized,
    unrealized: money(unrealized),
    total: money(unrealized + account.realized),
    fees: account.fees,
    winRate: account.closes ? account.wins / account.closes : null
  };
}
export const journalHeaders = [
  'Time UTC',
  'Instrument',
  'Side',
  'Order type',
  'Quantity',
  'Price USD',
  'Fee USD',
  'Realized before fee USD',
  'Execution source'
];
export const journalRecords = (fills) =>
  fills.map((f) => ({
    id: f.id,
    values: [new Date(f.at).toISOString(), f.symbol, f.side, f.type, f.qty, f.price, f.fee, f.closing, f.source]
  }));
export function journalCsv(fills) {
  return (
    [journalHeaders, ...journalRecords(fills).map((r) => r.values)]
      .map((row) => row.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(','))
      .join('\r\n') + '\r\n'
  );
}
