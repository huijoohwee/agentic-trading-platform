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
export const researchMapping = {
  protocol: '1.0', operations: Object.fromEntries([['read.capital-flow', capitalFlow], ['read.rank', hotList]]
    .map(([operation, projection]) => [operation, { ...projection, schema_digest: sha(projection) }]))
};
