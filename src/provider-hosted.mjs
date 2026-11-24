import { captureMapping } from './provider-capture.mjs';

// The hosted quote_stock_quote descriptor is byte-identical to the reviewed Desktop pin, so the
// reviewed read.ticker mapping binds the hosted OAuth read unchanged; N3 qualifies only that one op.
export const hostedProvenance = {
  binding: 'hosted-mcp',
  host: 'https://mcp.moomoo.com/mcp (hosted moomoo MCP, OAuth 2.1)',
  scope: 'quote:read',
  captured_utc: '2026-11-24T00:32:42Z',
  symbol: 'HK.00700',
  market: 'HK',
  market_date: '2026-11-23',
  cost_usd: 0,
  hosted_n3: true,
  note: 'One real entitled $0 read.ticker captured through the hosted moomoo MCP OAuth binding (N3). Credentials remain with the host; no token is stored or forwarded. Replay uses the captured fixture with zero extra provider calls. Currency, delay class and per-quote feed attribution remain unknown.'
};

export const hostedMapping = {
  protocol: captureMapping.protocol,
  operations: { 'read.ticker': captureMapping.operations['read.ticker'] }
};

export const hostedOperations = ['read.ticker'];

export const hostedSummary = {
  symbol: 'HK.00700', name: 'TENCENT', market: 'HK', market_date: '2026-11-23',
  last: 344, prev_close: 344, open: 335, high: 344.6, low: 333,
  volume: 35289665, turnover: 11960782218, data_time: 1795421270000,
  unknowns: ['currency', 'delay class', 'per-quote feed attribution']
};