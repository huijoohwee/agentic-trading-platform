import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha } from '../runtime/core.mjs';
import { marketRead } from '../src/market-reads.mjs';
import { captureCalendarFixture } from '../scripts/export-calendar-fixture.mjs';

test('the synthetic calendar read preserves market-local dates, microsecond time and null estimates', () => {
  const at = Date.parse('2026-11-20T15:00:00Z');
  const { rows } = marketRead('read.calendar', { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-21' }, at);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].earnings_date, '2026-11-19');
  assert.equal(rows[2].earnings_date, '2026-11-21');
  assert.ok(Number.isSafeInteger(rows[0].earnings_timestamp));
  assert.equal(rows[0].earnings_timestamp, Date.parse('2026-11-19T13:30:00Z') * 1000);
  assert.equal(rows[0].eps_actual, 1.25);
  assert.equal(rows[1].eps_actual, null);
  assert.equal(rows[1].published, false);
  assert.match(rows[0].price, /^\d+\.\d{4}$/);
  assert.throws(() => marketRead('read.calendar', { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-27' }, at), /INVALID_PARAMETER/);
});

test('the calendar fixture exports a checksummed synthetic receipt with HTTP/MCP parity and no external call', async t => {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'the calendar fixture must never call a provider');
    return realFetch(url, options);
  });
  const receipt = await captureCalendarFixture();
  assert.equal(receipt.schema, 'trading-calendar-fixture/v1');
  assert.equal(receipt.operation, 'read.calendar');
  assert.equal(receipt.source, 'synthetic-market/v1');
  assert.equal(receipt.market, 'US');
  assert.equal(receipt.earnings_date, '2026-11-20');
  assert.ok(Number.isSafeInteger(receipt.earnings_timestamp));
  assert.equal(receipt.eps_actual, null);
  assert.equal(receipt.eps_predict, 1.3);
  assert.match(receipt.price, /^\d+\.\d{4}$/);
  assert.equal(receipt.published, false);
  assert.ok(Number.isSafeInteger(receipt.ledger_revision) && receipt.ledger_revision >= 1);
  const { digest, ...body } = receipt;
  assert.equal(digest, sha(body));
  const text = JSON.stringify(receipt, null, 2) + '\n';
  assert.ok(Buffer.byteLength(text) <= 4096);
  assert(!text.includes('PRIVATE KEY') && !text.includes('fixture-token'));
  if (process.env.TRADING_CALENDAR_TEST_OUTPUT) {
    await writeFile(join(process.env.TRADING_CALENDAR_TEST_OUTPUT, 'calendar.json'), text, { mode: 0o600 });
  }
});