import assert from 'node:assert/strict';
import test from 'node:test';
import { nextScheduledAt } from '../src/forward-schedule.mjs';

// VCC-26, handbook §6 examples A and E. Expected UTC instants are specified independently.
const zone = 'Asia/Shanghai';
const createdAt = '2027-05-01T09:02:00+08:00';
const interval = { type: 'interval', expression: 'PT5M' };
const cron = { type: 'cron', expression: '*/5 * * * *', timezone: zone };

test('a five-minute interval keeps its creation anchor while cron uses clock boundaries', () => {
  const firstInterval = nextScheduledAt(interval, { createdAt });
  const firstCron = nextScheduledAt(cron, { createdAt });
  assert.equal(firstInterval, '2027-05-01T01:07:00Z');
  assert.equal(firstCron, '2027-05-01T01:05:00Z');
  assert.equal(nextScheduledAt(interval, { createdAt, after: firstInterval }), '2027-05-01T01:12:00Z');
  assert.equal(nextScheduledAt(cron, { createdAt, after: firstCron }), '2027-05-01T01:10:00Z');
  // A previous run finishing at 09:09 does not shift either schedule.
  const late = { createdAt, after: '2027-05-01T09:09:00+08:00' };
  assert.equal(nextScheduledAt(interval, late), '2027-05-01T01:12:00Z');
  assert.equal(nextScheduledAt(cron, late), '2027-05-01T01:10:00Z');
});

test('cron aligns in the named time zone even when its clock grid differs from UTC', () => {
  const policy = { ...cron, expression: '*/10 * * * *', timezone: 'Asia/Kathmandu' };
  assert.equal(nextScheduledAt(policy, { createdAt: '2027-05-01T09:02:00+05:45' }), '2027-05-01T03:25:00Z');
  assert.throws(() => nextScheduledAt({ ...policy, timezone: undefined }, { createdAt }), /explicit time zone/);
});

test('recurrence rejects 59 seconds, accepts 60 seconds and preserves 61 seconds', () => {
  const next = expression => nextScheduledAt({ ...interval, expression }, { createdAt });
  assert.throws(() => next('PT59S'), /at least one minute/);
  assert.equal(next('PT60S'), '2027-05-01T01:03:00Z');
  assert.equal(next('PT1M'), '2027-05-01T01:03:00Z');
  assert.equal(next('PT61S'), '2027-05-01T01:03:01Z');
  const minuteCron = { ...cron, expression: '* * * * *' };
  assert.equal(nextScheduledAt(minuteCron, { createdAt }), '2027-05-01T01:03:00Z');
  assert.throws(() => nextScheduledAt({ ...cron, expression: '*/5 * * * * *' }, { createdAt }), /five-field/);
});

for (const policy of [interval, cron]) {
  test(policy.type + ' includes start_at and suppresses every new trigger from stop_at onward', () => {
    const bounded = { ...policy, timezone: zone, start_at: '2027-05-01T09:00:00+08:00',
      stop_at: '2027-05-01T18:00:00+08:00' };
    const createdAt = '2027-05-01T08:47:00+08:00';
    const next = after => nextScheduledAt(bounded, { createdAt, after });
    assert.equal(next(createdAt), '2027-05-01T01:00:00Z');
    assert.equal(next('2027-05-01T17:54:59+08:00'), '2027-05-01T09:55:00Z');
    assert.equal(next('2027-05-01T17:55:00+08:00'), null);
    assert.equal(next('2027-05-01T17:59:59+08:00'), null);
    assert.equal(next(bounded.stop_at), null);
    assert.equal(next('2027-05-01T18:02:00+08:00'), null);
    // Moving only the cutoff one second later admits the same 18:00 trigger.
    assert.equal(nextScheduledAt({ ...bounded, stop_at: '2027-05-01T18:00:01+08:00' },
      { createdAt, after: '2027-05-01T17:55:00+08:00' }), '2027-05-01T10:00:00Z');
  });
}

test('offline API rehearsal binds acceptance, cutoff, cursor and final readback independently', async () => {
  const { rehearseForward } = await import('../src/forward-rehearsal.mjs');
  const report = rehearseForward();
  assert.equal(report.authority, false);
  assert.equal(report.providerCredits, 'UNKNOWN');
  const rows = report.timeline;
  assert.deepEqual(rows.map(row => row.outcome), ['configured','accepted','completed','accepted','duplicate_trigger',
    'concurrency_limit_reached','completed','paused','paused','resumed','accepted','window_closed','completed']);
  const create = rows[0].request;
  assert.equal(create.method, 'POST');
  assert.equal(create.path, '/api/v1/forward/schedules');
  assert.equal(create.body.execution.session_mode, 'new_session');
  assert.equal(create.body.execution.max_concurrent_runs, 1);
  assert.equal(create.body.trigger_policy.timezone, zone);
  assert.equal(create.body.initial_events[0].type, 'user.message');
  assert.equal(rows[1].request.path, '/api/v1/forward/schedules/fixture-schedule/run');
  assert.equal(rows[10].cursor, rows[6].cursor);
  assert.equal(rows[11].run, rows[12].run);
  assert.ok(rows[12].at > rows[11].at);
  for (const row of rows.filter(row => row.action === 'readback'))
    assert.deepEqual(row.request, { method: 'GET', path: '/api/v1/forward/schedule_runs/' + row.run });
  assert.deepEqual(rehearseForward(), report);
});

test('redacted fixture qualification detects scope, account, cost, pinned versions and optional channel drift', async () => {
  const { readFile } = await import('node:fs/promises');
  const { inspectBindings } = await import('../src/forward-bindings.mjs');
  const record = JSON.parse(await readFile(new URL('../src/binding-fixture.json', import.meta.url)));
  assert.deepEqual(inspectBindings(record),{ok:true,source:'SYNTHETIC',authority:false,reasons:[]});
  const cases = [
    [r=>r.cloud.environment='LIVE','ACCOUNT_BINDING'], [r=>r.selected.profile='competition','ACCOUNT_BINDING'],
    [r=>r.desktop.alias=null,'ACCOUNT_BINDING'], [r=>r.cloud.scopes.push('submit'),'READ_GRANTS'],
    [r=>r.cloud.vaultAttached=false,'READ_GRANTS'],[r=>r.budget.remaining=0,'BUDGET_HALT'],
    [r=>{r.budget.hardCapUsd=null; r.budget.denyAtExhaustion=false;},'BUDGET_HALT'],[r=>r.budget.expiresUtc=r.evaluatedUtc,'STALE_EVIDENCE'],
    [r=>r.template.skills[0].version='latest','BINDING_DRIFT_SKILLS'],
    [r=>r.template.children[0].version='fixture-v3','BINDING_DRIFT_CHILDREN'],
    [r=>r.template.mcp=[],'BINDING_DRIFT_MCP'],[r=>r.template.tools=[],'BINDING_DRIFT_TOOLS'],
    [r=>r.template.cloudVersion='latest','VERSION_RECORD'],[r=>r.channel={botCount:6},'CHANNEL_UNVERIFIED'],
  ];
  for (const [change, reason] of cases) {
    const next=structuredClone(record); change(next);
    const result=inspectBindings(next); assert.equal(result.ok,false); assert.ok(result.reasons.includes(reason));
    assert.equal(result.authority,false);
  }
});
