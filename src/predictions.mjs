import { mark } from './market.mjs';
export const horizons = {
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
  '1w': 604800000
};
export function assessPrediction(p, at) {
  const expires = p.at + horizons[p.horizon],
    price = mark(p.symbol, Math.min(at, expires)),
    move = 100 * (price / p.entry - 1);
  const correct = p.direction === 'up' ? price > p.entry : price < p.entry;
  return { price, move, expires, state: at < expires ? 'Tracking' : correct ? 'Correct' : 'Missed' };
}
