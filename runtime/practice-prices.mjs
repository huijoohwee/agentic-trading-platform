import { accountKey } from '../src/contracts.mjs';
import { requireThat as need } from './core.mjs';
// Revalue from admitted public USD snapshots only. Private archived research never supplies a fill.
export function valueAccount(session, market, at, { effect = false, selected = false } = {}) {
  const old = session.observedMarks ?? {},
    marks = {};
  const keys = new Set([
    ...Object.keys(session.positions).filter((k) => session.positions[k].qty > 0),
    ...Object.keys(session.contracts ?? {}),
    ...session.orders.map((o) => accountKey(o.venue, o.marketType, o.symbol))
  ]);
  if (selected) keys.add(accountKey(session.venue, session.marketType, session.symbol));
  for (const key of keys) {
    if (!key.includes('/')) continue;
    const [venue, marketType, symbol] = key.split('/');
    let observation;
    try {
      const snapshot = market?.('read.ticker', { venue, marketType, symbol });
      need(
        snapshot?.quality === 'live' &&
          snapshot.market.currency === 'USD' &&
          snapshot.at <= at &&
          at - snapshot.at <= 15000,
        'FRESH_USD_MARK_REQUIRED'
      );
      const prior = old[key];
      need(!prior || (snapshot.at >= prior.at && snapshot.sequence >= prior.sequence), 'FEED_ROLLBACK');
      observation = {
        price: snapshot.rows.last,
        at: snapshot.at,
        sequence: snapshot.sequence,
        digest: snapshot.source.sha256,
        source: snapshot.source.id
      };
      const pos = session.contracts?.[key];
      if (pos) {
        const funding = snapshot.funding;
        need(
          funding && funding.from <= pos.fundedThrough && funding.through >= pos.fundedThrough,
          'FUNDING_RECOVERY_REQUIRED'
        );
        observation.payments = funding.events.filter(
          (f) => f.time > pos.fundedThrough && f.time <= funding.through
        );
        observation.fundedThrough = funding.through;
      }
    } catch (error) {
      if (effect) throw error;
      if (old[key]) observation = { ...old[key], stale: true };
    }
    if (observation) marks[key] = observation;
  }
  session.observedMarks = marks;
}
