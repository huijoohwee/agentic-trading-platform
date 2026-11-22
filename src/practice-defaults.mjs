import { catalog, SOURCE } from './market.mjs';
import { example } from './strategy-example.mjs';

export const initialPractice = () => ({
  schema: 'practice-session/v2',
  marketType: 'spot',
  venue: 'synthetic',
  contracts: {},
  funding: [],
  fundingTotal: 0,
  source: SOURCE,
  watch: [catalog[0].symbol],
  symbol: catalog[0].symbol,
  frame: '5m',
  studies: ['volume', 'ema20', 'rsi'],
  code: example,
  cash: 100000,
  realized: 0,
  fees: 0,
  wins: 0,
  closes: 0,
  positions: {},
  orders: [],
  fills: [],
  samples: [],
  predictions: []
});
