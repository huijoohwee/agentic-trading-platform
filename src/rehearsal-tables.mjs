import { asText, bindWorkbookExport } from './rehearsal-workbook.mjs';
import { mountDataView } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { createFieldTypeIcon, createKeyTypeValueRows } from '../owners/design/site/key-type-value.js';
import { MICRO } from './competition-rules.mjs';

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

function tableViewport(node) {
  const viewport = node('div'), mount = node('div'), stylesheet = node('link');
  viewport.className = 'rehearsal-table';
  mount.setAttribute('part', 'mount');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
  viewport.attachShadow({ mode: 'open' }).append(stylesheet, mount);
  return { viewport, mount };
}

export function mountPivotTable(host, { headers, records }, node, format) {
  const { mount, viewport } = tableViewport(node);
  host.replaceChildren(viewport);
  return mountDataView(mount, { ariaLabel: 'Replay pivot results', layout: 'multiDimensional',
    columns: headers.map((name, index) => ({ id: 'field-' + index, name })),
    rows: records.map(({ id, values }) => ({ id, cells: values.map((cell, index) =>
      cell === undefined ? '—' : index ? format(cell) : String(cell)) })),
  });
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

  const { viewport, mount } = tableViewport(node);
  const inspector = node('section');
  inspector.setAttribute('aria-label', spec.inspector);
  body.replaceChildren(controls, error, viewport, inspector);
  let visible = rows, selected, table;
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
  bindWorkbookExport(save, error, spec, downloadJson);
  filter();
  return {
    filter(query, focus = true) { search.value = query; filter(); if (focus) search.focus(); },
    destroy() { table.destroy(); },
  };
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
