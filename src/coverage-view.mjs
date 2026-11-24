import { createRecordLinkCodec } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { mountCoverageRecords } from './coverage-routes-view.mjs';
import { providerCoverage, coverageSummary, mappedReads, routeInventory, catalogReferences } from './provider-coverage.mjs';

import { coverageRelations, httpFieldInventory, routeId } from './coverage-relations.mjs';

// Lazy, read-only discovery surface for the moomoo OpenAPI feature-family coverage. It renders the
// reviewed inventory metadata only: no provider call, no credential, no dispatch authority. Host-specific captures are labelled independently.
export async function mountCoverageView(host) {
  const { default: catalog } = await import('../qualification/moomoo/route-inventory.json', { with: { type: 'json' } });
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const summary = coverageSummary();
  const status = node('p', `${summary.families} feature families · ${summary.mapped_operations.length} mapped read operations · hosted read.ticker qualified`);
  status.id = 'coverage-status'; status.setAttribute('role', 'status');
  const references = catalogReferences(catalog);
  const additional = catalog.sources.filter(source => source.reference).length;
  const intro = node('p', `${references.length} known OpenAPI sources · ${references.length - additional} from the original mirror · ${additional} additional public references. Select a row or card for full values and source links. Connected qualification applies to the named host and read.`);
  const counts = node('p', Object.entries(summary.by_status).map(([key, value]) => `${key}: ${value}`).join(' · '));
  const text = (id, name) => ({ id, name });
  const number = (id, name) => ({ id, name, kind: 'number' });
  const category = (id, name) => ({ id, name, kind: 'select' });
  function sourceLine(parent, label, url, hash) {
    const link = node('a', label); link.href = url; link.rel = 'noopener noreferrer'; link.target = '_blank';
    const line = node('p'); line.append(link, node('code', ' SHA-256 ' + hash)); parent.append(line);
  }
  const rows = routeInventory(catalog, references);
  const links = coverageRelations(catalog, rows, references, providerCoverage);
  const { href: fragment, parse } = createRecordLinkCodec({ fragment: 'provider-coverage',
    views: [{ view: 'route' }, { view: 'reference' }, { view: 'field', group: 'fields' }, { view: 'family' }] });
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
  let selectedTools, fieldView;
  const routeView = mountCoverageRecords(finder, rows, node, { id: 'route', key: routeId, onSelect: row => remember({ view: 'route', record: routeId(row) }), plural: 'routes', singular: 'route', title: 'Routes',
    columns: [text('label', 'Route or tool'), category('transport', 'Transport'), category('status', 'Disposition'), category('scope', 'Access scope')],
    rowDimension: 'transport', groupDimension: 'status' }, (row, detail) => {
    detail.append(node('h5', row.label), node('p', row.scope + ' · ' + row.evidence), node('p', row.units));
    const bindings = [...new Set(row.sources.map(source => source.http).filter(http => http && http !== row.label))];
    if (bindings.length) detail.append(node('h6', 'HTTP bindings'), ...bindings.map(http => node('p', http)));
    for (const source of row.sources) {
      sourceLine(detail, source.tool ?? 'Open source ' + new URL(source.url).pathname, source.url, source.digest);
    }
    const tools = links.tools.to(routeId(row)).map(edge => edge.source);
    selectedTools = tools;
    fieldView?.showRelated(tools);
    related(detail, 'Public HTTP fields', tools.map(tool => link('View fields for ' + tool, { view: 'field', group: tool })));
    if (!tools.length) detail.append(node('p', 'The public tool directory has no field schema for this route.'));
    related(detail, 'Related references', [...new Set(links.references.to(routeId(row)).map(edge => edge.source))].map(path => link(path, { view: 'reference', record: path })));
  });
  const supplement = node('section'), families = node('section');
  supplement.id = 'coverage-references'; families.id = 'coverage-families';
  supplement.append(node('h4', references.length + ' public references'));
  const sources = references.map(source => {
    const parts = source.path.split('/').filter(Boolean);
    const locale = /^zh-(cn|hk)$/.test(parts[0]) ? parts.shift() : 'Default';
    const section = parts[0] === 'api' ? parts[1] ?? 'api' : parts[0] ?? 'Home';
    return { ...source, label: source.path, section, locale, routeCount: source.routes.length };
  });
  const referenceView = mountCoverageRecords(supplement, sources, node, { id: 'reference', key: row => row.label, onSelect: row => remember({ view: 'reference', record: row.label }), title: 'References', plural: 'references', singular: 'reference',
    columns: [text('label', 'Reference path'), category('section', 'Section'), category('locale', 'Locale'), text('sha256', 'SHA-256'), number('routeCount', 'Routes listed'), category('collection', 'Source collection')],
    rowDimension: 'locale', groupDimension: 'section' }, (row, detail) => {
    sourceLine(detail, row.label, row.url, row.sha256);
    detail.append(node('p', row.collection + ' · ' + row.file));
    if (!row.routeCount) detail.append(node('p', 'This catalog reference lists no routes.'));
    related(detail, 'Documented routes', links.references.from(row.label).map(edge =>
      link(edge.label, { view: 'route', record: edge.target })));
    related(detail, 'Cited by feature families', links.familySources.to(row.label).map(edge =>
      link(edge.label, { view: 'family', record: edge.source })));
  });
  families.append(node('h4', 'Feature families'), counts);
  const entries = providerCoverage.map(entry => ({ ...entry, operationNames: entry.operations.join(', '), readCount: mappedReads([entry]).length }));
  const familyView = mountCoverageRecords(families, entries, node, { id: 'family', key: row => row.id,
    onSelect: row => remember({ view: 'family', record: row.id }), title: 'Feature families', plural: 'families', singular: 'family',
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
    for (const edge of links.familySources.from(entry.id)) {
      const doc = links.documentsByPath.get(edge.target), line = node('p');
      line.append(link(doc.file, { view: 'reference', record: doc.path }), node('code', ' SHA-256 ' + doc.sha256));
      detail.append(line);
    }
  });
  const fields = node('section'), fieldStatus = node('p'), notice = node('p');
  const toolRoutes = node('nav'); toolRoutes.setAttribute('aria-label', 'Routes for selected tool');
  const routeLinks = tool => links.tools.from(tool).map(({ target }) => {
    const route = links.routesById.get(target);
    return link(route.transport + ' · ' + route.label, { view: 'route', record: target });
  });
  fields.id = 'coverage-fields'; fields.append(node('h4', 'Public HTTP fields'), fieldStatus, toolRoutes);
  notice.setAttribute('role', 'status');
  host.replaceChildren(status, intro, notice, finder, fields, supplement, families);
  let pending;
  function loadFields() {
    if (pending) return pending;
    fieldStatus.textContent = 'Loading field definitions…';
    pending = import('../qualification/moomoo/route-fields.json', { with: { type: 'json' } }).then(({ default: register }) => {
      const records = httpFieldInventory(register, catalog);
      if (!register.tools.every(tool => links.tools.from(tool.name).length)) throw Error('FIELD_ROUTE_MISSING');
      fieldStatus.textContent = records.length + ' field records across ' + register.tools.length + ' public tools';
      fieldView = mountCoverageRecords(fields, records, node, { id: 'field', plural: 'fields', singular: 'field', title: 'HTTP fields',
        onDimension(value) {
          toolRoutes.replaceChildren();
          if (value !== 'All') related(toolRoutes, 'Routes for ' + value, routeLinks(value));
        },
        key: row => row.key, onSelect: row => remember({ view: 'field', group: row.tool, record: row.key }),
        columns: [{ id: 'label', name: 'Field path', format: 'code-list' }, { id: 'tool', name: 'Tool', format: 'code-list' },
          category('section', 'Location'), text('type', 'Type'), category('requirement', 'Requirement')],
        rowDimension: 'tool', groupDimension: 'section', boardPageSize: 48 }, (row, detail) => {
        detail.append(node('h5', row.label), node('p', row.tool + ' · ' + row.section + ' · ' + row.type + ' · ' + row.requirement));
        if (row.rules.length) detail.append(node('p', row.rules.join(' · ')));
        if (row.wrap) detail.append(node('p', 'Response wrapper · ' + row.wrap));
        if (row.section === 'Response') detail.append(node('p', 'The public tool directory supplies this field name. See the REST reference for the wire format.'));
        related(detail, 'Related routes', routeLinks(row.tool));
      });
      if (selectedTools) fieldView.showRelated(selectedTools);
      return fieldView;
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
    const destination = parse('#' + hash);
    let opened = false;
    if (destination?.view === 'route') opened = routeView.open({ key: destination.record });
    else if (destination?.view === 'reference') opened = referenceView.open({ key: destination.record });
    else if (destination?.view === 'family') opened = familyView.open({ key: destination.record });
    else if (destination?.view === 'field') {
      const view = await loadFields();
      if (location.hash !== '#' + hash) return;
      if (!view) { fields.scrollIntoView({ block: 'center' }); return; }
      opened = view.open({ dimension: destination.group, key: destination.record });
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
