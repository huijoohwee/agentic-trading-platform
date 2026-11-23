import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moomooQuote } from '../scripts/moomoo-quote.mjs';

const file = new URL('../qualification/moomoo/sdk-replay.json',import.meta.url);
test('the Trading reader accepts the serialized SDK response as a labelled replay', async () => {
  const quote = await moomooQuote(['replay','HK.00700',file]);
  assert.equal(quote.price,'302.25'); assert.equal(quote.marketTimeUtc,'2023-11-14T22:13:20.125Z');
  assert.equal(quote.currency,null); assert.equal(quote.evidence,'replay');
  await assert.rejects(moomooQuote(['replay','US.AAPL',file]), /SECURITY_MISMATCH/);
});
test('a live read requires explicit entitlement and a valid loopback port', async () => {
  await assert.rejects(moomooQuote(['snapshot','HK.00700','--port=11111']), /Usage/);
  await assert.rejects(moomooQuote(['snapshot','HK.00700','--entitled-zero-cost','--port=65536']),/INVALID_PORT/);
});
