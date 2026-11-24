import { mountDataView, mountRecordViewToolbar } from '../owners/base/packages/views-react/dist/browser-data-view.js';

const pageSize = 12;
const cssUrl = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);

export function mountCoverageRecords(host, inventory, node, config, inspect) {
  const { columns: fields, rowDimension, groupDimension, plural, singular, title } = config;
  const labelFor = id => fields.find(field => field.id === id).name;
  const rows = inventory.map((row, index) => ({ ...row, recordId: config.id + '-' + index }));
  const distinct = key => [...new Set(rows.map(row => row[key]))].sort();
  const groups = distinct(groupDimension), dimensions = distinct(rowDimension);
  const root = node('div'), evidence = node('section');
  root.id = config.id + '-views'; root.className = 'coverage-record-views';
  evidence.setAttribute('aria-label', 'Selected ' + singular + ' evidence');
  const shadow = root.attachShadow({ mode: 'open' });
  const css = node('link'); css.rel = 'stylesheet'; css.href = cssUrl.href;
  const localStyle = node('link'); localStyle.rel = 'stylesheet'; localStyle.href = new URL('../journal.css', import.meta.url);
  const toolbarHost = node('div'), content = node('div');
  content.className = 'route-record-content';
  const theme = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    if (theme.matches) root.dataset.darkVariant = 'black';
    else delete root.dataset.darkVariant;
  }
  applyTheme(); theme.addEventListener('change', applyTheme);

  function control(label, input) {
    const field = node('label', label); input.setAttribute('aria-label', label); field.append(input); return field;
  }
  function select(values) {
    const input = node('select');
    for (const value of ['All', ...values]) input.append(node('option', value));
    return input;
  }
  const search = node('input'); search.type = 'search';
  const dimensionFilter = select(dimensions), groupFilter = select(groups);
  const searchPanel = node('div'), filterPanel = node('div');
  searchPanel.className = filterPanel.className = 'route-query-controls';
  searchPanel.hidden = filterPanel.hidden = true;
  searchPanel.append(control(fields[0].name, search)); filterPanel.append(control(labelFor(rowDimension), dimensionFilter), control(labelFor(groupDimension), groupFilter));
  const measure = node('select'), measurePanel = node('div');
  measurePanel.className = 'route-query-controls'; measurePanel.hidden = true;
  if (config.measure) {
    measure.append(node('option', title), node('option', config.measure.label));
    measurePanel.append(control('Count', measure));
    measure.addEventListener('change', () => render());
  }
  shadow.append(css, localStyle, toolbarHost, searchPanel, filterPanel, measurePanel, content);
  host.append(root, evidence);
  let layout = config.layout ?? 'table', orientation = 'rows', offset = 0, sorted = false, selected, table, toolbar, matches = rows;

  function showEvidence(row) {
    selected = row;
    evidence.replaceChildren();
    if (selected) inspect(selected, evidence);
  }
  function selectRecord(id) {
    showEvidence(matches.find(row => row.recordId === id));
    if (selected) config.onSelect?.(selected);
    if (layout === 'table') table.update(viewState());
  }
  function matrixState() {
    const activeGroups = groups.filter(value => matches.some(row => row[groupDimension] === value));
    const kinds = dimensions.filter(kind => matches.some(row => row[rowDimension] === kind));
    const count = config.measure && measure.selectedIndex === 1 ? config.measure.count : group => group.length;
    const records = [...kinds, 'Total'].map(kind => {
      const group = kind === 'Total' ? matches : matches.filter(row => row[rowDimension] === kind);
      return { id: kind, cells: [kind, ...activeGroups.map(value => String(count(group.filter(row => row[groupDimension] === value)))), String(count(group))] };
    });
    const columns = [labelFor(rowDimension), ...activeGroups, 'Total'].map((name, index) => ({ name, id: name, kind: index ? 'number' : 'text' }));
    return { layout, columns, rows: records, orientation, ariaLabel: title + ' counts',
      onOrientationChange(value) { orientation = value; render(); } };
  }
  const pageLength = () => layout === 'table' ? pageSize : layout === 'kanban' ? config.boardPageSize : undefined;
  function viewState() {
    if (layout === 'multiDimensional') return matrixState();
    const tableView = layout === 'table', length = pageLength();
    const page = length ? matches.slice(offset, offset + length) : matches;
    return { layout, wrapText: tableView, columns: fields, rows: page.map(row => ({ id: row.recordId, cells: fields.map(field => String(row[field.id] ?? '')) })),
      ariaLabel: tableView ? title + ' table' : title + ' by ' + labelFor(groupDimension).toLowerCase(), onActivateRow: selectRecord,
      ...(tableView ? { selectedRowId: page.some(row => row === selected) ? selected.recordId : null } : { groupByColumnId: groupDimension }) };
  }
  function toggle(panel, input) {
    panel.hidden = !panel.hidden;
    refreshToolbar();
    if (!panel.hidden) input.focus();
  }
  function changePage(delta) { offset += delta; selected = null; evidence.replaceChildren(); render(); }
  function refreshToolbar() {
    const count = matches.length, length = pageLength();
    const status = !count ? 'No matching ' + plural : length
      ? (offset + 1) + '–' + Math.min(offset + length, count) + ' of ' + count : count + ' matching ' + plural;
    const actions = [
      { id: 'search', label: 'Search ' + plural, pressed: !searchPanel.hidden, invoke: () => toggle(searchPanel, search) },
      { id: 'filter', label: 'Filter ' + plural, pressed: !filterPanel.hidden, invoke: () => toggle(filterPanel, dimensionFilter) },
    ];
    if (layout !== 'multiDimensional') actions.push({ id: 'sort', label: 'Sort by ' + fields[0].name.toLowerCase(), pressed: sorted,
      invoke() { sorted = !sorted; applyFilters(); } });
    if (length) actions.push(
      { id: 'previous', label: 'Previous', disabled: !offset, invoke: () => changePage(-length) },
      { id: 'next', label: 'Next', disabled: offset + length >= count, invoke: () => changePage(length) });
    const state = { layout, status, actions, label: title + ' views',
      onLayoutChange(value) { layout = value; offset = 0; selected = null; evidence.replaceChildren(); render(); } };
    if (toolbar) toolbar.update(state); else toolbar = mountRecordViewToolbar(toolbarHost, state);
  }
  function render(revealSelection = false) {
    refreshToolbar();
    measurePanel.hidden = !config.measure || layout !== 'multiDimensional';
    content.dataset.layout = layout;
    if (!matches.length) { table?.destroy(); table = undefined; return; }
    const state = viewState();
    if (revealSelection) state.revealSelection = true;
    if (table) table.update(state); else table = mountDataView(content, state);
  }
  function filterRows() {
    config.onDimension?.(dimensionFilter.value);
    const term = search.value.trim().toLowerCase();
    matches = rows.filter(row => (dimensionFilter.value === 'All' || row[rowDimension] === dimensionFilter.value) &&
      (groupFilter.value === 'All' || row[groupDimension] === groupFilter.value) && fields.some(field => String(row[field.id] ?? '').toLowerCase().includes(term)));
    if (sorted) matches.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  }
  function applyFilters() {
    filterRows(); offset = 0; showEvidence(null); render();
  }
  search.addEventListener('input', applyFilters);
  for (const control of [dimensionFilter, groupFilter]) control.addEventListener('change', applyFilters);
  render();
  // A relationship opens the exact record even when a different page, layout or filter is active.
  return { open({ key, dimension }) {
    const row = key === undefined ? null : rows.find(item => config.key(item) === key);
    if ((key !== undefined && !row) || (dimension !== undefined && !dimensions.includes(dimension)) ||
        (row && dimension !== undefined && row[rowDimension] !== dimension)) return false;
    if (dimension !== undefined) {
      dimensionFilter.value = dimension; groupFilter.value = 'All'; search.value = ''; filterPanel.hidden = false;
    } else if (!matches.includes(row)) {
      if (dimensionFilter.value !== row[rowDimension]) dimensionFilter.value = 'All';
      if (groupFilter.value !== row[groupDimension]) groupFilter.value = 'All';
      if (!fields.some(f => String(row[f.id] ?? '').toLowerCase().includes(search.value.trim().toLowerCase()))) search.value = '';
    }
    layout = 'table'; filterRows();
    if (row && !matches.includes(row)) return false;
    offset = row ? Math.floor(matches.indexOf(row) / pageSize) * pageSize : 0;
    showEvidence(row); render(Boolean(row));
    if (!row) {
      const heading = host.querySelector('h4'); heading.tabIndex = -1;
      heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'center' });
    }
    return true;
  } };
}
