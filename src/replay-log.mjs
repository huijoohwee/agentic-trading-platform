import { mountDataView } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { createFieldTypeIcon, createKeyTypeValueRows } from '../owners/design/site/key-type-value.js';
import { MICRO } from './competition-rules.mjs';

const columns = [
  { id: 'event', name: 'Event' }, { id: 'decision', name: 'Decision' },
  { id: 'at', name: 'Time (UTC)' }, { id: 'type', name: 'Event type' },
  { id: 'equity', name: 'Equity (USD)' },
];

async function exportWorkbook(pack, records, downloadJson) {
  const { CONTRACT, executeWorkbook, encodeSnapshot } = await import('../owners/sheets/sheets/core.mjs');
  const { addressOf } = await import('../owners/sheets/sheets/schema.mjs');
  const cells = {};
  function writeRow(index, values) {
    values.forEach((value, column) => {
      cells[addressOf(index, column)] = { type: typeof value === 'number' ? 'number' : 'text', value };
    });
  }
  writeRow(0, columns.map(column => column.name));
  records.forEach(({ row, equity }, index) => writeRow(index + 1, [...row.cells.slice(0, -1), equity / MICRO]));
  const run = pack.snapshot.run;
  const { workbook } = await executeWorkbook(null, {
    contract: CONTRACT, operationId: 'export-events', operation: 'create', expectedRevision: 0,
    payload: { workbookId: 'replay-' + pack.sha256, sheetId: 'events', name: 'Run ' + run + ' decision log', cells },
  });
  downloadJson(encodeSnapshot(workbook), 'run-' + run + '-events.sheets.json');
}

export function mountReplayLog(body, pack, { money, node, timestamp, downloadJson }) {
  const { receipts, curve } = pack.snapshot;
  const events = new Map(pack.tape.events.map(event => [event.id, event]));
  const records = receipts.map((receipt, index) => {
    const event = events.get(receipt.id), point = curve[index];
    if (!event || point?.event !== receipt.id) throw Error('Replay event and equity evidence disagree.');
    return { event, equity: point.equity, row: { id: receipt.id, cells: [
      receipt.id, receipt.reason, receipt.at, receipt.type, money(point.equity),
    ] } };
  });
  const controls = node('div'), label = node('label', 'Filter events'), search = node('input');
  controls.className = 'agentic-dashboard-actions agentic-form-controls';
  search.type = 'search'; label.append(search);
  const save = node('button', 'Export run to Sheets');
  save.type = 'button'; save.className = 'agentic-form-control';
  const count = node('span'), error = node('p');
  count.className = 'agentic-text-detail'; count.setAttribute('role', 'status');
  error.setAttribute('role', 'alert');
  controls.append(label, save, count);

  const viewport = node('div'), mount = node('div'), stylesheet = node('link');
  viewport.className = 'replay-log-table';
  mount.setAttribute('part', 'mount');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
  viewport.attachShadow({ mode: 'open' }).append(stylesheet, mount);
  const inspector = node('section');
  inspector.setAttribute('aria-label', 'Event evidence');
  body.replaceChildren(controls, error, viewport, inspector);
  let visible = records, selected, table, active = true;
  function select(record) {
    selected = record;
    if (!record) { inspector.replaceChildren(); return; }
    const { event, equity } = record;
    const rows = Object.entries(event).map(([key, value]) => {
      const type = key === 'at' ? 'datetime' : Array.isArray(value) ? 'list' : typeof value === 'string' ? 'text' : typeof value;
      return { id: key, keyNode: key, typeNode: createFieldTypeIcon(type),
        valueNode: key === 'at' ? timestamp(value) : node('samp', typeof value === 'object' ? JSON.stringify(value) : value) };
    });
    rows.push({ id: 'equityAfter', keyNode: 'Equity after event', typeNode: createFieldTypeIcon('number'), valueNode: node('samp', money(equity)) });
    inspector.replaceChildren(node('h4', 'Event evidence · ' + event.id), createKeyTypeValueRows({ rows }));
  }
  function tableState() {
    return { ariaLabel: 'Replay events', columns, rows: visible.map(record => record.row), selectedRowId: selected?.row.id ?? null,
      onActivateRow(id) {
        select(visible.find(record => record.row.id === id));
        table.update(tableState());
      } };
  }
  function filter() {
    const query = search.value.trim().toLowerCase();
    visible = records.filter(({ row }) => row.cells.some(cell => cell.toLowerCase().includes(query)));
    select(visible.includes(selected) ? selected : visible[0]);
    count.textContent = visible.length + ' of ' + records.length + ' events';
    if (table) table.update(tableState());
    else table = mountDataView(mount, tableState());
  }
  search.addEventListener('input', filter);
  save.onclick = async () => {
    save.disabled = true; error.textContent = '';
    try {
      await exportWorkbook(pack, records, (text, file) => { if (active) downloadJson(text, file); });
    } catch (failure) { error.textContent = failure.message; }
    finally { save.disabled = false; }
  };
  filter();
  return { destroy() { active = false; table.destroy(); } };
}
