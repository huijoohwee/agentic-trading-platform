import { buildMoomooMarketRequest, projectMoomooMarketResponse, marketRestRoutes } from 'agentic-gateway/connectors/moomoo-market-rest';
import { requireThat, sha } from './core.mjs';
import { researchMapping } from './moomoo-research.mjs';

const profile = 'moomoo-market-rest/v1';
const restOnly = {
  'read.candle-history': 'quote_history_kline',
  'read.capital-distribution': 'quote_capital_distribution',
  'read.capital-flow-history': 'quote_capital_flow_history',
};
export function requiresMarketRest(operation, tool) {
  return Object.hasOwn(restOnly, operation) || Object.values(restOnly).includes(tool);
}
export const marketRestSpecs = Object.fromEntries(Object.entries({
  'read.ticker': 'quote_stock_quote', 'read.depth': 'quote_order_book',
  'read.tape': 'quote_rt_ticker', 'read.candles': 'quote_cur_kline', ...restOnly,
}).map(([operation, tool]) => {
  const [method, path] = marketRestRoutes[tool].split(' ');
  const spec = { profile, tool, method, path, rows_path: [], pin_inputs: true };
  return [operation, { ...spec, schema_digest: sha(spec) }];
}));

export const marketRestMapping = { protocol: '1.0', operations: { ...researchMapping.operations, ...marketRestSpecs } };
export function isMarketRest(spec) {
  return spec?.profile === profile || spec?.tool && Object.hasOwn(marketRestRoutes, spec.tool);
}
export function verifyMarketRest(operation, spec, origin) {
  requireThat(Object.hasOwn(marketRestSpecs, operation) && sha(spec) === sha(marketRestSpecs[operation]) &&
    origin === 'https://webapi.moomoo.com/', 'INVALID_MAPPING');
}
export function marketRequest(spec, inputs, allowed) {
  const { grant, ...parameters } = inputs;
  requireThat(allowed.name === spec.tool && allowed.schema_digest === spec.schema_digest, 'SCHEMA_DRIFT');
  requireThat(allowed.inputs_digest === sha(parameters), 'SCOPE_DENIED');
  return buildMoomooMarketRequest(spec.tool, parameters);
}
export function marketPage(spec, parameters, wire) {
  const { rows, requested, pagination } = projectMoomooMarketResponse(spec.tool, parameters, wire);
  // Bind the signed candle selectors to each visible bar also when opening the saved page offline.
  const page = { rows: requested ? rows.map(row => ({ ...row, ...requested })) : rows, decimals: rows.map(() => ({})) };
  if (pagination) {
    page.pagination = { completed: !pagination.has_more, next_cursor: pagination.next_page_token ?? pagination.next_time?.toString() ?? null,
      ...(Object.hasOwn(pagination, 'next_page_token') && { next_page_token: pagination.next_page_token }), next_time: pagination.next_time };
  }
  return page;
}
