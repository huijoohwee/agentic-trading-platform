// Evidence-led moomoo Desktop capture surface. The reviewed mapping binds four native read-only
// operations to the captured $0 Desktop reads; the display summary is a curated projection that the
// conformance test pins against the captured fixture so the dashboard cannot drift from the evidence.
// This is Desktop-binding evidence (desktop-mcp), distinct from the hosted OAuth milestone (N3).
export const captureProvenance = {
  binding: 'desktop-mcp',
  host: 'mcp://moomoo (Qoder Desktop binding, OpenD-backed)',
  captured_utc: '2026-11-23T23:17:44Z',
  symbol: 'HK.00700',
  market: 'HK',
  market_date: '2026-11-23',
  cost_usd: 0,
  hosted_n3: false,
  note: 'Real entitled $0 reads captured through the available Desktop moomoo binding. The hosted https://mcp.moomoo.com/mcp OAuth milestone (N3) remains open and requires separate qualification. Prices are JSON numbers; the reviewed projection records their exact round-trip decimal string.'
};

export const captureMapping = {
  protocol: '2025-11-25',
  operations: {
    'read.ticker': {
      tool: 'quote_stock_quote', input_map: { code_list: 'symbol' }, array_parameters: ['code_list'],
      rows_path: ['data', 'quote_list'],
      fields: {
        symbol: { path: ['code'] }, name: { path: ['name'] }, market_date: { path: ['data_date'] },
        last: { path: ['last_price'] }, prev_close: { path: ['prev_close_price'] }, open: { path: ['open_price'] },
        high: { path: ['high_price'] }, low: { path: ['low_price'] }, volume: { path: ['volume'] },
        turnover: { path: ['turnover'] }, data_time: { path: ['data_time'] }
      },
      numeric: ['last', 'prev_close', 'open', 'high', 'low', 'volume', 'turnover', 'data_time']
    },
    'read.depth': {
      tool: 'quote_order_book', input_map: { code: 'symbol', num: 'count' }, rows_path: ['data'],
      fields: {
        symbol: { path: ['code'] }, name: { path: ['name'] }, exchange: { path: ['books', '0', 'exchange'] },
        bids: { path: ['books', '0', 'bid_list'] }, asks: { path: ['books', '0', 'ask_list'] }
      }
    },
    'read.tape': {
      tool: 'quote_rt_ticker', input_map: { symbol: 'symbol', num: 'count' }, rows_path: ['data', 'ticker_list'],
      fields: {
        price: { path: ['price'] }, volume: { path: ['volume'] }, turnover: { path: ['turnover'] },
        direction: { path: ['ticker_direction'] }, time: { path: ['time'] }, tick_type: { path: ['tick_type'] }
      },
      numeric: ['price', 'volume', 'turnover', 'time']
    },
    'read.candles': {
      tool: 'quote_cur_kline', input_map: { symbol: 'symbol', num: 'count', ktype: 'ktype' },
      parameters: { autype: 1 }, rows_path: ['data', 'kline_list'],
      fields: {
        time: { path: ['time_key'] }, open: { path: ['open_price'] }, high: { path: ['high_price'] },
        low: { path: ['low_price'] }, close: { path: ['close_price'] }, volume: { path: ['volume'] },
        turnover: { path: ['turnover'] }
      },
      numeric: ['time', 'open', 'high', 'low', 'close', 'volume', 'turnover']
    }
  }
};

export const captureOperations = ['read.ticker', 'read.depth', 'read.tape', 'read.candles'];

export const captureSummary = {
  symbol: 'HK.00700', name: 'TENCENT', market: 'HK', market_date: '2026-11-23',
  last: 344, prev_close: 344, open: 335, high: 344.6, low: 333,
  volume: 35289665, turnover: 11960782218, data_time: 1795421270000,
  depth_levels: 10, tape_ticks: 20, candle_count: 5, candle_last_close: 344,
  unknowns: ['currency', 'delay class', 'per-quote feed attribution', 'hosted OAuth qualification (N3)']
};