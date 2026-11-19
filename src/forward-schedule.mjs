import { utcMillis } from './rules.mjs';

const MINUTE = 60_000;

// Handbook timestamps carry an explicit offset. Use Trading's whole-second calendar validation.
function instant(value) {
  const match = typeof value === 'string' && /^(.*)(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const wall = match ? utcMillis(match[1] + 'Z') : null;
  if (wall === null || Number(match[4]) > 23 || Number(match[5]) > 59) {
    throw new RangeError('Expected a whole-second timestamp with a valid UTC offset');
  }
  if (match[2] === 'Z') return wall;
  const offset = (Number(match[4]) * 60 + Number(match[5])) * MINUTE;
  return match[3] === '+' ? wall - offset : wall + offset;
}

function intervalMillis(expression) {
  const match = /^PT(\d+)([MS])$/.exec(expression);
  if (!match) throw new RangeError('Offline interval fixtures use whole minutes or seconds');
  const period = Number(match[1]) * (match[2] === 'M' ? MINUTE : 1000);
  if (!Number.isSafeInteger(period) || period < MINUTE) {
    throw new RangeError('A recurring interval must be at least one minute and exactly representable');
  }
  return period;
}

// Only the every-minute and minute-step five-field policies used by the offline contract.
function clockTick(expression, timezone, earliest) {
  const match = /^\*(?:\/(\d+))? \* \* \* \*$/.exec(expression);
  const step = Number(match?.[1] ?? 1);
  if (!match || step < 1 || step > 59) throw new RangeError('Expected five-field minute-step cron');
  if (typeof timezone !== 'string' || !timezone) throw new RangeError('Cron requires an explicit time zone');
  const minute = new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: timezone });
  let tick = Math.ceil(earliest / MINUTE) * MINUTE;
  while (Number(minute.format(tick)) % step !== 0) tick += MINUTE;
  return tick;
}

/** Return the next nominal UTC trigger strictly after the cursor, or null once the window closes. */
export function nextScheduledAt(policy, { createdAt, after = createdAt }) {
  const created = instant(createdAt);
  const cursor = Math.max(created, instant(after));
  const start = policy.start_at === undefined ? null : instant(policy.start_at);
  const stop = policy.stop_at === undefined ? Infinity : instant(policy.stop_at);
  if (start !== null && stop <= start) throw new RangeError('stop_at must follow start_at');
  const earliest = Math.max(cursor + 1, start ?? created);
  let due;
  if (policy.type === 'interval') {
    const period = intervalMillis(policy.expression);
    const anchor = start ?? created + period;
    due = anchor + Math.max(0, Math.ceil((earliest - anchor) / period)) * period;
  } else if (policy.type === 'cron') {
    due = clockTick(policy.expression, policy.timezone, earliest);
  } else throw new RangeError('Expected a recurring interval or cron fixture');
  return due < stop ? new Date(due).toISOString().replace('.000Z', 'Z') : null;
}
