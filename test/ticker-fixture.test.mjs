import assert from 'node:assert/strict';
import test from 'node:test';
import { sha } from '../runtime/core.mjs';
import { quote } from '../src/market.mjs';
import { marketRead } from '../src/market-reads.mjs';
import { captureTickerFixture } from '../scripts/export-ticker-fixture.mjs';

test('ticker fixture carries exact synthetic units through HTTP and MCP and reuses its ledger revision', async () => {
  const { digest, ...receipt } = await captureTickerFixture();
  assert.equal(digest, sha(receipt));
  assert.equal(receipt.price, quote('ALD.USD', Date.parse('2026-11-19T09:00:00Z')).last.toFixed(4));
  assert.equal(receipt.currency, 'USD');
  assert.equal(receipt.source, 'synthetic-market/v1');
  assert.equal(receipt.market_time_utc, '2026-11-19T09:00:00.000Z');
  assert.ok(Date.parse(receipt.observed_utc) >= Date.parse(receipt.market_time_utc));
  assert.equal(receipt.delay_class, 'unknown');
  assert.ok(receipt.ledger_revision > 0);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'currency', 'delay_class', 'ledger_revision', 'market_time_utc', 'observed_utc', 'operation',
    'price', 'request_id', 'schema', 'source', 'symbol'
  ]);
});

test('time selection is confined to the synthetic ticker and rejects invalid or future times', () => {
  const at = Date.parse('2026-11-19T09:00:00Z');
  const read = extra => marketRead('read.ticker', { symbol: 'ALD.USD', ...extra }, at).rows;
  assert.equal(read({}).at, at);
  for (const value of [null, 'unknown', '2026-11-20T09:00:00Z']) {
    assert.throws(() => read({ fixture_market_utc: value }), /INVALID_MARKET_TIME/);
  }
});
