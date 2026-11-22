const rows = [
  ['Trend crossover', 'BTC', 'perpetual', '1h', []],
  ['Volatility compression breakout', 'BTC', 'perpetual', '4h', []],
  ['Trend pullback', 'ETH', 'perpetual', '1h', []],
  ['Seven-day retest', 'SOL', 'perpetual', '1h', []],
  ['Volatility squeeze', 'ETH', 'perpetual', '30m', []],
  ['UTC VWAP reversion', 'BTC', 'perpetual', '5m', []],
  ['Prior-day liquidity sweep', 'ETH', 'perpetual', '15m', []],
  ['Short-period RSI', 'BTC', 'spot', '1d', []],
  ['UTC opening range', 'BTC', 'perpetual', '15m', []],
  ['Funding capitulation', 'BTC', 'perpetual', '1h', ['funding', 'openInterest']],
  ['Crowded breakdown', 'ETH', 'perpetual', '4h', ['funding', 'openInterest']],
  ['Matched spot and perpetual carry', 'BTC', 'perpetual', '1h', ['spot', 'funding', 'liquidity']],
  ['ETH/BTC residual reversion', 'ETH', 'perpetual', '4h', ['BTC']],
  ['Cross-sectional momentum', 'BTC', 'perpetual', '1d', ['universe20']],
  ['Cross-asset liquidation reversal', 'BTC', 'perpetual', '1h', ['liquidations', 'openInterest', 'universe10']],
  ['BTC impulse and lag', 'BTC', 'perpetual', '5m', ['ETH', 'SOL']],
  ['Queue imbalance', 'BTC', 'perpetual', '1m', ['depth', 'trades']],
  ['Aggressor-volume divergence', 'BTC', 'perpetual', '1m', ['taker', 'openInterest']],
  ['Monthly spot rotation', 'BTC', 'spot', '1d', ['ETH', 'SOL']],
  ['Delta-hedged options premium', 'BTC', 'spot', '1d', ['options']]
];
export const hypotheses = rows.map(([name, base, marketType, frame, additional], i) => ({
  id: i + 1,
  version: 1,
  name,
  base,
  marketType,
  frame,
  requires: ['ohlcv', ...additional]
}));
