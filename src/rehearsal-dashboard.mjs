import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { replayWorksheets } from './rehearsal-worksheets.mjs';

export function replayDashboard(pack, ui, evidence, log) {
  const { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
  const { snapshot } = pack;
  const { node, money, percent } = ui;
  const cards = [
    ['equity', 'Account equity', money(snapshot.equity), 'primary'],
    ['net', 'Net P&L vs cash', money(snapshot.net), 'secondary'],
    ['drawdown', 'Maximum drawdown', percent(snapshot.maxDrawdown), 'neutral'],
  ].map(([id, eyebrow, text, accent]) => {
    const value = node('span', text);
    value.className = 'agentic-mono';
    return { id, eyebrow, title: value, accent };
  });
  const worksheets = replayWorksheets(pack, ui, log);
  for (const path of ['floating-panel.css', 'dashboard-range.css', 'hover.css']) {
    const link = node('link'); link.rel = 'stylesheet';
    link.href = new URL('../owners/design/site/' + path, import.meta.url);
    worksheets.root.prepend(link);
  }
  const element = DashboardCanvasLayout({ id: 'replay-dashboard', ariaLabel: 'Replay dashboard',
    title: DashboardPrimitive({ kind: 'heading', level: 2, children: 'Run ' + snapshot.run + ' · ' + snapshot.profile }),
    description: DashboardPrimitive({ kind: 'text', children: snapshot.account + ' · ' + snapshot.currency + ' · Synthetic replay' }),
    overview: DashboardCardGrid({ ariaLabel: 'Run performance indicators', cards }), insights: worksheets.root, sections: evidence });
  return { element, destroy: worksheets.destroy };
}
