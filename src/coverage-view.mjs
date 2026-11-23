import { providerCoverage, coverageSummary, COVERAGE_INDEX } from './provider-coverage.mjs';

// Lazy, read-only discovery surface for the moomoo OpenAPI feature-family coverage. It renders the
// reviewed inventory metadata only: no provider call, no credential, no dispatch authority. Connected
// qualification stays UNQUALIFIED until candidate-bound external receipts exist.
export async function mountCoverageView(host) {
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const summary = coverageSummary();
  const status = node('p', `${summary.families} feature families · ${summary.mapped_operations.length} mapped read operations · connected runtime UNQUALIFIED`);
  status.id = 'coverage-status'; status.setAttribute('role', 'status');
  const intro = node('p', `Evidence-led inventory of ${COVERAGE_INDEX.known_sources} known OpenAPI sources (${COVERAGE_INDEX.imported_sources} imported, ${COVERAGE_INDEX.incomplete_sources} incomplete). Statuses describe mapping readiness, not connected readiness. Live order dispatch is excluded from the read-only $0 scope.`);
  const counts = node('p', Object.entries(summary.by_status).map(([key, value]) => `${key}: ${value}`).join(' · '));
  const list = node('div'); list.id = 'coverage-families';
  for (const entry of providerCoverage) {
    const section = node('section'); section.className = 'coverage-family'; section.dataset.status = entry.status;
    const heading = node('h4', `${entry.label} · ${entry.status} · ${entry.transport}`);
    const note = node('p', entry.note);
    const facts = node('dl'); facts.className = 'facts';
    const add = (term, detail) => { facts.append(node('dt', term), node('dd', detail)); };
    add('Semantic reads', entry.operations.length ? entry.operations.join(', ') : 'none (excluded)');
    add('Verified MCP tools', entry.mcp.length ? entry.mcp.join(', ') : 'none observed');
    section.append(heading, note, facts);
    const sources = node('ul'); sources.className = 'coverage-sources';
    for (const item of entry.sources) {
      const li = node('li');
      const link = node('a', item.path); link.href = item.url; link.rel = 'noopener noreferrer'; link.target = '_blank';
      li.append(link, node('code', ' SHA-256 ' + item.sha256.slice(0, 16) + '…'));
      sources.append(li);
    }
    if (entry.sources.length) section.append(sources);
    list.append(section);
  }
  host.replaceChildren(status, intro, counts, list);
}