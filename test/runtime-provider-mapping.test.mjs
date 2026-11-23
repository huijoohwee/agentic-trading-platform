import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { openStore } from '../runtime/store.mjs';
import { createGateway } from '../runtime/gateway.mjs';
import { createProviderRegistry, validateProviderDefinition, MCP_PROTOCOLS } from '../runtime/provider-mapping.mjs';

// Outbound provider-mapping conformance (VCC-36/37, R-GW). These are generated MOCK definitions and
// grants; they prove the reviewed registry binds fail-closed and isolates providers, and qualify no
// live endpoint, credential or account.
const at = '2026-11-20T15:00:00Z', now = () => Date.parse(at), candidate = sha('provider-mapping-test');
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-practice' };
const mappingA = { protocol: '2025-11-25', operations: { 'read.candles': { tool: 'read_candles', rows_path: ['data'] } } };
const mappingB = { protocol: '2025-11-25', operations: { 'read.candles': { tool: 'read_candles_b', rows_path: ['data'] } } };
const definition = (overrides = {}) => ({ schema: 'trading-provider-definition/v1', provider: 'provider-a', adapter_version: '1',
  transport: { kind: 'MCP', origin: 'https://a.example/mcp', protocol: '2025-11-25' }, adapter_digest: sha('adapter-a'),
  schema_digest: sha('schema-a'), mapping_digest: sha(mappingA), mapping: mappingA, operations: ['read.candles'], allowlist: ['read_candles'],
  mode: 'account', source: 'PROVIDER', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt-a'), expires_utc: '2026-11-20T16:00:00Z' }, ...overrides });
const capability = (def, overrides = {}) => ({ provider: def.provider, adapter_version: def.adapter_version, adapter_digest: def.adapter_digest,
  schema_digest: def.schema_digest, mapping_digest: def.mapping_digest, transport: def.transport.kind, protocol: def.transport.protocol,
  source: def.source, mode: def.mode, operations: [...def.operations], allowlist: [...def.allowlist],
  cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('cap-receipt'), expires_utc: '2026-11-20T16:00:00Z' }, ...overrides });
const distinctB = () => definition({ provider: 'provider-b', transport: { kind: 'MCP', origin: 'https://b.example/mcp', protocol: '2025-11-25' },
  adapter_digest: sha('adapter-b'), schema_digest: sha('schema-b'), mapping_digest: sha(mappingB), mapping: mappingB,
  allowlist: ['read_candles_b'], qualification: { status: 'QUALIFIED', receipt_digest: sha('receipt-b'), expires_utc: '2026-11-20T16:00:00Z' } });
const mappingRest = { protocol: '1.0', operations: { 'read.candles': { path: '/v1/candles', rows_path: ['data'] } } };
const restDefinition = () => definition({ transport: { kind: 'REST', origin: 'https://a.example/rest', protocol: '1.0' },
  adapter_digest: sha('adapter-a-rest'), schema_digest: sha('schema-a-rest'), mapping_digest: sha(mappingRest), mapping: mappingRest,
  allowlist: ['read_candles_rest'] });

test('a reviewed definition binds its capability and discovery exposes metadata only', () => {
  const def = definition(), registry = createProviderRegistry([def]);
  const binding = registry.bind(capability(def));
  assert.equal(binding.definition_digest, sha(def));
  assert.deepEqual(binding.mapping, mappingA);
  assert.equal(registry.size, 1);
  const [metadata] = registry.discover();
  assert.equal(metadata.provider, 'provider-a');
  assert.deepEqual(metadata.transport, { kind: 'MCP', protocol: '2025-11-25' });
  assert.equal(metadata.mapping, undefined);
  assert.equal(JSON.stringify(registry.discover()).includes('a.example'), false);
});

test('each provider is admitted once with isolated adapter/schema/mapping/origin pins', () => {
  assert.throws(() => createProviderRegistry([definition(), definition()]), /DUPLICATE_PROVIDER/);
  const sharedAdapter = distinctB(); sharedAdapter.adapter_digest = sha('adapter-a');
  assert.throws(() => createProviderRegistry([definition(), sharedAdapter]), /PROVIDER_ISOLATION/);
  const sharedSchema = distinctB(); sharedSchema.schema_digest = sha('schema-a');
  assert.throws(() => createProviderRegistry([definition(), sharedSchema]), /PROVIDER_ISOLATION/);
  const sharedMapping = distinctB(); sharedMapping.mapping = mappingA; sharedMapping.mapping_digest = sha(mappingA);
  assert.throws(() => createProviderRegistry([definition(), sharedMapping]), /PROVIDER_ISOLATION/);
  const sharedOrigin = distinctB(); sharedOrigin.transport = { kind: 'MCP', origin: 'https://a.example/mcp', protocol: '2025-11-25' };
  assert.throws(() => createProviderRegistry([definition(), sharedOrigin]), /PROVIDER_ISOLATION/);
  assert.equal(createProviderRegistry([definition(), distinctB()]).size, 2);
});

test('capability pin drift and widening refuse typed before dispatch', () => {
  const def = definition(), registry = createProviderRegistry([def]);
  assert.throws(() => registry.bind(capability(def, { provider: 'absent' })), /PROVIDER_UNKNOWN/);
  assert.throws(() => registry.bind(capability(def, { adapter_digest: sha('other') })), /ADAPTER_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { adapter_version: '2' })), /ADAPTER_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { schema_digest: sha('other') })), /SCHEMA_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { mapping_digest: sha('other') })), /MAPPING_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { protocol: '2025-06-18' })), /PROTOCOL_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { transport: 'HTTP' })), /PROTOCOL_DRIFT/);
  assert.throws(() => registry.bind(capability(def, { operations: ['read.candles', 'read.tape'] })), /UNSUPPORTED/);
  assert.throws(() => registry.bind(capability(def, { allowlist: ['read_candles', 'place_order'] })), /SCOPE_DENIED/);
  assert.throws(() => registry.bind(capability(def, { source: 'MOCK' })), /UNSUPPORTED/);
  assert.throws(() => registry.bind(capability(def, { mode: 'public' })), /UNSUPPORTED/);
  assert.ok(registry.bind(capability(def, { operations: ['read.candles'], allowlist: ['read_candles'] })));
});

test('the outbound origin is pinned https without userinfo, query, fragment or whitespace', () => {
  const origin = value => definition({ transport: { kind: 'MCP', origin: value, protocol: '2025-11-25' } });
  for (const bad of ['http://a.example/mcp', 'https://user:pass@a.example/mcp', 'https://a.example/mcp?x=1',
    'https://a.example/mcp#f', 'https://a.example/mcp ', 'not-a-url']) {
    assert.throws(() => validateProviderDefinition(origin(bad)), /INVALID_TRANSPORT_PIN/);
  }
  assert.throws(() => validateProviderDefinition(definition({ transport: { kind: 'HTTP', origin: 'https://a.example/mcp', protocol: '2025-11-25' } })), /INVALID_TRANSPORT_PIN/);
  assert.throws(() => validateProviderDefinition(definition({ transport: { kind: 'MCP', origin: 'https://a.example/mcp', protocol: '1999-01-01' } })), /INVALID_TRANSPORT_PIN/);
  assert.ok(MCP_PROTOCOLS.includes('2025-11-25'));
  assert.ok(validateProviderDefinition(origin('https://a.example/mcp')));
});

test('definition validation fails closed on mapping drift, cost, source and shape', () => {
  assert.throws(() => validateProviderDefinition(definition({ mapping_digest: sha('other') })), /MAPPING_DRIFT/);
  assert.throws(() => validateProviderDefinition(definition({ cost: { hard_cap_usd: 5, deny_at_exhaustion: true } })), /BUDGET_HALT/);
  assert.throws(() => validateProviderDefinition(definition({ cost: { hard_cap_usd: 0, deny_at_exhaustion: false } })), /BUDGET_HALT/);
  assert.throws(() => validateProviderDefinition(definition({ source: 'MOCK' })), /UNSUPPORTED/);
  assert.throws(() => validateProviderDefinition(definition({ mode: 'public' })), /UNSUPPORTED/);
  assert.throws(() => validateProviderDefinition(definition({ operations: [] })), /INVALID_PROVIDER_DEFINITION/);
  assert.throws(() => validateProviderDefinition(definition({ operations: ['read.candles', 'read.candles'] })), /INVALID_PROVIDER_DEFINITION/);
  assert.throws(() => validateProviderDefinition({ ...definition(), extra: true }), /INVALID_PROVIDER_DEFINITION/);
  assert.throws(() => validateProviderDefinition(definition({ schema: 'other/v1' })), /INVALID_PROVIDER_DEFINITION/);
});

const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, { role, principal: role + '-fixture',
  runtime: role + '-fixture', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }]));
function readGrant(def, nonce = 'grant-one', tool = 'read_candles') {
  const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: keys.operator.principal,
    runtime: keys.operator.runtime, issued_utc: at, expires_utc: '2026-11-20T16:00:00Z', nonce, mapping_digest: def.mapping_digest,
    tools: [{ operation: 'read.candles', name: tool, effect: 'read', schema_digest: def.schema_digest }],
    limits: { max_calls: 12, timeout_ms: 1000 }, proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: '2026-11-20T16:00:00Z' })),
    cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 12 } };
  return { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), pairs.operator.privateKey).toString('base64url') };
}
async function gatewayFixture(t, { capabilities, providers }) {
  const directory = await mkdtemp(join(tmpdir(), 'trading-provider-'));
  const path = join(directory, 'state.sqlite'), store = openStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let dispatched = 0;
  const gateway = createGateway({ store, scope, candidate, capabilities, keys, audienceToken: 'fixture-audience-token-0000000000', providers,
    readers: { 'read.candles': async () => { dispatched++; return { source: 'AUTHENTICATED_ADAPTER', rows: [], decimals: [], cost: { tool_calls: 4 } }; } }, now });
  const request = (cap, adjust = {}) => ({ contract_version: '1', request_id: 'req-' + dispatched + '-' + Math.random().toString(16).slice(2),
    capability_digest: sha(cap), operation: 'read.candles', scope, inputs: { grant: readGrant(definition()) }, deadline_utc: '2026-11-20T15:05:00Z', ...adjust });
  return { gateway, request, dispatched: () => dispatched };
}

test('the gateway binds a PROVIDER capability to its reviewed definition and ledgers the binding', async t => {
  const def = definition(), cap = capability(def);
  const { gateway, request, dispatched } = await gatewayFixture(t, { capabilities: [cap], providers: createProviderRegistry([def]) });
  const admitted = await gateway.admit(request(cap), 'Bearer fixture-audience-token-0000000000');
  assert.equal(admitted.status, 'OK');
  assert.equal(admitted.provenance.source, 'PROVIDER');
  assert.equal(admitted.provenance.definition_digest, sha(def));
  assert.equal(dispatched(), 1);
});

test('a PROVIDER capability without a reviewed registry refuses before dispatch', async t => {
  const cap = capability(definition());
  const { gateway, request, dispatched } = await gatewayFixture(t, { capabilities: [cap], providers: null });
  const refused = await gateway.admit(request(cap), 'Bearer fixture-audience-token-0000000000');
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.error.code, 'UNQUALIFIED');
  assert.equal(dispatched(), 0);
});

test('registry pin drift and unknown providers refuse typed before dispatch', async t => {
  const def = definition();
  const drifted = capability(def, { schema_digest: sha('drifted') });
  const unknown = capability(definition({ provider: 'absent-provider' }));
  const { gateway, request, dispatched } = await gatewayFixture(t, { capabilities: [drifted, unknown], providers: createProviderRegistry([def]) });
  const drift = await gateway.admit(request(drifted), 'Bearer fixture-audience-token-0000000000');
  assert.equal(drift.status, 'REFUSED'); assert.equal(drift.error.code, 'SCHEMA_DRIFT');
  const absent = await gateway.admit(request(unknown), 'Bearer fixture-audience-token-0000000000');
  assert.equal(absent.status, 'REFUSED'); assert.equal(absent.error.code, 'UNQUALIFIED');
  assert.equal(dispatched(), 0);
});

test('distinct pinned MCP and REST bindings coexist for one provider', () => {
  const mcp = definition(), rest = restDefinition(), registry = createProviderRegistry([mcp, rest]);
  assert.equal(registry.size, 2);
  const mcpBinding = registry.bind(capability(mcp)), restBinding = registry.bind(capability(rest));
  assert.equal(mcpBinding.definition_digest, sha(mcp));
  assert.equal(restBinding.definition_digest, sha(rest));
  assert.equal(mcpBinding.transport.kind, 'MCP');
  assert.equal(restBinding.transport.kind, 'REST');
  assert.deepEqual(registry.discover().map(item => item.transport.kind).sort(), ['MCP', 'REST']);
  assert.throws(() => createProviderRegistry([rest, restDefinition()]), /DUPLICATE_PROVIDER/);
});

test('cross-transport pin reuse and unreviewed transports refuse typed', () => {
  const sharedAdapter = restDefinition(); sharedAdapter.adapter_digest = sha('adapter-a');
  assert.throws(() => createProviderRegistry([definition(), sharedAdapter]), /PROVIDER_ISOLATION/);
  const sharedOrigin = restDefinition(); sharedOrigin.transport = { kind: 'REST', origin: 'https://a.example/mcp', protocol: '1.0' };
  assert.throws(() => createProviderRegistry([definition(), sharedOrigin]), /PROVIDER_ISOLATION/);
  const registry = createProviderRegistry([definition(), restDefinition()]);
  // Isolation gives each transport its own adapter pin, so a cross-transport claim drifts typed before binding.
  assert.throws(() => registry.bind(capability(definition(), { transport: 'REST' })), /ADAPTER_DRIFT/);
  assert.throws(() => registry.bind(capability(restDefinition(), { transport: 'MCP' })), /ADAPTER_DRIFT/);
  const mcpOnly = createProviderRegistry([definition()]);
  assert.throws(() => mcpOnly.bind(capability(restDefinition())), /PROTOCOL_DRIFT/);
});

test('the gateway admits both transports of one provider with distinct definition ledgers', async t => {
  const mcp = definition(), rest = restDefinition();
  const { gateway, request, dispatched } = await gatewayFixture(t, { capabilities: [capability(mcp), capability(rest)], providers: createProviderRegistry([mcp, rest]) });
  const viaMcp = await gateway.admit(request(capability(mcp)), 'Bearer fixture-audience-token-0000000000');
  const viaRest = await gateway.admit(request(capability(rest), { inputs: { grant: readGrant(rest, 'grant-rest', 'read_candles_rest') } }), 'Bearer fixture-audience-token-0000000000');
  assert.equal(viaMcp.status, 'OK'); assert.equal(viaRest.status, 'OK');
  assert.equal(viaMcp.provenance.definition_digest, sha(mcp));
  assert.equal(viaRest.provenance.definition_digest, sha(rest));
  assert.equal(viaRest.ledger_revision, viaMcp.ledger_revision + 2);
  assert.equal(dispatched(), 2);
  const mcpOnly = await gatewayFixture(t, { capabilities: [capability(rest)], providers: createProviderRegistry([mcp]) });
  const refused = await mcpOnly.gateway.admit(mcpOnly.request(capability(rest), { inputs: { grant: readGrant(rest, 'grant-rest', 'read_candles_rest') } }), 'Bearer fixture-audience-token-0000000000');
  assert.equal(refused.status, 'REFUSED'); assert.equal(refused.error.code, 'SCHEMA_DRIFT');
  assert.equal(mcpOnly.dispatched(), 0);
});
