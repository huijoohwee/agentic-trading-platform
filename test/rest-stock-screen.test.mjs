import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { researchMapping, stockScreenMcpMapping } from '../runtime/moomoo-research.mjs';
import { createRestMarketReadAdapter } from '../runtime/rest-market-read.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';

const operation = 'read.stock-screen', tool = 'quote_stock_screen';
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-screen' };
const candidate = sha('stock-screen-runtime-fixture');
const operator = generateKeyPairSync('ed25519'), integration = generateKeyPairSync('ed25519');
const keys = Object.fromEntries(Object.entries({ operator, integration }).map(([role, pair]) => [role, {
  role, principal: role, runtime: role, publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
}]));
const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
  privateKey: integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const descriptor = { name: tool, description: 'Local stock-screen fixture', inputSchema: { type: 'object' } };
const restOrigin = 'https://webapi.moomoo.com', mcpOrigin = 'https://fixture.invalid/mcp';
const utc = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
function provider(kind, expiry) {
  const rest = kind === 'REST', mapping = rest ? researchMapping : stockScreenMcpMapping;
  return { schema: 'trading-provider-definition/v1', provider: 'screen-fixture', adapter_version: '1', mapping,
    transport: { kind, origin: rest ? restOrigin + '/' : mcpOrigin, protocol: mapping.protocol },
    adapter_digest: sha(kind), mapping_digest: sha(mapping), schema_digest: rest ? mapping.operations[operation].schema_digest : sha(descriptor),
    operations: [operation], allowlist: [tool], source: 'PROVIDER', mode: 'account', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('fixture-' + kind), expires_utc: expiry } };
}

test('REST permits the reviewed stock-screen POST alone', async () => {
  const definition = provider('REST', utc(Date.now() + 3600000));
  const spec = definition.mapping.operations[operation];
  for (const [op, delta] of [[operation, { path: '/api/v1.0/accounts/fixture/orders' }], [operation, { tool: 'other' }],
    [operation, { pin_inputs: false }], ['read.rank', {}]]) {
    const mapping = { protocol: '1.0', operations: { [op]: { ...spec, ...delta } } };
    assert.throws(() => createRestMarketReadAdapter({ provider: { ...definition, mapping, mapping_digest: sha(mapping) },
      token: 'fixture-rest-token', scope, candidate, attestation, mapping }), /INVALID_MAPPING/);
  }
  const adapter = createRestMarketReadAdapter({ provider: { ...definition,
    transport: { ...definition.transport, origin: 'https://fixture.invalid/' } }, token: 'fixture-rest-token',
    scope, candidate, attestation, mapping: definition.mapping });
  await assert.rejects(adapter.open({ grant: { mapping_digest: definition.mapping_digest,
    tools: [{ operation, name: tool, effect: 'read', schema_digest: spec.schema_digest }] } }), /INVALID_MAPPING/);
});

test('running gateway serves the same stock screen through both reviewed transports and replays each request', async t => {
  const expiry = utc(Date.now() + 3600000), transports = ['REST', 'MCP'];
  const definitions = transports.map(kind => provider(kind, expiry));
  const capabilities = definitions.map(({ schema, mapping, transport, ...identity }) => ({
    ...identity, transport: transport.kind, protocol: transport.protocol,
  }));
  const audience = 'fixture-local-audience-stock-screen';
  const directory = await mkdtemp(join(tmpdir(), 'stock-screen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ schema: 'trading-runtime-config/v1', scope, candidate, keys,
    database: 'local.sqlite', viewer_token: 'local-example-viewer-for-screen-fixture', providers: definitions,
    provider_credentials: { 'screen-fixture': { transports: Object.fromEntries(transports.map(kind =>
      [kind, { token: 'fixture-credential-' + kind, attestation }])) } }, gateway: { audience_token: audience, capabilities } }), { mode: 0o600 });
  const fixture = { ret_code: 0, data: { items: [{ code: 'HK.00700', name: 'Example',
    results: [{ simple_property_result: { property: { name: 2301 }, res: { result_type: 2, ival: '9007199254740993' } } }] }] },
    pagination: { total: 8, has_more: true, next_key: '17' } };
  const network = globalThis.fetch, calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return network(url, options);
    const body = JSON.parse(options.body);
    const rest = String(url) === restOrigin + '/api/v1.0/quote/stock-screen';
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-credential-' + (rest ? 'REST' : 'MCP'));
    if (!rest) assert.equal(String(url), mcpOrigin);
    calls.push(rest ? 'REST' : body.method);
    const rpc = result => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return rpc({ protocolVersion: stockScreenMcpMapping.protocol, capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return rpc({ tools: [descriptor] });
    if (!rest) assert.equal(body.params.name, tool);
    assert.deepEqual(rest ? body : body.params.arguments, { screen_queries: [{ simple_field_query: { simple_field: 1, screen_value_list: [1] } }],
      retrieve_queries: [{ simple_property: { name: 2301 } }], limit: 1 });
    return rest ? Response.json(fixture) : rpc({ content: [{ type: 'text', text: JSON.stringify(fixture) }] });
  });
  const server = await runtimeCommand(['gateway', path, '0']);
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function post(route, payload) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.ok(response.ok); return response.json();
  }
  for (const capability of capabilities) {
    const parameters = { market: 'HK', factors: ['market_cap'], limit: 1 };
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 2000), expires_utc: expiry, nonce: 'fixture-' + capability.transport,
      mapping_digest: capability.mapping_digest, tools: [{ operation, name: tool, schema_digest: capability.schema_digest,
        effect: 'read', inputs_digest: sha(parameters) }], limits: { max_calls: 4, timeout_ms: 10000 },
      proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: expiry })),
      cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 8 } };
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    const request = { contract_version: '1', operation, scope, capability_digest: sha(capability), request_id: 'screen-' + capability.transport,
      inputs: { ...parameters, grant }, deadline_utc: utc(Date.now() + 60000) };
    const result = await post('/api/gateway', request);
    assert.equal(result.status, 'OK', JSON.stringify(result.error));
    assert.deepEqual(result.data.rows, [{ symbol: 'HK.00700', name: 'Example',
      factors: [{ factor: 'market_cap', raw: '9007199254740993', value: '9007199254740.993' }] }]);
    assert.deepEqual(result.data.pagination, { total: 8, completed: false, next_cursor: '17' });
    const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: operation, arguments: request } });
    assert.deepEqual(replay.result.structuredContent, result);
    const refusal = await post('/api/gateway', { ...request, request_id: request.request_id + '-changed',
      inputs: { ...request.inputs, next_key: '17' } });
    assert.equal(refusal.error.code, 'UNAUTHORIZED');
  }
  assert.deepEqual(calls, ['REST', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});
