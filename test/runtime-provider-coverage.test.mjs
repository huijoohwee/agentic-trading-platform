import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from 'agentic-gateway/connectors/moomoo-catalog.json' with { type: 'json' };
import { researchMapping } from '../runtime/moomoo-research.mjs';
import { providerCoverage, coverageSummary, routeInventory, COVERAGE_INDEX } from '../src/provider-coverage.mjs';

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
  assert.deepEqual(summary.rest_only_mapped, ['calendar', 'capital-flow', 'rank', 'plate-industry', 'news-research', 'ipo',
    'financials', 'corporate-actions', 'holders', 'influencer', 'macro', 'derivatives', 'etf', 'event-contract', 'crypto-market', 'valuation', 'short', 'stock-connect', 'top-brokers', 'chip-cbbc']);
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
  assert.deepEqual(['REST', 'MCP', 'Push'].map(key => on(key).length), [217, 107, 24]);
  assert.equal(catalog.sources.length, 305);
  assert.equal(catalog.sources.filter(source => hex(source.sha256)).length, 196);
  assert.deepEqual(on('MCP').map(row => row.label).sort(), catalog.tools.map(tool => tool.name).sort());
  assert.equal(on('Push').filter(row => row.status === 'offline replay').length, 4);
  const mappedPaths = on('REST').filter(row => row.status === 'mapped').map(row => row.label).sort();
  const researchPaths = Object.values(researchMapping.operations).map(spec => 'GET ' + spec.path);
  assert.deepEqual(mappedPaths, ['GET /api/v1.0/quote/earnings-calendar', ...researchPaths].sort());
  assert.equal(on('MCP').find(row => row.label === 'quote_capital_flow').status, 'candidate');
  assert.equal(on('REST').find(row => row.label.endsWith('/modify-user-security')).status, 'blocked');
  assert.equal(on('REST').find(row => row.label === 'POST /api/v1/crypto/accounts/{acc_id}/orders').status, 'excluded');
  for (const row of rows) assert.ok(row.sources.length && row.sources.every(source => hex(source.digest)));
  assert.throws(() => routeInventory({ ...catalog, index_sha256: 'changed' }), /COVERAGE_SOURCE_DRIFT/);
});
