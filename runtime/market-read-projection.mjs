import { boundedJson, fail, id, requireThat } from './core.mjs';

const decimalPattern = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const datePattern = /^\d{4}-\d\d-\d\d$/;
const symbolPattern = /^[A-Z0-9_]+\.[A-Za-z0-9_.-]+$/;
const currencyPattern = /^[A-Z]{1,10}$/;
const dayMs = 86_400_000;
// The coefficient is a source string. Compare its decimal magnitude before any binary rounding.
function withinUnit(text) {
  const [mantissa, exponent = '0'] = text.replace(/^-/, '').toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  const places = digits.length - fraction.length + Number(exponent);
  return !digits || places < 1 || places === 1 && /^10*$/.test(digits);
}
const validDate = value => {
  if (typeof value !== 'string' || !datePattern.test(value)) return false;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
};
const readPath = (object, path, optional) => {
  requireThat(Array.isArray(path) && path.length > 0 && path.length <= 12, 'INVALID_MAPPING');
  let value = object;
  for (const key of path) {
    requireThat(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_MAPPING');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      if (optional) return undefined;
      fail('SOURCE_MAPPING_REQUIRED');
    }
    value = value[key];
  }
  return value;
};

function responseRows(body, spec) {
  if (spec.available) {
    const available = readPath(body, spec.available, false);
    requireThat(typeof available === 'boolean', 'INVALID_PAGE');
    if (!available) return [];
  }
  const raw = readPath(body, spec.rows_path, false);
  if (spec.groups) {
    return Object.entries(spec.groups).flatMap(([key, side]) => {
      const group = readPath(raw, [key], false);
      requireThat(Array.isArray(group) && group.length <= spec.group_limit &&
        group.every(item => item?.[spec.group_field] === side), 'INVALID_PAGE');
      return group;
    });
  }
  return spec.single_row ? [raw] : raw;
}

function project(raw, spec, body, inputs) {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_PAGE');
  if (!spec.fields) return { row: boundedJson(raw), precise: {} };
  const row = {}, precise = {};
  for (const [target, projection] of Object.entries(spec.fields)) {
    requireThat(id(target) && !['__proto__', 'prototype', 'constructor'].includes(target), 'INVALID_MAPPING');
    const optional = spec.nullable?.includes(target);
    const value = Object.hasOwn(projection, 'constant') ? projection.constant : readPath(projection.source === 'response' ? body : raw, projection.path, optional);
    if (value === undefined || value === null || spec.missing_values?.[target]?.includes(value)) {
      // A missing estimate stays null; it is never coerced to zero or interpolated.
      requireThat(optional, 'PRECISION_UNKNOWN');
      row[target] = null; continue;
    }
    if (spec.nested?.[target]) {
      requireThat(Array.isArray(value), 'INVALID_PAGE');
      const limit = spec.nested_limits?.[target];
      if (limit) requireThat(value.length <= (inputs[limit.input] ?? limit.fallback), 'INVALID_PAGE');
      row[target] = value.map(item => project(item, spec.nested[target], body, inputs).row);
    } else if (spec.decimal_text?.includes(target)) {
      requireThat(typeof value === 'string' && value.length <= 64 && decimalPattern.test(value), 'PRECISION_UNKNOWN');
      if (spec.unit_interval?.includes(target)) requireThat(withinUnit(value), 'INVALID_PAGE');
      row[target] = value;
    } else if (spec.wire_decimal?.includes(target)) {
      const validString = typeof value === 'string' && value.length <= 64 && decimalPattern.test(value);
      const validNumber = Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
      requireThat(validString || validNumber, 'PRECISION_UNKNOWN');
      row[target] = value;
    } else if (spec.currency?.includes(target)) {
      requireThat(typeof value === 'string' && currencyPattern.test(value), 'SOURCE_MAPPING_REQUIRED');
      row[target] = value;
    } else if (spec.numeric?.includes(target)) {
      const doubles = spec.provider_doubles === true || Array.isArray(spec.provider_doubles) && spec.provider_doubles.includes(target);
      const text = doubles && typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      requireThat(!Object.hasOwn(projection, 'constant') && typeof text === 'string' && text.length <= 64 && decimalPattern.test(text), 'PRECISION_UNKNOWN');
      precise[target] = text;
      const number = Number(text);
      requireThat(Number.isFinite(number), 'PRECISION_UNKNOWN');
      row[target] = number;
    } else if (spec.integer?.includes(target)) {
      // Unix-microsecond publication time: preserve the exact integer and refuse any precision loss.
      const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : null)
        : (typeof value === 'string' && /^\d{1,19}$/.test(value) ? value : null);
      requireThat(text !== null && Number.isSafeInteger(Number(text)), 'PRECISION_UNKNOWN');
      precise[target] = text; row[target] = Number(text);
    } else if (spec.exact_integer?.includes(target)) {
      const text = Number.isSafeInteger(value) ? String(value) : value;
      requireThat(typeof text === 'string' && /^-?\d{1,20}$/.test(text), 'PRECISION_UNKNOWN');
      const integer = BigInt(text);
      requireThat(integer >= -(1n << 63n) && integer < (1n << 63n), 'PRECISION_UNKNOWN');
      row[target] = text;
    } else if (spec.local_date?.includes(target)) {
      requireThat(typeof value === 'string' && /^\d{4}\/\d\d\/\d\d$/.test(value) &&
        validDate(value.replaceAll('/', '-')), 'PRECISION_UNKNOWN');
      row[target] = value;
    } else if (spec.opaque_ids?.includes(target)) {
      requireThat(Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0 && value.length <= 128, 'PRECISION_UNKNOWN');
      row[target] = String(value);
    } else if (spec.text?.includes(target)) {
      requireThat(typeof value === 'string', 'SOURCE_MAPPING_REQUIRED');
      row[target] = value;
    } else if (spec.date?.includes(target)) {
      requireThat(validDate(value), 'PRECISION_UNKNOWN');
      row[target] = value;
    } else row[target] = value;
  }
  if (spec.row_market) {
    const code = row[spec.row_market.field];
    requireThat(typeof code === 'string' && symbolPattern.test(code) &&
      code.startsWith(spec.row_market.market + '.'), 'SOURCE_MAPPING_REQUIRED');
  }
  for (const [key, values] of Object.entries(spec.allowed_values ?? {}))
    requireThat(values.includes(row[key]), 'SOURCE_MAPPING_REQUIRED');
  for (const [field, input] of Object.entries(spec.match_inputs ?? {}))
    if (inputs[input]) requireThat(row[field] === inputs[input], 'SOURCE_MAPPING_REQUIRED');
  for (const [field, filter] of Object.entries(spec.match_filters ?? {})) {
    const value = inputs[filter.input];
    if (value && value !== filter.all && (!filter.when || filter.when.includes(value)))
      requireThat(String(value).split(',').includes(row[field]), 'SOURCE_MAPPING_REQUIRED');
  }
  if (spec.market_input) {
    const { field, input } = spec.market_input;
    requireThat(symbolPattern.test(row[field]) && row[field].startsWith(inputs[input].split('_')[0] + '.'), 'SOURCE_MAPPING_REQUIRED');
  }
  if (spec.window?.field) {
    const { field, begin, end } = spec.window;
    requireThat((!inputs[begin] || row[field] >= inputs[begin]) && (!inputs[end] || row[field] <= inputs[end]), 'SOURCE_MAPPING_REQUIRED');
  }
  return { row, precise };
}

export function marketReadParameters(spec, inputs, strict = spec.strict_inputs) {
  if (strict) {
    const accepted = new Set(['grant', ...Object.values(spec.input_map), ...Object.keys(spec.fixed_inputs ?? {})]);
    if (spec.symbol_path) accepted.add('symbol');
    requireThat(Object.keys(inputs).every(key => accepted.has(key)), 'INVALID_PARAMETER');
  }
  for (const [key, expected] of Object.entries(spec.fixed_inputs ?? {})) {
    requireThat(inputs[key] === expected, 'INVALID_PARAMETER');
  }
  const parameters = {};
  for (const [parameter, inputKey] of Object.entries(spec.input_map ?? {})) {
    requireThat(id(parameter) && id(inputKey), 'SOURCE_MAPPING_REQUIRED');
    const rule = spec.params?.[parameter] ?? {};
    const present = Object.hasOwn(inputs, inputKey);
    requireThat(present || !rule.required, 'SOURCE_MAPPING_REQUIRED');
    if (!present) continue;
    const value = inputs[inputKey];
    if (rule.allow_empty && value === '') continue;
    if (rule.enum) requireThat(rule.enum.includes(value), 'INVALID_PARAMETER');
    else if (rule.symbols) {
      requireThat(typeof value === 'string' && value.length <= rule.symbols * 33, 'INVALID_PARAMETER');
      const codes = value.split(',');
      requireThat(codes.length <= rule.symbols && codes.every(code => code.length <= 32 && symbolPattern.test(code)), 'INVALID_PARAMETER');
    }
    else if (rule.currency) requireThat(typeof value === 'string' && currencyPattern.test(value), 'INVALID_PARAMETER');
    else if (rule.date) requireThat(validDate(value), 'INVALID_PARAMETER');
    else if (rule.length) requireThat(typeof value === 'string' && value.trim().length >= rule.length[0] &&
      [...value].length <= rule.length[1], 'INVALID_PARAMETER');
    else if (rule.integer) requireThat(Number.isSafeInteger(value) && value >= rule.integer[0] && value <= rule.integer[1], 'INVALID_PARAMETER');
    else requireThat(typeof value === 'string' && value.length <= 64, 'INVALID_PARAMETER');
    if (rule.symbol) requireThat(symbolPattern.test(value), 'INVALID_PARAMETER');
    if (rule.numeric_list) requireThat(/^[0-9]+(,[0-9]+)*$/.test(value), 'INVALID_PARAMETER');
    if (rule.one_of_list) requireThat(value.split(',').every(part => rule.one_of_list.includes(part)), 'INVALID_PARAMETER');
    parameters[parameter] = value;
  }
  if (spec.window) {
    const begin = inputs[spec.window.begin], end = inputs[spec.window.end];
    if (begin && end) {
      requireThat(validDate(begin) && validDate(end), 'INVALID_PARAMETER');
      const span = (Date.parse(end + 'T00:00:00Z') - Date.parse(begin + 'T00:00:00Z')) / dayMs + 1;
      requireThat(span >= 1 && (spec.window.max_days === undefined || span <= spec.window.max_days), 'INVALID_PARAMETER');
    }
  }
  if (spec.market_input) {
    const { filter, input } = spec.market_input;
    if (inputs[filter]) requireThat(inputs[filter].startsWith(inputs[input].split('_')[0] + '.'), 'INVALID_PARAMETER');
  }
  return parameters;
}

export function marketReadSymbol(spec, inputs) {
  const symbol = inputs.symbol;
  requireThat(typeof symbol === 'string' && symbol.length <= 32 && symbolPattern.test(symbol), 'INVALID_PARAMETER');
  if (spec.symbol_markets) requireThat(spec.symbol_markets.includes(symbol.split('.')[0]), 'UNSUPPORTED');
  return symbol;
}

export function projectMarketReadPage(spec, inputs, body) {
  requireThat(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_RESPONSE');
  const code = body[spec.response_code ?? 'ret_code'];
  if (spec.response_code && Object.hasOwn(body, 'ret_code')) requireThat(body.ret_code === code, 'INVALID_RESPONSE');
  requireThat(Number.isSafeInteger(code), 'INVALID_RESPONSE');
  const decimals = [];
  let rows;
  if (code === -10 && !spec.response_code) { rows = []; } // no_data is an empty observation, never invented rows
  else {
    if (spec.strict_inputs && code === -3) fail('INVALID_PARAMETER');
    if (code === -8) fail('UNSUPPORTED');
    if (code === -9) fail('SCOPE_DENIED');
    requireThat(code === 0, 'PROVIDER_ERROR');
    const raw = responseRows(body, spec);
    const limit = spec.row_limit ? inputs[spec.row_limit.input] ?? spec.row_limit.fallback
      : spec.series_limit ?? inputs.page_size ?? spec.default_page_size ?? 600;
    requireThat(Array.isArray(raw) && raw.length <= Math.min(600, limit), 'INVALID_PAGE');
    rows = raw.map(item => { const { row, precise } = project(item, spec, body, inputs); decimals.push(precise); return row; });
    if (spec.unique_by) requireThat(new Set(rows.map(row => row[spec.unique_by])).size === rows.length, 'INVALID_PAGE');
    if (spec.window?.max_distinct)
      requireThat(new Set(rows.map(row => row[spec.window.field])).size <= spec.window.max_distinct, 'INVALID_PAGE');
  }
  const metadata = {};
  if (spec.last_valid_ms) {
    const last = code === 0 ? readPath(body, spec.last_valid_ms, false) : null;
    requireThat(last === null || Number.isSafeInteger(last) && last >= 0, 'INVALID_PAGE');
    metadata.last_valid_time_ms = last;
  }
  if (spec.pagination_mode === 'next_key') {
    const page = code === 0 ? readPath(body, spec.pagination, false) : { has_more: false, next_key: '' };
    requireThat(typeof page?.has_more === 'boolean' && typeof page.next_key === 'string' &&
      page.next_key.length <= spec.cursor_limit && (!page.has_more || page.next_key && page.next_key !== inputs.next_key), 'INVALID_PAGE');
    metadata.pagination = { completed: !page.has_more, next_cursor: page.has_more ? page.next_key : null };
  } else if (spec.pagination) {
    const page = code === 0 ? readPath(body, spec.pagination, false) : { completed: true, page_flag: '', ...(spec.optional_total ? {} : { total: 0 }) };
    const total = spec.total_path && code === 0 ? readPath(body, spec.total_path, false) : page?.total;
    const size = spec.total_series ? Math.max(0, ...rows.map(row => row[spec.total_series].length)) : rows.length;
    requireThat(typeof page?.completed === 'boolean' && typeof page.page_flag === 'string' &&
      page.page_flag.length <= (spec.cursor_limit ?? 64) && (page.completed ? page.page_flag === '' : page.page_flag.length > 0 &&
        page.page_flag !== inputs.page_flag) && (spec.optional_total === true && !Object.hasOwn(page, 'total') ||
      Number.isSafeInteger(total) && total >= size), 'INVALID_PAGE');
    metadata.pagination = { completed: page.completed, next_cursor: page.completed ? null : page.page_flag,
      ...(total !== undefined && { total }) };
  }
  return { rows, decimals, ...metadata };
}
