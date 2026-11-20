import { bindWorkbookExport } from './rehearsal-workbook.mjs';
import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { createDashboardRange } from '../owners/design/site/dashboard-range.mjs';
import { MICRO } from './competition-rules.mjs';

// Curve values are observed after each event, in integer millionths of a USD.
// Reuse replay order, including distinct observations with the same timestamp.
function dailyEquity(curve) {
  const days = [];
  for (const { at, equity } of curve) {
    const date = at.slice(0, 10);
    const last = days.at(-1);
    if (last?.label === date) {
      last.high = Math.max(last.high, equity);
      last.low = Math.min(last.low, equity);
      last.close = equity;
      last.events++;
    } else {
      days.push({ label: date, tickLabel: date.slice(5), open: equity, high: equity, low: equity, close: equity, events: 1 });
    }
  }
  return days;
}

export function replayDashboard(pack, { node, money, percent, downloadJson }, evidence, inspectEvents) {
  const { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
  const { snapshot } = pack;
  const cards = [
    ['equity', 'Account equity', money(snapshot.equity), 'primary'],
    ['net', 'Net P&L vs cash', money(snapshot.net), 'secondary'],
    ['drawdown', 'Maximum drawdown', percent(snapshot.maxDrawdown), 'neutral'],
  ].map(([id, eyebrow, text, accent]) => {
    const value = node('span', text);
    value.className = 'agentic-mono';
    return { id, eyebrow, title: value, accent };
  });
  const days = dailyEquity(snapshot.curve);
  const chart = node('section');
  chart.setAttribute('aria-label', 'Daily account equity');
  const css = node('link');
  css.rel = 'stylesheet';
  css.href = new URL('../owners/design/site/dashboard-range.css', import.meta.url);
  const readout = node('p');
  readout.className = 'agentic-mono-detail';
  readout.setAttribute('role', 'status');
  const actions = node('div');
  actions.className = 'agentic-dashboard-actions agentic-form-controls';
  const source = node('button'), save = node('button', 'Export daily equity to Sheets'), error = node('p');
  for (const button of [source, save]) { button.type = 'button'; button.className = 'agentic-form-control'; }
  error.setAttribute('role', 'alert');
  function select(day) {
    readout.textContent = [day.label + ' UTC', 'Open ' + money(day.open), 'High ' + money(day.high),
      'Low ' + money(day.low), 'Close ' + money(day.close)].join(' · ');
    source.textContent = 'Inspect ' + day.events + (day.events === 1 ? ' source event' : ' source events');
    source.onclick = () => inspectEvents(day.label);
  }
  const plot = createDashboardRange(document, { label: 'Select an observed UTC day', points: days, formatValue: money, onSelect: select });
  select(days.at(-1));
  bindWorkbookExport(save, error, {
    name: 'Run ' + snapshot.run + ' daily equity', workbookId: 'equity-' + pack.sha256, sheetId: 'daily-equity',
    filename: 'run-' + snapshot.run + '-daily-equity.sheets.json',
    headers: ['Date (UTC)', 'Open (USD)', 'High (USD)', 'Low (USD)', 'Close (USD)', 'Observed events'],
    records: days.map(day => ({ values: [day.label, day.open / MICRO, day.high / MICRO, day.low / MICRO, day.close / MICRO, day.events] })),
  }, downloadJson);
  actions.append(source, save);
  chart.append(css, node('h3', 'Daily account equity'), node('p', 'USD · Observed after each event, grouped by UTC day.'),
    plot, readout, actions, error);
  return DashboardCanvasLayout({ id: 'replay-dashboard', ariaLabel: 'Replay dashboard',
    title: DashboardPrimitive({ kind: 'heading', level: 2, children: 'Run ' + snapshot.run + ' · ' + snapshot.profile }),
    description: DashboardPrimitive({ kind: 'text', children: snapshot.account + ' · ' + snapshot.currency + ' · Synthetic replay' }),
    overview: DashboardCardGrid({ ariaLabel: 'Run performance indicators', cards }), insights: chart, sections: evidence });
}
