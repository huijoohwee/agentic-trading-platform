import { mountCoverageRecords } from './coverage-routes-view.mjs';
import { providerCoverage, coverageSummary, mappedReads, routeInventory, COVERAGE_INDEX } from './provider-coverage.mjs';

import { coverageRelations, httpFieldInventory, routeId } from './coverage-relations.mjs';

// Lazy, read-only discovery surface for the moomoo OpenAPI feature-family coverage. It renders the
// reviewed inventory metadata only: no provider call, no credential, no dispatch authority. Host-specific captures are labelled independently.
export async function mountCoverageView(host) {
  const { default: catalog } = await import('../qualification/moomoo/route-inventory.json', { with: { type: 'json' } });
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const summary = coverageSummary();
  const status = node('p', `${summary.families} feature families · ${summary.mapped_operations.length} mapped read operations · hosted read.ticker qualified`);
  status.id = 'coverage-status'; status.setAttribute('role', 'status');
  const references = catalog.sources.filter(source => source.reference);
  const intro = node('p', `${COVERAGE_INDEX.known_sources} known OpenAPI sources · ${COVERAGE_INDEX.imported_sources} from the original mirror · ${references.length} additional public references. Select a row or card for full values and source links. Connected qualification applies to the named host and read.`);
  const counts = node('p', Object.entries(summary.by_status).map(([key, value]) => `${key}: ${value}`).join(' · '));
  const text = (id, name) => ({ id, name });
  const number = (id, name) => ({ id, name, kind: 'number' });
  const category = (id, name) => ({ id, name, kind: 'select' });
  function sourceLine(parent, label, url, hash) {
    const link = node('a', label); link.href = url; link.rel = 'noopener noreferrer'; link.target = '_blank';
    const line = node('p'); line.append(link, node('code', ' SHA-256 ' + hash)); parent.append(line);
  }
  const rows = routeInventory(catalog);
  const links = coverageRelations(catalog, rows);
  const fragment = params => '#provider-coverage?' + new URLSearchParams(params);
  const remember = params => history.replaceState(history.state, '', fragment(params));
  function link(label, params) {
    const anchor = node('a', label); anchor.href = fragment(params);
    return anchor;
  }
  function related(parent, heading, anchors) {
    if (!anchors.length) return;
    const list = node('ul');
    for (const anchor of anchors) { const item = node('li'); item.append(anchor); list.append(item); }
    parent.append(node('h6', heading), list);
  }
  const summaryLine = node('p', ['REST', 'MCP', 'Push'].map(kind =>
    rows.filter(row => row.transport === kind).length + ' ' + kind + ' routes').join(' · '));
  const finder = node('section');
  finder.id = 'coverage-routes';
  finder.append(node('h4', 'Find a provider route'), summaryLine,
    node('p', 'Gateway owns provider route definitions. Trading owns mappings and admission. Each connected read requires host-specific rights, a provider-enforced $0 limit and remaining quota.'));
  const routeView = mountCoverageRecords(finder, rows, node, { id: 'route', key: routeId, onSelect: row => remember({ route: routeId(row) }), plural: 'routes', singular: 'route', title: 'Routes',
    columns: [text('label', 'Route or tool'), category('transport', 'Transport'), category('status', 'Disposition'), category('scope', 'Access scope')],
    rowDimension: 'transport', groupDimension: 'status' }, (row, detail) => {
    detail.append(node('h5', row.label), node('p', row.scope + ' · ' + row.evidence), node('p', row.units));
    const bindings = [...new Set(row.sources.map(source => source.http).filter(http => http && http !== row.label))];
    if (bindings.length) detail.append(node('h6', 'HTTP bindings'), ...bindings.map(http => node('p', http)));
    for (const source of row.sources) {
      sourceLine(detail, source.tool ?? new URL(source.url).pathname, source.url, source.digest);
    }
    const tools = [...new Set(row.sources.map(source => source.tool).filter(Boolean))];
    related(detail, 'Public HTTP fields', tools.map(tool => link('View fields for ' + tool, { fields: tool })));
    if (!tools.length) detail.append(node('p', 'The public tool directory has no field schema for this route.'));
    related(detail, 'Related references', [...links.byRoute.get(routeId(row))].map(path => link(path, { reference: path })));
  });
  const supplement = node('section'), families = node('section');
  supplement.id = 'coverage-references'; families.id = 'coverage-families';
  supplement.append(node('h4', references.length + ' additional public references'));
  const sources = references.map(source => {
    const parts = source.path.split('/').filter(Boolean);
    const locale = /^zh-(cn|hk)$/.test(parts[0]) ? parts.shift() : 'Default';
    const section = parts[0] === 'api' ? parts[1] ?? 'api' : parts[0] ?? 'Home';
    return { label: source.path, section, locale, hash: source.reference.sha256, routeCount: source.reference.routes.length, reference: source.reference };
  });
  const referenceView = mountCoverageRecords(supplement, sources, node, { id: 'reference', key: row => row.label, onSelect: row => remember({ reference: row.label }), title: 'References', plural: 'references', singular: 'reference',
    columns: [text('label', 'Reference path'), category('section', 'Section'), category('locale', 'Locale'), text('hash', 'SHA-256'), number('routeCount', 'Routes listed')],
    rowDimension: 'locale', groupDimension: 'section' }, (row, detail) => {
    sourceLine(detail, row.label, catalog.origin + '/' + row.reference.file, row.hash);
    detail.append(node('p', 'Markdown file · ' + row.reference.file));
    if (!row.routeCount) detail.append(node('p', 'This catalog reference lists no routes.'));
    related(detail, 'Documented routes', row.reference.routes.map(spelling =>
      link(spelling, { route: routeId(links.byReference.get(row.label).get(spelling)) })));
  });
  families.append(node('h4', 'Feature families'), counts);
  const entries = providerCoverage.map(entry => ({ ...entry, operationNames: entry.operations.join(', '), readCount: mappedReads([entry]).length }));
  mountCoverageRecords(families, entries, node, { id: 'family', title: 'Feature families', plural: 'families', singular: 'family',
    columns: [text('label', 'Feature family'), category('transport', 'Transport'), category('status', 'Disposition'), { id: 'operationNames', name: 'Operation IDs', format: 'code-list' }, number('readCount', 'Mapped reads')],
    measure: { label: 'Distinct mapped reads', count: group => mappedReads(group).length },
    rowDimension: 'transport', groupDimension: 'status' }, (entry, detail) => {
    detail.append(node('h5', entry.label), node('p', entry.note));
    const facts = node('dl'); facts.className = 'facts';
    const operations = node('dd', entry.operations.length ? '' : 'None');
    entry.operations.forEach((id, index) => {
      if (index) operations.append(', ');
      operations.append(node('code', id));
    });
    facts.append(node('dt', 'Family ID'), node('dd', entry.id),
      node('dt', 'Operation IDs'), operations,
      node('dt', 'Mapped reads'), node('dd', entry.readCount),
      node('dt', 'Listed MCP tools'), node('dd', entry.mcp.join(', ') || 'See individual routes'));
    detail.append(facts);
    for (const item of entry.sources) sourceLine(detail, item.path, item.url, item.sha256);
  });
  const fields = node('section'), fieldStatus = node('p'), notice = node('p');
  const toolRoutes = node('nav'); toolRoutes.setAttribute('aria-label', 'Routes for selected tool');
  const routeLinks = tool => [...links.byTool.get(tool)].map(route => link(route.transport + ' · ' + route.label, { route: routeId(route) }));
  fields.id = 'coverage-fields'; fields.append(node('h4', 'Public HTTP fields'), fieldStatus, toolRoutes);
  notice.setAttribute('role', 'status');
  host.replaceChildren(status, intro, notice, finder, fields, supplement, families);
  let pending;
  function loadFields() {
    if (pending) return pending;
    fieldStatus.textContent = 'Loading field definitions…';
    pending = import('../qualification/moomoo/route-fields.json', { with: { type: 'json' } }).then(({ default: register }) => {
      const records = httpFieldInventory(register, catalog);
      if (!register.tools.every(tool => links.byTool.has(tool.name))) throw Error('FIELD_ROUTE_MISSING');
      fieldStatus.textContent = records.length + ' field records across ' + register.tools.length + ' public tools';
      return mountCoverageRecords(fields, records, node, { id: 'field', plural: 'fields', singular: 'field', title: 'HTTP fields',
        onDimension(value) {
          toolRoutes.replaceChildren();
          if (value !== 'All') related(toolRoutes, 'Routes for ' + value, routeLinks(value));
        },
        key: row => row.key, onSelect: row => remember({ fields: row.tool, field: row.key }),
        columns: [{ id: 'label', name: 'Field path', format: 'code-list' }, { id: 'tool', name: 'Tool', format: 'code-list' },
          category('section', 'Location'), text('type', 'Type'), category('requirement', 'Requirement')],
        rowDimension: 'tool', groupDimension: 'section', layout: 'multiDimensional', boardPageSize: 48 }, (row, detail) => {
        detail.append(node('h5', row.label), node('p', row.tool + ' · ' + row.section + ' · ' + row.type + ' · ' + row.requirement));
        if (row.rules.length) detail.append(node('p', row.rules.join(' · ')));
        if (row.wrap) detail.append(node('p', 'Response wrapper · ' + row.wrap));
        if (row.section === 'Response') detail.append(node('p', 'The public tool directory supplies this field name. See the REST reference for the wire format.'));
        related(detail, 'Related routes', routeLinks(row.tool));
      });
    }).catch(() => {
      pending = undefined;
      const retry = node('button', 'Retry field definitions'); retry.type = 'button';
      retry.onclick = () => { if (location.hash.startsWith('#provider-coverage?fields=')) void follow(location.hash.slice(1)); else void loadFields(); };
      fieldStatus.replaceChildren('Field definitions unavailable. ', retry);
      return null;
    });
    return pending;
  }
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void loadFields(); }
    }, { rootMargin: '160px' });
    observer.observe(fields);
  } else void loadFields();

  async function follow(hash) {
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    let opened = false;
    if (params.has('route')) opened = routeView.open({ key: params.get('route') });
    else if (params.has('reference')) opened = referenceView.open({ key: params.get('reference') });
    else if (params.has('fields')) {
      const view = await loadFields();
      if (location.hash !== '#' + hash) return;
      if (!view) { fields.scrollIntoView({ block: 'center' }); return; }
      opened = view.open({ dimension: params.get('fields'), key: params.get('field') ?? undefined });
    }
    notice.textContent = opened ? '' : 'This linked record is unavailable in the pinned catalog.';
    if (!opened) notice.scrollIntoView({ block: 'center' });
  }
  host.addEventListener('click', event => {
    const anchor = event.target.closest('a');
    if (anchor?.getAttribute('href') !== location.hash || !location.hash.startsWith('#provider-coverage?') ||
        event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void follow(location.hash.slice(1));
  });
  return { follow };
}
