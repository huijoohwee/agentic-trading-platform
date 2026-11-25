import { IndexedDBAdapter } from '../owners/base/src/index.mjs';
import { assessTicket, readFixture, ticketInputs, utcMillis } from './rules.mjs';
import { createTicketStore } from './tickets.mjs';
import { prepareOffline } from './offline-shell.mjs';
import { mountTradingDashboard } from './dashboard.mjs';

mountTradingDashboard(document);
// Native toggle covers pointer, touch and keyboard, including rehearsal tables added after startup.
document.addEventListener('toggle', ({ target }) => {
  if (!target.matches('details[data-agentic-section]')) return;
  const summary = target.querySelector(':scope > summary');
  if (target.open) summary.dataset.agenticAnnotationTarget = 'true';
  else delete summary.dataset.agenticAnnotationTarget;
}, true);
const byId = id => document.getElementById(id);
let calculationVisible = false, updateCalculation;
const sections = new Map([
  ['provider-desk', () => import('./moomoo-desk-view.mjs').then(m => m.mountMoomooDeskView(byId('desk-body')))],
  ['private-watchlists', () => import('./watchlist-view.mjs').then(m => m.mountWatchlists(byId('watchlist-body')))],
  ['provider-capture', () => import('./capture-view.mjs').then(m => m.mountCaptureView(byId('capture-body')))],
  ['provider-hosted', () => import('./hosted-view.mjs').then(m => m.mountHostedView(byId('hosted-body')))],
  ['runtime-readback', () => import('./runtime-view.mjs').then(m => m.mountRuntimeView(byId('runtime-body')))],
  ['rehearsal', () => import('./rehearsal-view.mjs').then(m => m.mountRehearsal(byId('rehearsal-body')))],
  ['audit', () => import('./audit-view.mjs').then(m => m.mountAudit(byId('audit')))],
  ['evidence', () => { calculationVisible = true; return updateCalculation?.(); }],
]);
const mounted = new Map();
function loadSection(id) {
  if (!mounted.has(id)) {
    const load = Promise.resolve().then(sections.get(id)).catch(() => {
      mounted.delete(id);
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry loading section';
      retry.onclick = () => { retry.remove(); void loadSection(id); };
      byId(id).append(retry);
    });
    mounted.set(id, load);
  }
  return mounted.get(id);
}
function observeSections() {
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const item of entries) if (item.isIntersecting) {
        observer.unobserve(item.target); void loadSection(item.target.id);
      }
    }, { rootMargin: '160px 0px' });
    for (const id of sections.keys()) observer.observe(byId(id));
  } else {
    for (const id of sections.keys()) void loadSection(id);
  }
}
function redirectCoverageBookmark() {
  const hash = location.hash;
  if (hash !== '#provider-coverage' && !hash.startsWith('#provider-coverage?')) return false;
  location.replace('./coverage.html' + (hash.includes('?') ? hash : ''));
  return true;
}
async function followSectionLink() {
  if (redirectCoverageBookmark()) return;
  const hash = location.hash.slice(1);
  const id = hash === 'replay-dashboard' ? 'rehearsal' : hash;
  if (!sections.has(id)) return;
  byId(id).scrollIntoView({ block: 'start' });
  const view = await loadSection(id);
  if (location.hash.slice(1) !== hash) return;
  if (hash === 'replay-dashboard') await view?.showDashboard();
}
window.addEventListener('hashchange', followSectionLink);
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
    if (!record || !calculationVisible) return;
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
    byId('evidence-empty').hidden = Boolean(record);
    byId('evidence-facts').hidden = !record;
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
  updateCalculation = renderCalculation;
  fill(current.record?.values ?? initial);
  renderSaved();
  renderCheck();
  fields.disabled = false;
}

if (!redirectCoverageBookmark()) {
  observeSections();
  void followSectionLink();
  void prepareOffline(byId('offline-status'));
  start().catch(error => {
    fields.disabled = true;
    byId('fatal').hidden = false;
    byId('fatal').textContent = error.message;
  });
}
