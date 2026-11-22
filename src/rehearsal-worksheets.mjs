import { createTabList } from '../owners/design/site/floating-panel.js';
import { createDashboardRange } from '../owners/design/site/dashboard-range.mjs';
import { bindWorkbookExport } from './rehearsal-workbook.mjs';
import { dimensions, measures, replayAnalysis } from './rehearsal-analysis.mjs';
import { MICRO } from './competition-rules.mjs';

const chartTypes = { range: 'Equity range', line: 'Line chart', area: 'Area chart', column: 'Column chart' };
const tones = { blue: 'Blue', green: 'Green', amber: 'Amber', rose: 'Rose', slate: 'Slate' };

function tabGroup(node, id, label, names, activeKey, onChange) {
  const root = node('div'), pages = {};
  root.id = id;
  for (const [key, title] of Object.entries(names)) {
    const page = node('section');
    page.dataset.panelTab = key;
    page.dataset.panelLabel = title;
    root.append(page);
    pages[key] = page;
  }
  const list = createTabList(root, { label, activeKey, onChange });
  root.prepend(list.rail);
  return { root, pages };
}

function preferences(key) {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(key)) ?? {}; } catch { saved = {}; }
  return {
    get: (field, fallback, allowed) => allowed.includes(saved[field]) ? saved[field] : fallback,
    set(field, value) {
      saved = { ...saved, [field]: value };
      try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch { /* The current view remains usable in memory. */ }
    },
  };
}

function analysisSheet(page, id, model, pack, ui, inspectEvents) {
  const { node, money, downloadJson } = ui;
  const isEquity = id === 'equity';
  const title = isEquity ? 'Daily account equity' : 'Event activity';
  const pref = preferences('trading-worksheet/1/' + pack.snapshot.run + '/' + id);
  const stage = node('section'), aside = node('aside'), body = node('div');
  stage.className = 'worksheet-stage';
  stage.setAttribute('aria-label', title);
  aside.setAttribute('aria-label', title + ' settings');
  body.className = 'worksheet-body';
  body.append(stage, aside);
  page.append(body);
  let mode = pref.get('mode', 'chart', ['chart','pivot']);
  let epoch = 0, widget, disposed = false;
  const state = {}, controls = {};
  function change(field, value) {
    state[field] = value;
    pref.set(field, value);
    if (field === 'row' && state.column === value) {
      state.column = ''; controls.column.input.value = ''; pref.set('column', '');
    }
    refresh();
  }
  function select(parent, field, label, choices, initial) {
    const wrap = node('label'), caption = node('span', label), input = node('select');
    caption.id = 'replay-' + id + '-' + field + '-label';
    input.setAttribute('aria-labelledby', caption.id);
    wrap.append(caption);
    for (const [key, name] of Object.entries(choices)) {
      const option = node('option', name);
      option.value = key; input.append(option);
    }
    state[field] = pref.get(field, initial, Object.keys(choices));
    input.value = state[field];
    input.onchange = () => change(field, input.value);
    wrap.append(input); parent.append(wrap); controls[field] = { wrap, input };
  }
  function toggle(parent, field, label, initial) {
    const wrap = node('label'), input = node('input');
    input.type = 'checkbox';
    input.checked = state[field] = pref.get(field, initial, [true, false]);
    input.onchange = () => change(field, input.checked);
    wrap.append(input, label); parent.append(wrap); controls[field] = { wrap, input };
  }
  function settingsTabs(parent, suffix, label, names) {
    const keys = Object.keys(names);
    const tabs = tabGroup(node, 'replay-' + id + '-' + suffix, label, names,
      pref.get(suffix, keys[0], keys), key => pref.set(suffix, key));
    for (const pane of Object.values(tabs.pages)) pane.className = 'worksheet-fields agentic-form-controls';
    parent.append(tabs.root);
    return tabs.pages;
  }
  const modes = tabGroup(node, 'replay-' + id + '-mode', 'Worksheet view', { chart: 'Chart', pivot: 'Pivot table' },
    mode, next => { mode = next; pref.set('mode', next); refresh(); });
  aside.append(modes.root);
  const { setup, customize } = settingsTabs(modes.pages.chart, 'chart-settings', 'Chart settings', { setup: 'Setup', customize: 'Customize' });
  const { fields, options } = settingsTabs(modes.pages.pivot, 'pivot-settings', 'Pivot settings', { fields: 'Fields', options: 'Options' });
  select(setup, 'type', 'Chart type', isEquity ? chartTypes : { line: 'Line chart', area: 'Area chart', column: 'Column chart' }, isEquity ? 'range' : 'column');
  select(setup, 'category', 'Category', dimensions, 'day');
  select(setup, 'measure', 'Value field', measures, isEquity ? 'close' : 'count');
  select(customize, 'tone', 'Series color', tones, 'blue');
  toggle(customize, 'grid', 'Show gridlines', true);
  toggle(customize, 'values', 'Show values', isEquity);
  select(fields, 'row', 'Rows', dimensions, isEquity ? 'day' : 'type');
  select(fields, 'column', 'Columns', { '': 'Single value column', ...dimensions }, '');
  select(fields, 'value', 'Values', measures, isEquity ? 'close' : 'count');
  select(fields, 'filter', 'Event type filter', Object.fromEntries([['','All event types'], ...model.types.map(type => [type, type])]), '');
  toggle(options, 'descending', 'Descending row order', false);
  toggle(options, 'total', 'Include grand total', false);
  if (state.row === state.column) { state.column = ''; controls.column.input.value = ''; }
  function button(label) {
    const button = node('button', label); button.type = 'button'; button.className = 'agentic-form-control'; return button;
  }
  function exportButton(actions, error, label, spec, sheetId) {
    const save = button(label);
    bindWorkbookExport(save, error, { ...spec, sheetId, workbookId: sheetId + '-' + pack.sha256,
      filename: 'run-' + pack.snapshot.run + '-' + sheetId + '.sheets.json' }, downloadJson);
    actions.append(save);
  }
  function rangeChart(output, actions, error) {
    const { days } = model;
    const readout = node('p'), source = button('');
    readout.className = 'agentic-mono-detail'; readout.setAttribute('role', 'status');
    readout.hidden = !state.values;
    function pick(day) {
      readout.textContent = [day.label + ' UTC', 'Open ' + money(day.open), 'High ' + money(day.high),
        'Low ' + money(day.low), 'Close ' + money(day.close)].join(' · ');
      source.textContent = 'Inspect ' + day.events + (day.events === 1 ? ' source event' : ' source events');
      source.onclick = () => inspectEvents(day.label);
    }
    output.append(createDashboardRange(document, { label: 'Select an observed UTC day', points: days, formatValue: money, onSelect: pick }), readout);
    pick(days.at(-1));
    actions.append(source);
    exportButton(actions, error, 'Export daily equity to Sheets', { name: 'Run ' + pack.snapshot.run + ' daily equity',
      headers: ['Date (UTC)', 'Open (USD)', 'High (USD)', 'Low (USD)', 'Close (USD)', 'Observed events'],
      records: days.map(day => ({ values: [day.label, day.open / MICRO, day.high / MICRO, day.low / MICRO, day.close / MICRO, day.events] })),
    }, 'daily-equity');
  }
  async function refresh() {
    const version = ++epoch;
    widget?.destroy(); widget = undefined;
    const range = state.type === 'range';
    for (const key of ['category', 'measure', 'tone', 'grid']) controls[key].wrap.hidden = range;
    for (const option of controls.column.input.options) option.disabled = option.value === state.row;
    const output = node('div'), actions = node('div'), error = node('p');
    actions.className = 'agentic-dashboard-actions agentic-form-controls';
    error.setAttribute('role', 'alert');
    const name = mode === 'pivot' ? title + ' pivot' : title;
    const description = mode === 'pivot' ? measures[state.value] + ' by ' + dimensions[state.row]
      : range ? 'USD · Observed after each event, grouped by UTC day.' : measures[state.measure] + ' by ' + dimensions[state.category];
    stage.replaceChildren(node('h3', name), node('p', description), output, actions, error);
    try {
      if (mode === 'chart' && range) { rangeChart(output, actions, error); return; }
      if (mode === 'pivot') {
        const spec = model.pivot({ ...state, measure: state.value });
        const { mountPivotTable } = await import('./rehearsal-tables.mjs');
        if (disposed || version !== epoch) return;
        widget = mountPivotTable(output, spec, node, value => state.value === 'count' ? String(value) : money(value * MICRO));
        exportButton(actions, error, 'Export pivot to Sheets', { ...spec, name }, id + '-pivot');
      } else {
        const series = model.series(state.category, state.measure).map(point => ({ ...point,
          tickLabel: state.category === 'day' ? point.label.slice(5) : undefined,
          detail: state.measure === 'count' ? String(point.value) + ' events' : money(point.value * MICRO) }));
        const { mountDashboardChart } = await import('../owners/base/packages/views-react/dist/browser-data-view.js');
        if (disposed || version !== epoch) return;
        const chart = node('div'); chart.className = 'worksheet-series'; output.append(chart);
        widget = mountDashboardChart(chart, { type: state.type, series, tone: state.tone, gridEnabled: state.grid });
        if (state.values) {
          const values = node('dl'); values.className = 'facts';
          for (const point of series) {
            const row = node('div'); row.append(node('dt', point.label), node('dd', point.detail)); values.append(row);
          }
          output.append(values);
        }
        exportButton(actions, error, 'Export chart data to Sheets', { name,
          headers: [dimensions[state.category], measures[state.measure]], records: series.map(point => ({ values: [point.label, point.value] })) }, id + '-chart');
      }
    } catch (failure) { if (!disposed && version === epoch) error.textContent = failure.message; }
  }
  void refresh();
  return () => { disposed = true; epoch++; widget?.destroy(); };
}

export function replayWorksheets(pack, ui, log) {
  const model = replayAnalysis(pack);
  const { node } = ui, marker = document.createComment('Replay evidence');
  log.section.before(marker);
  let disposeView, priorOpen;
  const names = { source: 'Source records', equity: 'Daily equity', activity: 'Event activity' };
  const tabs = tabGroup(node, 'replay-worksheets', 'Replay worksheets', names, 'equity', activate);
  function activate(key) {
    disposeView?.(); disposeView = undefined;
    for (const id of ['equity', 'activity']) tabs.pages[id].replaceChildren();
    if (key === 'source') {
      priorOpen = log.section.open;
      tabs.pages.source.append(log.section);
      log.openWith(view => view.filter('', false));
    } else {
      if (log.section.parentNode === tabs.pages.source) {
        marker.after(log.section); log.section.open = priorOpen;
      }
      disposeView = analysisSheet(tabs.pages[key], key, model, pack, ui, date => log.openWith(view => view.filter(date)));
    }
  }
  activate('equity');
  return { root: tabs.root, destroy() { disposeView?.(); } };
}
