import { boundedJson, fail, id, requireThat, sameScope, scopeKey, sha, utcMillis } from './core.mjs';

// N4a streaming contract. Quote and trade-event WebSocket profiles register separately, each with its
// own entitled subscription, bounded buffer, heartbeat and cursor. Frames are deterministic injected
// records: no socket, provider call or credential lives here. A degraded session resumes only with a
// fresh grant, and the cursor advances only after a snapshot or scoped REST history reconcile succeeds.
export const STREAM_PROFILES = Object.freeze({ quote: 'quote:read', 'trade-event': 'trade:read' });
export const WATCHLIST_RIGHT = 'quote:write';
const GRANT_KEYS = 'rights,scope,expires_utc,nonce';
const FRAME_KEYS = 'sequence,symbol,at,payload';
const DEGRADED = ['disconnected', 'stale', 'overflow', 'conflict', 'expired'];
const frameDigest = ({ sequence, symbol, at, payload }) => sha({ sequence, symbol, at, payload });
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.split(',').includes(key));

function authorize(right, grant, scope, now) {
  requireThat(only(grant, GRANT_KEYS) && id(grant.nonce), 'STREAM_UNAUTHORIZED');
  requireThat(sameScope(grant.scope, scope), 'SCOPE_DENIED');
  requireThat(utcMillis(grant.expires_utc) !== null && now() < utcMillis(grant.expires_utc), 'STREAM_EXPIRED');
  requireThat(Array.isArray(grant.rights) && grant.rights.includes(right), 'STREAM_RIGHTS');
  return grant;
}

export function createStreamHub({ scope, now = Date.now, heartbeatMs = 15_000, bufferLimit = 64 } = {}) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(typeof now === 'function' && Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0, 'INVALID_TIMEOUT');
  requireThat(Number.isSafeInteger(bufferLimit) && bufferLimit > 0, 'INVALID_BUFFER');
  const sessions = new Map();

  function open(profile) {
    requireThat(Object.hasOwn(STREAM_PROFILES, profile), 'UNSUPPORTED');
    requireThat(!sessions.has(profile), 'DUPLICATE_PROFILE');
    const session = { profile, state: 'idle', cursor: 0, subscriptions: 0, recoveries: 0,
      appliedCount: 0, last: null, lastSeen: null, expires: null, buffered: new Map() };
    const recent = new Map();
    let pendingHistory = null;
    const apply = frame => {
      session.cursor = frame.sequence; session.appliedCount += 1; session.last = frame;
      recent.set(frame.sequence, frameDigest(frame));
      if (recent.size > bufferLimit) recent.delete(recent.keys().next().value);
    };
    function verifyRedelivery(frame, priorDigest) {
      if (priorDigest !== undefined && priorDigest !== frameDigest(frame)) {
        session.state = 'conflict'; fail('CONFLICTING_EVENT');
      }
    }
    function checkExpiry() {
      if (session.expires !== null && now() >= session.expires) {
        session.state = 'expired';
        fail('STREAM_EXPIRED');
      }
    }
    function checkActive() {
      requireThat(session.state === 'active', session.state === 'disconnected' ? 'STREAM_DISCONNECTED' : 'STREAM_INACTIVE');
      checkExpiry();
      if (now() - session.lastSeen > heartbeatMs) { session.state = 'stale'; fail('STREAM_INACTIVE'); }
    }
    const flush = () => { while (session.buffered.has(session.cursor + 1)) {
      const next = session.buffered.get(session.cursor + 1); session.buffered.delete(session.cursor + 1); apply(next);
    } };
    const touch = () => { session.lastSeen = now(); };

    function subscribe(grant) {
      requireThat(session.state === 'idle', 'STREAM_INACTIVE');
      authorize(STREAM_PROFILES[profile], grant, scope, now);
      session.state = 'active'; session.subscriptions += 1; session.expires = utcMillis(grant.expires_utc); touch();
      return status();
    }
    function push(frame) {
      checkActive();
      const f = boundedJson(frame);
      requireThat(only(f, FRAME_KEYS) && Number.isSafeInteger(f.sequence) && f.sequence > 0 &&
        Object.hasOwn(f, 'payload') && id(f.symbol) && utcMillis(f.at) !== null, 'INVALID_FRAME');
      const buffered = session.buffered.get(f.sequence);
      if (buffered || f.sequence <= session.cursor) {
        const prior = buffered ? frameDigest(buffered) : recent.get(f.sequence);
        if (prior === undefined) return { stale: true, duplicate: false, cursor: session.cursor };
        verifyRedelivery(f, prior);
        touch(); return { duplicate: true, cursor: session.cursor };
      }
      touch();
      if (f.sequence === session.cursor + 1) { apply(f); flush(); return { duplicate: false, cursor: session.cursor }; }
      if (session.buffered.size >= bufferLimit) { session.state = 'overflow'; fail('STREAM_BUFFER_OVERFLOW'); }
      session.buffered.set(f.sequence, f);
      return { duplicate: false, buffered: true, cursor: session.cursor };
    }
    function heartbeat() {
      checkActive();
      touch(); return status();
    }
    function tick() {
      if (['active', 'recovering'].includes(session.state) && now() >= session.expires) session.state = 'expired';
      else if (session.state === 'active' && now() - session.lastSeen > heartbeatMs) session.state = 'stale';
      return status();
    }
    function disconnect() {
      requireThat(session.state === 'active' || session.state === 'stale', 'STREAM_INACTIVE');
      session.state = 'disconnected'; session.buffered.clear();
      return status();
    }
    function resume(grant) {
      requireThat(DEGRADED.includes(session.state), 'STREAM_INACTIVE');
      authorize(STREAM_PROFILES[profile], grant, scope, now);
      pendingHistory = null; session.state = 'recovering'; session.subscriptions += 1; session.expires = utcMillis(grant.expires_utc); touch();
      return status();
    }
    async function recover(input) {
      requireThat(session.state === 'recovering', 'STREAM_INACTIVE');
      checkExpiry();
      if (profile === 'quote') {
        const snapshot = boundedJson(input?.snapshot ?? null);
        requireThat(only(snapshot, 'cursor,state') && Number.isSafeInteger(snapshot.cursor) &&
          snapshot.cursor >= session.cursor && Object.hasOwn(snapshot, 'state'), 'STREAM_RECOVERY');
        session.cursor = snapshot.cursor; session.buffered.clear(); recent.clear();
        session.state = 'active'; session.recoveries += 1; touch();
        return { ...status(), recovery: 'snapshot', snapshot };
      }
      requireThat(typeof input?.history === 'function', 'STREAM_RECOVERY');
      requireThat(pendingHistory === null, 'STREAM_RECOVERY_IN_PROGRESS');
      const attempt = Symbol();
      pendingHistory = attempt;
      try {
        const page = await input.history(boundedJson(scope));
        requireThat(pendingHistory === attempt && session.state === 'recovering', 'STREAM_INACTIVE');
        checkExpiry();
        requireThat(Array.isArray(page) && page.length <= 600, 'STREAM_RECOVERY');
        const unique = new Map();
        for (const event of boundedJson(page)) {
          requireThat(only(event, FRAME_KEYS + ',scope') && Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
            Object.hasOwn(event, 'payload') && id(event.symbol) && utcMillis(event.at) !== null, 'STREAM_RECOVERY');
          requireThat(!Object.hasOwn(event, 'scope') || sameScope(event.scope, scope), 'SCOPE_DENIED');
          const prior = unique.get(event.sequence) ?? session.buffered.get(event.sequence);
          verifyRedelivery(event, prior ? frameDigest(prior) : recent.get(event.sequence));
          if (event.sequence > session.cursor) unique.set(event.sequence, event);
        }
        const ordered = [...unique.values()].sort((a, b) => a.sequence - b.sequence);
        let next = session.cursor;
        for (const event of ordered) { requireThat(event.sequence === next + 1, 'STREAM_RECOVERY'); next = event.sequence; }
        for (const sequence of session.buffered.keys()) requireThat(sequence <= next, 'STREAM_RECOVERY');
        for (const event of ordered) apply(event);
        session.buffered.clear();
        session.state = 'active'; session.recoveries += 1; touch();
        return { ...status(), recovery: 'history', applied: ordered.length };
      } finally {
        if (pendingHistory === attempt) pendingHistory = null;
      }
    }
    function unsubscribe() {
      requireThat(session.state !== 'idle', 'STREAM_INACTIVE');
      session.state = 'idle'; session.buffered.clear(); session.expires = null; pendingHistory = null;
      return status();
    }
    function status() {
      return { profile, state: session.state, cursor: session.cursor, subscriptions: session.subscriptions,
        recoveries: session.recoveries, appliedCount: session.appliedCount, buffered: session.buffered.size,
        right: STREAM_PROFILES[profile] };
    }
    const handle = Object.freeze({ subscribe, push, heartbeat, tick, disconnect, resume, recover, unsubscribe, status });
    sessions.set(profile, handle);
    return handle;
  }

  // Watchlist maintenance carries its own quote:write grant; a read grant never authorizes a write.
  function maintainWatchlist(grant) {
    authorize(WATCHLIST_RIGHT, grant, scope, now);
    return { ok: true, right: WATCHLIST_RIGHT };
  }
  return Object.freeze({ open, maintainWatchlist, profiles: () => [...sessions.keys()], get size() { return sessions.size; } });
}
