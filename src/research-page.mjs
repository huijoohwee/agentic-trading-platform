import { canonical, digest } from './rules.mjs';
import { researchDisplaySchema } from './research-display-schema.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
function check(ok, message = 'The file contains an invalid research result.') {
  if (!ok) throw Error(message);
}
function isoTime(ms) {
  check(Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15);
  return new Date(ms).toISOString();
}
function projectRow(source, schema, precise = {}) {
  check(object(source) && object(precise));
  const row = {};
  const optional = (schema.optional ?? []).filter(key => Object.hasOwn(source, key));
  for (const key of [...schema.columns, ...optional]) {
    check(Object.hasOwn(source, key));
    const value = source[key];
    check(value !== null || schema.nullable?.includes(key) || optional.includes(key));
    if (schema.nested?.[key]) {
      check(Array.isArray(value));
      row[key] = value.map(item => projectRow(item, schema.nested[key]));
    } else if (Object.hasOwn(precise, key)) {
      const exact = precise[key];
      check(typeof exact === 'string' && exact.length <= 64 && decimal.test(exact) &&
        Number.isFinite(value) && Number(exact) === value, 'A source decimal disagrees with its projected value.');
      row[key] = exact;
    } else {
      check(value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value));
      check(value === null || !schema.decimals?.includes(key), 'A source decimal is missing.');
      check(!Number.isInteger(value) || Number.isSafeInteger(value), 'An integer has lost source precision.');
      row[key] = value;
    }
    if (value !== null) {
      if (schema.integers?.includes(key)) check(Number.isSafeInteger(value));
      if (schema.text?.includes(key)) check(typeof value === 'string');
      if (schema.booleans?.includes(key)) check(typeof value === 'boolean');
      if (schema.exactIntegers?.includes(key)) check(typeof value === 'string' && /^-?\d{1,20}$/.test(value));
      if (schema.decimalText?.includes(key)) check(typeof value === 'string' && decimal.test(value));
    }
  }
  return row;
}

function pagination(page, required, operation, rows) {
  if (page === undefined && !required) return null;
  check(object(page) && typeof page.completed === 'boolean');
  check(page.completed ? page.next_cursor === null : typeof page.next_cursor === 'string' &&
    page.next_cursor.length > 0 && page.next_cursor.length <= 1000, 'Invalid continuation cursor.');
  if (Object.hasOwn(page, 'total')) check(Number.isSafeInteger(page.total) && page.total >= 0);
  if (operation === 'read.candle-history') {
    const { next_page_token: token, next_time: time } = page;
    check(token === null || (typeof token === 'string' && /^[0-9a-f]{48}$/.test(token)));
    check(time === null || (Number.isSafeInteger(time) && time !== 0 && Math.abs(time) <= 8.64e15));
    check(page.next_cursor === (token ?? time?.toString() ?? null));
    check(page.completed || rows.length > 0);
    check(time === null || rows.every(row => time <= row.time_ms));
    return { completed: page.completed, cursor: page.next_cursor, total: null, token, nextTime: time };
  }
  return { completed: page.completed, cursor: page.next_cursor, total: page.total ?? null };
}

export async function exampleCalendarPage() {
  const { marketRead } = await import('./market-reads.mjs');
  const operation = 'read.calendar', schema = researchDisplaySchema[operation];
  const inputs = { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-21' };
  const example = marketRead(operation, inputs, Date.UTC(2026, 10, 19));
  return { operation, binding: example.source, units: schema.units, rows: example.rows.map(row => projectRow(row, schema)) };
}

export async function readResearchPage(file) {
  check(object(file));
  if (file.schema === 'trading-calendar-fixture/v1') {
    const { digest: checksum, ...body } = file;
    check(body.operation === 'read.calendar' && body.source === 'synthetic-market/v1' && typeof checksum === 'string');
    check(await digest(canonical(body)) === checksum, 'The calendar fixture checksum does not match.');
    check(Number.isSafeInteger(body.ledger_revision) && body.ledger_revision >= 1);
    const schema = researchDisplaySchema[body.operation];
    return { operation: body.operation, binding: 'Synthetic calendar export', revision: body.ledger_revision,
      units: schema.units, rows: [projectRow(body, schema)], pagination: null };
  }
  let envelope = file;
  if (Object.hasOwn(file, 'jsonrpc')) {
    check(file.jsonrpc === '2.0' && file.result?.isError === false && !Object.hasOwn(file, 'error'),
      'Expected a successful Gateway MCP tool result.');
    envelope = file.result.structuredContent;
  }
  check(envelope?.status === 'OK' && object(envelope.provenance) && object(envelope.data),
    'Expected a successful Gateway research result.');
  const { data, provenance, ledger_revision: revision } = envelope;
  const { operation, provider, source } = provenance;
  check(Object.hasOwn(researchDisplaySchema, operation), 'This operation has no research display mapping.');
  check(typeof provider === 'string' && provider.length > 0 && provider.length <= 128 &&
    Number.isSafeInteger(revision) && revision >= 1);
  const mock = source === 'MOCK' && data.source === 'synthetic-market/v1' && operation === 'read.calendar';
  check(mock || (source === 'PROVIDER' && data.source === 'AUTHENTICATED_ADAPTER'), 'Unrecognized Gateway research source.');
  const schema = researchDisplaySchema[operation];
  check(Array.isArray(data.rows) && data.rows.length <= (schema.rowLimit ?? 600));
  check((mock && data.decimals === undefined) || (Array.isArray(data.decimals) && data.decimals.length === data.rows.length),
    'The source decimals do not match the page.');
  const observed = isoTime(data.at);
  const symbol = data.market?.symbol;
  check(symbol == null || typeof symbol === 'string' && symbol.length <= 128);
  const rows = data.rows.map((row, i) => projectRow(row, schema, data.decimals?.[i]));
  if (operation === 'read.candle-history') check(rows.every(row => Math.abs(row.time_ms) <= 8.64e15));
  return { operation, binding: provider + ' · ' + source, observed, symbol, revision, units: schema.units,
    rows, pagination: pagination(data.pagination, schema.paged, operation, rows),
    ...(Object.hasOwn(data, 'last_valid_time_ms') && {
      lastValid: data.last_valid_time_ms === null ? null : isoTime(data.last_valid_time_ms) }) };
}
