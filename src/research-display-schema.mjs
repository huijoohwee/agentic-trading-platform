import { researchMapping } from '../runtime/moomoo-research.mjs';
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

export const researchDisplaySchema = { 'read.calendar': calendar,
  ...Object.fromEntries(Object.entries(researchMapping.operations).map(([operation, spec]) => {
    const shape = operation === 'read.stock-screen'
      ? { columns: ['symbol', 'name', 'factors'], text: ['symbol', 'name'],
        nested: { factors: { columns: ['factor', 'raw', 'value'], text: ['factor'], exactIntegers: ['raw'], decimalText: ['value'] } } }
      : columns(spec);
    return [operation, { ...shape, units: researchRouteUnits(spec.method, spec.path), paged: Boolean(spec.pagination) || operation === 'read.stock-screen' }];
  }))
};
