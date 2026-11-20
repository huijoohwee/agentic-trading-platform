import { utcMillis } from './rules.mjs';

const number = Number.isFinite;
const positive = n => number(n) && n > 0;
const nonnegative = n => number(n) && n >= 0;
const text = s => typeof s === 'string' && s.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/.test(s);
const instant = s => utcMillis(s) !== null;
const currency = s => typeof s === 'string' && /^[A-Z]{3}$/.test(s);
const oneOf = (...values) => value => values.includes(value);
const schemas = {
  IN_Quotes: { key: 'symbol_key', max: 500, fields: { symbol_key: text, market: text, ccy: currency, last: positive,
    prev_close: positive, quote_ts_utc: instant, source_id: oneOf('MANUAL'), delay_class: oneOf('realtime','delayed','unknown') } },
  IN_Positions: { key: 'symbol_key', max: 500, fields: { account_alias: text, symbol_key: text, qty: nonnegative,
    avg_cost: nonnegative, ccy: currency, as_of_utc: instant } },
  IN_Balance: { key: 'ccy', max: 20, fields: { account_alias: text, ccy: currency, cash: number, total_assets: number, as_of_utc: instant } },
  IN_Orders: { key: 'broker_order_id', max: 2000, fields: { broker_order_id: text, account_alias: text, symbol_key: text,
    side: oneOf('BUY','SELL'), order_type: oneOf('LIMIT'), qty: positive, limit_price: positive,
    status_src: oneOf('WORKING','PARTIAL','FILLED','CANCELLED','REJECTED','EXPIRED'), filled_qty: nonnegative,
    avg_fill_price: n => n === null || positive(n), created_utc: instant, updated_utc: instant } },
};

// Per-sheet uniqueness is scoped to one fixture run and account. All copies of a duplicate are invalid.
export function readLanding(snapshot, { quoteSource = 'MANUAL' } = {}) {
  if (!['MANUAL', 'PROVIDER'].includes(quoteSource)) throw Error('Invalid quote source contract');
  if (!text(snapshot?.run_id) || !text(snapshot.account_alias)) throw Error('Missing run or account alias');
  const accepted = {}, invalid = [];
  for (const [sheet, { key, max, fields }] of Object.entries(schemas)) {
    const rows = snapshot[sheet];
    // Import staging allows rejected rows. The logical sheet limit applies to accepted rows.
    if (!Array.isArray(rows) || rows.length > max + 50) throw Error('Missing or oversized ' + sheet);
    const counts = new Map();
    for (const row of rows) counts.set(row?.[key], (counts.get(row?.[key]) ?? 0) + 1);
    accepted[sheet] = rows.filter((row, index) => {
      let reason;
      if (!row || row.run_id !== snapshot.run_id || ('account_alias' in fields && row.account_alias !== snapshot.account_alias))
        reason = 'WRONG_SCOPE';
      else if (Object.keys(row).some(field => field !== 'run_id' && !Object.hasOwn(fields, field)) ||
          Object.entries(fields).some(([field, valid]) => field === 'source_id' ? row[field] !== quoteSource : !valid(row[field]))) reason = 'INVALID_FIELD';
      else if (counts.get(row[key]) !== 1) reason = 'DUPLICATE_KEY';
      else if ((row.as_of_utc ?? row.updated_utc ?? row.quote_ts_utc) > snapshot.evaluated_utc) reason = 'FUTURE_INPUT';
      else if (sheet === 'IN_Orders' && (row.created_utc > row.updated_utc ||
          (row.status_src === 'FILLED' && row.filled_qty < row.qty) ||
          (row.status_src === 'PARTIAL' && (row.filled_qty <= 0 || row.filled_qty >= row.qty)))) reason = 'INVALID_ORDER';
      if (reason) invalid.push({ sheet, row: index + 1, reason });
      return !reason;
    });
    if (accepted[sheet].length > max) throw Error('Accepted rows exceed ' + sheet + ' capacity');
  }
  return { ...accepted, invalid };
}

// Compute with the decimal spelling of each finite JSON number. A product is a list of factors.
// Keep the base-10 exponent until comparison so an exact limit cannot move across a binary rounding boundary.
function decimalSum(products) {
  let units = 0n, exponent = 0;
  for (const factors of products) {
    let product = 1n, power = 0;
    for (const factor of factors) {
      if (!number(factor)) return null;
      const [mantissa, shift = '0'] = String(factor).split('e');
      const fraction = mantissa.split('.')[1] ?? '';
      product *= BigInt(mantissa.replace('.', ''));
      power += Number(shift) - fraction.length;
    }
    const common = Math.min(exponent, power);
    units = units * 10n ** BigInt(exponent - common) + product * 10n ** BigInt(power - common);
    exponent = common;
  }
  return { units, exponent };
}
export function decimalSign(products) {
  const sum = decimalSum(products);
  if (!sum) throw Error('Missing decimal input');
  return sum.units < 0n ? -1 : sum.units > 0n ? 1 : 0;
}
export function decimalValue(products) {
  const sum = decimalSum(products);
  if (!sum) return null;
  const value = Number(String(sum.units) + 'e' + sum.exponent);
  // A JSON number in the report must round-trip to the exact decimal total.
  return number(value) && decimalSign([...products, [-value]]) === 0 ? value : null;
}

export function portfolio(rows, fx, evaluatedAt) {
  const quotes = new Map(rows.IN_Quotes.map(row => [row.symbol_key, row]));
  const bad = name => rows.invalid.some(row => row.sheet === name);
  const cashValues = rows.IN_Balance.map(row => [row.cash, positive(fx[row.ccy]) ? fx[row.ccy] : null]);
  const positions = rows.IN_Positions.filter(row => row.qty > 0).map(row => {
    const q = quotes.get(row.symbol_key), rate = fx[row.ccy];
    const flags = [];
    if (!q || q.ccy !== row.ccy) flags.push('NO_QUOTE');
    if (q && q.quote_ts_utc > evaluatedAt) flags.push('FUTURE_QUOTE');
    if (!positive(rate)) flags.push('FX_MISSING');
    return { symbol: row.symbol_key, quantity: row.qty, flags,
      value: flags.length ? null : decimalValue([[row.qty, q.last, rate]]),
      dayPnl: flags.length ? null : decimalValue([[row.qty, q.last, rate], [-row.qty, q.prev_close, rate]]) };
  });
  const cash = !bad('IN_Balance') && cashValues.length ? decimalValue(cashValues) : null;
  const equity = bad('IN_Positions') ? null : decimalValue([[cash], ...positions.map(row => [row.value])]);
  const dayPnl = bad('IN_Positions') ? null : decimalValue(positions.map(row => [row.dayPnl]));
  return { cash, equity, dayPnl, positions, openCount: bad('IN_Positions') ? null : positions.length };
}

// Rehearse read-only ingestion with a caller-supplied synthetic adapter. No provider SDK or credentials.
export function rehearseImport(seed, adapter, { callHeadroom, hardCapUsd, now } = {}) {
  const started = now?.(), sheets = Object.keys(schemas);
  const landing = Object.fromEntries(sheets.map(sheet => [sheet, []]));
  let calls = 0, errors = 0;
  const cost = () => ({ run_id: seed.run_id, source:'OFFLINE_FIXTURE', tool_calls:calls, tokens_in:0,
    tokens_out:0, provider_fees:0, active_min:(now() - started) / 60_000 });
  const stop = reason => ({ ok:false, reason, cost:cost() });
  if (!Number.isFinite(started) || typeof now !== 'function') throw Error('Missing fixture clock');
  if (seed.halt !== 'RUN') return stop('IMPORT_HALTED');
  if (seed.source !== 'SYNTHETIC' || hardCapUsd !== 0 || !Number.isSafeInteger(callHeadroom) || callHeadroom < sheets.length)
    return stop('BUDGET_HALT');
  if (!Array.isArray(adapter?.capabilities) || adapter.capabilities.length !== sheets.length ||
      !sheets.every(sheet => adapter.capabilities.includes(sheet))) return stop('SCOPE_DENIED');
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const sheet of sheets) {
    let cursor = null;
    const seen = new Set();
    let complete = false;
    while (calls < 12) {
      if (calls >= Math.min(12, callHeadroom)) return stop('BUDGET_HALT');
      if (now() < started || now() - started >= 600_000) return stop('WINDOW_CLOSED');
      calls++;
      let page;
      try { page = adapter.read({ sheet, cursor, run:seed.run_id, account:seed.account_alias, limit:50 }); }
      catch (error) {
        if (error.code === 'SCOPE_DENIED') return stop(error.code);
        if (++errors === 2) return stop('TWO_READ_ERRORS');
        continue;
      }
      if (now() < started || now() - started >= 600_000) return stop('WINDOW_CLOSED');
      errors = 0;
      if (!page || !Array.isArray(page.rows) || page.rows.length > 50 ||
          (page.next !== null && (!text(page.next) || seen.has(page.next)))) return stop('INVALID_PAGE');
      bytes += encoder.encode(JSON.stringify(page.rows)).length;
      if (bytes > 480_000) return stop('INPUT_TOO_LARGE');
      landing[sheet].push(...page.rows);
      cursor = page.next;
      if (cursor !== null) seen.add(cursor);
      if (cursor === null) { complete = true; break; }
    }
    if (!complete) return stop('BUDGET_HALT');
  }
  const input = { ...seed, ...landing }, rows = readLanding(input);
  if (rows.invalid.length) return stop('INVALID_ROWS');
  const symbols = new Set([...rows.IN_Quotes, ...rows.IN_Positions, ...rows.IN_Orders].map(row => row.symbol_key));
  if (symbols.size > 50 || rows.IN_Orders.some(row => utcMillis(seed.evaluated_utc) - utcMillis(row.created_utc) > 30 * 86_400_000))
    return stop('SCOPE_DENIED');
  return { ok:true, input, manifest:{ run_id:seed.run_id, account_alias:seed.account_alias,
    rows:Object.fromEntries(sheets.map(sheet => [sheet,rows[sheet].length])) }, cost:cost() };
}
