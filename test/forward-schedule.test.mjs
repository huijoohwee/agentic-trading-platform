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
