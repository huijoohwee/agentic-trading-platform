import { createHmac } from 'node:crypto';
import { sha, requireThat as need } from './core.mjs';
import { history } from '../src/market.mjs';
import { portfolio } from '../src/practice-account.mjs';
import { initialPractice } from '../src/practice-defaults.mjs';
const day = 86400000;
const pick = (item, fields) =>
  Object.fromEntries(fields.filter((k) => Object.hasOwn(item, k)).map((k) => [k, item[k]]));
export const activityScope = (scope) => ({ ...scope, account_alias: 'activity/' + sha(scope.account_alias) });
const observerScope = (token) => ({
  environment: 'SIMULATE',
  profile: 'practice',
  account_alias: 'observe/' + sha(token)
});
export function observerLink({ store, scope, token, now }) {
  const owner = activityScope(scope),
    at = now();
  let opened = store.read(owner).configs.observerOpened;
  if (!Number.isSafeInteger(opened) || opened + day <= at)
    opened = store.transaction(owner, (s) => {
      if (!Number.isSafeInteger(s.configs.observerOpened) || s.configs.observerOpened + day <= at)
        s.configs.observerOpened = at;
      return s.configs.observerOpened;
    });
  const bearer = createHmac('sha256', Buffer.from(token, 'hex'))
    .update('observer/v1/' + opened)
    .digest('base64url');
  const index = observerScope(bearer);
  if (!store.read(index).configs.access)
    store.transaction(index, (s) => {
      s.configs.access = { scope, expires: opened + day };
    });
  return { path: '/observe.html#' + bearer, expires: opened + day, readOnly: true };
}
export function recordActivity(store, scope, { at, operation, status, actor, elapsed, runId, delivery }) {
  need(
    ['owner', 'human', 'agent', 'system'].includes(actor) && /^[a-z]+\.[a-z]+$/i.test(operation),
    'INVALID_ACTIVITY'
  );
  store.transaction(activityScope(scope), (s) => {
    if (delivery) {
      const recent = s.configs.recentDeliveries ?? [];
      if (recent.includes(delivery)) return;
      s.configs.recentDeliveries = [...recent.slice(-119), delivery];
    }
    const log = (s.configs.activity ??= []),
      seq = (log.at(-1)?.seq ?? 0) + 1;
    log.push({
      seq,
      at,
      operation,
      outcome: status === 'OK' ? 'accepted' : 'refused',
      actor: actor === 'owner' ? 'human' : actor,
      elapsed: Math.max(0, elapsed),
      ...(typeof runId === 'string' && /^[\da-f-]{36}$/.test(runId) ? { runId } : {})
    });
    s.configs.activity = log.slice(-120);
  });
}
export function observerRead(store, token, after, now, archive, researchService) {
  need(typeof token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(token), 'OBSERVER_DENIED');
  const link = store.read(observerScope(token)).configs.access;
  need(link && link.expires > now, 'OBSERVER_DENIED');
  need(Number.isSafeInteger(after) && after >= 0, 'INVALID_CURSOR');
  const current = store.read(link.scope),
    s = { ...initialPractice(), ...current.configs.practice };
  const meta = store.read(activityScope(link.scope)).configs,
    events = meta.activity ?? [];
  const binding = pick(s, ['symbol', 'frame', 'marketType', 'venue', 'studies']);
  const bars =
    s.venue && s.venue !== 'synthetic'
      ? (archive?.read({ ...binding, count: 100 }).bars ?? [])
      : history(s.symbol, s.frame, now, 100);
  const p = portfolio(s, now),
    markers =
      meta.overlay?.symbol === s.symbol &&
      meta.overlay.frame === s.frame &&
      meta.overlay.venue === (s.venue ?? 'synthetic') &&
      meta.overlay.marketType === s.marketType
        ? meta.overlay.markers
        : [];
  return {
    expires: link.expires,
    revision: current.revision,
    context: binding,
    bars,
    markers,
    tab: meta.tab ?? 'market',
    research: meta.research
      ? {
          id: meta.research.id,
          status: researchService?.runStatus(link.scope, meta.research.id) ?? meta.research.status
        }
      : null,
    summary: {
      cash: p.cash,
      equity: p.equity,
      positions: p.holdings,
      fills: s.fills
        .slice(-20)
        .reverse()
        .map((f) => pick(f, ['at', 'symbol', 'marketType', 'qty', 'side', 'price'])),
      working: s.orders.map((o) => pick(o, ['symbol', 'marketType', 'side', 'qty', 'trigger', 'type'])),
      predictions: s.predictions.length
    },
    sequence: events.at(-1)?.seq ?? 0,
    historyReset: Boolean(after && after < (events[0]?.seq ?? 0) - 1),
    activity: events.filter((e) => e.seq > after).reverse()
  };
}
