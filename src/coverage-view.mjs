import { providerCoverage, coverageSummary, routeInventory, COVERAGE_INDEX } from './provider-coverage.mjs';

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
      node('p', (tool.wrap ? tool.wrap + ' · ' : '') + tool.response.join(', ')));
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
  const intro = node('p', `Evidence-led inventory of ${COVERAGE_INDEX.known_sources} known OpenAPI sources (${COVERAGE_INDEX.imported_sources} imported, ${COVERAGE_INDEX.incomplete_sources} incomplete). Connected qualification is specific to the host and read. Live order dispatch is excluded from the read-only $0 scope.`);
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
  const rows = routeInventory(catalog);
  const missing = catalog.sources.filter(source => source.imported === false);
  const summaryLine = node('p', ['REST', 'MCP', 'Push'].map(kind =>
    rows.filter(row => row.transport === kind).length + ' ' + kind + ' routes').join(' · '));
  const finder = node('section');
  finder.id = 'coverage-routes';
  finder.append(node('h4', 'Find a provider route'), summaryLine,
    node('p', 'Gateway owns provider route definitions. Trading owns mappings and admission. Each connected read requires host-specific rights, a provider-enforced $0 limit and remaining quota.'));
  const label = node('label', 'Route or tool ');
  const query = node('input');
  query.type = 'search';
  label.append(query);
  const filterLabel = node('label', ' Disposition ');
  const filter = node('select');
  for (const value of ['All', ...new Set(rows.map(row => row.status))]) filter.append(node('option', value));
  filterLabel.append(filter);
  const previous = node('button', 'Previous'), next = node('button', 'Next');
  previous.type = next.type = 'button';
  const results = node('ul'), range = node('p');
  range.setAttribute('role', 'status');
  let offset = 0;
  function render() {
    const term = query.value.trim().toLowerCase();
    const matches = rows.filter(row => (filter.value === 'All' || row.status === filter.value) &&
      (row.transport + ' ' + row.label).toLowerCase().includes(term));
    const page = matches.slice(offset, offset + 12);
    range.textContent = page.length ? (offset + 1) + '–' + (offset + page.length) + ' of ' + matches.length : 'No matching routes';
    results.replaceChildren(...page.map(row => {
      const item = node('li'), detail = node('details');
      detail.append(node('summary', row.transport + ' · ' + row.label + ' · ' + row.status),
        node('p', row.scope + ' · ' + row.evidence), node('p', row.units));
      const tools = [...new Set(row.sources.map(source => source.tool).filter(Boolean))];
      if (tools.length) {
        const fields = node('div');
        detail.append(fields);
        let ready = false;
        detail.addEventListener('toggle', async () => {
          if (!detail.open || ready) return;
          ready = true;
          try {
            const index = await loadFieldRegister();
            fields.replaceChildren(...tools.map(name => {
              if (!index.has(name)) throw Error('MISSING_FIELD_DEFINITION');
              return showHttpFields(index.get(name), node);
            }));
          } catch {
            fields.textContent = 'Field definitions unavailable. Reopen this route to retry.';
            ready = false;
          }
        });
      }
      for (const source of row.sources) {
        const link = node('a', source.tool ?? new URL(source.url).pathname);
        link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        const line = node('p'); line.append(link, node('code', ' SHA-256 ' + source.digest));
        detail.append(line);
      }
      item.append(detail);
      return item;
    }));
    previous.disabled = offset === 0;
    next.disabled = offset + page.length >= matches.length;
  }
  for (const [element, event] of [[query, 'input'], [filter, 'change']]) {
    element.addEventListener(event, () => { offset = 0; render(); });
  }
  previous.addEventListener('click', () => { offset -= 12; render(); });
  next.addEventListener('click', () => { offset += 12; render(); });
  finder.append(label, filterLabel, range, results, previous, next);
  render();
  const gaps = node('details');
  gaps.append(node('summary', missing.length + ' source URLs awaiting import'));
  const paths = node('ul');
  for (const source of missing) paths.append(node('li', source.path));
  gaps.append(paths);
  const families = node('details');
  families.append(node('summary', 'Feature families'), counts, list);
  host.replaceChildren(status, intro, finder, gaps, families);
}