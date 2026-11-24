import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { moomooQuote } from '../scripts/moomoo-quote.mjs';

const file = new URL('../qualification/moomoo/sdk-replay.json',import.meta.url);
test('the Trading reader accepts the serialized SDK response as a labelled replay', async () => {
  const quote = await moomooQuote(['replay','HK.00700',file]);
  assert.equal(quote.price,'302.25'); assert.equal(quote.marketTimeUtc,'2023-11-14T22:13:20.125Z');
  assert.equal(quote.bid,null); assert.equal(quote.ask,null);
  assert.equal(quote.currency,null); assert.equal(quote.evidence,'replay');
  await assert.rejects(moomooQuote(['replay','US.AAPL',file]), /SECURITY_MISMATCH/);
});
test('a live read requires explicit entitlement and a valid loopback port', async () => {
  await assert.rejects(moomooQuote(['snapshot','HK.00700','--port=11111']), /Usage/);
  await assert.rejects(moomooQuote(['snapshot','HK.00700','--entitled-zero-cost','--port=65536']),/INVALID_PORT/);
});

test('Trading discovers capabilities without SDK, network, grant or dispatch', async () => {
  const records = await moomooQuote(['discover']);
  const video = records.find(r => r.manifest.id === 'media/hyperframes-import');
  const trading = records.find(r => r.manifest.id === 'trading/moomoo-snapshot');
  assert.deepEqual(video.routes[0].missing,['browser-dom','hyperframes-importer']);
  assert.deepEqual(trading.routes[0],{route:'replay',available:true,missing:[]});
  assert.equal(trading.routes[1].available,false);
});

test('the file reader preserves two-sided and one-sided replays independently', async t => {
  const dir = await mkdtemp(join(tmpdir(),'moomoo-sides-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const path = join(dir,'snapshot.json');
  const snapshot = JSON.parse(await readFile(file,'utf8'));
  const basic = snapshot.s2c.snapshotList[0].basic;
  basic.bidPrice = 302.1;
  basic.askPrice = 302.4;
  await writeFile(path,JSON.stringify(snapshot));
  const {bid,ask} = await moomooQuote(['replay','HK.00700',path]);
  assert.deepEqual([bid,ask],['302.1','302.4']);
  delete basic.askPrice;
  await writeFile(path,JSON.stringify(snapshot));
  const oneSide = await moomooQuote(['replay','HK.00700',path]);
  assert.deepEqual([oneSide.bid,oneSide.ask],['302.1',null]);
});


test('replay accepts four offline market frame types and rejects an unknown topic or symbol', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moomoo-push-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'frame.json'), symbol = 'US.AAPL';
  const run = async (type, data, selected = symbol) => {
    await writeFile(path, JSON.stringify({ symbol, type, data }));
    return moomooQuote(['replay', selected, path]);
  };
  assert.equal((await run('QUOTE', { last_price: 180.12 })).last, '180.12');
  assert.deepEqual((await run('ORDER_BOOK', { bid_list: [], ask_list: [] })).bids, []);
  assert.deepEqual((await run('TICKER', { ticker_list: [] })).ticks, []);
  assert.deepEqual((await run('KLINE', { period: '1D', adjust: 'none', kl_list: [] })).bars, []);
  await assert.rejects(run('QUOTE', { last_price: 180.12 }, 'HK.00700'), /SECURITY_MISMATCH/);
  await assert.rejects(run('MARKET_STATE', {}), /UNSUPPORTED_PUSH_TYPE/);
});
