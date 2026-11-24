import { captureMapping } from './provider-capture.mjs';
// Evidence-led moomoo OpenAPI feature-family coverage. Each entry pins the imported documentation
// source (path + on-disk SHA-256), the verified MCP tool names (only tools observed in the session
// catalog), the proposed semantic read operations, the outbound transport and an honest status.
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

export const providerCoverage = Object.freeze([
  family('market-reads', 'Realtime quotes, history, book and tape', 'mapped', 'MCP',
    ['read.catalog', 'read.candles', 'read.ticker', 'read.depth', 'read.tape'],
    ['quote_stock_quote', 'quote_rt_ticker', 'quote_cur_kline', 'quote_order_book'],
    [source('api/quote/kline/list.md', '2d0a1de5628c5165adbbfad1ca0ac649874408f106723e7ca16f0baad08271a7')],
    'Operation-shaped MCP reads share one durable $0 counter; decimal strings are preserved verbatim.'),
  family('calendar', 'Earnings calendar', 'mapped', 'REST',
    ['read.calendar'], [],
    [source('api/quote/calendar/earnings-calendar.md', '36da3343d16f677f29c49f8194f6c645b5ce273bda0ccc2a1c442c8f29bf4bc2')],
    'REST-only (no MCP tool). Market-local dates, Unix-microsecond publication time, session and null estimates preserved; ≤7-day inclusive window.'),
  family('capital-flow', 'Capital flow and unusual activity', 'candidate', 'MCP+REST',
    ['read.capital-flow'], ['quote_capital_flow'],
    [source('api/quote/unusual/capital.md', '6822c10b8faf8c50ddac9440f2efdbf1446c7c76130c3268e349ec15a633e6f9')],
    'MCP capital-flow tool observed; REST unusual-activity docs imported. Semantic read not yet mapped.'),
  family('rank', 'Rankings and hot lists', 'candidate', 'MCP+REST',
    ['read.rank'], [],
    [source('api/quote/rank/rank-hot-list.md', 'c863d51e04fdd576a24be433ddaff86e931a7ebadcfaa734473c16784561baa7'),
     source('api/quote/rank/rank-earnings-beat.md', '4689cb06a31b34f6a020aaa32b977b8a9ed8f0ba6d2a2d4521703f1680f7f934')],
    'Screening/ranking docs imported; no verified MCP ranking tool in the observed catalog subset.'),
  family('plate-industry', 'Sectors, plates and industrial chain', 'candidate', 'MCP+REST',
    ['read.plate'], ['quote_plate_list', 'quote_plate_stock', 'quote_owner_plate'],
    [source('api/quote/industry/heatmap.md', 'a636ade5e00f7018f4cb7461b1bd82e607119f3714483eff68476bb8665a0297'),
     source('api/quote/industry/industrial-chain-list.md', 'b446c6175a9198f884c20864327a1f300307ea460c516767dc68449befea20c5')],
    'Plate MCP tools observed; heatmap and industrial-chain REST docs imported.'),
  family('news-research', 'News and analyst research', 'candidate', 'MCP+REST',
    ['read.news', 'read.research'], ['news_search'],
    [source('api/quote/research/research-analyst-ratings.md', '31cf7fb1d42fa1da41dcda3c8bb3b036ac4ec648fd79c7b7a3baf4b31a22ea28')],
    'news_search MCP tool observed; analyst-ratings REST docs imported. Requires own data admission.'),
  family('ipo', 'IPO listings', 'candidate', 'MCP',
    ['read.ipo'], ['quote_ipo_list_us', 'quote_ipo_list_hk', 'quote_ipo_list_cn', 'quote_ipo_list_sg', 'quote_ipo_list_my'],
    [],
    'Per-market IPO MCP tools observed; no separate imported IPO doc pinned in this inventory.'),
  family('financials', 'Company financials and profile', 'candidate', 'REST',
    ['read.financials'], [],
    [source('api/quote/company/profile.md', 'de67cc6e2ac7fd84acb650086fc38830e50d41fb2ae6a09569edfcc8b7c370d4')],
    'Company profile REST doc imported; per-symbol financials referenced by the earnings calendar.'),
  family('corporate-actions', 'Dividends, splits and buybacks', 'candidate', 'REST',
    ['read.corporate-actions'], [],
    [source('api/quote/corporate-actions/dividends.md', '8d1688ba5a6003fe96da5c6a002fbd1c32f403b84a8076d7f7bc2db95b1b54ed')],
    'Dividend/split/buyback REST docs imported; semantic read not yet mapped.'),
  family('holders', 'Shareholders, institutions and ARK', 'candidate', 'REST',
    ['read.holders'], [],
    [source('api/quote/shareholders/overview.md', '522a012101fe093cf4faca3bf79de297c8a6e3e54e0e8195ce078a343e978ed4'),
     source('api/quote/institution/institution-holding-list.md', '00983e8f58dcbfae1262c6ce85d9b40ae881f4bd4308eddf191e760a67cd411c'),
     source('api/quote/ark/ark-fund-holding.md', '589fd7c7ff9f5c0bcbbb9fa1c1b56fa0a0080eb28f0d4fff489c41955df7d7db')],
    'Holder/institution/ARK REST docs imported; influencer holdings also available.'),
  family('influencer', 'Influencer holdings', 'candidate', 'REST',
    ['read.influencer'], [],
    [source('api/quote/influencer/holdings.md', 'c1c9a069b296fb0e96bf1c594184936f6f355532f68115d91d09549dac1abc4e'),
     source('api/quote/influencer/holding-change.md', '506c3dad2f36a508e1e5a79a52d93beefdcb5c103d242d41ad519f70d73b572e')],
    'Influencer holdings and changes REST docs imported.'),
  family('macro', 'Macro indicators and Fed watch', 'candidate', 'REST',
    ['read.macro'], [],
    [source('api/quote/macro/macro-indicators.md', '05793610fec13ef1dc4daebfc70ccba885945cd7bf225bd8b5f75d110ee17299')],
    'Macro indicator and Fed-watch REST docs imported.'),
  family('derivatives', 'Options and futures derivatives', 'candidate', 'MCP+REST',
    ['read.derivatives'], ['quote_future_info'],
    [source('api/quote/unusual/derivatives.md', 'ca21b50ff8bef45e3b33cf5f86698c3a69d46fec85cc40343d8b0c575ac4425e')],
    'Futures MCP tool observed; options quotes/Greeks gate research rows 15/17/20 and remain unmapped.'),
  family('etf', 'ETF holdings and screens', 'candidate', 'REST',
    ['read.etf'], [],
    [source('api/quote/etf/quote-etf-top-holdings.md', 'f64d56a974cb6c7d8ea6993f68e883f27a4740b2f8a98098807ccd764681b9c4')],
    'ETF holdings, style-box and screen REST docs imported.'),
  family('event-contract', 'Event contracts', 'candidate', 'REST',
    ['read.event-contract'], [],
    [source('api/quote/event-contract/event-contract-event-list.md', 'da1fca568e3da2a63191b1df2917e769031a4b954ba9687eb96b8e9080c86c70')],
    'Event-contract event/series/milestone REST docs imported.'),
  family('crypto-market', 'Crypto market data', 'candidate', 'REST',
    ['read.crypto-market'], [],
    [source('api/quote/crypto-market/crypto-market-overview.md', 'f4b0eb0e96c62513cca891e6a880367335e410dfb6f47b6207338c9119bddb1b')],
    'Crypto overview, fear/greed and institution-holding REST docs imported (market data, not trading).'),
  family('valuation', 'Valuation analysis', 'candidate', 'REST',
    ['read.valuation'], [],
    [source('api/quote/valuation/detail.md', 'f51a510e4a27bfc15c8711bd33bebd54a8f94711be0e1f6d605e029a2e6d2f30')],
    'Valuation detail and index/plate constituent REST docs imported.'),
  family('short', 'Short selling and interest', 'candidate', 'REST',
    ['read.short'], [],
    [source('api/quote/short/interest.md', '5fb77899253871812da937ddf4f0b26a2d4e4eb1c506114eb7f06062999e5469')],
    'Short interest, daily volume and JP credit/deposit REST docs imported.'),
  family('stock-connect', 'Stock connect flows', 'candidate', 'REST',
    ['read.stock-connect'], [],
    [source('api/quote/stock-connect/quote-stock-connect-flow.md', '12d1b508fe619fc3f7de81c3e02552b5c77f7da1bc3b60b1d4aee6ef6221059d')],
    'Stock-connect flow, hold-ratio and history REST docs imported.'),
  family('top-brokers', 'Top broker holdings', 'candidate', 'REST',
    ['read.top-brokers'], [],
    [source('api/quote/top-brokers/top-brokers.md', '4829004be19ed773465303f76f7342ac79e4badb46bbc1d53d955f1090471dc8')],
    'Top-broker buy/sell and hold-ratio REST docs imported.'),
  family('chip-cbbc', 'Chip distribution and CBBC', 'candidate', 'REST',
    ['read.chip', 'read.cbbc'], [],
    [source('api/quote/chip/quote-chip-distribution.md', 'e135c006a96cedabb95df63efb0b1e2b9018a8b17ee667248e6c41012fb045f7'),
     source('api/quote/cbbc/quote-cbbc-basic-info.md', '07ecfcb503fed3311277495af5910c4c449c7c4bd25714238bdb156609aa4b68')],
    'Chip distribution and CBBC basic-info/distribution REST docs imported.'),
  family('push', 'Realtime push subscription', 'candidate', 'PUSH',
    ['subscribe.push'], [],
    [source('api/quote/push/overview.md', '485db83bdf0dd46e4e63f042ce21c9bd473bd68745eb64c1328ebfe59c789670')],
    'Offline QUOTE, ORDER_BOOK, TICKER and KLINE replay. An entitled stream needs its own subscription and recovery evidence.'),
  family('sim-trade', 'Simulated paper trading', 'paper-candidate', 'REST',
    ['practice.sim'], [],
    [source('api/sim-trade/cash-info.md', '68a9a178c1b0c1d06b4dd6ecf066c907d808a03e1ecce5a1f565cd83bca62960')],
    'Simulated account/order REST docs imported; paper rehearsal needs the domain guard, never live dispatch.'),
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
const replayTopics = new Set(['QUOTE', 'ORDER_BOOK', 'TICKER', 'KLINE']);
const routeKey = http => http.replace(/\{[A-Za-z_][\w]*\}/g, '{}');

// Labels describe the evidence needed at Trading admission. This inventory has
// no transport handler and supplies neither permission nor spendable headroom.
function disposition(methodPath, topic, name) {
  if (topic) {
    const market = topic.startsWith('/api/quote/push/');
    return market && replayTopics.has(topic.split('/').at(-1))
      ? ['offline replay', 'quote:read', 'Gateway replay']
      : ['candidate', market ? 'quote:read' : 'trade:read', 'Review stream rights and recovery'];
  }
  const [method, path] = methodPath.split(' ');
  if (path.startsWith('/api/v1.0/sim-trade/')) {
    return ['paper candidate', 'simulator grant', 'Verify simulator alias and operation'];
  }
  if (path.includes('/modify-user-security')) return ['blocked', 'quote:write', 'Separate watchlist grant'];
  if (path.includes('/accounts/') && (['PUT', 'DELETE', 'PATCH'].includes(method) ||
      method === 'POST' && /\/(orders|order_confirm|transfers?)$/.test(path))) {
    return ['excluded', 'trade:write', 'Live effect excluded'];
  }
  if (name && deskTools.has(name)) {
    return ['mapped', 'quote:read', name === 'quote_stock_quote' ? 'Desktop and hosted captures' : 'Desktop capture'];
  }
  if (!name && methodPath === 'GET /api/v1.0/quote/earnings-calendar') {
    return ['mapped', 'quote:read', 'Local REST calendar fixture'];
  }
  const scope = path.includes('/quote/') || name === 'news_search' ? 'quote:read'
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
      route = { transport, label, status, scope, evidence, sources: [] };
      routes.set(key, route);
    }
    route.sources.push(source);
  }
  for (const doc of catalog.sources) {
    for (const route of doc.routes ?? []) {
      const source = { url: catalog.origin + doc.path, digest: doc.sha256 };
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
