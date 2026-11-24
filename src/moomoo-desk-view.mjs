import { createNativeDashboard } from '../owners/design/site/dashboard.mjs';
import { mountDataView, mountDashboardChart } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { deskProvenance, deskQuote, deskDepth, deskTape, deskCandles } from './provider-desk.mjs';
import { mountDeskDiagrams } from './desk-diagrams.mjs';
import { addQuoteProvenance, quoteChange } from './quote-display.mjs';

// Moomoo-inspired read-only market desk: quote board, order-book ladder, time & sales and daily
// candles, composed from pinned Agentic Design System / Base owner primitives (no token forks).
// Every row is the captured $0 Desktop evidence replayed offline; no provider call or order control.
export async function mountMoomooDeskView(host) {
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const ownerStyle = () => { const style = node('link'); style.rel = 'stylesheet'; style.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url); return style; };
  const viewport = (parent, title) => {
    const region = node('section'), heading = node('h4', title), frame = node('div'), mount = node('div');
    frame.className = 'rehearsal-table'; mount.setAttribute('part', 'mount');
    frame.attachShadow({ mode: 'open' }).append(ownerStyle(), mount);
    region.append(heading, frame); parent.append(region);
    return mount;
  };
  const table = (parent, title, columns, rows) => {
    const details = node('details');
    details.append(node('summary', title));
    parent.append(details);
    details.addEventListener('toggle', function reveal() {
      if (!details.open) return;
      details.removeEventListener('toggle', reveal);
      mountDataView(viewport(details, 'Exact values'), {
        ariaLabel: title, columns: columns.map(name => ({ id: name, name })),
        rows: rows.map((cells, index) => ({ id: title + '-' + index,
          cells: cells.map(value => value == null ? 'UNKNOWN' : String(value)) }))
      });
    });
  };
  const clock = epoch => epoch == null ? null : new Date(epoch).toISOString().slice(11, 23);
  const diagrams = mountDeskDiagrams(document);
  const diagram = (parent, title, svg) => { const region = node('section'); region.append(node('h4', title), svg); parent.append(region); };

  const s = deskQuote, p = deskProvenance;
  const status = node('p', `${s.symbol} ${s.name} · last ${s.last} · ${p.binding} replay · $${p.cost_usd} · read-only desk`);
  status.id = 'desk-status'; status.setAttribute('role', 'status');
  const intro = node('p', p.note);
  const before = node('div'); before.append(status, intro);

  const change = quoteChange(s.last, s.prev_close);
  const display = value => value == null ? 'UNKNOWN' : String(value);
  const { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive } = createNativeDashboard(document);
  const overview = DashboardCardGrid({
    ariaLabel: 'Market quote board',
    cards: [
      { id: 'desk-last', eyebrow: 'Last', title: String(s.last), accent: 'primary' },
      { id: 'desk-change', eyebrow: 'Change vs prev close', title: change.text, accent: change.accent },
      { id: 'desk-range', eyebrow: 'Day range', title: `${display(s.low)} – ${display(s.high)}`, accent: 'neutral' },
      { id: 'desk-volume', eyebrow: 'Volume', title: display(s.volume), accent: 'neutral' },
      { id: 'desk-turnover', eyebrow: 'Turnover', title: display(s.turnover), accent: 'neutral' }
    ]
  });

  const sections = node('div');
  const facts = node('dl'); facts.className = 'facts';
  const add = (term, detail) => { facts.append(node('dt', term), node('dd', detail)); };
  add('Symbol', `${s.symbol} (${s.market})`); add('Name', s.name); add('Market date', s.market_date);
  add('Open', display(s.open)); add('Previous close', display(s.prev_close));
  add('Exchange', deskDepth.exchange); addQuoteProvenance(add, s.marketTimeUtc, p.captured_utc); add('Binding', p.binding);
  sections.append(facts);

  diagram(sections, 'Order book depth · bar length is volume', diagrams.depth(deskDepth));
  const ladder = [
    ...[...deskDepth.ask].reverse().map(level => ['ASK', level.price, level.volume, level.orders]),
    ...deskDepth.bid.map(level => ['BID', level.price, level.volume, level.orders])
  ];
  table(sections, `Order book · ${deskDepth.exchange} (${deskDepth.ask.length} ask / ${deskDepth.bid.length} bid)`,
    ['Side', 'Price', 'Volume', 'Orders'], ladder);

  diagram(sections, 'Time & sales volume · color is direction', diagrams.tape(deskTape));
  table(sections, `Time & sales (${deskTape.length} ticks)`, ['Time (UTC)', 'Price', 'Volume', 'Turnover', 'Side'],
    deskTape.map(tick => [clock(tick.time), tick.price, tick.volume, tick.turnover, tick.direction]));

  diagram(sections, 'Daily candles · open / high / low / close', diagrams.candles(deskCandles));
  mountDashboardChart(viewport(sections, 'Daily volume'), {
    type: 'column', tone: 'blue', gridEnabled: true,
    series: deskCandles.map(candle => ({ label: candle.date, value: candle.volume, detail: String(candle.volume) }))
  });
  table(sections, `Daily candles (${deskCandles.length})`, ['Date', 'Open', 'High', 'Low', 'Close', 'Volume', 'Change %'],
    deskCandles.map(candle => [candle.date, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.change_rate]));

  const unknownsHeading = node('p', 'Unknown for this capture');
  const unknowns = node('ul'); unknowns.className = 'capture-unknowns';
  for (const item of ['currency', 'delay class', 'per-quote feed attribution']) unknowns.append(node('li', item));
  sections.append(unknownsHeading, unknowns);

  function inspector(id, title, mount) {
    const panel = node('details'), body = node('div');
    panel.id = id;
    panel.append(node('summary', title), body);
    sections.append(panel);
    panel.addEventListener('toggle', async function open() {
      if (!panel.open) return;
      panel.removeEventListener('toggle', open);
      try {
        body.replaceChildren();
        await mount(body);
      } catch {
        body.textContent = 'Reader unavailable. Reopen after refreshing the offline files.';
        panel.addEventListener('toggle', open);
      }
    });
  }
  inspector('quote-push-inspector', 'Inspect a saved quote push', async body => {
    const { mountQuotePushView } = await import('./quote-push-view.mjs');
    mountQuotePushView(body, s.symbol, { node, table, diagram, diagrams });
  });
  inspector('research-page-inspector', 'Inspect a saved research result', async body => {
    const { mountResearchPageView } = await import('./research-page-view.mjs');
    mountResearchPageView(body, node);
  });

  host.replaceChildren(DashboardCanvasLayout({
    ariaLabel: 'Moomoo market desk',
    beforeHeader: before,
    title: DashboardPrimitive({ kind: 'heading', level: 3, children: `${s.symbol} · ${s.name}` }),
    description: DashboardPrimitive({ kind: 'text', children: 'Read-only $0 replay · no execution controls' }),
    overview,
    sections
  }));
}
