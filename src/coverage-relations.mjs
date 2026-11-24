// The catalog retains each source spelling, including aliases folded into one REST route.
export const routeId = row => row.transport + ' ' + row.label;

export function coverageRelations(catalog, routes) {
  const documents = new Map(catalog.sources.filter(s => s.reference).map(source =>
    [catalog.origin + '/' + source.reference.file, source]));
  const byTool = new Map(), byReference = new Map(), byRoute = new Map();
  for (const route of routes) {
    const references = new Set();
    for (const source of route.sources) {
      if (source.tool) {
        if (!byTool.has(source.tool)) byTool.set(source.tool, new Set());
        byTool.get(source.tool).add(route);
      }
      const doc = documents.get(source.url);
      if (!doc) continue;
      const spelling = source.http ?? 'PUSH ' + route.label;
      if (source.digest !== doc.reference.sha256 || !doc.reference.routes.includes(spelling)) throw Error('REFERENCE_ROUTE_DRIFT');
      if (!byReference.has(doc.path)) byReference.set(doc.path, new Map());
      byReference.get(doc.path).set(spelling, route);
      references.add(doc.path);
    }
    byRoute.set(routeId(route), references);
  }
  for (const doc of documents.values()) {
    if (!doc.reference.routes.every(spelling => byReference.get(doc.path)?.has(spelling))) throw Error('REFERENCE_ROUTE_MISSING');
  }
  return { byTool, byReference, byRoute };
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
