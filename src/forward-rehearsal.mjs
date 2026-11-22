// Offline contract fixture. The method and path describe the handbook request. No transport is used.
import { nextScheduledAt } from './forward-schedule.mjs';
import { utcMillis } from './rules.mjs';

const schedules = '/api/v1/forward/schedules';
const schedule = schedules + '/fixture-schedule';
const runs = '/api/v1/forward/schedule_runs/';
const start = '2027-05-01T01:00:00Z';
const stop = '2027-05-01T01:20:00Z';

export function rehearseForward() {
  const createdAt = '2027-05-01T00:58:00Z';
  const policy = { type: 'cron', expression: '*/5 * * * *', timezone: 'Asia/Shanghai', start_at: start, stop_at: stop };
  const body = {
    name: 'Synthetic decision journal review', identity_id: 'fixture-identity',
    template_id: 'fixture-coordinator', environment_id: 'fixture-local',
    initial_events: [{ type: 'user.message', content: 'Inspect the synthetic decision log and report gaps.' }],
    trigger_policy: policy, execution: { session_mode: 'new_session', max_concurrent_runs: 1 },
  };
  const timeline = [];
  const seen = new Set();
  let paused = false, active = null, cursor = null;
  function record(at, action, outcome, request, run = active) {
    timeline.push({ at, action, outcome, run, cursor, ...(request && { request }) });
  }
  function trigger(at, action, event, request) {
    let outcome;
    if (seen.has(event)) outcome = 'duplicate_trigger';
    else if (utcMillis(at) >= utcMillis(stop)) outcome = 'window_closed';
    else if (paused) outcome = 'paused';
    else if (active) outcome = 'concurrency_limit_reached';
    else {
      active = 'fixture-run-' + event;
      outcome = 'accepted';
    }
    seen.add(event);
    record(at, action, outcome, request);
  }
  function complete(at, lastEvent) {
    if (!active) throw new Error('No fixture run awaits a readback');
    cursor = lastEvent;
    record(at, 'readback', 'completed', { method: 'GET', path: runs + active }, active);
    active = null;
  }
  function setPaused(at, value) {
    paused = value;
    const action = value ? 'pause' : 'unpause';
    record(at, action, value ? 'paused' : 'resumed', { method: 'POST', path: schedule + '/' + action });
  }
  record(createdAt, 'create', 'configured', { method: 'POST', path: schedules, body });
  trigger('2027-05-01T00:59:00Z', 'manual', 'manual', { method: 'POST', path: schedule + '/run' });
  complete('2027-05-01T00:59:30Z', 'fixture-event-1');
  let after = createdAt;
  for (let slot = 0; slot < 4; slot++) {
    const at = nextScheduledAt(policy, { createdAt, after });
    if (!at) throw new Error('Missing fixture trigger');
    trigger(at, 'schedule', at);
    if (slot === 0) trigger(at, 'redelivery', at);
    if (slot === 1) {
      complete('2027-05-01T01:06:00Z', 'fixture-event-2');
      setPaused('2027-05-01T01:07:00Z', true);
    }
    if (slot === 2) setPaused('2027-05-01T01:12:00Z', false);
    after = at;
  }
  if (nextScheduledAt(policy, { createdAt, after }) !== null) throw new Error('Stop boundary admitted a new trigger');
  record(stop, 'cutoff', 'window_closed');
  complete('2027-05-01T01:21:00Z', 'fixture-event-3');
  return { source: 'OFFLINE_FIXTURE', authority: false, providerCredits: 'UNKNOWN', timeline };
}
