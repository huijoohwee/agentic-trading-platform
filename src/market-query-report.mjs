export function routeValues(route) {
  if (!route) return [];
  const joined = key => [...new Set(route.sources.map(source => source[key]).filter(Boolean))].join(' | ');
  return [route.transport, route.label, route.status, route.scope, route.evidence, route.units,
    joined('http'), joined('tool'), ...['url', 'digest'].map(key => route.sources.map(source => source[key]).join(' | '))];
}

export function unpackMarketQueries(report, routes) {
  let routeIndex = 0;
  return report.offsets.map((offset, i) => {
    routeIndex += offset;
    const route = routes[routeIndex], values = routeValues(route);
    const cells = report.columns.map(column => {
      const entry = Array.isArray(column) ? column[i] : column;
      return typeof entry === 'number' ? values[entry] : entry;
    });
    const record = Object.fromEntries(report.headers.map((header, j) => [header, cells[j]]));
    return { ...record, label: record['Route or tool'], route };
  });
}
