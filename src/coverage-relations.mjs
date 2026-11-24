import { createRecordRelation } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { catalogReferences, providerCoverage } from './provider-coverage.mjs';

// The catalog retains each source spelling, including aliases folded into one REST route.
export const routeId = row => row.transport + ' ' + row.label;

export function coverageRelations(catalog, routes, documents = catalogReferences(catalog), families = providerCoverage) {
  const documentsByPath = new Map(documents.map(doc => [doc.path, doc]));
  const toolLinks = [], documentLinks = [];
  const routeIds = routes.map(routeId);
  for (const route of routes) {
    const target = routeId(route);
    for (const source of route.sources) {
      if (source.tool) toolLinks.push({ source: source.tool, target });
      if (!source.document) continue;
      const doc = documentsByPath.get(source.document);
      const label = source.http ?? 'PUSH ' + route.label;
      if (!doc || source.url !== doc.url || source.digest !== doc.sha256 || !doc.routes.includes(label)) throw Error('REFERENCE_ROUTE_DRIFT');
      documentLinks.push({ source: doc.path, target, label });
    }
  }
  const references = createRecordRelation({ sources: documentsByPath.keys(), targets: routeIds, links: documentLinks });
  for (const doc of documents) {
    const declared = doc.routes;
    const edges = references.from(doc.path);
    if (edges.length !== declared.length || !declared.every(label => edges.some(edge => edge.label === label))) throw Error('REFERENCE_ROUTE_MISSING');
  }
  const tools = createRecordRelation({ sources: catalog.tools.map(tool => tool.name), targets: routeIds, links: toolLinks });
  const citations = [];
  for (const family of families) {
    for (const source of family.sources) {
      // Two published paths can refer to the same Markdown file. Keep every attested path.
      const matches = documents.filter(doc => doc.file === source.path && doc.sha256 === source.sha256);
      if (!matches.length) throw Error('FAMILY_REFERENCE_DRIFT');
      for (const doc of matches) citations.push({ source: family.id, target: doc.path, label: family.label });
    }
  }
  const familySources = createRecordRelation({ sources: families.map(family => family.id), targets: documentsByPath.keys(), links: citations });
  return { references, familySources, documentsByPath, tools, routesById: new Map(routes.map(row => [routeId(row), row])) };
}

const limits = {
  default: 'Default', enum: 'Values', min: 'Minimum', max: 'Maximum', maximum: 'Maximum',
  minLength: 'Minimum length', maxLength: 'Maximum length', minItems: 'Minimum items', maxItems: 'Maximum items', pattern: 'Pattern',
};

export function httpFieldInventory(register, catalog) {
  if (register.schema !== 'moomoo-public-http-fields/v1' || register.authority !== false ||
      register.directory_sha256 !== catalog.directory_sha256) throw Error('FIELD_REGISTER_DRIFT');
  const rows = [];
  for (const tool of register.tools) {
    function add(field, section, parents = []) {
      const name = [...parents, field.name];
      rows.push({ tool: tool.name, section, label: name.join('.'), key: JSON.stringify([tool.name, section, ...name]),
        type: field.type ?? 'Unspecified', requirement: field.required === undefined ? 'Unspecified' : field.required ? 'Required' : 'Optional',
        rules: Object.entries(limits).filter(([key]) => Object.hasOwn(field, key)).map(([key, label]) =>
          label + ' ' + (Array.isArray(field[key]) ? field[key].join(', ') : String(field[key]))), wrap: tool.wrap });
      for (const child of field.fields ?? []) add(child, section, name);
    }
    for (const name of tool.path) add(tool.params.find(p => p.name === name) ?? { name }, 'Path');
    for (const field of tool.params) if (!tool.path.includes(field.name)) add(field, 'Parameter');
    for (const field of tool.body) add(field, 'Request body');
    for (const name of tool.response) add({ name }, 'Response');
    for (const name of tool.pagination ?? []) add({ name }, 'Pagination');
  }
  return rows;
}
