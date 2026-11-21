import { registerActions, deskActions } from './desk-actions.mjs';
import { hypotheses } from './research-catalog.mjs';
import { bindWorkbookExport } from './rehearsal-workbook.mjs';
import { renderTable } from './desk-panels.mjs';
const el = (id) => document.getElementById(id);
export function bindLab(client, onOverlay) {
  let active, interval, request, trace, reference;
  const err = (error) => (el('lab-status').textContent = error.message);
  async function call(op, input = {}, requestId, actor = 'human') {
    const r = await client.invoke(op, input, requestId, actor);
    if (r.status === 'OK') {
      if (r.data?.session) await client.reload();
      if (op === 'research.overlay') onOverlay(r.data);
      if (op === 'research.start' || op === 'research.suite') {
        active = r.data.id;
        watch();
      }
    }
    return r;
  }
  registerActions(deskActions, (op, input, id) => {
    if (
      ['practice.order', 'practice.cancel', 'practice.funds', 'practice.prediction', 'practice.reset'].includes(
        op
      ) &&
      (!input.explicitIntent || !window.confirm('Confirm paper effect ' + op + ' ' + JSON.stringify(input)))
    )
      return {
        status: 'REFUSED',
        error: { code: 'EXPLICIT_INTENT_REQUIRED', retryable: false },
        missing: ['direct owner intent']
      };
    return call(op, input, id, 'agent');
  });
  async function human(op, input = {}, id) {
    const out = await call(op, input, id);
    if (out.status !== 'OK') throw Error(out.error.code);
    return out.data;
  }
  const h = el('hypothesis'),
    form = el('historical').elements;
  for (const s of hypotheses) h.add(new Option(s.id + '. ' + s.name, s.id));
  const date = new Date();
  form.start.value = '2021-01-01';
  form.end.value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).toISOString().slice(0, 10);
  el('save-source').onclick = async () => {
    try {
      const strategy = await human(
        'research.save',
        { name: el('strategy-name').value, code: el('code').value },
        crypto.randomUUID()
      );
      el('lab-status').textContent = 'Saved ' + strategy.name + ' · ' + strategy.hash;
      await listSaved();
    } catch (e) {
      err(e);
    }
  };
  async function listSaved() {
    const list = await human('research.strategies');
    el('saved-source').replaceChildren(
      new Option('Choose a saved version', ''),
      ...list.saved.map((s) => new Option(s.name + ' · ' + s.hash.slice(0, 10), s.hash))
    );
    el('saved-source').onchange = () => {
      const s = list.saved.find((s) => s.hash === el('saved-source').value);
      if (s) {
        el('code').value = s.code;
        el('code').dispatchEvent(new Event('input'));
      }
    };
    if (!active && list.runs.length) {
      active = list.runs[0].id;
      watch();
    }
  }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function refresh() {
    if (!active) return;
    const id = active,
      run = await human('research.get', { id });
    if (id !== active) return;
    el('lab-status').textContent =
      run.status +
      ' · ' +
      id +
      (run.error ? ' · ' + run.error : '') +
      (run.receipt
        ? ' · ' +
          (run.receipt.cached ? 'cached from ' + run.receipt.originalRun : 'cold run') +
          ' · ' +
          run.receipt.scientificHash
        : '');
    el('run-trace').textContent = run.trace.map((t) => new Date(t.at).toISOString() + ' ' + t.status).join('\n');
    el('export-artifact').hidden = !run.receipt;
    if (run.rows) {
      el('export-artifact').href = '/api/practice/artifact?id=' + encodeURIComponent(run.id);
      reference = run;
      const headers = [
        'Hypothesis',
        'Quality',
        'Actual UTC dates',
        'Return',
        'Drawdown',
        'Trades',
        'Profitability',
        'Reason'
      ];
      const rows = run.rows.map((r) => [
        r.id + '. ' + r.name,
        r.status,
        r.actual ? r.actual.map((t) => new Date(t).toISOString().slice(0, 10)).join(' – ') : 'Unknown',
        r.return === null ? 'Unknown' : (r.return * 100).toFixed(2) + '%',
        r.metrics ? (r.metrics.maxDrawdown * 100).toFixed(2) + '%' : '—',
        r.metrics?.tradeCount ?? '—',
        r.profitability,
        r.reason ?? r.warnings.join(' · ')
      ]);
      renderTable('run-results', headers, rows);
      el('run-detail').textContent = JSON.stringify(
        run.rows.map(({ id, market, metrics, annual, walkForward, costs }) => ({
          id,
          market,
          metrics,
          annual,
          walkForward,
          costs
        })),
        null,
        2
      );
      bindWorkbookExport(
        el('research-sheets'),
        el('lab-status'),
        {
          workbookId: 'historical-research',
          sheetId: 'results',
          name: 'Historical research',
          headers: [
            'Hypothesis',
            'Quality',
            'Actual UTC dates',
            'Return (fraction)',
            'Drawdown (fraction)',
            'Trades',
            'Profitability',
            'Reason'
          ],
          records: run.rows.map((r, i) => ({
            id: 'hypothesis-' + r.id,
            values: [
              rows[i][0],
              r.status,
              r.actual ? rows[i][2] : undefined,
              r.return ?? undefined,
              r.metrics?.maxDrawdown,
              r.metrics?.tradeCount,
              r.profitability,
              rows[i][7]
            ]
          })),
          filename: 'research-results.json'
        },
        download
      );
    }
    if (!['running', 'queued'].includes(run.status)) {
      clearTimeout(interval);
      el('cancel-run').disabled = true;
    } else {
      el('cancel-run').disabled = false;
      clearTimeout(interval);
      interval = setTimeout(() => refresh().catch(err), 600);
    }
  }
  function watch() {
    clearTimeout(interval);
    void refresh().catch(err);
  }
  el('historical').onsubmit = async (e) => {
    e.preventDefault();
    const suite = e.submitter?.value === 'suite',
      input = {
        start: form.start.value,
        end: form.end.value,
        capital: Number(form.capital.value),
        venue: form.venue.value
      };
    if (!suite) {
      input.hypothesis = Number(h.value);
      const chosen = hypotheses[input.hypothesis - 1];
      input.symbol = form.symbol.value.trim() || chosen.base + '.USDT';
      input.frame = form.frame.value || chosen.frame;
      input.marketType = chosen.marketType;
      if (chosen.id === 19 && form.basket.value.trim())
        input.basket = [
          input.symbol,
          ...form.basket.value
            .trim()
            .toUpperCase()
            .split(/[,\s]+/)
        ];
    }
    const bytes = JSON.stringify([suite, input]);
    if (request?.bytes !== bytes) request = { bytes, id: crypto.randomUUID() };
    try {
      await human(suite ? 'research.suite' : 'research.start', input, request.id);
      request = null;
    } catch (e) {
      err(e);
    }
  };
  el('cancel-run').onclick = () =>
    active && human('research.cancel', { id: active }, crypto.randomUUID()).then(watch).catch(err);
  el('overlay-run').onclick = () =>
    active &&
    human('research.overlay', { id: active, hypothesis: Number(h.value) }, crypto.randomUUID()).catch(err);
  el('export-run').onclick = () => reference && download(JSON.stringify(reference, null, 2), 'historical-run.json');
  el('observer-open').onclick = async () => {
    try {
      const data = await human('desk.observer'),
        link = el('observer-link');
      link.href = new URL(data.path, data.origin ?? location.origin).href;
      link.hidden = false;
      link.textContent = 'Open read-only observer · expires ' + new Date(data.expires).toISOString();
    } catch (e) {
      err(e);
    }
  };
  async function activity() {
    clearTimeout(trace);
    if (!el('console').open) return;
    try {
      const data = await human('desk.activity');
      el('activity-log').replaceChildren(
        ...data.activity.map((e) =>
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
        )
      );
    } catch (e) {
      err(e);
    }
    trace = setTimeout(activity, 2500);
  }
  el('console').ontoggle = activity;
  const tab = () => {
    const key = location.hash.slice(1);
    if (['market', 'portfolio', 'research', 'predictions'].includes(key))
      void human('desk.tab', { tab: key }).catch(err);
  };
  window.addEventListener('hashchange', tab);
  window.addEventListener('pagehide', () => {
    clearTimeout(trace);
    clearTimeout(interval);
  });
  if (client.online) {
    listSaved().catch(err);
    tab();
  }
  return { human };
}
