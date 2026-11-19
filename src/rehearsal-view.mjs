import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
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
  section.append(node('summary', title), content);
  return section;
}
function chart(points) {
  const values = points.map(p => p.equity);
  const lo = Math.min(...values), hi = Math.max(...values);
  const times = points.map(p => Date.parse(p.at));
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
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
function trace(pack) {
  const list = node('ol');
  for (const [i, receipt] of pack.snapshot.receipts.entries()) {
    const e = pack.tape.events[i];
    const item = node('li');
    const rows = Object.entries(e).map(([key,value]) => [key, typeof value === 'object' ? JSON.stringify(value) : value]);
    rows.push(['Equity after event',money(pack.snapshot.curve[i].equity)]);
    const details = facts(rows);
    item.append(disclosure(receipt.at + ' · ' + receipt.id + ' · ' + receipt.reason, details));
    list.append(item);
  }
  return disclosure('Decision and execution log (' + list.children.length + ')', list);
}

export async function mountRehearsal(host) {
  const response = await fetch('./src/rehearsal.json');
  if (!response.ok) throw Error('Rehearsal fixture unavailable');
  const fixture = await readRehearsal(await response.text());
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
  host.replaceChildren(controls, status, result);
  let current, busy = false;
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
    result.replaceChildren(heading, grid, trace(pack), disclosure('Strategy and review roles',mandate), disclosure(pack.verifiedBoundaries + ' verified rule boundaries',checks),
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
    const url = URL.createObjectURL(new Blob([JSON.stringify(current)],{type:'application/json'}));
    const anchor = node('a'); anchor.href = url; anchor.download = 'rehearsal-' + current.snapshot.run + '.json';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  download.disabled = true;
  const saved = localStorage.getItem(latestKey);
  if (saved !== null) await update(() => restore(fixture,saved),false);
  else status.textContent = 'Choose a synthetic run to replay on this device.';
}

