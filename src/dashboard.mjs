import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';

export function mountDashboardPage(document, { description, hero, overview, sections }) {
  const main = document.querySelector('main');
  const { DashboardCanvasLayout, DashboardPrimitive } = createNativeDashboard(document);
  main.replaceChildren(DashboardCanvasLayout({
    beforeHeader: document.getElementById('session-slot').content,
    title: DashboardPrimitive({ kind: 'heading', level: 1, children: main.getAttribute('aria-label') }),
    description: description && DashboardPrimitive({ kind: 'text', children: description }),
    hero, overview, sections,
  }));
}

export function mountTradingDashboard(document) {
  const { DashboardCardGrid } = createNativeDashboard(document);
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
  mountDashboardPage(document, {
    description: 'Synthetic trading workspace · 19 Nov 2026 · UTC',
    hero: slot('age'), overview, sections: slot('evidence'),
  });
}
