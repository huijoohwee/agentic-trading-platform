// Curated moomoo market-desk rows projected from the captured $0 Desktop fixture
// (qualification/moomoo/desktop-mcp-capture.json). Prices/turnover/change_rate keep the exact
// round-trip decimal string of the provider JSON number; tick `sequence` exceeds 2^53 and is left
// opaque (not projected). test/provider-desk.test.mjs pins every row against the fixture so the
// desk cannot drift from the evidence. Read-only replay: no provider call, no order dispatch.
export const deskProvenance = {
  binding: 'desktop-mcp',
  fixture: 'qualification/moomoo/desktop-mcp-capture.json',
  captured_utc: '2026-11-23T23:17:44Z',
  symbol: 'HK.00700',
  market: 'HK',
  market_date: '2026-11-23',
  cost_usd: 0,
  operations: ['read.depth', 'read.tape', 'read.candles'],
  note: 'Moomoo-inspired read-only desk replayed from the captured entitled $0 Desktop reads. Depth, tape and candles are the provider rows as captured; currency, delay class and per-quote feed attribution remain unknown. No live feed, subscription or order operation is performed.'
};

export const deskDepth = {
  exchange: 'SEHK',
  ask: [
    { price: '344', volume: 272400, orders: 62 },
    { price: '344.2', volume: 96900, orders: 27 },
    { price: '344.4', volume: 123300, orders: 15 },
    { price: '344.6', volume: 132800, orders: 31 },
    { price: '344.8', volume: 75600, orders: 41 },
    { price: '345', volume: 112300, orders: 133 },
    { price: '345.2', volume: 83700, orders: 26 },
    { price: '345.4', volume: 7500, orders: 7 },
    { price: '345.6', volume: 83900, orders: 25 },
    { price: '345.8', volume: 70300, orders: 32 }
  ],
  bid: [
    { price: '343.8', volume: 41700, orders: 13 },
    { price: '343.6', volume: 30000, orders: 37 },
    { price: '343.4', volume: 78900, orders: 25 },
    { price: '343.2', volume: 59900, orders: 16 },
    { price: '343', volume: 92200, orders: 98 },
    { price: '342.8', volume: 90100, orders: 23 },
    { price: '342.6', volume: 29400, orders: 12 },
    { price: '342.4', volume: 18100, orders: 8 },
    { price: '342.2', volume: 23800, orders: 18 },
    { price: '342', volume: 84100, orders: 60 }
  ]
};

export const deskTape = [
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 1500, turnover: '516000', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 3300, turnover: '1135200', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 500, turnover: '172000', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 1100, turnover: '378400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 1400, turnover: '481600', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 300, turnover: '103200', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 200, turnover: '68800', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 1500, turnover: '516000', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 200, turnover: '68800', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 500, turnover: '172000', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 1200, turnover: '412800', direction: 'BUY', tick_type: 'AUTO_MATCH' },
  { time: 1795421300722, price: '344', volume: 100, turnover: '34400', direction: 'BUY', tick_type: 'AUTO_MATCH' }
];

export const deskCandles = [
  { date: '2026-11-17', time: 1794844800000, open: '386.6', high: '386.6', low: '376', close: '376', volume: 31401095, turnover: '11892584512', change_rate: '-3.6885245901639343' },
  { date: '2026-11-18', time: 1794931200000, open: '374', high: '378', low: '370', close: '372.8', volume: 21333340, turnover: '7956175438', change_rate: '-0.851063829787234' },
  { date: '2026-11-19', time: 1795017600000, open: '361.8', high: '365', low: '345', close: '348.4', volume: 76426269, turnover: '26816605631', change_rate: '-6.545064377682404' },
  { date: '2026-11-20', time: 1795104000000, open: '341', high: '349.6', low: '339.6', close: '344', volume: 41094469, turnover: '14089992865', change_rate: '-1.2629161882893225' },
  { date: '2026-11-23', time: 1795363200000, open: '335', high: '344.6', low: '333', close: '344', volume: 35289665, turnover: '11960782218', change_rate: '0' }
];