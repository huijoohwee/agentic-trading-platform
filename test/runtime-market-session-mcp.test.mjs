import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonical, sha } from '../runtime/core.mjs';
import { createMcpMarketReadAdapter } from '../runtime/mcp-market-read.mjs';
import { marketPage, marketRestSpecs, sessionMcpSpecs } from '../runtime/moomoo-market-rest.mjs';
import { researchMcpMapping } from '../runtime/moomoo-research.mjs';
import { fixtureTransport } from './research-mcp-fixture.mjs';

const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-sessions' };
const candidate = sha('session-example'), keys = generateKeyPairSync('ed25519');
const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
  privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const expiry = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const base = { schema: 'trading-provider-definition/v1', provider: 'sessions-fixture', adapter_version: '1',
  adapter_digest: sha('local-sessions'), source: 'PROVIDER', mode: 'account', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('local sessions'), expires_utc: expiry },
  transport: { kind: 'MCP', origin: 'https://sessions-fixture.invalid/mcp', protocol: researchMcpMapping.protocol } };
function setup(op, response, spec = sessionMcpSpecs[op]) {
  const mapping = { protocol: researchMcpMapping.protocol, operations: { [op]: spec } };
  const descriptor = { name: spec.tool, inputSchema: { type: 'object' } };
  const provider = { ...base, operations: [op], allowlist: [spec.tool], mapping, mapping_digest: sha(mapping), schema_digest: sha(descriptor) };
  const transport = fixtureTransport(descriptor, { structuredContent: response });
  const adapter = createMcpMarketReadAdapter({ provider, scope, candidate, token: 'local-session-fixture', attestation, mapping, fetchImpl: transport.fetchImpl });
  return { adapter, calls: transport.calls, grant(parameters) {
    return { mapping_digest: sha(mapping), cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 4 }, tools: [{ name: spec.tool, operation: op, effect: 'read', schema_digest: sha(descriptor), inputs_digest: sha(parameters) }],
      issued_utc: new Date(Date.now() - 10000).toISOString().replace(/\.\d{3}Z$/, 'Z'), expires_utc: expiry, limits: { max_calls: 4 },
      proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind), expires_utc: expiry })) };
  } };
}

test('session MCP calls bind the signed selectors and reuse the REST projection for camel-case wire fields', async () => {
  for (const [op, inputs, args, mcp, rest] of [
    ['read.market-state', { symbol: 'US.DIA', is_contain_overnight: true }, { code_list: ['US.DIA'], is_contain_overnight: true },
      { marketStateList: [{ code: 'US.DIA', marketState: 'OVERNIGHT', tradedSeconds: '003' }] },
      { market_state_list: [{ code: 'US.DIA', market_state: 'OVERNIGHT', traded_seconds: '003' }] }],
    ['read.trading-days', { market: 'HK', start: '2025-12-24', end: '2025-12-24' }, { market: 'HK', start: '2025-12-24', end: '2025-12-24' },
      { tradingDays: [{ time: '2025-12-24', tradeDateType: 'MORNING', tradeSecond: 14400 }] },
      { trading_days: [{ time: '2025-12-24', trade_date_type: 'MORNING', trade_second: 14400 }] }],
  ]) {
    const { adapter, grant, calls } = setup(op, { retCode: 0, data: mcp });
    const signed = grant(inputs), allowed = signed.tools[0];
    assert.throws(() => adapter.validateInputs(op, { ...inputs, unexpected: true }, allowed), /SCOPE_DENIED/);
    assert.throws(() => adapter.validateInputs(op, inputs, { ...allowed, inputs_digest: undefined }), /SCOPE_DENIED/);
    assert.equal(calls.length, 0);
    adapter.validateInputs(op, inputs, allowed);
    await adapter.open({ grant: signed, operation: op, inputs });
    const envelope = await adapter.read({ operation: op, inputs });
    assert.deepEqual(calls.at(-1).body.params.arguments, args);
    assert.equal(calls.length, 4);
    assert.deepEqual(envelope.payload.rows, marketPage(marketRestSpecs[op], inputs, JSON.stringify({ ret_code: 0, data: rest })).rows);
    assert.ok(verify(null, Buffer.from(canonical(envelope.payload)), keys.publicKey, Buffer.from(envelope.signature, 'base64url')));
  }
});
test('MCP calendar admission uses the tool-specific market enum and rejects substituted mappings', () => {
  const op = 'read.trading-days', inputs = { market: 'KR', start: '2025-12-01', end: '2025-12-03' };
  const { adapter, grant, calls } = setup(op, {});
  assert.throws(() => adapter.validateInputs(op, inputs, grant(inputs).tools[0]), /INVALID_PARAMETER/);
  for (const spec of [{ ...sessionMcpSpecs[op], tool: 'quote_market_state' }, { tool: 'custom', rows_path: [] }])
    assert.throws(() => setup(op, {}, spec), /INVALID_MAPPING/);
  assert.throws(() => setup('read.depth', {}, sessionMcpSpecs[op]), /INVALID_MAPPING/);
  assert.equal(calls.length, 0);
});
