import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { createPanelSectionSummary, installPanelSections, PANEL_SECTION } from '../owners/design/site/panel-section.js';
import { replayDashboard } from './rehearsal-dashboard.mjs';
import { archive, MAX_ARCHIVE, readRehearsal, restore } from './replay.mjs';
import { MICRO } from './competition-rules.mjs';

const latestKey = 'trading-rehearsal/1/last-verified';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const money = amount => usd.format(amount / MICRO);
const percent = value => (100 * value).toFixed(3) + '%';
const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
function facts(rows) {
  const list = node('dl');
  list.className = 'facts';
  for (const [term, value] of rows) {
    const row = node('div');
    row.append(node('dt', term), node('dd', value));
    list.append(row);
  }
  return list;
}
function disclosure(title, content) {
  const section = node('details');
  const summary = node('summary', title);
  section.append(summary, content);
  return section;
}
function tableSection(id, title, mount, loadData) {
  const section = node('details'), body = node('div');
  section.id = id;
  section.dataset.agenticSection = '';
  section.dataset.agenticSticky = 'false';
  body.id = id + '-content';
  body.className = PANEL_SECTION.body + ' rehearsal-table-content';
  section.append(createPanelSectionSummary(document, title), body);
  const releaseSection = installPanelSections(section);
  let view, onOpen, loading = false, disposed = false;
  section.addEventListener('toggle', async () => {
    if (!section.open || view || loading || disposed) return;
    loading = true;
    try {
      const [tables, data] = await Promise.all([import('./rehearsal-tables.mjs'), loadData?.()]);
      if (!disposed && section.open) {
        view = mount(tables, body, data);
        onOpen?.(view);
        onOpen = undefined;
      }
    } catch (error) {
      if (!disposed) {
        const message = node('p', title + ' could not be opened. ' + error.message);
        message.setAttribute('role', 'alert');
        body.replaceChildren(message);
      }
    } finally { loading = false; }
  });
  return { section,
    openWith(callback) {
      section.open = true;
      if (view) callback(view);
      else onOpen = callback;
    },
    destroy() { disposed = true; onOpen = undefined; view?.destroy(); releaseSection(); },
  };
}

function downloadJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = node('a');
  anchor.href = url; anchor.download = filename;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function mountRehearsal(host) {
  const response = await fetch('./src/rehearsal.json');
  if (!response.ok) throw Error('Rehearsal fixture unavailable');
  const fixture = await readRehearsal(await response.text());
  const ui = { money, percent, node, downloadJson };
  const schedule = tableSection('schedule', 'Offline schedule and run receipts',
    (tables, body, timeline) => tables.mountSchedule(body, timeline, ui),
    async () => (await import('./forward-rehearsal.mjs')).rehearseForward().timeline);
  const { DashboardCardGrid } = createNativeDashboard(document);
  const controls = node('div'), status = node('p'), result = node('div');
  controls.className = 'agentic-dashboard-actions agentic-form-controls';
  status.setAttribute('role','status'); status.id = 'replay-status';
  const select = node('select'), runLabel = node('label','Synthetic run');
  for (const r of fixture.runs) {
    const option = node('option', 'Run ' + r.id + ' · ' + r.profile); option.value = r.id; select.append(option);
  }
  runLabel.append(select);
  const button = label => {
    const b = node('button', label); b.type = 'button'; b.className = 'agentic-form-control'; return b;
  };
  const run = button('Replay run'), download = button('Export replay');
  const upload = node('input'), fileLabel = node('label', 'Restore replay file');
  upload.type = 'file'; upload.accept = '.json,application/json'; fileLabel.append(upload);
  controls.append(runLabel, run, download, fileLabel);
  const panelStyle = node('link');
  panelStyle.rel = 'stylesheet';
  panelStyle.href = new URL('../owners/design/site/panel-section.css', import.meta.url);
  host.replaceChildren(panelStyle, controls, status, result, schedule.section);
  let current, dashboard, log, boundaries, busy = false;
  function render(pack) {
    const s = pack.snapshot;
    const portfolio = facts([['Cash',money(s.cash)], ['Recorded fees',money(s.fees)], ['Interest', money(s.interest)],
      ['Drawdown',percent(s.drawdown)]]);
    const working = s.orders.filter(o => o.status === 'WORKING');
    const inventory = facts([
      ...Object.entries(s.positions).map(([symbol,p]) => [symbol, p.qty + ' held · basis ' + money(p.basis)]),
      ['Open orders', String(working.length)], ...working.map(o => [o.id,o.side + ' ' + (o.qty-o.filled) + ' ' + o.symbol + ' remaining']),
      ['Risk state',s.halt ? 'Halted' : 'Clear']]);
    const age = node('span');
    const millis = Date.now() - Date.parse(s.at);
    age.textContent = millis < 0 ? 'Device time precedes fixture' : Math.floor(millis/60000).toLocaleString() + ' min at viewing';
    const provenance = facts([['Account',s.environment + ' · ' + s.account],['Observed (UTC)',s.at],
      ['Imported (UTC)',s.importedAt], ['Observation age',age.textContent], ['Source',s.source], ['Strategy',s.strategy], ['Policy',s.policy],
      ['Evaluator',s.evaluator], ['Qoder runs / credits','Unobserved offline']]);
    if (s.profile === 'competition') {
      portfolio.append(...facts([['Friday mark',money(s.weekly)],['Final ranked equity',money(s.ranked)]]).children);
    }
    const grid = DashboardCardGrid({ ariaLabel:'Competition rehearsal snapshot', cards:[
      {id:'returns',title:'Account detail',accent:'primary',content:portfolio},
      {id:'inventory',title:'Positions and open orders',accent:'secondary',content:inventory},
      {id:'source',title:'Run evidence',accent:'success',content:provenance}] });
    const mandate = facts([...Object.entries(pack.tape.mandate), ...Object.entries(s.roles)]);
    dashboard?.destroy();
    log?.destroy();
    boundaries?.destroy();
    log = tableSection('replay-log', 'Decision and execution log (' + s.receipts.length + ')',
      (tables, body) => tables.mountReplayLog(body, pack, ui));
    boundaries = tableSection('rule-boundaries', pack.verifiedBoundaries + ' verified rule boundaries',
      (tables, body) => tables.mountBoundaries(body, fixture, pack, ui));
    const evidence = node('section');
    evidence.setAttribute('aria-label', 'Replay evidence');
    evidence.append(grid, log.section, disclosure('Strategy and review roles',mandate), boundaries.section,
      disclosure('Replay SHA-256',node('code',pack.sha256)));
    dashboard = replayDashboard(pack, ui, evidence, log);
    result.replaceChildren(dashboard.element);
    select.value = s.run;
    current = pack;
  }
  async function update(operation, persist) {
    if (busy) return;
    busy = true;
    for (const control of [run,select,upload,download]) control.disabled = true;
    try {
      const pack = await operation();
      if (persist) localStorage.setItem(latestKey,JSON.stringify(pack));
      render(pack);
      status.textContent = 'Verified run ' + pack.snapshot.run + ' · ' + pack.snapshot.receipts.length + ' synthetic events';
    } catch (error) { status.textContent = error.message; }
    finally {
      busy = false;
      for (const control of [run,select,upload]) control.disabled = false;
      download.disabled = !current;
    }
  }
  run.onclick = () => update(() => archive(fixture,select.value),true);
  upload.onchange = async () => {
    const file = upload.files[0];
    if (file) await update(async () => {
      if (file.size > MAX_ARCHIVE) throw Error('Archive exceeds limit');
      return restore(fixture,await file.text());
    },true);
    upload.value = '';
  };
  download.onclick = () => {
    if (!current) return;
    downloadJson(JSON.stringify(current), 'rehearsal-' + current.snapshot.run + '.json');
  };
  download.disabled = true;
  const saved = localStorage.getItem(latestKey);
  if (saved !== null) await update(() => restore(fixture,saved),false);
  else status.textContent = 'Choose a synthetic run to replay on this device.';
  return { async showDashboard() {
    if (!current && saved === null) await update(() => archive(fixture, 'B'), false);
    if (location.hash !== '#replay-dashboard' || !host.closest('details')?.open) return;
    (result.querySelector('#replay-dashboard') ?? status).scrollIntoView({ block: 'start' });
  } };
}
