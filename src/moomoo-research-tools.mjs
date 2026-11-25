import { marketRestRoutes } from 'agentic-gateway/connectors/moomoo-market-rest';

// Reviewed intersection of Trading research projections and Gateway's pinned public directory.
export const researchTools = Object.freeze({
  'read.capital-flow': 'quote_capital_flow',
  'read.plate': 'quote_plate_list',
  'read.ipo': 'quote_ipo_list_hk',
  'read.option-chain': 'quote_option_chain',
  'read.option-expiries': 'quote_option_expiration_date',
  'read.news': 'news_search',
  'read.financials': 'quote_company_profile',
  'read.company-executive-background': 'quote_company_executive_background',
  'read.company-executives': 'quote_company_executives',
  'read.company-operational-efficiency': 'quote_company_operational_efficiency',
  'read.financial-statements': 'quote_financials_statements',
  'read.corporate-actions': 'quote_corporate_actions_dividends',
  'read.holders': 'quote_shareholders_overview',
  'read.derivatives': 'quote_unusual_derivatives',
  'read.valuation': 'quote_valuation_detail',
  'read.short': 'quote_short_interest',
  'read.top-brokers': 'quote_top_ten_brokers'
});

export const sessionTools = Object.freeze({
  'read.market-state': 'quote_market_state',
  'read.trading-days': 'quote_trading_days',
});

export const rankingNames = Object.freeze(['top-movers', 'us-pre-market', 'us-after-hours', 'us-overnight',
  'period-change', 'dividend', 'high-dividend-soe', 'earnings-beat', 'short-selling']);
export const rankingTools = Object.freeze(Object.fromEntries(rankingNames.map(name =>
  ['read.rank-' + name, 'rest_rank_' + name.replaceAll('-', '_')])));

export const ipoRegions = Object.freeze(['cn', 'us', 'sg', 'my', 'jp']);
export const regionalIpoTools = Object.freeze(Object.fromEntries(ipoRegions.map(region =>
  ['read.ipo-' + region, (region === 'jp' ? 'rest' : 'quote') + '_ipo_list_' + region])));

const researchRestPrefix = 'rest_research_';
export const researchRestTools = Object.freeze(Object.fromEntries(Object.keys(marketRestRoutes)
  .filter(tool => tool.startsWith(researchRestPrefix))
  .map(tool => ['read.' + tool.slice(researchRestPrefix.length).replaceAll('_', '-'), tool])));
