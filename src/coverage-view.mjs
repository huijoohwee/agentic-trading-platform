import { mountCoverageRecords } from './coverage-routes-view.mjs';
import { providerCoverage, coverageSummary, mappedReads, routeInventory, COVERAGE_INDEX } from './provider-coverage.mjs';

const limits = {
  default: 'Default', enum: 'Values', min: 'Minimum', max: 'Maximum', maximum: 'Maximum',
  minLength: 'Minimum length', maxLength: 'Maximum length', minItems: 'Minimum items', maxItems: 'Maximum items', pattern: 'Pattern'
};

function fieldList(fields, node) {
  const list = node('ul');
  for (const field of fields) {
    const item = node('li');
    const requirement = field.required === undefined ? '' : field.required ? ' · required' : ' · optional';
    item.append(node('code', field.name), document.createTextNode(' · ' + field.type + requirement));
    const rules = Object.entries(limits).filter(([key]) => Object.hasOwn(field, key))
      .map(([key, label]) => label + ' ' + (Array.isArray(field[key]) ? field[key].join(', ') : String(field[key])));
    if (rules.length) item.append(node('p', rules.join(' · ')));
    if (field.fields?.length) item.append(fieldList(field.fields, node));
    list.append(item);
  }
  return list;
}

function showHttpFields(tool, node) {
  const section = node('section');
  section.append(node('h5', 'Public HTTP fields · ' + tool.name));
  if (tool.path.length) section.append(node('p', 'Path variables · ' + tool.path.join(', ')));
  for (const [name, fields] of [['Parameters', tool.params], ['Request body', tool.body]]) {
    if (fields.length) section.append(node('h6', name), fieldList(fields, node));
  }
  if (tool.response.length) {
    const response = node('details');
    response.append(node('summary', 'Response fields (' + tool.response.length + ')'),
      node('p', (tool.wrap ? tool.wrap + ' · ' : '') + tool.response.join(', ')),
      node('p', 'These names come from the public tool directory. The REST reference gives the JSON field names returned by that endpoint.'));
    section.append(response);
  }
  if (tool.pagination?.length) section.append(node('p', 'Pagination · ' + tool.pagination.join(', ')));
  return section;
}

// Lazy, read-only discovery surface for the moomoo OpenAPI feature-family coverage. It renders the
// reviewed inventory metadata only: no provider call, no credential, no dispatch authority. Host-specific captures are labelled independently.
export async function mountCoverageView(host) {
  const { default: catalog } = await import('../qualification/moomoo/route-inventory.json', { with: { type: 'json' } });
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  let register;
  function loadFieldRegister() {
    register ??= import('../qualification/moomoo/route-fields.json', { with: { type: 'json' } }).then(({ default: data }) => {
      if (data.schema !== 'moomoo-public-http-fields/v1' || data.authority !== false ||
          data.directory_sha256 !== catalog.directory_sha256) throw Error('FIELD_REGISTER_DRIFT');
      return new Map(data.tools.map(tool => [tool.name, tool]));
    }).catch(error => { register = undefined; throw error; });
    return register;
  }
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
  const summaryLine = node('p', ['REST', 'MCP', 'Push'].map(kind =>
    rows.filter(row => row.transport === kind).length + ' ' + kind + ' routes').join(' · '));
  const finder = node('section');
  finder.id = 'coverage-routes';
  finder.append(node('h4', 'Find a provider route'), summaryLine,
    node('p', 'Gateway owns provider route definitions. Trading owns mappings and admission. Each connected read requires host-specific rights, a provider-enforced $0 limit and remaining quota.'));
  mountCoverageRecords(finder, rows, node, { id: 'route', plural: 'routes', singular: 'route', title: 'Routes',
    columns: [text('label', 'Route or tool'), category('transport', 'Transport'), category('status', 'Disposition'), category('scope', 'Access scope')],
    rowDimension: 'transport', groupDimension: 'status' }, (row, detail) => {
    detail.append(node('h5', row.label), node('p', row.scope + ' · ' + row.evidence), node('p', row.units));
    const bindings = [...new Set(row.sources.map(source => source.http).filter(http => http && http !== row.label))];
    if (bindings.length) detail.append(node('h6', 'HTTP bindings'), ...bindings.map(http => node('p', http)));
    for (const source of row.sources) {
      sourceLine(detail, source.tool ?? new URL(source.url).pathname, source.url, source.digest);
    }
    const tools = [...new Set(row.sources.map(source => source.tool).filter(Boolean))];
    if (!tools.length) return;
    const fields = node('div');
    detail.append(fields);
    async function show() {
      try {
        const index = await loadFieldRegister();
        fields.replaceChildren(...tools.map(name => {
          if (!index.has(name)) throw Error('MISSING_FIELD_DEFINITION');
          return showHttpFields(index.get(name), node);
        }));
      } catch {
        const retry = node('button', 'Retry field definitions');
        retry.type = 'button'; retry.addEventListener('click', show, { once: true });
        fields.replaceChildren(node('p', 'Field definitions unavailable.'), retry);
      }
    }
    show();
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
  mountCoverageRecords(supplement, sources, node, { id: 'reference', title: 'References', plural: 'references', singular: 'reference',
    columns: [text('label', 'Reference path'), category('section', 'Section'), category('locale', 'Locale'), text('hash', 'SHA-256'), number('routeCount', 'Routes listed')],
    rowDimension: 'locale', groupDimension: 'section' }, (row, detail) => {
    sourceLine(detail, row.label, catalog.origin + '/' + row.reference.file, row.hash);
    detail.append(node('p', 'Markdown file · ' + row.reference.file));
    if (!row.routeCount) detail.append(node('p', 'This catalog reference lists no routes.'));
    for (const route of row.reference.routes) detail.append(node('p', route));
  });
  families.append(node('h4', 'Feature families'), counts);
  const entries = providerCoverage.map(entry => ({ ...entry, operationNames: entry.operations.join(', '), readCount: mappedReads([entry]).length }));
  mountCoverageRecords(families, entries, node, { id: 'family', title: 'Feature families', plural: 'families', singular: 'family',
    columns: [text('label', 'Feature family'), category('transport', 'Transport'), category('status', 'Disposition'), text('operationNames', 'Operation IDs'), number('readCount', 'Mapped reads')],
    measure: { label: 'Distinct mapped reads', count: group => mappedReads(group).length },
    rowDimension: 'transport', groupDimension: 'status' }, (entry, detail) => {
    detail.append(node('h5', entry.label), node('p', entry.note));
    const facts = node('dl'); facts.className = 'facts';
    facts.append(node('dt', 'Family ID'), node('dd', entry.id),
      node('dt', 'Operation IDs'), node('dd', entry.operationNames || 'None'),
      node('dt', 'Mapped reads'), node('dd', entry.readCount),
      node('dt', 'Listed MCP tools'), node('dd', entry.mcp.join(', ') || 'See individual routes'));
    detail.append(facts);
    for (const item of entry.sources) sourceLine(detail, item.path, item.url, item.sha256);
  });
  host.replaceChildren(status, intro, finder, supplement, families);
}
