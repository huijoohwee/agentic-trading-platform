import { IndexedDBAdapter } from '../owners/base/src/index.mjs';
import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { mountDataView, mountDashboardChart } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { localFixtureTable } from './tickets.mjs';
import { canonical, digest } from './rules.mjs';

export async function validateRuntimeView(value) {
  if (!value || value.schema !== 'trading-runtime-view/v1' || value.environment !== 'SIMULATE' ||
    !['practice', 'competition'].includes(value.profile) || value.readiness !== 'UNQUALIFIED' ||
    !/^[a-f0-9]{64}$/.test(value.candidate) || !/^[a-f0-9]{64}$/.test(value.configured_candidate) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    JSON.stringify(value).length > 64_000) throw Error('Invalid runtime projection');
  const shape = (row, fields) => row && !Array.isArray(row) && typeof row === 'object' && Object.keys(row).sort().join(',') === fields.split(',').sort().join(',');
  const text = item => typeof item === 'string' && item.length <= 128;
  const number = item => item === null || Number.isFinite(item);
  const time = item => item === null || (typeof item === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(item) && Number.isFinite(Date.parse(item)));
  if (!shape(value, 'schema,candidate,configured_candidate,revision,source,readiness,account_alias,profile,environment,observed_utc,retrieved_utc,snapshot_digest,halted,halt_reason,equity,cash,day_pnl,max_drawdown,curve,counts,positions,orders,decisions,runs,threads,digest') ||
    !['AUTHENTICATED_ADAPTER', 'NO_PROVIDER_OBSERVATION'].includes(value.source) || !text(value.account_alias) ||
    typeof value.halted !== 'boolean' || !text(value.halt_reason) || !time(value.observed_utc) || !time(value.retrieved_utc) ||
    !(value.snapshot_digest === null || /^[a-f0-9]{64}$/.test(value.snapshot_digest)) ||
    !['equity', 'cash', 'day_pnl', 'max_drawdown'].every(key => number(value[key])) ||
    !shape(value.counts, 'positions,orders,decisions,runs,threads')) throw Error('Invalid projection fields');
  const validators = {
    positions: row => shape(row, 'symbol,quantity,value,flags') && text(row.symbol) && number(row.quantity) && number(row.value) && Array.isArray(row.flags) && row.flags.length <= 16 && row.flags.every(text),
    orders: row => shape(row, 'reference,symbol,side,quantity,filled,status') && ['reference','symbol','side','status'].every(key => text(row[key])) && number(row.quantity) && number(row.filled),
    decisions: row => shape(row, 'reference,at,result,reason') && ['reference','result','reason'].every(key => text(row[key])) && time(row.at),
    runs: row => shape(row, 'reference,stream,status,delivery,usage,threads') && ['reference','stream','status','delivery'].every(key => text(row[key])) && number(row.usage) && (row.threads === null || Number.isSafeInteger(row.threads) && row.threads >= 0),
    threads: row => shape(row, 'reference,role,status,usage') && ['reference','role','status'].every(key => text(row[key])) && number(row.usage),
    curve: row => shape(row, 'at,equity,drawdown') && time(row.at) && number(row.equity) && number(row.drawdown),
  };
  for (const [key, valid] of Object.entries(validators)) {
    if (!Array.isArray(value[key]) || value[key].length > (key === 'curve' ? 128 : 50) || !value[key].every(valid) ||
      key !== 'curve' && (!Number.isSafeInteger(value.counts[key]) || value.counts[key] < value[key].length)) throw Error('Invalid projection rows');
  }
  const { digest: expected, ...data } = value;
  if (await digest(canonical(data)) !== expected) throw Error('Runtime projection integrity mismatch');
  return value;
}
export async function mountRuntimeView(host) {
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const status = node('p', 'No runtime observation saved. Offline rehearsal remains available.'); status.id = 'runtime-status'; status.setAttribute('role', 'status');
  const label = node('label', 'Local viewer token'), token = node('input'); token.type = 'password'; token.id = 'runtime-token'; token.autocomplete = 'off';
  label.append(token);
  const refresh = node('button', 'Read local runtime'); refresh.type = 'button'; refresh.id = 'runtime-refresh';
  const controls = node('div'); controls.className = 'agentic-dashboard-actions agentic-form-controls'; controls.append(label, refresh);
  const output = node('div'); output.id = 'runtime-output';
  const privacy = node('p', 'Read-only projection. Viewer tokens stay in memory; broker credentials never reach this page. Stored redacted observations do not authorize trades.');
  const simulator = node('details');
  simulator.append(node('summary', 'Inspect a completed simulator read'));
  simulator.addEventListener('toggle', async function open() {
    if (!simulator.open) return;
    simulator.removeEventListener('toggle', open);
    try { (await import('./simulator-receipt-view.mjs')).mountSimulatorReceipts(simulator, node); }
    catch { simulator.append(node('p', 'Simulator receipt viewer unavailable.')); }
  });
  const events = node('details');
  events.id = 'private-trade-events';
  events.append(node('summary', 'Replay private trade events'));
  events.addEventListener('toggle', async function open() {
    if (!events.open) return;
    events.removeEventListener('toggle', open);
    try { (await import('./trade-event-view.mjs')).mountTradeEvents(events, node); }
    catch { events.append(node('p', 'Private trade-event viewer unavailable.')); }
  });
  const orders = node('details');
  orders.id = 'private-open-orders';
  orders.className = 'rehearsal-table-content';
  orders.append(node('summary', 'Inspect saved orders and fills'));
  orders.addEventListener('toggle', async function open() {
    if (!orders.open) return;
    orders.removeEventListener('toggle', open);
    try { (await import('./open-orders-view.mjs')).mountOpenOrders(orders, node); }
    catch { orders.append(node('p', 'Saved orders and fills viewer unavailable.')); }
  });
  host.replaceChildren(status, privacy, controls, output, simulator, events, orders);
  const baseId = 'trading-runtime-projections-v1', tableId = 'observations', recordId = 'latest';
  const { run, ensureTable } = localFixtureTable(new IndexedDBAdapter({ databaseName: baseId }), {
    baseId, tableId, title: 'Redacted runtime observations', baseName: 'Trading runtime readback',
    fields: [{ id: 'snapshot', name: 'Redacted projection', type: 'text', required: true }],
    permitRecord: id => id === null || id === recordId,
  });
  await ensureTable();
  let current = await run('view.project', { baseId, tableId, view: { kind: 'table', columns: ['snapshot'] } });
  let snapshot = null, widgets = [];
  const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) : 'UNKNOWN';
  const showTable = (parent, title, columns, rows) => {
    const region = node('section'), heading = node('h4', title), viewport = node('div'), mount = node('div'), style = node('link');
    viewport.className = 'rehearsal-table'; mount.setAttribute('part', 'mount'); style.rel = 'stylesheet';
    style.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
    viewport.attachShadow({ mode: 'open' }).append(style, mount); region.append(heading, viewport); parent.append(region);
    widgets.push(mountDataView(mount, { ariaLabel: title, columns: columns.map(name => ({ id: name, name })),
      rows: rows.map((cells, index) => ({ id: title + '-' + index, cells: cells.map(value => value === null || value === undefined ? 'UNKNOWN' : String(value)) })) }));
  };
  function render(cached) {
    if (!snapshot) return;
    widgets.forEach(widget => widget.destroy()); widgets = [];
    const { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
    const age = snapshot.observed_utc ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.observed_utc)) / 1000)) + ' s old' : 'age unknown';
    status.textContent = `${cached || !navigator.onLine ? 'Stored observation' : 'Read-only observation'} · ${age} · ${snapshot.source} · runtime UNQUALIFIED`;
    const details = node('div');
    const facts = node('p', `Observed ${snapshot.observed_utc ?? 'UNKNOWN'} · Snapshot ${snapshot.snapshot_digest ?? 'UNKNOWN'} · ${snapshot.halted ? 'HALTED: ' + snapshot.halt_reason : 'No recorded halt'}`);
    details.append(facts, node('p', `Evidence candidate ${snapshot.candidate} · ${snapshot.candidate === snapshot.configured_candidate ? 'matches local configuration' : 'CONFIGURATION CHANGED — observation belongs to an earlier candidate'}`));
    const chart = node('div'); chart.className = 'worksheet-series'; details.append(chart);
    if (snapshot.curve.length > 1 && snapshot.curve.every(point => Number.isFinite(point.equity))) {
      widgets.push(mountDashboardChart(chart, { type: 'line', tone: 'blue', gridEnabled: true,
        series: snapshot.curve.map(point => ({ label: point.at, value: point.equity, detail: money(point.equity) })) }));
    } else chart.append(node('p', 'Equity curve needs at least two complete observed marks; missing values are not interpolated.'));
    details.append(node('p', 'Drawdown is sampled from observed marks, not an official competition result. Tables show at most 50 rows.'));
    showTable(details, `Positions (${snapshot.counts.positions})`, ['Symbol', 'Quantity', 'Value', 'Data gaps'],
      snapshot.positions.map(row => [row.symbol, row.quantity, money(row.value), row.flags.join(', ')]));
    showTable(details, `Orders (${snapshot.counts.orders})`, ['Reference', 'Symbol', 'Side', 'Quantity', 'Filled', 'State'],
      snapshot.orders.map(row => [row.reference, row.symbol, row.side, row.quantity, row.filled, row.status]));
    showTable(details, `Decisions (${snapshot.counts.decisions})`, ['Reference', 'Observed', 'Result', 'Reason'],
      snapshot.decisions.map(row => [row.reference, row.at, row.result, row.reason]));
    showTable(details, `Forward observations (${snapshot.counts.runs})`, ['Reference', 'Stream', 'Run state', 'Delivery', 'Credits', 'Threads'],
      snapshot.runs.map(row => [row.reference, row.stream, row.status, row.delivery, row.usage, row.threads]));
    showTable(details, `Thread observations (${snapshot.counts.threads})`, ['Reference', 'Role', 'State', 'Credits'],
      snapshot.threads.map(row => [row.reference, row.role, row.status, row.usage]));
    output.replaceChildren(DashboardCanvasLayout({ ariaLabel: 'Runtime readback',
      title: DashboardPrimitive({ kind: 'heading', level: 3, children: snapshot.account_alias + ' · ' + snapshot.profile }),
      description: DashboardPrimitive({ kind: 'text', children: 'SIMULATE · redacted local copy · no execution controls' }),
      overview: DashboardCardGrid({ ariaLabel: 'Runtime indicators', cards: [
        { id: 'runtime-equity', eyebrow: 'Observed equity', title: money(snapshot.equity), accent: 'primary' },
        { id: 'runtime-pnl', eyebrow: 'Observed day P&L', title: money(snapshot.day_pnl), accent: 'secondary' },
        { id: 'runtime-drawdown', eyebrow: 'Sampled maximum drawdown', title: snapshot.max_drawdown === null ? 'UNKNOWN' : (snapshot.max_drawdown * 100).toFixed(2) + '%', accent: 'neutral' },
      ] }), sections: details }));
  }
  try {
    if (current.total > 1) throw Error('Unexpected projection count');
    const record = current.projection.rows[0];
    if (record) { if (record.id !== recordId) throw Error('Unexpected projection identity'); snapshot = await validateRuntimeView(JSON.parse(record.values.snapshot)); render(true); }
  } catch { status.textContent = 'Stored projection is invalid. Runtime reading is locked; offline rehearsal remains available.'; refresh.disabled = true; return; }
  refresh.addEventListener('click', async () => {
    if (token.value.length < 32) { status.textContent = 'Enter the local runtime viewer token; do not enter a broker token.'; return; }
    refresh.disabled = true;
    try {
      const response = await fetch('./api/runtime', { headers: { Authorization: 'Bearer ' + token.value }, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw Error(response.status === 401 ? 'Viewer token rejected.' : 'Runtime unavailable or not configured.');
      const value = await validateRuntimeView(await response.json());
      const record = current.projection.rows[0];
      const payload = { baseId, tableId, expectedRevision: current.revision, values: { snapshot: JSON.stringify(value) } };
      await run(record ? 'record.update' : 'record.create', record ? { ...payload, recordId, expectedRecordRevision: record.revision } : { ...payload, id: recordId });
      current = await run('view.project', { baseId, tableId, view: { kind: 'table', columns: ['snapshot'] } });
      snapshot = value; render(false);
    } catch (error) { status.textContent = (error.code === 'CONFLICT' ? 'Another tab saved first. Reload before reading again.' : error.message) + ' Last saved observation was not replaced.'; }
    finally { token.value = ''; refresh.disabled = false; }
  });
  window.addEventListener('offline', () => render(true));
  window.addEventListener('online', () => render(true));
}
