import { mountChart } from './chart.mjs';
const el = (id) => document.getElementById(id),
  token = location.hash.slice(1);
const chart = mountChart(el('chart'), el('ohlc'), el('expand'));
let seq = 0,
  timer,
  closed = false,
  last = 0;
function list(id, rows, fields) {
  el(id).replaceChildren(
    ...rows.map((r) => {
      const p = document.createElement('p');
      p.textContent = fields
        .map((f) => r[f])
        .filter((v) => v !== undefined)
        .join(' · ');
      return p;
    })
  );
}
async function poll() {
  if (closed) return;
  try {
    const response = await fetch('/api/practice/observe?after=' + seq, {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000)
    });
    if (response.status === 403 || response.status === 401) {
      closed = true;
      document
        .querySelector('main')
        .replaceChildren(
          Object.assign(document.createElement('p'), { textContent: 'Observer session expired or unavailable.' })
        );
      return;
    }
    if (!response.ok) throw Error('Observer unavailable');
    const s = await response.json();
    if (closed) return;
    el('context').textContent = [s.context.venue, s.context.symbol, s.context.marketType, s.context.frame].join(
      ' · '
    );
    chart.update(s.bars, s.context.studies, s.markers, s.context.frame, s.context.symbol.split('.')[1]);
    el('status').textContent =
      'Read only · ' +
      s.tab +
      ' · expires ' +
      new Date(s.expires).toISOString() +
      (s.research ? ' · research ' + s.research.status : '');
    const a = s.summary;
    el('account').textContent =
      'Virtual cash ' + a.cash.toFixed(2) + ' · equity ' + a.equity.toFixed(2) + ' · predictions ' + a.predictions;
    list('positions', a.positions, ['symbol', 'marketType', 'quantity', 'average', 'mark']);
    list('recent-fills', a.fills, ['symbol', 'side', 'qty', 'price']);
    list('pending-orders', a.working, ['symbol', 'side', 'qty', 'type', 'trigger']);
    if (s.historyReset) {
      el('activity').replaceChildren();
      last = 0;
    }
    const entries = s.activity
      .filter((v) => v.seq > last)
      .map((e) =>
        Object.assign(document.createElement('li'), {
          textContent:
            new Date(e.at).toISOString() +
            ' · ' +
            e.actor +
            ' · ' +
            e.operation +
            ' · ' +
            e.outcome +
            ' · ' +
            e.elapsed +
            ' ms' +
            (e.runId ? ' · ' + e.runId : '')
        })
      );
    el('activity').prepend(...entries);
    while (el('activity').children.length > 120) el('activity').lastChild.remove();
    seq = last = s.sequence;
  } catch {
    if (!closed) el('status').textContent = 'Disconnected · reconnecting';
  }
  if (!closed) timer = setTimeout(poll, 2000);
}
window.addEventListener('pagehide', () => {
  closed = true;
  clearTimeout(timer);
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    closed = false;
    void poll();
  }
});
void poll();
