import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamHub, STREAM_PROFILES, WATCHLIST_RIGHT } from '../runtime/stream-recovery.mjs';

// N4a streaming acceptance. Every frame, heartbeat and history page is a deterministic local fixture;
// the injected clock drives expiry and timeout. No socket, provider call or credential is involved.
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'stream-fixture' };
let clock = Date.parse('2026-11-20T15:00:00Z');
const now = () => clock;
const advance = ms => { clock += ms; };
const grant = (rights, overrides = {}) => ({ rights, scope, expires_utc: '2026-11-20T16:00:00Z', nonce: 'grant-one', ...overrides });
const frame = (sequence, overrides = {}) => ({ sequence, symbol: 'HK.00700', at: '2026-11-20T15:00:00Z', payload: { price: '303.0' }, ...overrides });
const hub = (options = {}) => createStreamHub({ scope, now, ...options });

test('quote and trade-event profiles register separately with independent state', () => {
  const h = hub(), quote = h.open('quote'), trades = h.open('trade-event');
  assert.equal(h.size, 2);
  assert.deepEqual(h.profiles().sort(), ['quote', 'trade-event']);
  assert.deepEqual(STREAM_PROFILES, { quote: 'quote:read', 'trade-event': 'trade:read' });
  assert.throws(() => h.open('quote'), /DUPLICATE_PROFILE/);
  assert.throws(() => h.open('order-event'), /UNSUPPORTED/);
  quote.subscribe(grant(['quote:read']));
  assert.equal(quote.status().state, 'active');
  assert.equal(trades.status().state, 'idle');
  assert.throws(() => trades.push(frame(1)), /STREAM_INACTIVE/);
  assert.throws(() => quote.subscribe(grant(['trade:read'])), /STREAM_INACTIVE/);
  trades.subscribe(grant(['trade:read']));
  quote.push(frame(1)); trades.push(frame(1));
  assert.equal(quote.status().cursor, 1);
  assert.equal(trades.status().cursor, 1);
  assert.throws(() => h.open('quote').subscribe(grant(['trade:read'])), /DUPLICATE_PROFILE/);
});

test('subscription refuses cross-account, expired, mis-scoped and malformed grants', () => {
  const quote = hub().open('quote');
  assert.throws(() => quote.subscribe(grant(['quote:read'], { scope: { ...scope, account_alias: 'outside' } })), /SCOPE_DENIED/);
  assert.throws(() => quote.subscribe(grant(['trade:read'])), /STREAM_RIGHTS/);
  assert.throws(() => quote.subscribe({ rights: ['quote:read'] }), /STREAM_UNAUTHORIZED/);
  advance(3_600_001);
  assert.throws(() => quote.subscribe(grant(['quote:read'])), /STREAM_EXPIRED/);
  advance(-3_600_001);
  assert.equal(quote.subscribe(grant(['quote:read'])).state, 'active');
});

test('deterministic frames apply once and duplicates produce one effect', () => {
  const quote = hub().open('quote');
  quote.subscribe(grant(['quote:read']));
  for (const sequence of [1, 2, 3]) assert.equal(quote.push(frame(sequence)).duplicate, false);
  assert.equal(quote.status().appliedCount, 3);
  for (const sequence of [1, 2, 3]) assert.equal(quote.push(frame(sequence)).duplicate, true);
  assert.equal(quote.status().appliedCount, 3);
  assert.equal(quote.status().cursor, 3);
  assert.throws(() => quote.push({ sequence: 4 }), /INVALID_FRAME/);
  assert.throws(() => quote.push(frame(0)), /INVALID_FRAME/);
});

test('out-of-order frames buffer within the bound, flush contiguously and halt on overflow', () => {
  const quote = hub({ bufferLimit: 4 }).open('quote');
  quote.subscribe(grant(['quote:read']));
  quote.push(frame(1));
  for (const sequence of [3, 4, 5]) assert.equal(quote.push(frame(sequence)).buffered, true);
  assert.equal(quote.status().cursor, 1);
  assert.equal(quote.push(frame(2)).cursor, 5);
  assert.equal(quote.status().appliedCount, 5);
  assert.equal(quote.status().buffered, 0);
  assert.equal(quote.push(frame(4)).duplicate, true);
  const bounded = hub({ bufferLimit: 4 }).open('quote');
  bounded.subscribe(grant(['quote:read']));
  bounded.push(frame(1));
  for (const sequence of [3, 4, 5, 6]) bounded.push(frame(sequence));
  assert.throws(() => bounded.push(frame(7)), /STREAM_BUFFER_OVERFLOW/);
  assert.equal(bounded.status().state, 'overflow');
  assert.throws(() => bounded.push(frame(2)), /STREAM_INACTIVE/);
});

test('heartbeat keeps a session alive and timeout degrades it before any further frame', () => {
  const quote = hub({ heartbeatMs: 1000 }).open('quote');
  quote.subscribe(grant(['quote:read']));
  quote.push(frame(1));
  advance(900); quote.heartbeat(); advance(900);
  assert.equal(quote.tick().state, 'active');
  advance(1001);
  assert.equal(quote.tick().state, 'stale');
  assert.throws(() => quote.push(frame(2)), /STREAM_INACTIVE/);
  assert.throws(() => quote.heartbeat(), /STREAM_INACTIVE/);
  assert.equal(quote.status().cursor, 1);
});

test('disconnect refuses frames and resume re-authenticates before re-subscription', () => {
  const quote = hub().open('quote');
  quote.subscribe(grant(['quote:read']));
  quote.push(frame(1));
  assert.equal(quote.disconnect().state, 'disconnected');
  assert.equal(quote.status().cursor, 1);
  assert.throws(() => quote.push(frame(2)), /STREAM_DISCONNECTED/);
  advance(3_600_001);
  assert.throws(() => quote.resume(grant(['quote:read'])), /STREAM_EXPIRED/);
  assert.equal(quote.status().state, 'disconnected');
  advance(-3_600_001);
  const resumed = quote.resume(grant(['quote:read'], { nonce: 'grant-two' }));
  assert.equal(resumed.state, 'recovering');
  assert.equal(resumed.subscriptions, 2);
  assert.throws(() => quote.push(frame(2)), /STREAM_INACTIVE/);
  assert.throws(() => quote.resume(grant(['quote:read'])), /STREAM_INACTIVE/);
});

test('quote recovery advances the cursor only after a snapshot reconcile', async () => {
  const quote = hub().open('quote');
  quote.subscribe(grant(['quote:read']));
  quote.push(frame(1));
  quote.disconnect();
  quote.resume(grant(['quote:read'], { nonce: 'grant-two' }));
  await assert.rejects(() => quote.recover({ snapshot: { cursor: 0, state: {} } }), /STREAM_RECOVERY/);
  assert.equal(quote.status().cursor, 1);
  assert.equal(quote.status().state, 'recovering');
  await assert.rejects(() => quote.recover({}), /STREAM_RECOVERY/);
  const recovered = await quote.recover({ snapshot: { cursor: 5, state: { price: '303.0' } } });
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.cursor, 5);
  assert.equal(recovered.recoveries, 1);
  assert.equal(quote.push(frame(6)).cursor, 6);
});

test('trade-event recovery backfills scoped REST history before advancing the cursor', async () => {
  const trades = hub().open('trade-event');
  trades.subscribe(grant(['trade:read']));
  trades.push(frame(1)); trades.push(frame(2));
  trades.disconnect();
  trades.resume(grant(['trade:read'], { nonce: 'grant-two' }));
  const recovered = await trades.recover({ history: async received => {
    assert.deepEqual(received, scope);
    return [frame(4), frame(3), frame(2), frame(3)];
  } });
  assert.equal(recovered.state, 'active');
  assert.equal(recovered.cursor, 4);
  assert.equal(recovered.applied, 2);
  assert.equal(recovered.appliedCount, 4);
  const gapped = hub().open('trade-event');
  gapped.subscribe(grant(['trade:read']));
  gapped.push(frame(1)); gapped.push(frame(2));
  gapped.disconnect();
  gapped.resume(grant(['trade:read'], { nonce: 'grant-two' }));
  await assert.rejects(() => gapped.recover({ history: async () => [frame(4), frame(5)] }), /STREAM_RECOVERY/);
  assert.equal(gapped.status().cursor, 2);
  assert.equal(gapped.status().state, 'recovering');
  await assert.rejects(() => gapped.recover({ history: async () => [frame(3, { scope: { ...scope, account_alias: 'outside' } })] }), /SCOPE_DENIED/);
  assert.equal(gapped.status().cursor, 2);
  const empty = await gapped.recover({ history: async () => [] });
  assert.equal(empty.cursor, 2);
  assert.equal(empty.applied, 0);
  assert.equal(empty.state, 'active');
});

test('unsubscribe stops delivery and re-subscription requires a fresh entitled grant', () => {
  const quote = hub().open('quote');
  quote.subscribe(grant(['quote:read']));
  quote.push(frame(1));
  assert.equal(quote.unsubscribe().state, 'idle');
  assert.equal(quote.status().cursor, 1);
  assert.throws(() => quote.push(frame(2)), /STREAM_INACTIVE/);
  assert.throws(() => quote.unsubscribe(), /STREAM_INACTIVE/);
  advance(3_600_001);
  assert.throws(() => quote.subscribe(grant(['quote:read'])), /STREAM_EXPIRED/);
  advance(-3_600_001);
  assert.equal(quote.subscribe(grant(['quote:read'], { nonce: 'grant-two' })).subscriptions, 2);
  assert.equal(quote.push(frame(2)).cursor, 2);
});

test('watchlist maintenance refuses a read grant, cross-account and expired writes', () => {
  const h = hub();
  assert.equal(WATCHLIST_RIGHT, 'quote:write');
  assert.throws(() => h.maintainWatchlist(grant(['quote:read'])), /STREAM_RIGHTS/);
  assert.throws(() => h.maintainWatchlist(grant(['trade:read'])), /STREAM_RIGHTS/);
  assert.throws(() => h.maintainWatchlist(grant(['quote:write'], { scope: { ...scope, account_alias: 'outside' } })), /SCOPE_DENIED/);
  assert.deepEqual(h.maintainWatchlist(grant(['quote:write'])), { ok: true, right: 'quote:write' });
  advance(3_600_001);
  assert.throws(() => h.maintainWatchlist(grant(['quote:write'])), /STREAM_EXPIRED/);
  advance(-3_600_001);
});

test('the two profiles degrade and recover independently', async () => {
  const h = hub(), quote = h.open('quote'), trades = h.open('trade-event');
  quote.subscribe(grant(['quote:read']));
  trades.subscribe(grant(['trade:read']));
  quote.push(frame(1)); trades.push(frame(1));
  quote.disconnect();
  assert.equal(trades.status().state, 'active');
  assert.equal(trades.push(frame(2)).cursor, 2);
  quote.resume(grant(['quote:read'], { nonce: 'grant-two' }));
  await quote.recover({ snapshot: { cursor: 9, state: {} } });
  assert.equal(quote.status().cursor, 9);
  assert.equal(trades.status().cursor, 2);
  assert.equal(trades.status().recoveries, 0);
});
