import assert from 'node:assert/strict';
import fields from 'agentic-gateway/connectors/moomoo-fields.json' with { type: 'json' };
import { sha } from '../runtime/core.mjs';
import { createMarketReadBoundary } from '../runtime/market-ingestion.mjs';
import { createMcpMarketReadAdapter } from '../runtime/mcp-market-read.mjs';
import { researchMcpMapping, researchMapping } from '../runtime/moomoo-research.mjs';
import { researchTools } from '../src/moomoo-research-tools.mjs';

const origin = 'https://research-fixture.invalid/mcp';
export function mcpDefinition(base, operation) {
  const tool = researchTools[operation];
  const descriptor = { name: tool, inputSchema: { type: 'object' }, description: 'Local fixture for ' + operation };
  const provider = { ...base, operations: [operation], allowlist: [tool], mapping: researchMcpMapping,
    mapping_digest: sha(researchMcpMapping), schema_digest: sha(descriptor),
    transport: { kind: 'MCP', origin, protocol: researchMcpMapping.protocol } };
  return { descriptor, provider };
}
export function fixtureTransport(descriptor, result) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const rpc = value => Response.json({ jsonrpc: '2.0', id: body.id, result: value });
    if (body.method === 'initialize') return rpc({ protocolVersion: researchMcpMapping.protocol, capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return rpc({ tools: [descriptor] });
    if (body.method === 'tools/call') return rpc(result);
    throw new Error('Unexpected fixture method ' + body.method);
  };
  return { calls, fetchImpl };
}
function camelFields(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(camelFields);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), camelFields(item)]));
}
export async function compareResearchTransports(runRest, context) {
  const { operation, inputs, permittedInputs, response, definition, restCalls, grant, ...boundaryOptions } = context;
  if (!Object.hasOwn(researchTools, operation)) return runRest();
  let rest, error;
  try { rest = await runRest(); } catch (caught) { error = caught; }
  const { provider, descriptor } = mcpDefinition(definition, operation);
  const payload = camelFields(response);
  const fake = fixtureTransport(descriptor, operation === 'read.news' ? { content: [{ type: 'text', text: JSON.stringify(payload) }] } :
    { structuredContent: payload });
  const adapter = createMcpMarketReadAdapter({ ...boundaryOptions, provider, mapping: provider.mapping,
    token: 'local-research-fixture', fetchImpl: fake.fetchImpl });
  const permit = grant('research-mcp', 'research-mcp', { mapping_digest: provider.mapping_digest, tools: [
    { operation, name: descriptor.name, effect: 'read', schema_digest: sha(descriptor), inputs_digest: sha(permittedInputs) }] });
  const runMcp = () => createMarketReadBoundary({ ...boundaryOptions, adapter })({ operation, inputs, grant: permit });
  if (error) await assert.rejects(runMcp, { message: error.message });
  else {
    const result = await runMcp();
    for (const name of ['rows', 'decimals', 'pagination', 'last_valid_time_ms', 'observed_utc']) {
      assert.deepEqual(result[name], rest[name], operation + ' ' + name);
    }
    assert.equal(result.cost.tool_calls, 4);
  }
  if (restCalls.length) {
    assert.deepEqual(fake.calls.map(call => call.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    const { name, arguments: args } = fake.calls.at(-1).body.params;
    assert.equal(name, descriptor.name);
    const params = new URL(restCalls[0].url).searchParams;
    const publicFields = fields.tools.find(entry => entry.name === name).params;
    const expected = Object.fromEntries(Array.from(params, ([key, value]) =>
      [key, publicFields.find(field => field.name === key).type === 'int' ? Number(value) : value]));
    if (researchMapping.operations[operation].symbol_path) expected.symbol = inputs.symbol;
    assert.deepEqual(args, expected);
  } else assert.equal(fake.calls.length, 0);
  if (error) throw error;
  return rest;
}
