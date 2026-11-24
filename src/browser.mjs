import { IndexedDBAdapter } from '../owners/base/src/index.mjs';
import { assessTicket, readFixture, ticketInputs, utcMillis } from './rules.mjs';
import { createTicketStore } from './tickets.mjs';
import { mountTradingDashboard } from './dashboard.mjs';

mountTradingDashboard(document);
// Native toggle covers pointer, touch and keyboard, including rehearsal tables added after startup.
document.addEventListener('toggle', ({ target }) => {
  if (!target.matches('details#audit, details[data-agentic-section]')) return;
  const summary = target.querySelector(':scope > summary');
  if (target.open) summary.dataset.agenticAnnotationTarget = 'true';
  else delete summary.dataset.agenticAnnotationTarget;
}, true);
const byId = id => document.getElementById(id);
let runtimeOpened = false;
byId('runtime-readback').addEventListener('toggle', async event => {
  if (!event.target.open || runtimeOpened) return;
  runtimeOpened = true;
  try { const { mountRuntimeView } = await import('./runtime-view.mjs'); await mountRuntimeView(byId('runtime-body')); }
  catch { byId('runtime-body').textContent = 'Runtime projection unavailable. The offline rehearsal is unchanged.'; }
});
let coverageOpened = false;
byId('provider-coverage').addEventListener('toggle', async event => {
  if (!event.target.open || coverageOpened) return;
  coverageOpened = true;
  try { const { mountCoverageView } = await import('./coverage-view.mjs'); await mountCoverageView(byId('coverage-body')); }
  catch { byId('coverage-body').textContent = 'Coverage inventory unavailable. The offline rehearsal is unchanged.'; }
});
let captureOpened = false;
byId('provider-capture').addEventListener('toggle', async event => {
  if (!event.target.open || captureOpened) return;
  captureOpened = true;
  try { const { mountCaptureView } = await import('./capture-view.mjs'); await mountCaptureView(byId('capture-body')); }
  catch { byId('capture-body').textContent = 'Provider capture unavailable. The offline rehearsal is unchanged.'; }
});
let hostedOpened = false;
byId('provider-hosted').addEventListener('toggle', async event => {
  if (!event.target.open || hostedOpened) return;
  hostedOpened = true;
  try { const { mountHostedView } = await import('./hosted-view.mjs'); await mountHostedView(byId('hosted-body')); }
  catch { byId('hosted-body').textContent = 'Hosted capture unavailable. The offline rehearsal is unchanged.'; }
});
const form = byId('ticket');
const fields = byId('fields');
const feedback = byId('feedback');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const descriptions = {
  WITHIN_WINDOW: 'The realtime quote is inside the five-minute window.',
  STALE_QUOTE: 'The quote is older than the five-minute limit.',
  MISSING_CLASS: 'The source did not establish a realtime freshness class.',
  DELAYED_QUOTE: 'The source classified this quote as delayed.',
  FUTURE_QUOTE: 'The quote was observed after the evaluation time.',
  MISSING_INPUT: 'A valid source timestamp, evaluation time and policy are required.',
};

async function prepareOffline() {
  const status = byId('offline-status');
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const pending = registration.installing ?? registration.waiting ?? registration.active;
      const timer = setTimeout(() => finish(false), 15000);
      function finish(ok) {
        clearTimeout(timer);
        pending?.removeEventListener('statechange', observe);
        navigator.serviceWorker.removeEventListener('controllerchange', observe);
        if (ok) resolve(); else reject(new Error('Offline shell installation failed.'));
      }
      function observe() {
        if (navigator.serviceWorker.controller) finish(true);
        else if (pending?.state === 'redundant') finish(false);
      }
      pending?.addEventListener('statechange', observe);
      navigator.serviceWorker.addEventListener('controllerchange', observe);
      observe();
    });
    const show = () => { status.textContent = navigator.onLine ? 'Offline ready' : 'Working offline'; };
    window.addEventListener('online', show);
    window.addEventListener('offline', show);
    show();
  } catch { status.textContent = 'Offline shell unavailable'; }
}

async function start() {
  const response = await fetch('./src/fixture.json');
  if (!response.ok) throw new Error('The synthetic fixture could not be opened.');
  const fixture = await readFixture(await response.arrayBuffer());
  const initial = ticketInputs(fixture);
  const store = createTicketStore(new IndexedDBAdapter({ databaseName: 'agentic-trading-fixture-v1' }), fixture);
  let current = await store.open();
  let blocked = false;
  byId('quote-symbol').textContent = fixture.symbol;
  byId('quote-price').textContent = money.format(fixture.quote.price);
  byId('observed').textContent = fixture.quote.observedAt.slice(11);
  byId('policy').textContent = fixture.policy.revision;
  const field = name => form.elements.namedItem(name);

  function values() {
    const time = field('evaluationTime').value;
    return { ...initial, side: field('side').value, quantity: field('quantity').valueAsNumber,
      limitPrice: field('limitPrice').valueAsNumber, metadata: field('metadata').value,
      evaluationAt: fixture.quote.observedAt.slice(0, 11) + (time.length === 5 ? time + ':00' : time) + 'Z' };
  }
  function fill(values) {
    for (const name of ['side', 'quantity', 'limitPrice', 'metadata']) field(name).value = values[name];
    field('evaluationTime').value = values.evaluationAt.slice(11, 19);
  }

  function renderCheck() {
    let outcome;
    try { outcome = assessTicket(values(), fixture); }
    catch (error) { outcome = { state: 'UNKNOWN', reason: null, message: error.message, ageSeconds: null }; }
    byId('state').textContent = outcome.state;
    byId('state').dataset.state = outcome.state;
    byId('reason').textContent = descriptions[outcome.reason] ?? outcome.message;
    const age = outcome.ageSeconds;
    byId('age').textContent = age === null ? 'Unknown' : age < 0 ? `${-age} s ahead` : `${age} s`;
    byId('window').value = age === null ? 0 : Math.max(0, Math.min(300, age));
  }

  async function renderCalculation() {
    const record = current.record;
    if (!record || !byId('evidence').open) return;
    try {
      const sheets = await import('../owners/sheets/sheets/core.mjs');
      const { quantity, limitPrice } = record.values;
      const { workbook } = await sheets.executeWorkbook(null, {
        contract: sheets.CONTRACT, operation: 'create', operationId: 'display', expectedRevision: 0,
        payload: { workbookId: 'ticket-display', sheetId: 'ticket', name: 'Draft notional', cells: {
          A1: { type: 'number', value: quantity }, B1: { type: 'number', value: limitPrice },
          C1: { type: 'formula', value: '=A1*B1' },
        } },
      });
      const result = sheets.calculate(workbook).C1;
      if (result.error || !Number.isFinite(result.value)) throw new Error('Sheets could not calculate this value.');
      if (record === current.record) byId('notional').textContent =
        `Draft notional · ${quantity} × ${money.format(limitPrice)} = ${money.format(result.value)}`;
    } catch (error) {
      if (record === current.record) byId('notional').textContent = `Calculation unavailable. ${error.message}`;
    }
  }
  function renderSaved() {
    const record = current.record;
    byId('empty').hidden = Boolean(record);
    byId('record').hidden = !record;
    byId('evidence').hidden = !record;
    byId('reopen').hidden = !record && !blocked;
    byId('revision').textContent = record ? 'Revision ' + record.revision : 'Unsaved';
    if (!record) return;
    const v = record.values;
    byId('saved-ticket').textContent = `${v.side} ${v.quantity} · ${v.symbol}`;
    byId('saved-price').textContent = money.format(v.limitPrice);
    byId('saved-time').textContent = v.evaluationAt.slice(11);
    byId('saved-result').textContent = assessTicket(v, fixture).state;
    byId('fixture-id').textContent = v.fixtureId;
    byId('saved-policy').textContent = v.policyRevision;
    byId('digest').textContent = v.fixtureDigest;
    byId('notional').textContent = '';
    void renderCalculation();
  }

  form.addEventListener('input', () => {
    renderCheck();
    if (!blocked) feedback.textContent = 'Unsaved edit';
  });
  byId('advance').addEventListener('click', () => {
    const ms = utcMillis(values().evaluationAt);
    if (ms === null || field('evaluationTime').value === '23:59:59') {
      feedback.textContent = 'Choose a time within the fixture date.'; return;
    }
    field('evaluationTime').value = new Date(ms + 1000).toISOString().slice(11, 19);
    field('evaluationTime').dispatchEvent(new Event('input', { bubbles: true }));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (blocked || fields.disabled) return;
    const draft = values();
    fields.disabled = true;
    try {
      current = await store.save(current, draft);
      renderSaved();
      feedback.textContent = `Revision ${current.record.revision} saved on this device.`;
    } catch (error) {
      if (error.code === 'CONFLICT') {
        blocked = true;
        byId('save').disabled = true;
        byId('reopen').hidden = false;
        feedback.textContent = 'Another tab saved first. Your edit is retained. Load the saved revision to replace it.';
      } else feedback.textContent = error.message;
    } finally { fields.disabled = false; }
  });
  byId('reopen').addEventListener('click', async () => {
    fields.disabled = true;
    try {
      current = await store.open();
      fill(current.record?.values ?? initial);
      blocked = false;
      byId('save').disabled = false;
      renderSaved();
      renderCheck();
      feedback.textContent = 'Loaded the current saved revision.';
    } catch (error) {
      blocked = true;
      byId('save').disabled = true;
      feedback.textContent = error.message;
    } finally { fields.disabled = false; }
  });
  byId('evidence').addEventListener('toggle', renderCalculation);
  fill(current.record?.values ?? initial);
  renderSaved();
  renderCheck();
  fields.disabled = false;
}

void prepareOffline();
start().catch(error => {
  fields.disabled = true;
  byId('fatal').hidden = false;
  byId('fatal').textContent = error.message;
});

const rehearsal = byId('rehearsal');
let opening;
function loadRehearsal() {
  opening ??= import('./rehearsal-view.mjs')
    .then(module => module.mountRehearsal(byId('rehearsal-body')))
    .catch(error => { opening = null; byId('rehearsal-body').textContent = error.message; });
  return opening;
}
rehearsal.addEventListener('toggle', () => { if (rehearsal.open) void loadRehearsal(); });
async function openLinkedDashboard() {
  if (location.hash !== '#replay-dashboard') return;
  rehearsal.open = true;
  const view = await loadRehearsal();
  if (location.hash === '#replay-dashboard' && rehearsal.open) await view?.showDashboard();
}
window.addEventListener('hashchange', openLinkedDashboard);
void openLinkedDashboard();

byId('audit').addEventListener('toggle', async function openAudit() {
  if (!this.open) return;
  this.removeEventListener('toggle', openAudit);
  try {
    const { mountAudit } = await import('./audit-view.mjs');
    await mountAudit(this);
  } catch (error) { byId('audit-status').textContent = error.message; }
});
