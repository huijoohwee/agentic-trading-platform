import { boundedJson, fail, id, requireThat, sameScope, scopeKey, utcMillis } from './core.mjs';

// N4a streaming contract. Quote and trade-event WebSocket profiles register separately, each with its
// own entitled subscription, bounded buffer, heartbeat and cursor. Frames are deterministic injected
// records: no socket, provider call or credential lives here. A degraded session resumes only with a
// fresh grant, and the cursor advances only after a snapshot or scoped REST history reconcile succeeds.
export const STREAM_PROFILES = Object.freeze({ quote: 'quote:read', 'trade-event': 'trade:read' });
export const WATCHLIST_RIGHT = 'quote:write';
const GRANT_KEYS = 'rights,scope,expires_utc,nonce';
const FRAME_KEYS = 'sequence,symbol,at,payload';
const DEGRADED = ['disconnected', 'stale', 'overflow'];
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
  scopeKey(scope);
  requireThat(typeof now === 'function' && Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0, 'INVALID_TIMEOUT');
  requireThat(Number.isSafeInteger(bufferLimit) && bufferLimit > 0, 'INVALID_BUFFER');
  const sessions = new Map();

  function open(profile) {
    requireThat(Object.hasOwn(STREAM_PROFILES, profile), 'UNSUPPORTED');
    requireThat(!sessions.has(profile), 'DUPLICATE_PROFILE');
    const session = { profile, state: 'idle', cursor: 0, subscriptions: 0, recoveries: 0,
      appliedCount: 0, last: null, lastSeen: null, grantNonce: null, buffered: new Map() };
    const apply = frame => { session.cursor = frame.sequence; session.appliedCount += 1; session.last = frame; };
    const flush = () => { while (session.buffered.has(session.cursor + 1)) {
      const next = session.buffered.get(session.cursor + 1); session.buffered.delete(session.cursor + 1); apply(next);
    } };
    const touch = () => { session.lastSeen = now(); };

    function subscribe(grant) {
      requireThat(session.state === 'idle', 'STREAM_INACTIVE');
      authorize(STREAM_PROFILES[profile], grant, scope, now);
      session.state = 'active'; session.subscriptions += 1; session.grantNonce = grant.nonce; touch();
      return status();
    }
    function push(frame) {
      requireThat(session.state === 'active', session.state === 'disconnected' ? 'STREAM_DISCONNECTED' : 'STREAM_INACTIVE');
      const f = boundedJson(frame);
      requireThat(only(f, FRAME_KEYS) && Number.isSafeInteger(f.sequence) && f.sequence > 0 &&
        id(f.symbol) && utcMillis(f.at) !== null, 'INVALID_FRAME');
      touch();
      if (f.sequence <= session.cursor || session.buffered.has(f.sequence)) return { duplicate: true, cursor: session.cursor };
      if (f.sequence === session.cursor + 1) { apply(f); flush(); return { duplicate: false, cursor: session.cursor }; }
      if (session.buffered.size >= bufferLimit) { session.state = 'overflow'; fail('STREAM_BUFFER_OVERFLOW'); }
      session.buffered.set(f.sequence, f);
      return { duplicate: false, buffered: true, cursor: session.cursor };
    }
    function heartbeat() {
      requireThat(session.state === 'active', 'STREAM_INACTIVE');
      touch(); return status();
    }
    function tick() {
      if (session.state === 'active' && now() - session.lastSeen > heartbeatMs) session.state = 'stale';
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
      session.state = 'recovering'; session.subscriptions += 1; session.grantNonce = grant.nonce; touch();
      return status();
    }
    async function recover(input) {
      requireThat(session.state === 'recovering', 'STREAM_INACTIVE');
      if (profile === 'quote') {
        const snapshot = boundedJson(input?.snapshot ?? null);
        requireThat(only(snapshot, 'cursor,state') && Number.isSafeInteger(snapshot.cursor) &&
          snapshot.cursor >= session.cursor, 'STREAM_RECOVERY');
        session.cursor = snapshot.cursor; session.buffered.clear();
        session.state = 'active'; session.recoveries += 1; touch();
        return { ...status(), recovery: 'snapshot' };
      }
      requireThat(typeof input?.history === 'function', 'STREAM_RECOVERY');
      const events = await input.history(scope);
      requireThat(Array.isArray(events), 'STREAM_RECOVERY');
      const unique = new Map();
      for (const event of events.map(event => boundedJson(event))) {
        requireThat(only(event, FRAME_KEYS + ',scope') && Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
          id(event.symbol) && utcMillis(event.at) !== null, 'STREAM_RECOVERY');
        requireThat(!event.scope || sameScope(event.scope, scope), 'SCOPE_DENIED');
        if (event.sequence > session.cursor) unique.set(event.sequence, event);
      }
      const ordered = [...unique.values()].sort((a, b) => a.sequence - b.sequence);
      let next = session.cursor;
      for (const event of ordered) { requireThat(event.sequence === next + 1, 'STREAM_RECOVERY'); next = event.sequence; }
      for (const event of ordered) apply(event);
      session.state = 'active'; session.recoveries += 1; touch();
      return { ...status(), recovery: 'history', applied: ordered.length };
    }
    function unsubscribe() {
      requireThat(session.state !== 'idle', 'STREAM_INACTIVE');
      session.state = 'idle'; session.buffered.clear(); session.grantNonce = null;
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
