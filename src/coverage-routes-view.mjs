import { mountDataView } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { createTabList } from '../owners/design/site/floating-panel.js';
import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';

const pageSize = 12;
const transports = ['REST', 'MCP', 'Push'];
const columns = names => names.map((name, i) => ({ id: 'field-' + i, name }));

export function mountRouteViews(host, inventory, node, inspect) {
  const rows = inventory.map((route, index) => ({ ...route, id: 'route-' + index }));
  const statuses = [...new Set(rows.map(row => row.status))].sort();
  const controls = node('div'), search = node('input');
  controls.className = 'route-controls agentic-form-controls';
  function control(name, input) {
    const label = node('label', name);
    input.setAttribute('aria-label', name); label.append(input); controls.append(label);
    return input;
  }
  search.type = 'search'; control('Route or tool', search);
  function filter(name, values) {
    const select = node('select');
    for (const value of ['All', ...values]) select.append(node('option', value));
    return control(name, select);
  }
  const transport = filter('Transport', transports), disposition = filter('Disposition', statuses);
  const root = node('div'), panels = {};
  root.id = 'route-views';
  for (const [key, name] of [['table', 'Table'], ['matrix', 'Multi-dimensional table'], ['board', 'Kanban']]) {
    const panel = node('section'); panel.dataset.panelTab = key; panel.dataset.panelLabel = name;
    panels[key] = panel; root.append(panel);
  }
  const status = node('p'), evidence = node('section');
  status.setAttribute('role', 'status'); evidence.setAttribute('aria-label', 'Selected route evidence');
  const { DashboardCardGrid } = createNativeDashboard(document);
  let matches = rows, offset = 0, selected, view = 'table', widget, orientation = 'rows';
  const boardPages = new Map();

  function select(row) {
    selected = row; evidence.replaceChildren();
    if (row) inspect(row, evidence);
  }
  function table(parent, state) {
    const frame = node('div'), mount = node('div'), css = node('link');
    frame.className = 'rehearsal-table route-table'; mount.setAttribute('part', 'mount');
    css.rel = 'stylesheet'; css.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
    frame.attachShadow({ mode: 'open' }).append(css, mount); parent.append(frame);
    widget = mountDataView(mount, state);
  }
  function button(name, onClick) {
    const el = node('button', name); el.type = 'button'; el.className = 'agentic-form-control';
    el.addEventListener('click', onClick); return el;
  }
  function showTable(panel) {
    const slice = matches.slice(offset, offset + pageSize);
    const state = { ariaLabel: 'Provider route table', columns: columns(['Route or tool', 'Transport', 'Disposition', 'Access scope']),
      rows: slice.map(row => ({ id: row.id, cells: [row.label, row.transport, row.status, row.scope] })),
      selectedRowId: slice.some(row => row.id === selected?.id) ? selected.id : null,
      onActivateRow(id) {
        select(slice.find(row => row.id === id)); widget.update({ ...state, selectedRowId: id });
      } };
    table(panel, state);
    const nav = node('div'); nav.className = 'agentic-dashboard-actions';
    function step(delta) { offset += delta; select(null); render(); panels.table.querySelector('button:not(:disabled)')?.focus(); }
    const previous = button('Previous', () => step(-pageSize)), next = button('Next', () => step(pageSize));
    previous.disabled = offset === 0; next.disabled = offset + pageSize >= matches.length;
    nav.append(previous, next); panel.append(nav);
    status.textContent = (offset + 1) + '–' + (offset + slice.length) + ' of ' + matches.length;
  }
  function showMatrix(panel) {
    const groups = transports.filter(kind => matches.some(row => row.transport === kind));
    const dimensions = statuses.filter(value => matches.some(row => row.status === value));
    const records = [...groups, 'Total'].map(kind => {
      const group = kind === 'Total' ? matches : matches.filter(row => row.transport === kind);
      return { id: kind, cells: [kind, ...dimensions.map(value => String(group.filter(row => row.status === value).length)), String(group.length)] };
    });
    table(panel, { layout: 'multiDimensional', orientation, ariaLabel: 'Route counts by transport and disposition',
      columns: columns(['Transport', ...dimensions, 'Total']), rows: records,
      onOrientationChange(value) { orientation = value; render(); } });
  }
  function showBoard(panel) {
    const lanes = statuses.flatMap(value => {
      const group = matches.filter(row => row.status === value);
      if (!group.length) return [];
      const cards = node('div'); cards.className = 'route-cards';
      const end = Math.min(boardPages.get(value) ?? 4, group.length);
      for (const row of group.slice(0, end)) {
        const card = button(row.label, () => {
          for (const el of panel.querySelectorAll('[aria-pressed="true"]')) el.setAttribute('aria-pressed', 'false');
          card.setAttribute('aria-pressed', 'true'); select(row); evidence.scrollIntoView({ block: 'nearest' });
        });
        card.className += ' route-card';
        card.dataset.route = row.id;
        card.prepend(node('small', row.transport));
        card.setAttribute('aria-pressed', String(row.id === selected?.id)); cards.append(card);
      }
      if (end < group.length) {
        const more = button('Show more ' + value + ' routes', () => {
          boardPages.set(value, end + pageSize); render();
          panel.querySelector('[data-route="' + group[end].id + '"]')?.focus();
        });
        cards.append(more);
      }
      return [{ id: value, title: value + ' (' + group.length + ')', content: cards }];
    });
    panel.append(DashboardCardGrid({ ariaLabel: 'Routes by disposition', cards: lanes, columns: 3, headingLevel: 5, className: 'route-board' }));
  }
  function render() {
    widget?.destroy(); widget = null;
    for (const panel of Object.values(panels)) panel.replaceChildren();
    status.textContent = matches.length ? matches.length + ' matching routes' : 'No matching routes';
    if (!matches.length) return;
    if (view === 'table') showTable(panels.table);
    else if (view === 'matrix') showMatrix(panels.matrix);
    else showBoard(panels.board);
  }
  const tabs = createTabList(root, { label: 'Provider route views', activeKey: view, onChange(key) {
    view = key; if (key === 'matrix') select(null); render();
  } });
  const style = node('link'); style.rel = 'stylesheet';
  style.href = new URL('../owners/design/site/floating-panel.css', import.meta.url);
  root.prepend(style);
  root.prepend(tabs.rail);
  function applyFilters() {
    const term = search.value.trim().toLowerCase();
    matches = rows.filter(row => (transport.value === 'All' || row.transport === transport.value) &&
      (disposition.value === 'All' || row.status === disposition.value) &&
      (row.transport + ' ' + row.label).toLowerCase().includes(term));
    offset = 0; boardPages.clear(); select(null); render();
  }
  search.addEventListener('input', applyFilters);
  for (const el of [transport, disposition]) el.addEventListener('change', applyFilters);
  host.append(controls, status, root, evidence); render();
}
