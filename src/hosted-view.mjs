import { hostedSummary, hostedProvenance, hostedOperations } from './provider-hosted.mjs';

// Lazy, read-only surface for the entitled $0 hosted moomoo OAuth capture (N3). It renders the curated
// display projection and its provenance only: no provider call, no credential, no dispatch authority.
// The conformance test pins this summary to the captured hosted fixture. Credentials remain with the
// host; no token is stored or forwarded. This hosted-binding evidence is distinct from the Desktop pin.
export async function mountHostedView(host) {
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const s = hostedSummary, p = hostedProvenance;
  const status = node('p', `${s.symbol} ${s.name} · last ${s.last} · ${p.binding} capture · $${p.cost_usd} · hosted N3 ${p.hosted_n3 ? 'qualified' : 'open'}`);
  status.id = 'hosted-status'; status.setAttribute('role', 'status');
  const intro = node('p', p.note);
  const facts = node('dl'); facts.className = 'facts';
  const add = (term, detail) => { facts.append(node('dt', term), node('dd', detail)); };
  add('Symbol', `${s.symbol} (${s.market})`);
  add('Name', s.name);
  add('Market date', s.market_date);
  add('Last', String(s.last));
  add('Previous close', String(s.prev_close));
  add('Open / high / low', `${s.open} / ${s.high} / ${s.low}`);
  add('Volume', String(s.volume));
  add('Turnover', String(s.turnover));
  add('Captured UTC', p.captured_utc);
  add('Binding', p.binding);
  add('Host', p.host);
  add('OAuth scope', p.scope);
  add('Hosted OAuth (N3)', p.hosted_n3 ? 'qualified' : 'open');
  const operations = node('p', 'Reviewed read operations: ' + hostedOperations.join(', ') + '. Live order dispatch is excluded from the read-only $0 scope.');
  const unknowns = node('ul'); unknowns.className = 'capture-unknowns';
  for (const item of s.unknowns) unknowns.append(node('li', item));
  const unknownsHeading = node('p', 'Unknowns preserved (not inferred):');
  host.replaceChildren(status, intro, facts, operations, unknownsHeading, unknowns);
}