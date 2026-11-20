import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvalDigest, auditSnapshot, restoreAudit } from '../src/local-audit.mjs';
import { readLanding } from '../src/landing.mjs';

const fixture = JSON.parse(await readFile(new URL('../src/audit-fixture.json', import.meta.url)));
const fresh = () => structuredClone(fixture);
const evaluate = async change => {
  const input = fresh();
  change(input, input.tickets[0]);
  return auditSnapshot(input);
};
test('literal landing rows exclude a duplicate pair, wrong type, formula and impossible date per sheet', () => {
  const input = fresh();
  for (const [sheet, key, date, amount] of [
    ['IN_Quotes','symbol_key','quote_ts_utc','last'], ['IN_Positions','symbol_key','as_of_utc','qty'],
    ['IN_Balance','ccy','as_of_utc','cash'], ['IN_Orders','broker_order_id','created_utc','qty'],
  ]) {
    const seed = input[sheet][0];
    const row = i => ({ ...seed, [key]: sheet === 'IN_Balance' ? 'AA' + String.fromCharCode(65+i) : 'symbol-' + i });
    input[sheet] = [...Array.from({ length:20 }, (_,i) => row(i)), row(20), row(20),
      { ...row(21), [amount]:'3' }, { ...row(22), [key]:'=value' }, { ...row(23), [date]:'2026-02-30T00:00:00Z' }];
  }
  const rows = readLanding(input);
  for (const sheet of Object.keys(input).filter(key => key.startsWith('IN_'))) {
    assert.equal(rows[sheet].length,20);
    assert.equal(rows.invalid.filter(r => r.sheet === sheet).length,5);
  }
  for (const prefix of ['=','+','-','@']) {
    const bad = fresh(); bad.IN_Quotes[0].symbol_key = prefix + 'SUM(A1)';
    assert.equal(readLanding(bad).invalid[0].reason,'INVALID_FIELD');
  }
  assert.deepEqual(rows,readLanding(input));
});

test('R01–R09 compare with an independently evaluated decimal oracle on boundary cases', async () => {
  const cases = [fresh()];
  const variants = [
    s => s.evaluated_utc = '2026-11-19T09:05:01Z', s => s.tickets[0].rationale = '',
    s => s.policy.maxPositionPct = 7.5, s => s.policy.maxPositionPct = 7.49,
    s => s.tickets[0].stop_price = 25, s => s.policy.maxRiskPct = 0.2, s => s.policy.maxRiskPct = 0.19,
    s => s.policy.minCashPct = 95, s => { s.IN_Positions = []; s.policy.maxPositions = 0; },
    s => { s.IN_Quotes[0].prev_close = 30; }, s => { s.tickets.push({ ...s.tickets[0], ticket_id:'draft-2',
      submitted_utc:null, broker_order_id:null }); }, s => s.tickets[0].limit_price = 27,
    s => { s.IN_Quotes[0].last=0.3; s.tickets[0].limit_price=0.33; s.policy.priceBandPct=10; },
    s => { s.IN_Quotes[0].last=0.3; s.tickets[0].limit_price=0.330001; s.policy.priceBandPct=10; },
    s => delete s.fx.USD, s => s.policy.maxRiskPct = null, s => s.halt = 'HALT',
    s => { s.tickets[0].side = 'SELL'; s.tickets[0].qty = 21; }, s => s.IN_Quotes[0].delay_class = 'unknown',
  ];
  for (const change of variants) { const input=fresh(); change(input); cases.push(input); }
  const oraclePath = fileURLToPath(new URL('./cash-oracle.py', import.meta.url));
  const oracle = JSON.parse(execFileSync('python3',[oraclePath], { input: JSON.stringify(cases), encoding:'utf8' }));
  for (const [i, input] of cases.entries()) {
    const { decisions:[decision] } = await auditSnapshot(input);
    assert.deepEqual(Object.values(decision.checks), oracle[i].checks, 'case ' + i);
    assert.equal(decision.outcome, oracle[i].outcome);
  }
});
test('reconciliation requires explicit IDs and individual fills, retains partials and detects overfill', async () => {
  const base = await auditSnapshot(fresh());
  assert.deepEqual(base.orphanOrders,['order-unbound']);
  assert.equal(base.decisions[0].match,'PRICE_OUT_OF_LIMIT');
  const match = async (mutate, expected) => assert.equal((await evaluate(mutate)).decisions[0].match, expected);
  await match(s => s.executions[1].price=25,'MATCHED');
  await match(s => s.executions=[],'INSUFFICIENT_EVIDENCE');
  await match(s => s.IN_Orders[0].side='SELL','SIDE_DIFF');
  await match(s => s.IN_Orders[0].symbol_key='OTHER','SYMBOL_DIFF');
  await match(s => s.IN_Orders[0].filled_qty=11,'OVERFILL');
  await match(s => s.tickets[0].broker_order_id=null,'SUBMITTED_WITHOUT_EVIDENCE');
  await match(s => s.tickets[0].broker_order_id='missing','ORDER_NOT_FOUND');
  for (const [status, expected] of [['PARTIAL','PARTIAL_OPEN'],['CANCELLED','PARTIAL_CLOSED']]) {
    await match(s => { s.IN_Orders[0].status_src=status; s.IN_Orders[0].filled_qty=5; s.executions.pop(); },expected);
  }
  await assert.rejects(evaluate(s => s.executions.push({...s.executions[0],price:30})),/Conflicting execution/);
});
test('approval binds recorded terms, and audit restore requires its independently kept witness', async () => {
  const input = fresh(), ticket = input.tickets[0];
  ticket.approved_utc=input.evaluated_utc; ticket.approved_by='fixture-owner'; ticket.approval_nonce='approval-1';
  const before = await auditSnapshot(input);
  ticket.approved_key = await approvalDigest(ticket,before.sourceDigest);
  const audit = await auditSnapshot(input), pack = {input,audit};
  assert.deepEqual(audit.decisions[0].flags,[]);
  assert.deepEqual(await restoreAudit(pack,audit.witness),audit);
  const changed = structuredClone(input); changed.tickets[0].limit_price=100;
  const newer = await auditSnapshot(changed);
  assert.deepEqual(newer.decisions[0].flags,['APPROVED_WITH_FAIL','EDIT_AFTER_APPROVAL']);
  await assert.rejects(restoreAudit({input:changed,audit:newer},audit.witness),/retained witness/);
  for (const alter of [p=>p.audit.events.pop(),p=>p.audit.events[0].decision.id='altered',p=>p.input.run_id='another']) {
    const tampered=structuredClone(pack); alter(tampered); await assert.rejects(restoreAudit(tampered,audit.witness));
  }
  const beforeRestore = await auditSnapshot(input);
  assert.deepEqual(beforeRestore,audit);
});
test('missing prices and FX keep equity unknown, working partials count as duplicates, and delayed evidence is flagged', async () => {
  for (const change of [s=>s.IN_Quotes=[], s=>delete s.fx.USD, s=>s.IN_Positions[0].qty='20']) {
    const report = await evaluate(change);
    assert.equal(report.totals.equity,null);
    assert.equal(report.decisions[0].checks.R03,'UNKNOWN');
  }
  for (const [status, expected] of [['PARTIAL','FAIL'],['CANCELLED','PASS']]) {
    const report = await evaluate(s=>{
      s.IN_Orders[0].status_src=status; s.IN_Orders[0].filled_qty=5; s.executions.pop();
      s.tickets.push({...s.tickets[0], ticket_id:'next', broker_order_id:null, submitted_utc:null});
    });
    assert.equal(report.decisions[1].checks.R08,expected);
  }
  const late = await evaluate((s,t)=>{ t.broker_order_id=null; s.evaluated_utc='2026-11-19T09:07:01Z'; });
  assert.ok(late.decisions[0].flags.includes('NO_BROKER_EVIDENCE'));
  await assert.rejects(evaluate((s,t)=>{ t.supersedes='next'; s.tickets.push({...t,ticket_id:'next',
    broker_order_id:null,supersedes:t.ticket_id}); }),/Invalid supersession/);
});

test('a bounded fixture import discards partial staging on scope, time, budget or repeated errors', async () => {
  const { rehearseImport } = await import('../src/landing.mjs');
  const s = fresh(), capabilities = Object.keys(s).filter(key => key.startsWith('IN_'));
  const ok = ({sheet}) => ({ rows:s[sheet],next:null });
  const run = (read, overrides={}, caps=capabilities) => rehearseImport(s,{capabilities:caps,read},
    {callHeadroom:12,hardCapUsd:0,now:()=>0,...overrides});
  const success = await run(ok);
  assert.deepEqual(success.input,s); assert.equal(success.cost.tool_calls,4);
  function denied(report, reason, calls) {
    assert.equal(report.reason,reason); assert.equal(report.cost.tool_calls,calls); assert.equal(report.input,undefined);
  }
  for (const halt of ['HALT', null]) {
    s.halt = halt;
    denied(await run(ok),'IMPORT_HALTED',0);
  }
  s.halt = 'RUN';
  denied(await run(ok,{hardCapUsd:null}),'BUDGET_HALT',0);
  denied(await run(ok,{},[...capabilities,'place-order']),'SCOPE_DENIED',0);
  denied(await run(()=>{ throw Object.assign(Error(),{code:'SCOPE_DENIED'}); }),'SCOPE_DENIED',1);
  denied(await run(()=>{ throw Error(); }),'TWO_READ_ERRORS',2);
  let attempts = 0;
  const retry = await run(request=>{ if (!attempts++) throw Error(); return ok(request); });
  assert.deepEqual(retry.input,s); assert.equal(retry.cost.tool_calls,5);
  denied(await run(()=>({ rows:[],next:'repeat' })),'INVALID_PAGE',2);
  let page = 0;
  denied(await run(()=>({ rows:[],next:'page-'+page++ })),'BUDGET_HALT',12);
  let time = 0;
  denied(await run(request=>{time=600_000;return ok(request);},{now:()=>time}),'WINDOW_CLOSED',1);
});
