import { mountDataView } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { createFieldTypeIcon, createKeyTypeValueRows } from '../owners/design/site/key-type-value.js';
import { MICRO } from './competition-rules.mjs';

function asText(value) {
  if (value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// The Base table and Sheets snapshot project the same ordered records.
// Keep numeric data native in Sheets and leave missing observations blank.
async function workbookSnapshot({ workbookId, sheetId, name, headers, records }) {
  const { CONTRACT, executeWorkbook, encodeSnapshot } = await import('../owners/sheets/sheets/core.mjs');
  const { addressOf } = await import('../owners/sheets/sheets/schema.mjs');
  const cells = {};
  function write(row, values) {
    values.forEach((value, column) => {
      if (value === undefined) return;
      cells[addressOf(row, column)] = typeof value === 'number'
        ? { type: 'number', value } : { type: 'text', value: asText(value) };
    });
  }
  write(0, headers);
  records.forEach((record, index) => write(index + 1, record.values));
  const { workbook } = await executeWorkbook(null, {
    contract: CONTRACT, operationId: 'export-' + sheetId, operation: 'create', expectedRevision: 0,
    payload: { workbookId, sheetId, name, fitToCells: true, cells },
  });
  return encodeSnapshot(workbook);
}

function evidenceRow(node, [label, value, kind]) {
  const text = asText(value);
  let type = kind;
  if (!type) {
    if (value == null || typeof value === 'string') type = 'text';
    else type = Array.isArray(value) ? 'list' : typeof value;
  }
  const valueNode = node(type === 'datetime' ? 'time' : 'samp', value === undefined ? '—' : text);
  if (type === 'datetime') valueNode.dateTime = text;
  return { id: label, keyNode: label, typeNode: createFieldTypeIcon(type), valueNode };
}

function mountTable(body, spec, { node, downloadJson }) {
  const columns = spec.headers.map(name => ({ id: name, name }));
  const rows = spec.records.map(record => ({
    id: record.id, cells: record.display ?? record.values.map(asText), record,
  }));
  const controls = node('div'), label = node('label', 'Filter ' + spec.noun), search = node('input');
  controls.className = 'agentic-dashboard-actions agentic-form-controls';
  search.type = 'search'; label.append(search);
  const save = node('button', spec.exportLabel);
  save.type = 'button'; save.className = 'agentic-form-control';
  const count = node('span'), error = node('p');
  count.className = 'agentic-text-detail'; count.setAttribute('role', 'status');
  error.setAttribute('role', 'alert');
  controls.append(label, save, count);

  const viewport = node('div'), mount = node('div'), stylesheet = node('link');
  viewport.className = 'rehearsal-table';
  mount.setAttribute('part', 'mount');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
  viewport.attachShadow({ mode: 'open' }).append(stylesheet, mount);
  const inspector = node('section');
  inspector.setAttribute('aria-label', spec.inspector);
  body.replaceChildren(controls, error, viewport, inspector);
  let visible = rows, selected, table, active = true;
  function select(row) {
    selected = row;
    if (!row) { inspector.replaceChildren(); return; }
    const { title, fields } = row.record;
    inspector.replaceChildren(node('h4', spec.inspector + ' · ' + title),
      createKeyTypeValueRows({ rows: fields.map(field => evidenceRow(node, field)) }));
  }
  function state() {
    return { ariaLabel: spec.tableLabel ?? spec.name, columns, rows: visible, selectedRowId: selected?.id ?? null,
      onActivateRow(id) {
        select(visible.find(row => row.id === id));
        table.update(state());
      } };
  }
  function filter() {
    const query = search.value.trim().toLowerCase();
    visible = rows.filter(row => row.cells.some(cell => cell.toLowerCase().includes(query)));
    select(visible.includes(selected) ? selected : visible[0]);
    count.textContent = visible.length + ' of ' + rows.length + ' ' + spec.noun;
    if (table) table.update(state());
    else table = mountDataView(mount, state());
  }
  search.addEventListener('input', filter);
  save.onclick = async () => {
    save.disabled = true; error.textContent = '';
    try {
      const text = await workbookSnapshot(spec);
      if (active) downloadJson(text, spec.filename);
    } catch (failure) { error.textContent = failure.message; }
    finally { save.disabled = false; }
  };
  filter();
  return { destroy() { active = false; table.destroy(); } };
}

export function mountReplayLog(body, pack, ui) {
  const { receipts, curve, run } = pack.snapshot;
  const events = new Map(pack.tape.events.map(event => [event.id, event]));
  const records = receipts.map((receipt, index) => {
    const event = events.get(receipt.id), point = curve[index];
    if (!event || point?.event !== receipt.id) throw Error('Replay event and equity evidence disagree.');
    const values = [receipt.id, receipt.reason, receipt.at, receipt.type, point.equity / MICRO];
    const equity = ui.money(point.equity);
    const fields = Object.entries(event).map(([key, value]) => [key, value, key === 'at' ? 'datetime' : undefined]);
    fields.push(['Equity after event', equity, 'number']);
    return { id: receipt.id, title: receipt.id, values, display: [...values.slice(0, -1), equity], fields };
  });
  return mountTable(body, { name: 'Run ' + run + ' decision log', tableLabel: 'Replay events', noun: 'events', inspector: 'Event evidence',
    headers: ['Event', 'Decision', 'Time (UTC)', 'Event type', 'Equity (USD)'], records,
    workbookId: 'replay-' + pack.sha256, sheetId: 'events', filename: 'run-' + run + '-events.sheets.json', exportLabel: 'Export run to Sheets' }, ui);
}

export function mountBoundaries(body, fixture, pack, ui) {
  const headers = ['Boundary', 'Expected result', 'Rule', 'Input'];
  const records = fixture.boundaries.map(probe => {
    const values = [probe.name, probe.expected, probe.rule, probe.input];
    return { id: probe.name, title: probe.name, values, fields: headers.map((key, i) => [key, values[i]]) };
  });
  return mountTable(body, { name: 'Verified rule boundaries', noun: 'boundaries', inspector: 'Boundary evidence', headers, records,
    workbookId: 'rules-' + pack.sha256, sheetId: 'boundaries', filename: 'rule-boundaries.sheets.json', exportLabel: 'Export boundaries to Sheets' }, ui);
}

export function mountSchedule(body, timeline, ui) {
  const headers = ['Action', 'Outcome', 'Time (UTC)', 'Request', 'Last completed event', 'Run', 'Request body'];
  const records = timeline.map(({ at, action, outcome, request, run, cursor }, index) => {
    const values = [action, outcome, at, request && request.method + ' ' + request.path, cursor ?? undefined, run ?? undefined, request?.body];
    const fields = headers.flatMap((key, i) => values[i] == null ? [] : [[key, values[i], i === 2 ? 'datetime' : undefined]]);
    return { id: 'receipt-' + (index + 1), title: action + ' · ' + at.slice(11), values, fields };
  });
  return mountTable(body, { name: 'Schedule receipts', noun: 'receipts', inspector: 'Receipt evidence', headers, records,
    workbookId: 'fixture-forward-schedule', sheetId: 'receipts', filename: 'schedule-receipts.sheets.json', exportLabel: 'Export receipts to Sheets' }, ui);
}
