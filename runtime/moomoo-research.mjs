import { sha } from './core.mjs';

// Reviewed REST response fields. The digest identifies this local projection.
// Provider qualification, credentials and each signed read grant remain host-owned.
const fields = names => Object.fromEntries(names.map(name => [name, { path: [name] }]));
const heat = ['trade_heat', 'search_heat', 'news_heat', 'average_heat'];
const scores = heat.flatMap(name => [name, name + '_change']);
const amounts = ['in_flow', 'super_in_flow', 'big_in_flow', 'mid_in_flow', 'sml_in_flow'];
const capitalFlow = {
  tool: 'quote.capital-flow', method: 'GET', path: '/api/v1.0/quote/{symbol}/capital-flow',
  symbol_path: true, input_map: { section: 'section' },
  params: { section: { enum: ['NORMAL', 'FULL', 'PREMARKET', 'AFTERHOURS'] } },
  rows_path: ['data', 'flow_list'], fields: fields(['capital_flow_item_time', ...amounts]),
  numeric: amounts, provider_doubles: true, integer: ['capital_flow_item_time'],
  last_valid_ms: ['data', 'last_valid_time']
};
const hotList = {
  tool: 'quote.rank-hot-list', method: 'GET', path: '/api/v1.0/quote/rank/hot-list',
  input_map: { market: 'market', sort_field: 'sort_field', sort_dir: 'sort_dir', page_size: 'page_size', page_flag: 'page_flag' },
  params: { market: { required: true, enum: ['HK', 'US', 'CN', 'SG', 'AU', 'CA', 'JP', 'MY'] },
    sort_field: { enum: heat.map(name => name.toUpperCase()) }, sort_dir: { enum: ['ASCENDING','DESCENDING'] },
    page_size: { integer: [1, 200] } },
  rows_path: ['data', 'items'], fields: fields(['code', 'name', ...scores]),
  numeric: scores, provider_doubles: true, pagination: ['pagination'], default_page_size: 10
};
const plate = {
  tool: 'quote.plate-list', strict_inputs: true, pin_inputs: true, method: 'GET', path: '/api/v1.0/quote/plate-list',
  input_map: { market: 'market', plate_class: 'plate_class' },
  params: { market: { required: true, enum: ['HK', 'US', 'SH', 'SZ', 'SG', 'JP', 'AU', 'CA', 'MY', 'KR'] },
    plate_class: { required: true, enum: ['ALL', 'INDUSTRY', 'REGION', 'CONCEPT', 'OTHER'] } },
  rows_path: ['data', 'plate_list'], fields: fields(['code', 'plate_id', 'plate_name']), text: ['code', 'plate_id', 'plate_name']
};
const ipoPrices = ['ipo_price_min', 'ipo_price_max', 'list_price'];
const ipo = {
  tool: 'quote.ipo-list-hk', strict_inputs: true, pin_inputs: true, method: 'GET', path: '/api/v1.0/quote/ipo-list/hk',
  fixed_inputs: { market: 'HK' }, row_market: { field: 'code', market: 'HK' }, input_map: { request_type: 'request_type' },
  params: { request_type: { integer: [9, 11] } }, rows_path: ['data'],
  fields: fields(['code', 'name', 'list_time', 'lot_size', ...ipoPrices]), text: ['code', 'name'],
  date: ['list_time'], integer: ['lot_size'], numeric: ipoPrices, provider_doubles: true,
  nullable: ['list_time', ...ipoPrices],
  missing_values: { list_time: ['--'], ipo_price_min: [0], ipo_price_max: [0], list_price: [0] }
};
const news = {
  tool: 'news.search', strict_inputs: true, pin_inputs: true, method: 'GET', path: '/api/v1.0/news/search',
  input_map: { keyword: 'keyword', news_type: 'news_type', sort_type: 'sort_type', lang: 'lang',
    source_ids: 'source_ids', sources: 'sources', page_size: 'page_size' },
  params: { keyword: { required: true, length: [1, 200] },
    source_ids: { length: [1, 200], numeric_list: true }, sources: { length: [1, 200] }, news_type: { enum: ['ALL', 'POST', 'NOTICE', 'REPORT'] },
    sort_type: { enum: ['TIME', 'PV'] }, lang: { enum: ['zh-CN', 'zh-HK', 'en', 'ja'] }, page_size: { integer: [1, 50] } },
  rows_path: ['data', 'items'], fields: fields(['news_id', 'title', 'news_type', 'source', 'publish_time']),
  opaque_ids: ['news_id'], text: ['title', 'news_type', 'source'], integer: ['publish_time'], default_page_size: 10
};
const ratings = {
  tool: 'quote.analyst-ratings', strict_inputs: true, pin_inputs: true, method: 'GET', path: '/api/v1.0/quote/research/analyst-ratings',
  input_map: { analyst_uid: 'analyst_uid', market: 'market', page_flag: 'page_flag', page_size: 'page_size' },
  params: { analyst_uid: { required: true, length: [1, 64] }, market: { enum: ['US', 'CA'] },
    page_size: { integer: [1, 20] } }, rows_path: ['data', 'items'],
  fields: fields(['code', 'rating', 'target_price', 'recommendation_date']), text: ['code', 'target_price'],
  integer: ['rating'], date: ['recommendation_date'], pagination: ['pagination'], optional_total: true, default_page_size: 10
};
// Each definition names a single public GET and the subset of provider fields
// the desk can interpret. Nested paths and parent disclosures are explicit.
function quote(tool, route, rowsPath, types, options = {}) {
  const { params = {}, source_fields = {}, ...settings } = options;
  return {
    tool: 'quote.' + tool, method: 'GET', path: '/api/v1.0/quote/' + route,
    strict_inputs: true, pin_inputs: true, symbol_path: route.includes('{symbol}'), rows_path: rowsPath,
    input_map: Object.fromEntries(Object.keys(params).map(key => [key, key])), params,
    fields: { ...fields(Object.values(types).flat()), ...source_fields }, ...types, ...settings
  };
}
const items = ['data', 'items'];
const symbol = '{symbol}/';
const boundedCount = (min, max) => ({ integer: [min, max] });
const disclosureTime = { disclosure_time_ms: { source: 'response', path: ['data', 'update_time'] } };
const optionMarkets = ['HK', 'US', 'JP'];
const cycles = ['MONTH', 'WEEK', 'END_OF_MONTH', 'QUARTERLY', 'WEEKMON', 'WEEKTUE', 'WEEKWED', 'WEEKTHU', 'WEEKFRI'];
const optionFilters = {
  index_option_type: { enum: [1, 2, 3, 4, 5, 1000, 1001, 1003, 1005, 1006, 1007, 1008, 1009,
    1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 2001, 2002, 2003] },
  filter_standard: { enum: ['ALL', 'STANDARD', 'NON_STANDARD'] }
};
const greeks = ['delta', 'gamma', 'vega', 'theta', 'rho', 'iv'];
const concretePeriods = [1, 2, 3, 4, 5, 6, 7];
const statementItem = {
  fields: fields(['field_id', 'display_name', 'value_type', 'data', 'yoy', 'qoq']),
  integer: ['field_id'], text: ['display_name', 'value_type'], wire_decimal: ['data', 'yoy', 'qoq'],
  nullable: ['data', 'yoy', 'qoq'], allowed_values: { value_type: ['amount', 'percent', ''] }
};
const futuresPositionFields = ['long', 'short', 'spread', 'net', 'net_change_weekly', 'open_interest', 'open_interest_change_weekly'];
const seasonalPoint = { fields: fields(['timestamp', 'close', 'prev_close']), integer: ['timestamp'],
  decimal_text: ['close', 'prev_close'], nullable: ['close', 'prev_close'] };
const correlationPoint = { fields: fields(['timestamp', 'correlation']), integer: ['timestamp'],
  decimal_text: ['correlation'], unit_interval: ['correlation'] };
const operations = {
  'read.capital-flow': capitalFlow, 'read.rank': hotList, 'read.plate': plate, 'read.ipo': ipo,
  'read.futures-positions': quote('future-positions', symbol + 'future/position-analysis', items,
    { integer: ['report_time'], text: ['variety'], exact_integer: futuresPositionFields, decimal_text: ['open_interest_change_rate_weekly'] },
    { params: { report_type: { length: [1, 64] }, page_size: boundedCount(1, 100), page_flag: {} },
      nullable: ['net_change_weekly', 'open_interest', 'open_interest_change_weekly', 'open_interest_change_rate_weekly'],
      pagination: ['pagination'], total_path: ['data', 'total'], default_page_size: 20 }),
  'read.futures-seasonality': quote('future-seasonal', symbol + 'future/seasonal', items,
    { integer: ['year'] }, { nullable: ['year'], unique_by: 'year', params: { period: { enum: ['MONTH', 'DAY'] } },
      source_fields: fields(['points']), nested: { points: seasonalPoint } }),
  'read.futures-correlation': quote('future-correlation', symbol + 'future/correlation', items,
    { text: ['code', 'related_code'] }, { params: { related_codes: { required: true, symbols: 4 },
      cycle: { enum: ['THREE_MONTH', 'SIX_MONTH', 'ONE_YEAR', 'THREE_YEAR'] },
      range: { enum: ['ONE_DAY', 'THREE_MONTH', 'SIX_MONTH', 'ONE_YEAR', 'THREE_YEAR'] },
      page_size: boundedCount(1, 200), page_flag: {} }, match_inputs: { code: 'symbol' },
      match_filters: { related_code: { input: 'related_codes' } }, unique_by: 'related_code', series_limit: 4,
      source_fields: fields(['points']), nested: { points: correlationPoint }, nested_limits: { points: { input: 'page_size', fallback: 30 } },
      pagination: ['pagination'], total_path: ['data', 'total'], total_series: 'points' }),
  'read.option-chain': quote('option-chain', symbol + 'option-chain', ['data', 'option_chain'],
    { text: ['code', 'stock_owner', 'option_type', 'expiration_cycle', 'option_standard_type'], date: ['strike_time'],
      numeric: ['strike_price'], integer: ['lot_size'] },
    { symbol_markets: optionMarkets, provider_doubles: true, params: { ...optionFilters,
      start: { date: true, allow_empty: true }, end: { date: true, allow_empty: true } },
      match_inputs: { stock_owner: 'symbol' }, match_filters: { option_standard_type: { input: 'filter_standard', all: 'ALL' } },
      window: { begin: 'start', end: 'end', field: 'strike_time', max_distinct: 20 },
      allowed_values: { option_type: ['CALL', 'PUT'], expiration_cycle: [...cycles, 'N/A'], option_standard_type: ['STANDARD', 'NON_STANDARD', 'N/A'] } }),
  'read.option-expiries': quote('option-expiration', symbol + 'option-expiration', ['data', 'expiration_list'],
    { date: ['strike_time'], integer: ['option_expiry_date_distance'], text: ['expiration_cycle'] },
    { symbol_markets: optionMarkets, params: { ...optionFilters,
      filter_expiration_cycles: { length: [0, 128], one_of_list: cycles, allow_empty: true } },
      match_filters: { expiration_cycle: { input: 'filter_expiration_cycles' } },
      allowed_values: { expiration_cycle: [...cycles, 'N/A'] } }),
  'read.option-events': quote('option-event', 'option-event', ['data', 'events'],
    { text: ['option', 'owner'], integer: ['fill_timestamp', 'strike_timestamp'],
      numeric: ['price', 'strike_price', 'bid_price', 'ask_price', ...greeks] },
    { provider_doubles: greeks, nullable: ['bid_price', 'ask_price', ...greeks], match_inputs: { owner: 'code' },
      market_input: { field: 'owner', filter: 'code', input: 'option_market' },
      params: { option_market: { required: true, enum: ['US_SECURITY', 'US_INDEX', 'HK_SECURITY', 'HK_INDEX'] },
        code: { symbol: true, length: [0, 64], allow_empty: true }, page_size: boundedCount(1, 300),
        page_flag: { length: [0, 256] } }, pagination: ['pagination'], default_page_size: 50, cursor_limit: 256 }),
  'read.news': news, 'read.research': ratings,
  'read.financials': quote('company-profile', symbol + 'company/profile', items,
    { text: ['name', 'value'], integer: ['field_type', 'attribute_type'] }, { nullable: ['value'] }),
  'read.financial-statements': quote('financial-statements', symbol + 'financials/statements', ['data', 'report_list'],
    { integer: ['date_time', 'structure'], text: ['fiscal_year', 'financial_type', 'period_text', 'structure_name',
      'accounting_standards', 'auditor_report'], currency: ['currency_code'] },
    { source_fields: fields(['item_list']), nested: { item_list: statementItem },
      params: { statement_type: { enum: [1, 2, 3, 4] }, financial_type: { enum: [...concretePeriods, 9, 10, 11] },
        currency_code: { currency: true, allow_empty: true }, limit: boundedCount(1, 50),
        next_key: { length: [0, 1000] } }, row_limit: { input: 'limit', fallback: 10 },
      pagination: ['pagination'], pagination_mode: 'next_key', cursor_limit: 1000,
      allowed_values: { financial_type: concretePeriods.map(String) }, match_inputs: { currency_code: 'currency_code' },
      match_filters: { financial_type: { input: 'financial_type', when: concretePeriods } } }),
  'read.corporate-actions': quote('dividends', symbol + 'corporate-actions/dividends', ['data', 'dividend_list'],
    { text: ['statement', 'currency', 'process'], local_date: ['ex_date', 'record_date', 'dividend_payable_date'] },
    { nullable: ['currency', 'process', 'ex_date', 'record_date', 'dividend_payable_date'],
      missing_values: { currency: [''], process: [''], ex_date: [''], record_date: [''], dividend_payable_date: [''] } }),
  'read.holders': quote('main-holders', symbol + 'shareholders/overview', ['data', 'main_holder'],
    { text: ['name'], numeric: ['holder_pct'], opaque_ids: ['holder_id'], date: ['static_date_str'] },
    { provider_doubles: true, nullable: ['holder_id', 'static_date_str'], params: { period_id: boundedCount(0, 2147483647) } }),
  'read.influencer': quote('influencer-holdings', 'influencer/holdings', items,
    { text: ['code', 'name', 'est_shares', 'last_change_est_shares', 'est_position_value'],
      date: ['last_change_date'], numeric: ['percent_of_portfolio'] },
    { response_code: 'code', provider_doubles: true, pagination: ['pagination'], optional_total: true, default_page_size: 20,
      params: { influencer: { required: true, enum: ['PELOSI', 'JOSH_GOTTHEIMER', 'MARJORIE_TAYLOR_GREENE', 'GIL_CISNEROS', 'DONALD_TRUMP'] },
        keyword: { length: [1, 200] }, sort_field: { enum: ['PERCENT_OF_PORTFOLIO', 'SHARES', 'CHANGE_SHARES', 'DATE', 'AMOUNT'] },
        sort_dir: { enum: ['ASCENDING', 'DESCENDING'] }, page_size: boundedCount(1, 200), page_flag: {} } }),
  'read.macro': quote('macro-indicators', 'macro/indicators', ['data'],
    { text: ['category_name', 'name'], opaque_ids: ['indicator_id'] },
    { params: { region: { required: true, enum: ['HK', 'US', 'JP', 'SG', 'AU', 'CA', 'MY', 'CN'] } } }),
  'read.derivatives': quote('unusual-derivatives', symbol + 'unusual/derivatives', ['data'],
    { integer: ['code'], text: ['time_range', 'content'] },
    { single_row: true, params: { time_range: boundedCount(1, 365) }, allowed_values: { code: [0, 1] } }),
  'read.etf': quote('etf-top-holdings', symbol + 'etf/top-holdings', items,
    { text: ['code', 'holding_name'], numeric: ['holding_rate'], integer: ['disclosure_time_ms'] },
    { source_fields: disclosureTime, provider_doubles: true }),
  'read.event-contract': quote('event-list', 'event-contract/events', ['data', 'events'],
    { text: ['event_code', 'event_name'] },
    { pagination: ['pagination'], default_page_size: 100, params: { series: { required: true, symbol: true, length: [1, 128] },
      page_size: boundedCount(1, 600), page_flag: {} } }),
  'read.crypto-market': quote('crypto-market-overview', 'crypto/market-overview', ['data'],
    { numeric: ['total_market_cap', 'total_market_cap_change_24h', 'turnover_24h', 'turnover_24h_change_24h'] },
    { single_row: true, provider_doubles: true }),
  'read.valuation': quote('valuation-history', symbol + 'valuation/detail', ['data', 'trend', 'historical_items'],
    { numeric: ['value', 'plate_value'], integer: ['time', 'valuation_type', 'last_update_time'], date: ['time_str'] },
    { provider_doubles: true, params: { valuation_type: boundedCount(1, 3), interval_type: boundedCount(1, 10) },
      source_fields: { valuation_type: { source: 'response', path: ['data', 'valuation_type'] },
        last_update_time: { source: 'response', path: ['data', 'last_update_time'] } } }),
  'read.short': quote('hk-short-interest', symbol + 'short/interest', items,
    { integer: ['timestamp'], date: ['timestamp_str'], exact_integer: ['aggregated_short'], numeric: ['aggregated_short_ratio'] },
    { symbol_markets: ['HK'], params: { count: boundedCount(1, 90) }, row_limit: { input: 'count', fallback: 30 }, provider_doubles: true }),
  'read.stock-connect': quote('daily-stock-connect-flow', symbol + 'stock-connect/flow', ['data', 'day'],
    { exact_integer: ['shares'], numeric: ['amount'], integer: ['rank'] },
    { single_row: true, available: ['data', 'latest_daily_data'] }),
  'read.top-brokers': quote('top-brokers', symbol + 'top-brokers', ['data'],
    { text: ['broker_code', 'broker_name'], integer: ['buy_sell_type', 'data_time'], exact_integer: ['net_vol'] },
    { symbol_markets: ['HK'], params: { date: { date: true } },
      groups: { buy_brokers: 1, sell_brokers: 2 }, group_field: 'buy_sell_type', group_limit: 10,
      source_fields: { data_time: { source: 'response', path: ['data', 'data_time'] } } }),
  'read.chip': quote('chip-distribution', symbol + 'chip-distribution', items,
    { integer: ['timestamp'], numeric: ['current_price', 'avg_cost', 'profit_ratio'] },
    { params: { date: { date: true }, count: boundedCount(1, 20), ktype: boundedCount(1, 11) }, row_limit: { input: 'count', fallback: 1 } }),
  'read.cbbc': quote('cbbc-basic-info', symbol + 'cbbc/basic-info', items,
    { integer: ['timestamp'], numeric: ['close_price', 'prev_close_price'], exact_integer: ['bull_outstanding', 'bear_outstanding'], text: ['currency'] },
    { source_fields: { currency: { source: 'response', path: ['data', 'currency'] } } })
};
export const researchMapping = {
  protocol: '1.0', operations: Object.fromEntries(Object.entries(operations)
    .map(([operation, projection]) => [operation, { ...projection, schema_digest: sha(projection) }]))
};
