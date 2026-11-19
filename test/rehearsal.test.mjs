import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { archive, canonical, digest, MAX_ARCHIVE, readRehearsal, replay, restore, verifyRun } from '../src/replay.mjs';

const source = await readFile(new URL('../src/rehearsal.json',import.meta.url),'utf8');
const f = await readRehearsal(source);
const [a,b] = f.runs;
const practice = (events, fixture = f) => replay(fixture,'A',events);
const through = (tape,id) => tape.events.slice(0,tape.events.findIndex(e => e.id === id)+1);

test('paper terms and both ledgers match independently specified amounts and reasons', () => {
  for (const r of [a,b]) {
    const { snapshot, verifiedBoundaries } = verifyRun(f,r.id);
    assert.equal(verifiedBoundaries,59);
    assert.deepEqual(replay(f,r.id,[...r.events,...r.events]),snapshot);
    assert.equal(snapshot.net,snapshot.equity-100000000000);
    assert.equal(snapshot.account,r.account);
    assert.ok(snapshot.maxDrawdown > 0);
  }
  assert.equal(practice(a.events).maxDrawdown,14971162/100000000000);
  const scored = replay(f,'B');
  assert.equal(scored.maxDrawdown,100000000/100935371050);
  assert.equal(scored.drawdown,1006600/100935371050);
  const wrong = structuredClone(f);
  wrong.boundaries.find(x => x.name.includes('0.11')).expected--;
  assert.throws(() => verifyRun(wrong,'A'),/Option premium 0.11/);
  assert.equal(verifyRun(f,'B').snapshot.interest,1080000);
});

test('working partials stay reserved, fills are observed separately and cancel preserves cost history', () => {
  const approved = practice(through(a,'entry'));
  assert.equal(approved.executions.length,0);
  assert.equal(approved.cash,100000000000);
  const partial = practice(through(a,'duplicate'));
  assert.equal(partial.orders[0].qty-partial.orders[0].filled,96);
  assert.equal(partial.receipts.at(-1).reason,'WORKING_DUPLICATE');
  const end = practice(through(a,'close-partial'));
  assert.deepEqual(end.executions.map(e => [e.price,e.result]),[[24,'AT_LIMIT_OR_BETTER'],[26,'OFF_LIMIT']]);
  assert.equal(end.orders[0].filled,10);
  assert.equal(end.orders[0].status,'CANCELLED');
  assert.deepEqual(end.positions.TEST,{ qty:10,basis:250000000 });
  assert.equal(end.cash,99749010000);
  assert.equal(practice(through(a,'average-only')).receipts.at(-1).reason,'UNKNOWN_FILL_PRICE');
  assert.equal(practice(a.events).orders.at(-1).qty,1);
});

test('redelivered events and triggers cannot duplicate orders or silently change evidence', () => {
  const e = a.events.find(x => x.id === 'entry');
  const before = practice(through(a,'entry'));
  const reordered = Object.fromEntries(Object.entries(e).reverse());
  assert.deepEqual(practice([...through(a,'entry'),reordered]),before);
  assert.equal(practice(through(a,'retry')).orders.length,1);
  assert.throws(() => practice([...through(a,'entry'),{...e,limit:100}]),/Conflicting event ID/);
  assert.throws(() => practice([...through(a,'entry'),{...e,id:'retry',qty:1}]),/Conflicting trigger/);
  for (const patch of [{qty:2},{review:{...e.review,account:b.account}},{review:{...e.review,actor:a.roles.research}},
    {review:{...e.review,expiresAt:'2026-11-04T14:00:00Z'}}]) {
    assert.equal(practice([a.events[0],{...e,...patch}]).receipts.at(-1).reason,'UNBOUND_REVIEW');
  }
  assert.throws(() => practice([b.events[0]]),/binding/);
  assert.deepEqual(practice(through(a,'entry')),before);
});

// Deliver actual unique orders, partials, cancellations and open reservations up to each ceiling.
function candidate(n, at, symbol = 'TEST', qty = 1) {
  const e = structuredClone(a.events.find(x => x.id === 'entry'));
  e.at = at; e.id = 'order-'+n; e.trigger = e.id; e.review.intent=e.id; e.symbol=symbol;
  e.qty=qty; e.limit=20+n/1000; e.quote.observedAt=at; e.review.expiresAt=at;
  e.review.binding = ['A','SIMULATE',a.account,a.strategy,f.policy,f.evaluator,
    e.trigger,e.at,e.symbol,e.side,e.effect,e.qty,e.limit,e.action,e.priorHigh,e.closes,e.quote,e.volume];
  return e;
}
test('the ledger deduplicates executed order IDs and carries reservations across trading days', () => {
  const at = '2026-11-04T15:01:00Z', next = '2026-11-05T15:01:00Z';
  const events = [a.events[0]];
  for (let i=0;i<199;i++) {
    const o = candidate(i,at,'TEST',2); events.push(o);
    for (let j=0;j<2;j++) events.push({type:'fill',id:'fill-'+i+'-'+j,account:a.account,at,
      order:o.id,qty:1,price:20,feeMicros:j ? 0 : 990000});
  }
  events.push(candidate(199,at),candidate(200,at));
  let snapshot = practice(events);
  assert.deepEqual(snapshot.receipts.slice(-2).map(r => r.reason),['AWAIT_FILL','DAILY_CAP']);
  events.push({type:'cancel',id:'drop',account:a.account,at,order:'order-199'},candidate(201,at));
  events.push(candidate(202,next));
  snapshot = practice(events);
  assert.deepEqual(snapshot.receipts.slice(-3).map(r => r.reason),['REMAINDER_RELEASED','AWAIT_FILL','AWAIT_FILL']);
  assert.equal(snapshot.executions.length,398);
});
test('position slots count distinct held or pending symbols, and clear on a terminal readback', () => {
  const fixture = structuredClone(f), at = '2026-11-04T15:01:00Z', events=[a.events[0]];
  for (let i=0;i<101;i++) {
    const symbol='S'+i;
    fixture.assets[symbol]=f.assets.TEST;
    events.push(candidate(i,at,symbol));
  }
  assert.equal(practice(events,fixture).receipts.at(-1).reason,'POSITION_CAP');
  events.push({id:'drop',type:'cancel',order:'order-0',at,account:a.account}, candidate(101,at,'S100'));
  assert.equal(practice(events,fixture).receipts.at(-1).reason,'AWAIT_FILL');
});

test('forced liquidation, corporate events and exercise reconcile only to the observed readback', () => {
  const position = id => replay(f,'B',through(b,id)).positions;
  assert.deepEqual(position('forward').OLD,{qty:20,basis:250000000});
  assert.deepEqual(position('reverse').OLD,position('ticker').NEW);
  assert.deepEqual(position('credit'),{});
  assert.equal(position('expire-call').TEST.qty,200);
  assert.equal(position('expire-low').TEST.qty,300);
  assert.equal(replay(f,'B').ranked,100835371050);
  assert.equal(replay(f,'B').equity,100934364450);
  assert.equal(practice(through(a,'deficit')).positions.TEST.qty,5);
  assert.equal(practice(through(a,'forced')).positions.TEST.qty,3);
  const wrong = structuredClone(b.events);
  wrong.find(x => x.type === 'delistCredit').at='2026-11-09T15:00:00Z';
  assert.throws(() => replay(f,'B',wrong),/Delisting credit/);
  const fraud=structuredClone(b.events); fraud.at(-1).equityMicros+=1;
  assert.throws(() => replay(f,'B',fraud),/settlement mismatch/);
  const bad=structuredClone(a.events); bad.find(x => x.id==='checked').cashMicros++;
  assert.throws(() => practice(bad),/Readback mismatch/);
});

test('archive A restores original inputs, roles, decisions and equity after run B; edits fail atomically',async () => {
  const A=await archive(f,'A'), B=await archive(f,'B');
  assert.notEqual(A.sha256,B.sha256);
  assert.deepEqual(await restore(f,JSON.stringify(A)),A);
  assert.deepEqual(await restore(f,JSON.stringify(B)),B);
  for (const change of [p => p.tape.environment='LIVE', p => p.tape.account='other',
    p => p.snapshot.policy='other', p => p.snapshot.receipts.pop(), p => p.tape.secret='unexpected']) {
    const altered=structuredClone(A); change(altered);
    delete altered.sha256; altered.sha256=await digest(canonical(altered));
    await assert.rejects(restore(f,JSON.stringify(altered)),/integrity/);
  }
  await assert.rejects(restore(f,' '.repeat(MAX_ARCHIVE+1)),/exceeds/);
  await assert.rejects(readRehearsal(source+' '),/source/);
  assert.deepEqual(await archive(f,'A'),A);
});


test('expiry supports an observed cash-settled index close and rejects an inconsistent credit', () => {
  const fixture = structuredClone(f);
  fixture.assets.CALL.settlement = 'cash';
  fixture.assets.CALL.underlying = 'INDEX';
  fixture.assets.INDEX = {kind:'INDEX'};
  const events = structuredClone(through(b,'expire-call'));
  events.find(e => e.type === 'finalClose').prices.INDEX=30;
  events.at(-1).creditMicros=1000000000;
  const result = replay(fixture,'B',events);
  assert.equal(result.cash,100735371050);
  assert.equal(result.positions.INDEX,undefined);
  events.at(-1).creditMicros--;
  assert.throws(() => replay(fixture,'B',events),/Cash settlement mismatch/);
});

test('a synthetic SIMULATE binding and a sealed fixture are required to certify an archive',async () => {
  const other=structuredClone(f);
  other.runs[0].environment='LIVE';
  assert.throws(() => replay(other,'A'),/binding/);
  await assert.rejects(archive(other,'A'),/pinned fixture/);
});
