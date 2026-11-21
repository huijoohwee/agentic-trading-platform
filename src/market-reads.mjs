import { history, quote, microstructure, searchCatalog, SOURCE } from './market.mjs';
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
    case 'read.ticker':
      rows = quote(symbol, at);
      break;
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
  return { source: SOURCE, at, rows };
}
