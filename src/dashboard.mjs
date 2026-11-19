import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';

export function mountTradingDashboard(document) {
  const { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
  const slot = name => document.getElementById(name + '-slot').content;
  const label = (id, text) => {
    const span = document.createElement('span');
    span.id = id;
    span.textContent = text;
    return span;
  };
  const overview = DashboardCardGrid({
    ariaLabel: 'Trading ticket workflow',
    headingLevel: 2,
    cards: [
      { id: 'quote', accent: 'primary', eyebrow: 'R01', title: label('check-heading', 'Quote freshness'), content: slot('quote') },
      { id: 'ticket', accent: 'secondary', eyebrow: 'LIMIT', title: label('ticket-heading', 'Draft ticket'), content: slot('ticket') },
      { id: 'saved', accent: 'success', eyebrow: label('revision', 'Unsaved'), title: label('saved-heading', 'Saved observation'), content: slot('saved') },
    ],
  });
  document.getElementById('journal').replaceChildren(DashboardCanvasLayout({
    beforeHeader: slot('session'),
    title: DashboardPrimitive({ kind: 'heading', level: 1, children: 'Decision journal' }),
    description: DashboardPrimitive({ kind: 'text', children: 'Synthetic trading workspace · 19 Nov 2026 · UTC' }),
    hero: slot('age'),
    overview,
    sections: slot('evidence'),
  }));
}
