// Pure rules operate on supplied instants. The first slice evaluates only R01.
export const FIXTURE_DIGEST = '60a34d26ad82e04faf2c7e08f40346ef20cc98b2616cb0fd4d16483018007e1a';

export function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value.slice(0, -1) + '.000Z') return null;
  return ms;
}

export async function readFixture(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== FIXTURE_DIGEST) throw new Error('Fixture integrity check failed.');
  const fixture = JSON.parse(new TextDecoder().decode(bytes));
  return Object.freeze({ ...fixture, digest, quote: Object.freeze(fixture.quote), policy: Object.freeze(fixture.policy) });
}

export function evaluateFreshness(quote, policy, evaluationAt) {
  const source = utcMillis(quote?.observedAt);
  const evaluation = utcMillis(evaluationAt);
  const threshold = policy?.maxAgeMinutes;
  if (source === null || evaluation === null || !Number.isFinite(threshold) || threshold < 0) {
    return { state: 'UNKNOWN', reason: 'MISSING_INPUT', ageSeconds: null };
  }
  const ageSeconds = (evaluation - source) / 1000;
  if (ageSeconds < 0) return { state: 'UNKNOWN', reason: 'FUTURE_QUOTE', ageSeconds };
  if (quote.freshness === 'delayed') return { state: 'FAIL', reason: 'DELAYED_QUOTE', ageSeconds };
  if (quote.freshness !== 'realtime') return { state: 'UNKNOWN', reason: 'MISSING_CLASS', ageSeconds };
  return ageSeconds <= threshold * 60
    ? { state: 'PASS', reason: 'WITHIN_WINDOW', ageSeconds }
    : { state: 'FAIL', reason: 'STALE_QUOTE', ageSeconds };
}

export function ticketInputs(fixture) {
  return { symbol: fixture.symbol, side: 'BUY', quantity: 1, limitPrice: fixture.quote.price,
    evaluationAt: '2026-11-19T09:05:00Z', metadata: 'as-received',
    fixtureId: fixture.id, fixtureDigest: fixture.digest, policyRevision: fixture.policy.revision };
}

export function verifyTicket(values, fixture) {
  if (values.fixtureId !== fixture.id || values.fixtureDigest !== fixture.digest ||
      values.policyRevision !== fixture.policy.revision || values.symbol !== fixture.symbol) {
    throw new Error('The saved source or policy differs from this fixture. Writing is locked.');
  }
  if (!['BUY', 'SELL'].includes(values.side) || !Number.isFinite(values.quantity) || values.quantity <= 0 ||
      !Number.isFinite(values.limitPrice) || values.limitPrice <= 0 ||
      !Number.isFinite(values.quantity * values.limitPrice)) throw new Error('Enter a valid side, positive quantity and limit price.');
  if (utcMillis(values.evaluationAt) === null) throw new Error('Enter an evaluation time in UTC, including seconds.');
  if (values.evaluationAt.slice(0, 10) !== fixture.quote.observedAt.slice(0, 10)) {
    throw new Error('Choose an evaluation time on the fixture date.');
  }
  if (!['as-received', 'missing'].includes(values.metadata)) throw new Error('Select a valid quote metadata setting.');
}

export function assessTicket(values, fixture) {
  verifyTicket(values, fixture);
  const quote = values.metadata === 'missing' ? { ...fixture.quote, freshness: null } : fixture.quote;
  return evaluateFreshness(quote, fixture.policy, values.evaluationAt);
}
