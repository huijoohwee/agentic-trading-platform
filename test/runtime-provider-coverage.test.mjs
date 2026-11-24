import { securitiesTradeTopics, cryptoReportTopics } from 'agentic-gateway/connectors/moomoo-trade-event';
import { simulatorSpecs } from '../runtime/moomoo-simulator-read.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from 'agentic-gateway/connectors/moomoo-catalog.json' with { type: 'json' };
import { marketRestSpecs } from '../runtime/moomoo-market-rest.mjs';
import { researchMapping } from '../runtime/moomoo-research.mjs';
import { providerCoverage, coverageSummary, mappedReads, routeInventory, COVERAGE_INDEX } from '../src/provider-coverage.mjs';

const statuses = ['mapped', 'candidate', 'paper-candidate', 'excluded'];
const transports = ['MCP', 'REST', 'MCP+REST', 'PUSH'];
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operationId = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);

test('the coverage inventory is evidence-led: pinned source hashes, honest statuses and no live dispatch', () => {
  assert.ok(providerCoverage.length >= 20);
  assert.ok(hex(COVERAGE_INDEX.index_sha256));
  assert.equal(COVERAGE_INDEX.known_sources, COVERAGE_INDEX.imported_sources + COVERAGE_INDEX.incomplete_sources);
  const ids = new Set();
  for (const entry of providerCoverage) {
    assert.ok(!ids.has(entry.id), 'duplicate family ' + entry.id); ids.add(entry.id);
    assert.ok(statuses.includes(entry.status), entry.status);
    assert.ok(transports.includes(entry.transport), entry.transport);
    assert.ok(entry.operations.every(operationId));
    assert.ok(entry.mcp.every(name => /^[a-z][a-z0-9_]{0,63}$/.test(name)));
    for (const item of entry.sources) {
      assert.ok(hex(item.sha256), item.path);
      assert.ok(item.url.startsWith('https://open.moomoo.com/'));
      assert.ok(item.path.endsWith('.md'));
    }
    if (entry.status === 'excluded') {
      assert.deepEqual(entry.operations, [], 'excluded families map no read');
      assert.deepEqual(entry.mcp, [], 'excluded families bind no tool');
    }
  }
});

test('mapped reads cover the MCP market family and reviewed REST projections', () => {
  const summary = coverageSummary();
  assert.ok(summary.mapped_operations.includes('read.calendar'));
  assert.ok(summary.mapped_operations.includes('read.ticker'));
  assert.ok(summary.mapped_operations.includes('read.quote-stream'));
  assert.deepEqual(summary.rest_only_mapped, ['calendar', 'influencer', 'macro', 'etf', 'event-contract', 'crypto-market', 'stock-connect', 'chip-cbbc']);
  assert.ok(summary.excluded.includes('trading') && summary.excluded.includes('crypto-trading'));
  const calendar = providerCoverage.find(entry => entry.id === 'calendar');
  assert.equal(calendar.transport, 'REST');
  assert.deepEqual(calendar.mcp, [], 'the earnings calendar has no MCP tool');
  assert.equal(calendar.sources[0].sha256, '36da3343d16f677f29c49f8194f6c645b5ce273bda0ccc2a1c442c8f29bf4bc2');
  assert.equal(summary.families, providerCoverage.length);
  assert.equal(Object.values(summary.by_status).reduce((a, b) => a + b, 0), providerCoverage.length);
});

test('pinned route inventory reconciles aliases, transport-specific evidence and known gaps', () => {
  const rows = routeInventory(catalog);
  const on = transport => rows.filter(row => row.transport === transport);
  assert.deepEqual(['REST', 'MCP', 'Push'].map(key => on(key).length), [258, 107, 24]);
  assert.equal(catalog.sources.length, 305);
  assert.equal(catalog.sources.filter(source => hex(source.sha256)).length, 196);
  assert.equal(catalog.sources.filter(source => hex(source.reference?.sha256)).length, 109);
  const options = on('REST').find(row => row.label.endsWith('/option-event'));
  assert.equal(options.status, 'mapped');
  assert.ok(options.sources.some(source => source.url.endsWith('/derivatives/option-event.md')));
  const statement = on('REST').find(row => row.label.endsWith('/financials/statements'));
  assert.equal(statement.status, 'mapped');
  assert.ok(statement.sources.some(source => source.tool === 'quote_financials_statements'));
  assert.ok(statement.sources.some(source => source.url.endsWith('/financials/statements.md')));
  const futures = on('REST').filter(row => row.label.includes('/future/'));
  assert.equal(futures.filter(row => row.status === 'mapped').length, 3);
  assert.ok(futures.filter(row => row.status === 'mapped').every(row => row.sources.some(source => source.url.endsWith('.md'))));
  assert.deepEqual(on('MCP').map(row => row.label).sort(), catalog.tools.map(tool => tool.name).sort());
  assert.deepEqual(on('Push').filter(row => row.status === 'offline replay').map(row => row.label.split('/').at(-1)).sort(),
    ['BROKER_QUEUE', 'KLINE', 'MARKET_STATE', 'ORDER_BOOK', 'QUOTE', 'TICKER', ...securitiesTradeTopics, ...cryptoReportTopics.map(String)].sort());
  assert.equal(on('Push').filter(row => row.status === 'candidate').length, 0);
  assert.deepEqual(on('Push').filter(row => row.evidence.includes('WebSocket')).map(row => row.label.split('/').at(-1)).sort(),
    ['KLINE', 'ORDER_BOOK', 'QUOTE', 'TICKER']);
  for (const [transport, label] of [['REST', 'POST /api/v1.0/quote/stock-screen'], ['MCP', 'quote_stock_screen']]) {
    const screen = on(transport).find(row => row.label === label);
    assert.deepEqual([screen.status, screen.scope, screen.evidence], ['mapped', 'quote:read', 'Signed local stock-screen fixture']);
    assert.match(screen.units, /Exact raw integer/);
  }
  const mappedPaths = on('REST').filter(row => row.status === 'mapped').map(row => row.label).sort();
  const researchPaths = Object.values({ ...researchMapping.operations, ...marketRestSpecs, ...simulatorSpecs }).map(spec => spec.method + ' ' + spec.path);
  assert.deepEqual(mappedPaths, ['GET /api/v1.0/quote/earnings-calendar', ...researchPaths].sort());
  assert.equal(on('MCP').filter(row => row.status === 'mapped').length, 24);
  const dual = on('MCP').filter(row => row.evidence === 'Signed local MCP research fixture');
  assert.equal(dual.length, 14);
  for (const row of dual) {
    const rest = on('REST').find(entry => entry.sources.some(source => source.tool === row.label));
    assert.equal(rest.status, 'mapped');
    assert.equal(row.units, rest.units);
    assert.equal(row.scope, rest.scope);
  }
  assert.equal(on('REST').find(row => row.label.endsWith('/modify-user-security')).status, 'blocked');
  assert.equal(on('REST').find(row => row.label === 'POST /api/v1/crypto/accounts/{acc_id}/orders').status, 'excluded');
  for (const row of rows) assert.ok(row.sources.length && row.sources.every(source => hex(source.digest)));
  assert.throws(() => routeInventory({ ...catalog, index_sha256: 'changed' }), /COVERAGE_SOURCE_DRIFT/);
});

test('all nine simulator bindings distinguish six research reads from three independently approved paper effects', () => {
  const routes = routeInventory(catalog).filter(row => row.transport === 'REST' && row.label.includes('/sim-trade/'));
  const tools = routeInventory(catalog).filter(row => row.transport === 'MCP' && row.label.startsWith('sim_trade_'));
  assert.equal(tools.length, 8);
  const mapped = tools.filter(row => row.status === 'mapped');
  assert.deepEqual(mapped.map(row => row.label).sort(), Object.values(simulatorSpecs).map(spec => spec.tool).filter(tool => tool.startsWith('sim_trade_')).sort());
  assert(mapped.every(row => row.evidence === 'Signed local simulator MCP fixture' && row.scope === 'Simulator account read'));
  assert(tools.filter(row => row.status === 'paper candidate').every(row => row.scope === 'Independent paper approval and simulator grant'));
  assert.equal(routes.length, 9);
  const reads = routes.filter(row => row.label.startsWith('GET '));
  const effects = routes.filter(row => row.label.startsWith('POST '));
  assert.equal(reads.length, 6);
  assert.equal(effects.length, 3);
  assert.equal(new Set(routes.map(row => row.evidence)).size, 9);
  for (const row of routes) {
    assert.equal(row.status, Object.values(simulatorSpecs).some(spec => row.label === spec.method + ' ' + spec.path) ? 'mapped' : 'paper candidate');
    assert.notEqual(row.units, 'See source field definitions');
    assert(row.sources.some(source => new URL(source.url).pathname.startsWith('/api/sim-trade/')));
  }
  assert(reads.every(row => row.scope === 'Simulator account read'));
  assert(effects.every(row => row.scope === 'Independent paper approval and simulator grant'));
});

test('coverage separates operation IDs from distinct mapped reads and retains each published HTTP binding', () => {
  const market = providerCoverage.find(row => row.id === 'market-reads'), paper = providerCoverage.find(row => row.id === 'sim-trade');
  assert.equal(mappedReads([market, market]).length, 5);
  assert.deepEqual(paper.operations, ['practice.sim']); assert.deepEqual(mappedReads([paper]), []);
  assert(providerCoverage.every(row => row.sources.length));
  const rows = routeInventory(catalog);
  for (const tool of catalog.tools) assert(rows.find(r => r.transport === 'MCP' && r.label === tool.name).sources.some(s => s.http === tool.http));
  for (const doc of catalog.sources) {
    const source = doc.reference ?? doc;
    for (const path of source.routes ?? []) if (!path.startsWith('PUSH ')) {
      assert(rows.some(row => row.transport === 'REST' && row.sources.some(s => s.http === path && s.digest === source.sha256)), path);
    }
  }
  for (const entry of providerCoverage) for (const evidence of entry.sources) {
    const doc = catalog.sources.find(x => (x.reference ?? x).file === evidence.path);
    assert.equal((doc?.reference ?? doc)?.sha256, evidence.sha256, evidence.path);
  }
});

test('every declared reference route and public field has a reversible catalog identity', async () => {
  const { build } = await import('../scripts/build.mjs');
  const { pathToFileURL } = await import('node:url');
  const { destination } = await build();
  const { coverageRelations, httpFieldInventory, routeId } = await import(pathToFileURL(destination + '/src/coverage-relations.mjs'));
  const { default: register } = await import('agentic-gateway/connectors/moomoo-fields.json', { with: { type: 'json' } });
  const routes = routeInventory(catalog), links = coverageRelations(catalog, routes);
  for (const doc of catalog.sources.filter(doc => doc.reference)) {
    for (const spelling of doc.reference.routes) {
      const edge = links.references.from(doc.path).find(item => item.label === spelling);
      const route = links.routesById.get(edge.target);
      assert(links.references.to(routeId(route)).includes(edge));
      assert(route.sources.some(s => s.digest === doc.reference.sha256 && s.url.endsWith('/' + doc.reference.file)));
    }
  }
  const fields = httpFieldInventory(register, catalog);
  assert.equal(fields.length, 1568);
  assert.equal(new Set(fields.map(row => row.key)).size, fields.length);
  for (const tool of register.tools) {
    const records = fields.filter(r => r.tool === tool.name);
    assert.deepEqual(new Set(links.tools.from(tool.name).map(edge => links.routesById.get(edge.target).transport)), new Set(['REST', 'MCP']));
    assert.deepEqual(records.filter(r => r.section === 'Path').map(r => r.label), tool.path);
    assert.deepEqual(records.filter(r => r.section === 'Response').map(r => r.label), tool.response);
    assert.deepEqual(records.filter(r => r.section === 'Pagination').map(r => r.label), tool.pagination ?? []);
  }
  const nested = fields.find(r => r.label.endsWith('leg_infos.leg_ratio_qty'));
  assert.equal(nested.type, 'string'); assert.equal(nested.requirement, 'Required');
  assert.equal(fields.find(r => r.tool === 'account_orders_detail' && r.section === 'Path' && r.label === 'acc_id').type, 'Unspecified');
  assert.throws(() => httpFieldInventory({ ...register, directory_sha256: 'other' }, catalog), /FIELD_REGISTER_DRIFT/);
});
