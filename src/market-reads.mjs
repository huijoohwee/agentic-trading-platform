import { history, instrument, quote, microstructure, searchCatalog, SOURCE } from './market.mjs';
import { utcMillis } from './rules.mjs';
import { studies, presets, indicatorVersion } from './indicators.mjs';
export const marketOperations = [
  'read.catalog',
  'read.candles',
  'read.ticker',
  'read.depth',
  'read.tape',
  'read.calendar',
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
    case 'read.calendar': {
      const market = inputs.market ?? 'US';
      const begin = inputs.begin_date ?? new Date(at).toISOString().slice(0, 10);
      const end = inputs.end_date ?? begin;
      const base = Date.parse(begin + 'T00:00:00Z'), last = Date.parse(end + 'T00:00:00Z');
      if (!Number.isFinite(base) || !Number.isFinite(last) || last < base || (last - base) / 86400000 > 6) throw Error('INVALID_PARAMETER');
      const sessions = ['BEFORE', 'AFTER', 'REGULAR'];
      rows = ['ALD', 'BIR', 'CED'].map((code, index) => {
        const day = new Date(Math.min(base + index * 86400000, last)).toISOString().slice(0, 10);
        const published = index === 0;
        return {
          code: market + '.' + code,
          name: 'Synthetic ' + code,
          earnings_date: day,
          earnings_timestamp: Date.parse(day + 'T13:30:00Z') * 1000,
          pub_type: sessions[index],
          period_text: '2026Q3',
          eps_actual: published ? 1.25 : null,
          eps_predict: 1.2 + index * 0.1,
          revenue_actual: published ? 1050000000 : null,
          revenue_predict: 1000000000 * (index + 1),
          price: (100 + index).toFixed(4),
          option_volume: String(1000 * (index + 1)),
          published
        };
      });
      break;
    }
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
