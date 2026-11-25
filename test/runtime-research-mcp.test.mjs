import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import catalog from 'agentic-gateway/connectors/moomoo-catalog.json' with { type: 'json' };
import { canonical, sha } from '../runtime/core.mjs';
import { createMcpMarketReadAdapter } from '../runtime/mcp-market-read.mjs';
import { researchMapping, researchMcpMapping, researchToolArguments } from '../runtime/moomoo-research.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { researchTools } from '../src/moomoo-research-tools.mjs';
import { readResearchPage } from '../src/research-page.mjs';
import { fixtureTransport, mcpDefinition } from './research-mcp-fixture.mjs';

const operation = 'read.holders';
const tool = researchTools[operation];
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-research' };
const candidate = sha('research-mcp-fixture');
const operator = generateKeyPairSync('ed25519'), integration = generateKeyPairSync('ed25519');
const keys = Object.fromEntries(Object.entries({ operator, integration }).map(([role, pair]) => [role, {
  role, principal: role, runtime: role, publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
}]));
const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
  privateKey: integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const utc = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
const expiry = utc(Date.now() + 3600000);
const { provider, descriptor } = mcpDefinition({ schema: 'trading-provider-definition/v1', provider: 'research-fixture',
  adapter_version: '1', adapter_digest: sha('mcp'), source: 'PROVIDER', mode: 'account',
  cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('local-research-fixture'), expires_utc: expiry } }, operation);

test('each public research tool has the same HTTP method and path as its reviewed projection', () => {
  assert.deepEqual(Object.keys(researchMcpMapping.operations).filter(name => Object.hasOwn(researchTools, name)).sort(),
    Object.keys(researchTools).sort());
  for (const [operation, name] of Object.entries(researchTools)) {
    const rest = researchMapping.operations[operation];
    assert.equal(catalog.tools.find(tool => tool.name === name).http, rest.method + ' ' + rest.path);
    assert.equal(researchMcpMapping.operations[operation].tool, name);
  }
  assert.throws(() => researchToolArguments(operation, { symbol: 'HK.00700', period_id: 1 }), /INVALID_PARAMETER/);
  for (const delta of [{ tool: 'quote_stock_quote' }, { projection_digest: sha('changed') }, { pin_inputs: false }]) {
    const mapping = { protocol: provider.mapping.protocol, operations: { [operation]: { ...provider.mapping.operations[operation], ...delta } } };
    assert.throws(() => createMcpMarketReadAdapter({ provider: { ...provider, mapping_digest: sha(mapping), mapping },
      token: 'fixture-research-token', scope, candidate, attestation, mapping }), /INVALID_MAPPING/);
  }
});

test('running gateway checks signed MCP arguments before reserving calls and replays exact holder rows into the desk', async t => {
  const { schema, transport, mapping, ...identity } = provider;
  const capability = { ...identity, transport: transport.kind, protocol: transport.protocol };
  const audience = 'local-research-audience-fixture-testing';
  const dir = await mkdtemp(join(tmpdir(), 'research-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ schema: 'trading-runtime-config/v1', scope, candidate, keys, database: 'fixture.sqlite',
    viewer_token: 'local-example-viewer-research-fixture', providers: [provider],
    provider_credentials: { [provider.provider]: { transports: { MCP: { token: 'fixture-research-token', attestation } } } },
    gateway: { audience_token: audience, capabilities: [capability] } }), { mode: 0o600 });
  const holder = { name: 'Example', holder_pct: '28.300', holder_id: null, static_date_str: null };
  const response = { structuredContent: { ret_code: 0, data: { main_holder: [holder] } } };
  const fake = fixtureTransport(descriptor, response), network = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) =>
    new URL(url).hostname === '127.0.0.1' ? network(url, options) : fake.fetchImpl(url, options));
  const server = await runtimeCommand(['gateway', path, '0']);
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function post(route, body) {
    const reply = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' } });
    assert.ok(reply.ok); return reply.json();
  }
  function request(nonce, parameters, digest, budget = 'shared') {
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 2000), expires_utc: expiry, nonce, mapping_digest: provider.mapping_digest, tools: [
        { operation, name: tool, schema_digest: provider.schema_digest, effect: 'read', ...(digest && { inputs_digest: digest }) }],
      limits: { max_calls: 4, timeout_ms: 10000 }, proofs: ['cost', 'rights', 'account'].map(kind =>
        ({ kind, digest: sha(kind === 'cost' ? budget : kind), expires_utc: expiry })),
      cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 4 } };
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    return { contract_version: '1', operation, scope, capability_digest: sha(capability), request_id: nonce,
      inputs: { ...parameters, grant }, deadline_utc: utc(Date.now() + 60000) };
  }
  const valid = { symbol: 'HK.00700', period_id: 0 };
  for (const [nonce, params, digest] of [['missing', valid], ['changed', valid, sha({ ...valid, period_id: 1 })],
    ['public-enum', { ...valid, period_id: 1 }, sha({ ...valid, period_id: 1 })],
    ['unexpected', { ...valid, keyword: 'x' }, sha({ ...valid, keyword: 'x' })]]) {
    const refusal = await post('/api/gateway', request(nonce, params, digest));
    assert.equal(refusal.status, 'REFUSED');
  }
  assert.equal(fake.calls.length, 0);
  const admitted = request('holders-page', valid, sha(valid));
  const result = await post('/api/gateway', admitted);
  assert.equal(result.status, 'OK', JSON.stringify(result.error));
  assert.equal(result.data.decimals[0].holder_pct, '28.300');
  assert.equal(result.provenance.source, 'PROVIDER');
  assert.deepEqual(result.data.rows, [{ ...holder, holder_pct: 28.3 }]);
  const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: operation, arguments: admitted } });
  assert.deepEqual(replay.result.structuredContent, result);
  assert.deepEqual(await readResearchPage(replay), await readResearchPage(result));
  assert.deepEqual(fake.calls.map(c => c.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(fake.calls.at(-1).body.params, { name: tool, arguments: valid });
  assert.ok(fake.calls.every(c => c.url === transport.origin && c.options.redirect === 'error' &&
    c.options.headers.Authorization === 'Bearer fixture-research-token'));
  holder.holderPct = '99';
  const ambiguous = await post('/api/gateway', request('ambiguous', valid, sha(valid), 'ambiguity'));
  assert.equal(ambiguous.status, 'REFUSED');
  assert.equal(fake.calls.length, 8);
  descriptor.description += ' changed';
  const drift = await post('/api/gateway', request('drift', valid, sha(valid), 'drift'));
  assert.equal(drift.status, 'REFUSED');
  assert.equal(fake.calls.at(-1).body.method, 'tools/list');
});
