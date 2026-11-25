import { researchMapping } from '../runtime/moomoo-research.mjs';
import { marketRestSpecs } from '../runtime/moomoo-market-rest.mjs';
import { researchRouteUnits } from './provider-coverage.mjs';

// The builder seals these display fields. Dispatch definitions and Node runtime dependencies stay on the host.
const calendar = {
  columns: ['code', 'name', 'earnings_date', 'pub_type', 'period_text', 'eps_actual', 'eps_predict',
    'earnings_timestamp', 'price', 'published'],
  optional: ['revenue_actual', 'revenue_predict', 'ebit_actual', 'ebit_predict', 'market_cap', 'option_volume', 'iv', 'iv_rank', 'iv_percentile'],
  integers: ['earnings_timestamp'], text: ['code', 'name', 'earnings_date', 'pub_type', 'period_text'], booleans: ['published'],
  nullable: ['period_text', 'eps_actual', 'eps_predict'],
  units: researchRouteUnits('GET', '/api/v1.0/quote/earnings-calendar')
};
function columns(spec) {
  return { columns: Object.keys(spec.fields),
    ...(spec.nullable && { nullable: spec.nullable }),
    ...(spec.numeric && { decimals: spec.numeric }),
    ...(spec.integer && { integers: spec.integer }),
    ...(spec.text && { text: spec.text }),
    ...(spec.exact_integer && { exactIntegers: spec.exact_integer }),
    ...(spec.decimal_text && { decimalText: spec.decimal_text }),
    ...(spec.nested && { nested: Object.fromEntries(Object.entries(spec.nested).map(([field, child]) => [field, columns(child)])) }) };
}

const level = { columns: ['price', 'raw_volume', 'volume', 'order_count'], decimalText: ['price', 'volume'],
  exactIntegers: ['raw_volume'], integers: ['order_count'], nullable: ['volume'] };
const distributionAmounts = ['in', 'out'].flatMap(side =>
  ['super', 'big', 'mid', 'small'].map(size => 'capital_' + side + '_' + size));
const flowAmounts = ['in_flow', 'main_in_flow', 'super_in_flow', 'big_in_flow', 'mid_in_flow', 'sml_in_flow'];
const optionalFlow = ['main_deal_ratio', 'acc_main_in_flow'];
const marketColumns = {
  'read.capital-distribution': { columns: ['symbol', 'update_time', ...distributionAmounts], rowLimit: 1,
    text: ['symbol'], integers: ['update_time'], decimalText: distributionAmounts },
  'read.capital-flow-history': { columns: ['symbol', 'period_type', 'capital_flow_item_time', ...flowAmounts],
    text: ['symbol', 'period_type'], integers: ['capital_flow_item_time'], optional: optionalFlow,
    decimalText: [...flowAmounts, ...optionalFlow], rowLimit: 1000, paged: true },
  'read.market-state': { columns: ['symbol', 'market_state', 'broker_id', 'time_date', 'stock_name', 'sc_name', 'tc_name', 'traded_seconds', 'total_seconds', 'trade_section', 'broker_ids'],
    text: ['symbol', 'market_state', 'stock_name', 'sc_name', 'tc_name', 'traded_seconds', 'total_seconds', 'trade_section', 'broker_ids'],
    integers: ['time_date', 'broker_id'], nullable: ['time_date', 'broker_id', 'stock_name', 'sc_name', 'tc_name', 'traded_seconds', 'total_seconds', 'trade_section', 'broker_ids'] },
  'read.trading-days': { columns: ['market', 'market_date', 'trade_date_type', 'trade_second'],
    text: ['market', 'market_date', 'trade_date_type'], integers: ['trade_second'] },
  'read.ticker': { columns: ['symbol', 'name', 'market_date', 'time_ms', 'last', 'price_source', 'open', 'high', 'low', 'prev_close', 'volume', 'turnover', 'suspended'],
    text: ['symbol', 'name', 'market_date', 'price_source'], integers: ['time_ms'], booleans: ['suspended'], exactIntegers: ['volume'],
    decimalText: ['last', 'open', 'high', 'low', 'prev_close', 'turnover'], nullable: ['open', 'high', 'low', 'prev_close', 'volume', 'turnover', 'suspended'] },
  'read.depth': { columns: ['symbol', 'name', 'exchange', 'time_ms', 'volume_precision', 'bid_flag', 'ask_flag', 'bids', 'asks'],
    text: ['symbol', 'name', 'exchange'], integers: ['time_ms', 'volume_precision', 'bid_flag', 'ask_flag'],
    nullable: ['volume_precision'], nested: { bids: level, asks: level } },
  'read.tape': { columns: ['symbol', 'time_ms', 'sequence', 'price', 'price_ex', 'raw_volume', 'volume_precision', 'volume', 'turnover',
      'direction', 'tick_type', 'period', 'pred_side', 'trade_type'], rowLimit: 750, integers: ['time_ms', 'volume_precision'], exactIntegers: ['sequence'],
    text: ['symbol', 'direction', 'tick_type', 'period', 'pred_side', 'trade_type'], decimalText: ['price', 'price_ex', 'raw_volume', 'volume', 'turnover'],
    nullable: ['price_ex', 'volume_precision', 'volume', 'pred_side', 'trade_type'] },
  'read.candles': { columns: ['symbol', 'time_ms', 'market_date', 'open', 'high', 'low', 'close', 'prev_close', 'volume', 'turnover',
      'turnover_rate_pct', 'change_pct', 'ktype', 'autype', 'extended_time', 'pred_side'],
    text: ['symbol', 'market_date'], integers: ['time_ms', 'ktype', 'autype', 'extended_time', 'pred_side'], exactIntegers: ['volume'],
    decimalText: ['open', 'high', 'low', 'close', 'prev_close', 'turnover', 'turnover_rate_pct', 'change_pct'], nullable: ['prev_close', 'turnover_rate_pct', 'change_pct'] }
};
const currentBars = marketColumns['read.candles'];
marketColumns['read.candle-history'] = {
  ...currentBars, rowLimit: 370, paged: true,
  columns: [...currentBars.columns, 'raw_volume', 'volume_precision', 'utc_offset_minutes', 'pe_ratio', 'open_interest',
    'reported_settle_price', 'implied_volatility_pct', 'name', 'sc_name', 'tc_name'],
  integers: [...currentBars.integers, 'volume_precision', 'utc_offset_minutes'],
  exactIntegers: ['raw_volume', 'open_interest'],
  decimalText: [...currentBars.decimalText, 'volume', 'pe_ratio', 'reported_settle_price', 'implied_volatility_pct'],
  text: [...currentBars.text, 'name', 'sc_name', 'tc_name'],
  nullable: [...currentBars.nullable, 'market_date', 'volume', 'volume_precision', 'utc_offset_minutes', 'pe_ratio', 'open_interest',
    'reported_settle_price', 'implied_volatility_pct', 'name', 'sc_name', 'tc_name']
};
export const researchDisplaySchema = { 'read.calendar': calendar,
  ...Object.fromEntries(Object.entries(marketRestSpecs).map(([operation, spec]) =>
    [operation, { ...marketColumns[operation], units: researchRouteUnits(spec.method, spec.path) }])),
  ...Object.fromEntries(Object.entries(researchMapping.operations).map(([operation, spec]) => {
    const shape = operation === 'read.stock-screen'
      ? { columns: ['symbol', 'name', 'factors'], text: ['symbol', 'name'],
        nested: { factors: { columns: ['factor', 'raw', 'value'], text: ['factor'], exactIntegers: ['raw'], decimalText: ['value'] } } }
      : columns(spec);
    return [operation, { ...shape, units: researchRouteUnits(spec.method, spec.path), paged: Boolean(spec.pagination) || operation === 'read.stock-screen' }];
  }))
};
