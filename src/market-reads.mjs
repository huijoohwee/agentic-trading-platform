import { history, instrument, quote, microstructure, searchCatalog, SOURCE } from './market.mjs';
import { utcMillis } from './rules.mjs';
import { studies, presets, indicatorVersion } from './indicators.mjs';
export const marketOperations = [
  'read.catalog',
  'read.candles',
  'read.ticker',
  'read.depth',
  'read.tape',
  'read.studies'
];
export function marketRead(operation, inputs, at) {
  const { symbol, frame, count, query } = inputs;
  let rows;
  switch (operation) {
    case 'read.catalog':
      rows = searchCatalog(query);
      break;
    case 'read.candles':
      rows = history(symbol, frame, at, count);
      break;
    case 'read.ticker': {
      const marketTime = Object.hasOwn(inputs, 'fixture_market_utc') ? utcMillis(inputs.fixture_market_utc) : at;
      if (marketTime === null || marketTime > at) throw Error('INVALID_MARKET_TIME');
      const tick = quote(symbol, marketTime);
      rows = {
        ...tick,
        last_decimal: tick.last.toFixed(4),
        currency: instrument(symbol).currency,
        market_time_utc: new Date(tick.at).toISOString(),
        observed_utc: new Date(at).toISOString(),
        delay_class: 'unknown'
      };
      break;
    }
    case 'read.depth': {
      const { tape, ...book } = microstructure(symbol, at);
      rows = book;
      break;
    }
    case 'read.tape':
      rows = microstructure(symbol, at).tape;
      break;
    case 'read.studies':
      rows = { version: indicatorVersion, studies, presets };
      break;
    default:
      throw Error('UNSUPPORTED');
  }
  return {
    source: SOURCE,
    at,
    rows,
    market: {
      venue: 'synthetic',
      symbol: symbol ?? null,
      marketType: inputs.marketType ?? 'spot',
      frame: frame ?? null
    }
  };
}
