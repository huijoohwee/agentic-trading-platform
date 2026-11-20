import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { createPanelSectionSummary, installPanelSections, PANEL_SECTION } from '../owners/design/site/panel-section.js';
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
function timestamp(at, label = at) {
  const time = node('time', label);
  time.dateTime = at;
  return time;
}
function disclosure(title, content, at) {
  const section = node('details');
  const summary = node('summary', title);
  if (at) summary.prepend(timestamp(at), ' · ');
  section.append(summary, content);
  return section;
}
function chart(points) {
  const values = points.map(p => p.equity);
  const lo = Math.min(...values), hi = Math.max(...values);
  const times = points.map(p => Date.parse(p.at));
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('equity-curve');
  svg.setAttribute('viewBox','0 0 300 60');
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label', 'Equity in USD. Opening value ' + money(values[0]) + ' to ' + money(values.at(-1)) +
    '. Minimum ' + money(lo) + ', maximum ' + money(hi));
  const line = document.createElementNS(svg.namespaceURI,'polyline');
  line.setAttribute('points',values.map((v,i) => [2 + 296 * (times[i]-times[0]) / (times.at(-1)-times[0] || 1),
    58 - 56 * (v-lo)/(hi-lo || 1)].join(',')).join(' '));
  line.setAttribute('fill','none'); line.setAttribute('stroke','currentColor'); svg.append(line);
  return svg;
}
function createLog(pack) {
  const section = node('details'), body = node('div');
  section.id = 'replay-log';
  section.dataset.agenticSection = '';
  section.dataset.agenticSticky = 'false';
  body.id = 'replay-log-content';
  body.className = PANEL_SECTION.body;
  const summary = createPanelSectionSummary(document, 'Decision and execution log (' + pack.snapshot.receipts.length + ')');
  section.append(summary, body);
  const releaseSection = installPanelSections(section);
  let view, loading = false, disposed = false;
  section.addEventListener('toggle', async () => {
    if (!section.open || view || loading || disposed) return;
    loading = true;
    try {
      const { mountReplayLog } = await import('./replay-log.mjs');
      if (!disposed && section.open) view = mountReplayLog(body, pack, { money, node, timestamp, downloadJson });
    } catch (error) {
      body.replaceChildren(node('p', 'Could not open the decision log. ' + error.message));
    } finally { loading = false; }
  });
  return { section, destroy() { disposed = true; view?.destroy(); releaseSection(); } };
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
  const scheduleLog = node('ol');
  const schedule = disclosure('Offline schedule and run receipts', scheduleLog);
  schedule.id = 'schedule';
  schedule.addEventListener('toggle', async () => {
    if (!schedule.open || scheduleLog.childElementCount) return;
    try {
      const { rehearseForward } = await import('./forward-rehearsal.mjs');
      const { timeline } = rehearseForward();
      scheduleLog.replaceChildren(...timeline.map(row => {
        const item = node('li');
        item.append(timestamp(row.at, row.at.slice(11)), ' · ' + row.action + ' · ' + row.outcome);
        if (row.request) item.append(node('code', row.request.method + ' ' + row.request.path));
        if (row.cursor) {
          const cursor = node('small', 'Last completed event · ');
          cursor.append(node('samp', row.cursor));
          item.append(cursor);
        }
        return item;
      }));
    } catch (error) { scheduleLog.replaceChildren(node('li', error.message)); }
  });
  const { DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
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
  host.replaceChildren(panelStyle, controls, status, result, schedule);
  let current, log, busy = false;
  function render(pack) {
    const s = pack.snapshot;
    const portfolio = facts([['Equity',money(s.equity)], ['Net P&L vs cash',money(s.net)],
      ['Cash',money(s.cash)], ['Recorded fees',money(s.fees)], ['Interest', money(s.interest)],
      ['Drawdown',percent(s.drawdown)], ['Maximum drawdown',percent(s.maxDrawdown)]]);
    const performance = node('div');
    performance.append(portfolio, chart(s.curve));
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
      {id:'returns',title:'Performance',accent:'primary',content:performance},
      {id:'inventory',title:'Positions and open orders',accent:'secondary',content:inventory},
      {id:'source',title:'Run evidence',accent:'success',content:provenance}] });
    const checks = node('ul');
    for (const probe of fixture.boundaries) checks.append(node('li',probe.name + ' · expected ' + probe.expected));
    const mandate = facts([...Object.entries(pack.tape.mandate), ...Object.entries(s.roles)]);
    const heading = DashboardPrimitive({kind:'heading',level:2,children:'Run ' + s.run + ' · ' + s.profile});
    log?.destroy();
    log = createLog(pack);
    result.replaceChildren(heading, grid, log.section, disclosure('Strategy and review roles',mandate), disclosure(pack.verifiedBoundaries + ' verified rule boundaries',checks),
      disclosure('Replay SHA-256',node('code',pack.sha256)));
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
}
