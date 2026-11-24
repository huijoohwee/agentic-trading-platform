import { researchTools } from './moomoo-research-tools.mjs';
import { captureMapping } from './provider-capture.mjs';
// Evidence-led moomoo OpenAPI feature-family coverage. Each entry pins the imported documentation
// source (path + on-disk SHA-256), the listed MCP tool names (see each route for evidence), the proposed semantic read operations, the outbound transport and an honest status.
// This is brand-specific discovery metadata for the dashboard and Graph Integrations; it is NOT part
// of the brand-neutral gateway contract and grants no admission, dispatch or write authority.
// Statuses: mapped = semantic read implemented; candidate = doc imported, read proposed, not mapped;
// paper-candidate = simulated trading needing separate admission; excluded = live order dispatch.
export const COVERAGE_INDEX = Object.freeze({
  url: 'https://open.moomoo.com/',
  index_sha256: 'dda1b306fc514df55ff9cc168e417dd26da716d91b2193ce27cb0b645d29b164',
  known_sources: 305, imported_sources: 196, incomplete_sources: 109,
  retrieved_utc: '2026-11-23T00:51:00Z'
});
const source = (path, sha256) => Object.freeze({ path, sha256, url: 'https://open.moomoo.com/' + path.replace(/\.md$/, '') });
const family = (id, label, status, transport, operations, mcp, sources, note) =>
  Object.freeze({ id, label, status, transport, operations: Object.freeze(operations), mcp: Object.freeze(mcp), sources: Object.freeze(sources), note });

const securitiesEvents = new Set(['EVENT_NEW', 'EVENT_REPLACED', 'EVENT_CANCELED', 'EVENT_EXPIRED', 'EVENT_FILL', 'EVENT_NEW_REJECTED',
  'EVENT_REPLACE_REJECTED', 'EVENT_CANCEL_REJECTED', 'EVENT_FILL_CORRECT', 'EVENT_FILL_CANCEL', 'EVENT_WAIT_OPEN',
  'EVENT_PRICE_PROTECT', 'EVENT_TRIGGER_WAITING', 'EVENT_TRIGGER']);
const cryptoReports = new Set(['1', '3', '4', '5']);
const replayTopics = new Set(['QUOTE', 'ORDER_BOOK', 'TICKER', 'KLINE', 'BROKER_QUEUE', 'MARKET_STATE']);

export const providerCoverage = Object.freeze([
  family('market-reads', 'Realtime quotes, history, book and tape', 'mapped', 'MCP+REST',
    ['read.catalog', 'read.candles', 'read.ticker', 'read.depth', 'read.tape'],
    ['quote_stock_quote', 'quote_rt_ticker', 'quote_cur_kline', 'quote_order_book'],
    [source('api/quote/kline/list.md', '2d0a1de5628c5165adbbfad1ca0ac649874408f106723e7ca16f0baad08271a7')],
    'Desktop MCP captures cover four reads. Signed local REST fixtures preserve quote price tokens, venue books, trade IDs and current candles.'),
  family('calendar', 'Earnings calendar', 'mapped', 'REST',
    ['read.calendar'], [],
    [source('api/quote/calendar/earnings-calendar.md', '36da3343d16f677f29c49f8194f6c645b5ce273bda0ccc2a1c442c8f29bf4bc2')],
    'REST-only (no MCP tool). Market-local dates, Unix-microsecond publication time, session and null estimates preserved; ≤7-day inclusive window.'),
  family('capital-flow', 'Capital flow', 'mapped', 'MCP+REST',
    ['read.capital-flow'], ['quote_capital_flow'],
    [],
    'MCP and REST fixtures preserve signed native-currency flows and millisecond timestamps.'),
  family('rank', 'Stock screening and rankings', 'mapped', 'MCP+REST',
    ['read.rank', 'read.stock-screen'], [],
    [source('api/quote/screening/stock-screen.md', 'e19263aeea9615a0262950b57df146deffd945ec1fd5ba329057d316008b6f88'),
     source('api/quote/rank/rank-hot-list.md', 'c863d51e04fdd576a24be433ddaff86e931a7ebadcfaa734473c16784561baa7'),
     source('api/quote/rank/rank-earnings-beat.md', '4689cb06a31b34f6a020aaa32b977b8a9ed8f0ba6d2a2d4521703f1680f7f934')],
    'Signed local fixtures cover market-wide screening over MCP and REST, plus the REST hot list. Each screen binds its market, factor bounds, sorting, columns and cursor.'),
  family('plate-industry', 'Sector directory', 'mapped', 'MCP+REST',
    ['read.plate'], ['quote_plate_list', 'quote_plate_stock', 'quote_owner_plate'],
    [source('api/quote/industry/heatmap.md', 'a636ade5e00f7018f4cb7461b1bd82e607119f3714483eff68476bb8665a0297'),
     source('api/quote/industry/industrial-chain-list.md', 'b446c6175a9198f884c20864327a1f300307ea460c516767dc68449befea20c5')],
    'MCP and REST sector-list fixtures preserve sector codes, IDs and names. The imported heatmap and industrial-chain documents cover related routes.'),
  family('news-research', 'News search and analyst ratings', 'mapped', 'MCP+REST',
    ['read.news', 'read.research'], ['news_search'],
    [source('api/quote/research/research-analyst-ratings.md', '31cf7fb1d42fa1da41dcda3c8bb3b036ac4ec648fd79c7b7a3baf4b31a22ea28')],
    'MCP and REST fixtures cover headline metadata. Analyst rating pages use the REST mapping.'),
  family('ipo', 'Hong Kong IPO listings', 'mapped', 'MCP+REST',
    ['read.ipo'], ['quote_ipo_list_us', 'quote_ipo_list_hk', 'quote_ipo_list_cn', 'quote_ipo_list_sg', 'quote_ipo_list_my'],
    [],
    'The HK MCP and REST fixtures map public listing dates, lot sizes and HKD offer prices. Other IPO markets await qualification.'),
  family('financials', 'Company profile and financial statements', 'mapped', 'MCP+REST',
    ['read.financials', 'read.financial-statements'], ['quote_financials_statements'],
    [source('api/quote/company/profile.md', 'de67cc6e2ac7fd84acb650086fc38830e50d41fb2ae6a09569edfcc8b7c370d4'),
     source('api/quote/financials/statements.md', 'f879dec57ec725c119c0e7d31e595198cbc8c890ba94d5c788b54a5e42085f8a')],
    'Local fixtures cover profile labels and reported line items by fiscal period, currency, accounting standard and value type.'),
  family('corporate-actions', 'Dividend announcements', 'mapped', 'MCP+REST',
    ['read.corporate-actions'], [],
    [source('api/quote/corporate-actions/dividends.md', '8d1688ba5a6003fe96da5c6a002fbd1c32f403b84a8076d7f7bc2db95b1b54ed')],
    'MCP and REST fixtures preserve provider statements and market-local dividend dates.'),
  family('holders', 'Main shareholders', 'mapped', 'MCP+REST',
    ['read.holders'], [],
    [source('api/quote/shareholders/overview.md', '522a012101fe093cf4faca3bf79de297c8a6e3e54e0e8195ce078a343e978ed4'),
     source('api/quote/institution/institution-holding-list.md', '00983e8f58dcbfae1262c6ce85d9b40ae881f4bd4308eddf191e760a67cd411c'),
     source('api/quote/ark/ark-fund-holding.md', '589fd7c7ff9f5c0bcbbb9fa1c1b56fa0a0080eb28f0d4fff489c41955df7d7db')],
    'MCP and REST fixtures preserve portfolio percentages and dated holder identifiers. The published MCP period selector accepts zero.'),
  family('influencer', 'Reported influencer holdings', 'mapped', 'REST',
    ['read.influencer'], [],
    [source('api/quote/influencer/holdings.md', 'c1c9a069b296fb0e96bf1c594184936f6f355532f68115d91d09549dac1abc4e'),
     source('api/quote/influencer/holding-change.md', '506c3dad2f36a508e1e5a79a52d93beefdcb5c103d242d41ad519f70d73b572e')],
    'USD estimates, portfolio percentages and US Eastern dates. Signed local REST fixture.'),
  family('macro', 'Macro indicator directory', 'mapped', 'REST',
    ['read.macro'], [],
    [source('api/quote/macro/macro-indicators.md', '05793610fec13ef1dc4daebfc70ccba885945cd7bf225bd8b5f75d110ee17299')],
    'Regional category names and indicator identifiers. Signed local REST fixture.'),
  family('derivatives', 'Options and futures research', 'mapped', 'MCP+REST',
    ['read.derivatives', 'read.option-chain', 'read.option-expiries', 'read.option-events',
     'read.futures-positions', 'read.futures-seasonality', 'read.futures-correlation'],
    ['quote_future_info', 'quote_option_chain', 'quote_option_expiration_date'],
    [source('api/quote/unusual/derivatives.md', 'ca21b50ff8bef45e3b33cf5f86698c3a69d46fec85cc40343d8b0c575ac4425e'),
     source('api/quote/derivatives/option-chain.md', 'fb7f9d61e0bbcf732ee05119b02377ed08d15f0768fed839b526901212f5031a'),
     source('api/quote/derivatives/option-expiration.md', '9f96aea83279fa7a4ccc4f31ed2cb6610b8610c7135afddb6b4cfe51d4641ec1'),
     source('api/quote/derivatives/option-event.md', 'b21cf9f36810dd3d653cf3179efc652e438d80872162d9c37a6f79a271ea2a44'),
     source('api/quote/derivatives/quote-future-position-analysis.md', '293b0cba0cca7cb6346d19ddf1e81e7e7be7b3bd20b9775bd42c251136bd51d9'),
     source('api/quote/derivatives/quote-future-seasonal.md', '1b1e2917fada8cb035a27b0da9bc650ac61fe26bb2e223a20b31379a8d41aded'),
     source('api/quote/derivatives/quote-future-correlation.md', '0f6e7004b2d91c3c1f037ce70928a48646fbd05b4d9077f29a9e0d0c14cca416')],
    'MCP and REST fixtures cover unusual derivatives, option chains and expiries. Option trades and the three futures reads use REST.'),
  family('etf', 'ETF top holdings', 'mapped', 'REST',
    ['read.etf'], [],
    [source('api/quote/etf/quote-etf-top-holdings.md', 'f64d56a974cb6c7d8ea6993f68e883f27a4740b2f8a98098807ccd764681b9c4')],
    'Portfolio weights in percent and disclosure time in milliseconds. Signed local REST fixture.'),
  family('event-contract', 'Event contract directory', 'mapped', 'REST',
    ['read.event-contract'], [],
    [source('api/quote/event-contract/event-contract-event-list.md', 'da1fca568e3da2a63191b1df2917e769031a4b954ba9687eb96b8e9080c86c70')],
    'Event identifiers and cursor within one series. Signed local REST fixture.'),
  family('crypto-market', 'Crypto market overview', 'mapped', 'REST',
    ['read.crypto-market'], [],
    [source('api/quote/crypto-market/crypto-market-overview.md', 'f4b0eb0e96c62513cca891e6a880367335e410dfb6f47b6207338c9119bddb1b')],
    'Aggregate USD market cap and turnover, 24-hour percentage changes. Signed local REST fixture.'),
  family('valuation', 'Historical valuation ratios', 'mapped', 'MCP+REST',
    ['read.valuation'], [],
    [source('api/quote/valuation/detail.md', 'f51a510e4a27bfc15c8711bd33bebd54a8f94711be0e1f6d605e029a2e6d2f30')],
    'MCP and REST fixtures preserve PE, PB or PS ratios and Unix seconds.'),
  family('short', 'Hong Kong short interest', 'mapped', 'MCP+REST',
    ['read.short'], [],
    [source('api/quote/short/interest.md', '5fb77899253871812da937ddf4f0b26a2d4e4eb1c506114eb7f06062999e5469')],
    'MCP and REST fixtures preserve exact share counts, float percentages and market dates.'),
  family('stock-connect', 'Daily Stock Connect flows', 'mapped', 'REST',
    ['read.stock-connect'], [],
    [source('api/quote/stock-connect/quote-stock-connect-flow.md', '12d1b508fe619fc3f7de81c3e02552b5c77f7da1bc3b60b1d4aee6ef6221059d')],
    'Signed daily shares and yuan amounts. Signed local REST fixture.'),
  family('top-brokers', 'Hong Kong broker rankings', 'mapped', 'MCP+REST',
    ['read.top-brokers'], [],
    [source('api/quote/top-brokers/top-brokers.md', '4829004be19ed773465303f76f7342ac79e4badb46bbc1d53d955f1090471dc8')],
    'MCP and REST fixtures preserve net-buy and net-sell share counts and Unix milliseconds.'),
  family('chip-cbbc', 'Chip distribution and CBBC outstanding volumes', 'mapped', 'REST',
    ['read.chip', 'read.cbbc'], [],
    [source('api/quote/chip/quote-chip-distribution.md', 'e135c006a96cedabb95df63efb0b1e2b9018a8b17ee667248e6c41012fb045f7'),
     source('api/quote/cbbc/quote-cbbc-basic-info.md', '07ecfcb503fed3311277495af5910c4c449c7c4bd25714238bdb156609aa4b68')],
    'Source price strings, profit percentage and Unix seconds. Quoted currency and exact bull and bear outstanding quantities. Signed local REST fixture.'),
  family('push', 'Realtime push subscription', 'candidate', 'PUSH',
    ['subscribe.push'], [],
    [source('api/quote/push/overview.md', '485db83bdf0dd46e4e63f042ce21c9bd473bd68745eb64c1328ebfe59c789670')],
    `Saved quote frames supported by the desk: ${[...replayTopics].join(', ')}. Private file replay covers fourteen securities events and four binary crypto reports. A connected stream needs entitlement and recovery evidence.`),
  family('simulator-reads', 'Simulator account, positions, orders and buying power', 'mapped', 'MCP+REST',
    ['read.simulator-account', 'read.simulator-balances', 'read.simulator-positions', 'read.simulator-orders', 'read.simulator-order-history', 'read.simulator-buying-power'],
    ['sim_trade_account_list', 'sim_trade_cash_info', 'sim_trade_position_list', 'sim_trade_history_order_list', 'sim_trade_max_buy_sell'],
    [source('api/sim-trade/cash-info.md', '68a9a178c1b0c1d06b4dd6ecf066c907d808a03e1ecce5a1f565cd83bca62960'),
     source('api/sim-trade/order-list.md', '1ab1b6881d212636ebb843517cb56e64199f5c06776dde8074071bd19ff49cad'),
     source('api/sim-trade/history-order-list.md', '8666d2d1a50e746925808d22291dc50d327b6ac881de1ba54f2cde3e416807b1'),
     source('api/sim-trade/max-buy-sell.md', '9b1a02fc551f0aa8eeb9ef2fb9a70f2e8531fcde694679fdd3e4450f5823cb06')],
    'Signed local fixtures verify the selected practice or competition account. Six REST reads and five native MCP tools preserve decimal values and account-bound results. Current-order lookup uses REST.'),
  family('sim-trade', 'Simulated paper trading', 'paper-candidate', 'REST',
    ['practice.sim'], [],
    [source('api/sim-trade/cash-info.md', '68a9a178c1b0c1d06b4dd6ecf066c907d808a03e1ecce5a1f565cd83bca62960')],
    'Nine simulator routes cover six reads and three ticket effects. The running local broker signs MOCK fills. Connected rehearsal requires a separately admitted simulator alias.'),
  family('trading', 'Live order dispatch', 'excluded', 'REST',
    [], [],
    [source('api/trading/overview.md', '5cc47dc21f38edb6e01c5d7cf1425d5248ba2d94583f9326e645581557e6bd2c'),
     source('api/trading/trade/place-order.md', '91b0a90a9294b138906d02628f19f1e6704e5d91a0fb0a7306ac890d15c1c0e6')],
    'Live place/cancel/modify order endpoints are out of the read-only $0 scope and never mapped.'),
  family('crypto-trading', 'Live crypto order dispatch', 'excluded', 'REST',
    [], [],
    [source('api/crypto_trading/overview.md', '5456c16b51a443854d46b46703b9521ac92a80d1d8e0858efffb0e2c6a51a0dc')],
    'Live crypto account/order/trade endpoints are out of the read-only $0 scope and never mapped.')
]);

export function coverageSummary(entries = providerCoverage) {
  const byStatus = {};
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  return Object.freeze({
    families: entries.length,
    mapped_operations: entries.flatMap(entry => entry.status === 'mapped' ? entry.operations : []),
    by_status: Object.freeze(byStatus),
    rest_only_mapped: entries.filter(entry => entry.status === 'mapped' && entry.transport === 'REST').map(entry => entry.id),
    excluded: entries.filter(entry => entry.status === 'excluded').map(entry => entry.id)
  });
}
const deskTools = new Set(Object.values(captureMapping.operations).map(operation => operation.tool));
const researchMcpNames = new Set(Object.values(researchTools));
const screenPath = 'POST /api/v1.0/quote/stock-screen';
const stockScreenEvidence = { evidence: 'Signed local stock-screen fixture',
  units: 'Prices and market cap ×1000, valuation multiples ×100000, dividend yield percent ×1000, listing time in seconds. Exact raw integer and decimal text.' };
const marketFixture = units => ({ evidence: 'Signed local market REST fixture', units });
const reviewedRest = new Map([
  ['POST /api/v1.0/quote/stock-quote', marketFixture('Source quote price and representation, market date, Unix milliseconds, shares and turnover')],
  ['POST /api/v1.0/quote/order-book', marketFixture('Per-exchange book, source size, scaled size, order count and exchange time in Unix milliseconds')],
  ['GET /api/v1.0/quote/{symbol}/rt-ticker', marketFixture('Exact trade sequence, source price, raw and scaled volume, session and Unix milliseconds')],
  ['GET /api/v1.0/quote/{symbol}/cur-kline', marketFixture('Market-local date, OHLC, shares, turnover, percent changes, Unix milliseconds and requested candle settings')],
  [screenPath, stockScreenEvidence],
  ['GET /api/v1.0/quote/{symbol}/future/position-analysis', { evidence: 'Local CFTC positions fixture', units: 'Reported contract counts, weekly changes, open interest and report time in Unix seconds' }],
  ['GET /api/v1.0/quote/{symbol}/future/seasonal', { evidence: 'Local seasonality fixture', units: 'Unscaled source prices for each year or the historical mean, with UTC+8-aligned Unix seconds' }],
  ['GET /api/v1.0/quote/{symbol}/future/correlation', { evidence: 'Local futures correlation fixture', units: 'Unscaled coefficients from −1 to 1, per related contract and UTC+8-aligned Unix timestamp' }],
  ['GET /api/v1.0/quote/{symbol}/financials/statements', { evidence: 'Local financial statements fixture',
    units: 'Amounts in the reported currency, percentages as supplied, and report dates in Unix milliseconds' }],
  ['GET /api/v1.0/quote/{symbol}/option-chain', { evidence: 'Local option-chain fixture', units: 'Contract, underlying, strike price, lot size and market-local expiry date' }],
  ['GET /api/v1.0/quote/{symbol}/option-expiration', { evidence: 'Local expiry fixture', units: 'Market-local strike date, signed days to expiry and expiration cycle' }],
  ['GET /api/v1.0/quote/option-event', { evidence: 'Local option trade fixture', units: 'Execution and expiry in Unix microseconds, trade price, Greeks and IV in percent' }],
  ['GET /api/v1.0/quote/earnings-calendar', { evidence: 'Local earnings calendar fixture', units: 'Market-local dates and Unix microseconds' }],
  ['GET /api/v1.0/quote/{symbol}/capital-flow', { evidence: 'Local capital-flow fixture', units: 'Native currency and Unix milliseconds' }],
  ['GET /api/v1.0/quote/rank/hot-list', { evidence: 'Local hot-list fixture', units: 'Provider heat scores and rank changes' }],
  ['GET /api/v1.0/quote/plate-list', { evidence: 'Local sector-list fixture', units: 'Market and plate identifiers' }],
  ['GET /api/v1.0/quote/ipo-list/hk', { evidence: 'Local HK IPO fixture', units: 'HKD offer prices, market dates and shares per lot' }],
  ['GET /api/v1.0/news/search', { evidence: 'Local headline fixture', units: 'Unix milliseconds and opaque news IDs' }],
  ['GET /api/v1.0/quote/research/analyst-ratings', { evidence: 'Local analyst-rating fixture', units: 'Market-local dates and native target-price text' }],
  ['GET /api/v1.0/quote/{symbol}/company/profile', { evidence: 'Local profile fixture', units: 'Localized labels and source field types' }],
  ['GET /api/v1.0/quote/{symbol}/corporate-actions/dividends', { evidence: 'Local dividends fixture', units: 'Provider statements and market-local dividend dates' }],
  ['GET /api/v1.0/quote/{symbol}/shareholders/overview', { evidence: 'Local overview fixture', units: 'Portfolio percentages and dated holder identifiers' }],
  ['GET /api/v1.0/quote/influencer/holdings', { evidence: 'Local holdings fixture', units: 'USD estimates, portfolio percentages and US Eastern dates' }],
  ['GET /api/v1.0/quote/macro/indicators', { evidence: 'Local indicators fixture', units: 'Regional category names and indicator identifiers' }],
  ['GET /api/v1.0/quote/{symbol}/unusual/derivatives', { evidence: 'Local derivatives fixture', units: 'Provider summary, lookback and movement status' }],
  ['GET /api/v1.0/quote/{symbol}/etf/top-holdings', { evidence: 'Local top-holdings fixture', units: 'Portfolio weights in percent and disclosure time in milliseconds' }],
  ['GET /api/v1.0/quote/event-contract/events', { evidence: 'Local events fixture', units: 'Event identifiers and cursor within one series' }],
  ['GET /api/v1.0/quote/crypto/market-overview', { evidence: 'Local market-overview fixture', units: 'Aggregate USD market cap and turnover, 24-hour percentage changes' }],
  ['GET /api/v1.0/quote/{symbol}/valuation/detail', { evidence: 'Local detail fixture', units: 'PE, PB or PS ratios and Unix seconds' }],
  ['GET /api/v1.0/quote/{symbol}/short/interest', { evidence: 'Local interest fixture', units: 'Exact share counts, float percentages and market dates' }],
  ['GET /api/v1.0/quote/{symbol}/stock-connect/flow', { evidence: 'Local flow fixture', units: 'Signed daily shares and yuan amounts' }],
  ['GET /api/v1.0/quote/{symbol}/top-brokers', { evidence: 'Local top-brokers fixture', units: 'Separate net-buy and net-sell share counts and Unix milliseconds' }],
  ['GET /api/v1.0/quote/{symbol}/chip-distribution', { evidence: 'Local chip-distribution fixture', units: 'Source price strings, profit percentage and Unix seconds' }],
  ['GET /api/v1.0/quote/{symbol}/cbbc/basic-info', { evidence: 'Local basic-info fixture', units: 'Quoted currency and exact bull and bear outstanding quantities' }]
]);
// These are documentation bindings for the simulator rehearsal. Admission
// and order dispatch remain owned by the paper guard and its selected broker.
export function researchRouteUnits(method, path) {
  const entry = reviewedRest.get(method + ' ' + path);
  if (!entry) throw Error('Missing research units for ' + method + ' ' + path);
  return entry.units;
}

const simRoot = '/api/v1.0/sim-trade/';
const simAccount = simRoot + '{acc_id}/';
const simOrder = simAccount + 'orders/{order_id}/';
const simRead = (label, fields) => ({ scope: 'Simulator account read', evidence: label, units: fields });
const mappedSimRead = (label, fields) => ({ ...simRead(label, fields), mapped: true });
const simEffect = (label, fields) => ({ scope: 'Independent paper approval and simulator grant', evidence: label, units: fields });
const simulationRoutes = new Map([
  ['GET ' + simRoot + 'accounts', mappedSimRead('Verify the selected simulator alias and profile', 'Opaque account ID, account market ID and practice or competition account type')],
  ['GET ' + simAccount + 'cash-info', mappedSimRead('Read cash after verifying the simulator account', 'Provider decimal strings for balance, held cash and buying power')],
  ['GET ' + simAccount + 'positions', mappedSimRead('Read positions after verifying the simulator account', 'Per-instrument market, symbol, quantities and cost price')],
  ['GET ' + simAccount + 'max-buy-sell', mappedSimRead('Check the ticket’s buying power', 'Round-lot quantities and nullable margin capacity')],
  ['GET ' + simAccount + 'orders', mappedSimRead('Read current simulator orders', 'Opaque order ID, status, decimal quantity and fill quantity')],
  ['GET ' + simAccount + 'history-orders', mappedSimRead('Reconcile prior simulator orders', 'Microsecond query window and opaque page cursor')],
  ['POST ' + simAccount + 'orders', simEffect('Place an independently approved paper ticket', 'Account market ID, symbol, side, quantity and conditional limit price')],
  ['POST ' + simOrder + 'modify', simEffect('Amend an independently approved paper ticket', 'Original order ID, new quantity and price')],
  ['POST ' + simOrder + 'cancel', simEffect('Cancel an independently approved paper ticket', 'Account market ID and original order ID')]
]);
const routeKey = http => http.replace(/\{[A-Za-z_][\w]*\}/g, '{}');

// Labels describe the evidence needed at Trading admission. This inventory has
// no transport handler and supplies neither permission nor spendable headroom.
function disposition(methodPath, topic, name) {
  if (topic) {
    const name = topic.split('/').at(-1);
    if (topic === '/api/trading/trade_event_push/' + name && securitiesEvents.has(name))
      return ['offline replay', 'trade:read', 'Securities JSON · exact account match'];
    if (topic === '/api/crypto_trading/trade_event_push/' + name && cryptoReports.has(name))
      return ['offline replay', 'trade:read', 'Crypto Protobuf · account absent from frame'];
    const market = topic.startsWith('/api/quote/push/');
    return market && replayTopics.has(topic.split('/').at(-1))
      ? ['offline replay', 'quote:read', 'Gateway replay']
      : ['candidate', market ? 'quote:read' : 'trade:read', 'Review stream rights and recovery'];
  }
  const [method, path] = methodPath.split(' ');
  if (path.startsWith('/api/v1.0/sim-trade/')) {
    const binding = simulationRoutes.get(methodPath);
    if (binding?.mapped) {
      if (!name) return ['mapped', binding.scope, binding.evidence];
      const family = providerCoverage.find(entry => entry.id === 'simulator-reads');
      if (family.mcp.includes(name)) return ['mapped', binding.scope, 'Signed local simulator MCP fixture'];
    }
    return ['paper candidate', binding?.scope ?? 'simulator grant', (name && binding?.mapped ? 'Review the simulator MCP binding' : binding?.evidence) ?? 'Verify simulator alias and operation'];
  }
  if (path.includes('/modify-user-security')) return ['blocked', 'quote:write', 'Separate watchlist grant'];
  if (path.includes('/accounts/') && (['PUT', 'DELETE', 'PATCH'].includes(method) ||
      method === 'POST' && /\/(orders|order_confirm|transfers?)$/.test(path))) {
    return ['excluded', 'trade:write', 'Live effect excluded'];
  }
  if (name === 'quote_stock_screen' && methodPath === screenPath) return ['mapped', 'quote:read', stockScreenEvidence.evidence];
  if (name && researchMcpNames.has(name) && reviewedRest.has(methodPath)) {
    return ['mapped', path.startsWith('/api/v1.0/news/') ? 'review news access' : 'quote:read', 'Signed local MCP research fixture'];
  }
  if (name && deskTools.has(name)) {
    return ['mapped', 'quote:read', name === 'quote_stock_quote' ? 'Desktop and hosted captures' : 'Desktop capture'];
  }
  if (!name && reviewedRest.has(methodPath)) {
    return ['mapped', path.startsWith('/api/v1.0/news/') ? 'review news access' : 'quote:read', reviewedRest.get(methodPath).evidence];
  }
  const scope = path.startsWith('/api/v1.0/news/') ? 'review news access' : path.includes('/quote/') ? 'quote:read'
    : path.includes('/accounts/') ? 'trade:read' : 'scope review';
  return ['candidate', scope, 'Review fields, rights and quota'];
}

export function routeInventory(catalog) {
  if (catalog.schema !== 'moomoo-documentation-catalog/v1' || catalog.authority !== false ||
      catalog.index_sha256 !== COVERAGE_INDEX.index_sha256) throw Error('COVERAGE_SOURCE_DRIFT');
  const routes = new Map();
  function add(transport, label, methodPath, topic, name, source) {
    const key = transport + ' ' + (transport === 'REST' ? routeKey(label) : label);
    let route = routes.get(key);
    if (!route) {
      const [status, scope, evidence] = disposition(methodPath, topic, name);
      const units = transport === 'REST' ? (reviewedRest.get(methodPath) ?? simulationRoutes.get(methodPath))?.units
        : name === 'quote_stock_screen' ? stockScreenEvidence.units : researchMcpNames.has(name) ? reviewedRest.get(methodPath)?.units : undefined;
      route = { transport, label, status, scope, evidence, units: units ?? 'See source field definitions', sources: [] };
      routes.set(key, route);
    }
    route.sources.push(source);
  }
  for (const doc of catalog.sources) {
    const record = doc.reference ?? doc;
    for (const route of record.routes ?? []) {
      const url = doc.reference ? catalog.origin + '/' + record.file : catalog.origin + doc.path;
      const source = { url, digest: record.sha256 };
      if (route.startsWith('PUSH ')) add('Push', route.slice(5), null, route.slice(5), null, source);
      else add('REST', route, route, null, null, source);
    }
  }
  for (const tool of catalog.tools) {
    const source = { url: catalog.directory, digest: tool.http_schema_sha256, tool: tool.name, http: tool.http };
    add('MCP', tool.name, tool.http, null, tool.name, source);
    add('REST', tool.http, tool.http, null, null, source);
  }
  return [...routes.values()];
}
