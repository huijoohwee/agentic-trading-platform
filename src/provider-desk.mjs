import {
  replayMoomooQuote, replayMoomooOrderBook, replayMoomooTicker, replayMoomooKline
} from 'agentic-gateway/connectors/moomoo';
import capture from '../qualification/moomoo/desktop-mcp-capture.json' with { type: 'json' };

// The build seals only the chart rows. Desktop returned MCP responses; the
// documented frame envelopes below are local inputs to Gateway's replay API.
export function projectDesktopDesk(fixture) {
  const { provenance, calls } = fixture;
  const { symbol, binding, captured_utc, market, market_date, cost_usd } = provenance;
  if (fixture.schema !== 'trading-moomoo-desktop-capture/v1' || binding !== 'desktop-mcp' ||
      provenance.hosted_n3 !== false || cost_usd !== 0) throw Error('DESK_CAPTURE_REQUIRED');
  const read = (name, parameter) => {
    const call = calls[name];
    const arg = call?.arguments?.[parameter];
    const matches = parameter === 'code_list'
      ? Array.isArray(arg) && arg.length === 1 && arg[0] === symbol : arg === symbol;
    if (!matches) throw Error('DESK_SYMBOL_MISMATCH');
    if (call.isError || call.structuredContent?.ret_code !== 0) throw Error('DESK_PROVIDER_REFUSED');
    return call.structuredContent.data;
  };
  const quotes = read('quote_stock_quote', 'code_list').quote_list;
  const books = read('quote_order_book', 'code');
  const tape = read('quote_rt_ticker', 'symbol');
  const klines = read('quote_cur_kline', 'symbol').kline_list;
  if (quotes?.length !== 1 || quotes[0].code !== symbol || quotes[0].data_date !== market_date ||
      books?.length !== 1 || books[0].code !== symbol || books[0].books?.length !== 1 ||
      tape.code !== symbol || !Array.isArray(klines) || klines.some(row => row.code !== symbol)) {
    throw Error('DESK_CAPTURE_MISMATCH');
  }
  const klineArgs = calls.quote_cur_kline.arguments;
  const schema = fixture.tools.find(tool => tool.name === 'quote_cur_kline')?.inputSchema.properties;
  if ((klineArgs.ktype ?? schema?.ktype?.default) !== 2 ||
      (klineArgs.autype ?? schema?.autype?.default) !== 1) throw Error('DESK_KLINE_DIMENSION');

  const frame = (type, data) => ({ type, symbol, data });
  const quote = quotes[0];
  const price = replayMoomooQuote(symbol, frame('QUOTE', { ...quote, data_time_ms: quote.data_time }));
  const book = books[0].books[0];
  const depth = replayMoomooOrderBook(symbol, frame('ORDER_BOOK', {
    bid_list: book.bid_list, ask_list: book.ask_list, data_time_ms: book.exchange_data_time_ms
  }));
  const { ticks } = replayMoomooTicker(symbol, frame('TICKER', {
    ticker_list: tape.ticker_list.map(row => ({
      price: row.price, volume: row.volume, turnover: row.turnover,
      direction: row.ticker_direction, time_ms: row.time
    }))
  }));
  const { bars } = replayMoomooKline(symbol, frame('KLINE', {
    period: '1D', adjust: 'forward_exclude_dividend',
    kl_list: klines.map(row => ({ ...row, time_ms: row.time_key }))
  }));
  const levels = side => side.map(({ price, volume, orderCount }) => ({ price, volume, orders: orderCount }));
  const epoch = utc => utc === null ? null : Date.parse(utc);
  return {
    deskProvenance: {
      binding, captured_utc, symbol, market, market_date, cost_usd,
      fixture: 'qualification/moomoo/desktop-mcp-capture.json',
      operations: ['read.ticker', 'read.depth', 'read.tape', 'read.candles'],
      note: 'Gateway replay of the saved Desktop quote, order book, trades and daily candles. Currency, delay and feed attribution are unknown.'
    },
    deskQuote: { name: quote.name, symbol, market, market_date, last: price.last, prev_close: price.previousClose,
      open: price.open, high: price.high, low: price.low, volume: price.volume, turnover: price.turnover,
      marketTimeUtc: price.marketTimeUtc },
    deskDepth: { exchange: book.exchange, ask: levels(depth.asks), bid: levels(depth.bids) },
    deskTape: ticks.map((tick, index) => ({
      time: epoch(tick.marketTimeUtc), price: tick.price, volume: tick.volume,
      turnover: tick.turnover, direction: tick.direction, tick_type: tape.ticker_list[index].tick_type
    })),
    deskCandles: bars.map((bar, index) => {
      const row = klines[index];
      const date = String(row.date).match(/^(\d{4})(\d{2})(\d{2})$/);
      if (!date || (row.change_rate != null && !Number.isFinite(row.change_rate))) throw Error('DESK_KLINE_FIELDS');
      return {
        date: date.slice(1).join('-'), time: epoch(bar.marketTimeUtc),
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, turnover: bar.turnover, change_rate: row.change_rate == null ? null : String(row.change_rate)
      };
    })
  };
}

export const { deskProvenance, deskQuote, deskDepth, deskTape, deskCandles } = projectDesktopDesk(capture);
