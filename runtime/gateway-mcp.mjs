import { boundedJson, id, requireThat } from './core.mjs';

const PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const SEMANTIC_SCHEMA = {
  type: 'object',
  properties: {
    contract_version: { type: 'string', const: '1' },
    request_id: { type: 'string' },
    capability_digest: { type: 'string', description: 'sha256 of the reviewed capability record' },
    operation: { type: 'string' },
    scope: { type: 'object', properties: { environment: { type: 'string' }, profile: { type: 'string' }, account_alias: { type: 'string' } },
      required: ['environment', 'profile', 'account_alias'], additionalProperties: false },
    inputs: { type: 'object' },
    deadline_utc: { type: 'string', description: 'exclusive UTC dispatch cutoff' },
  },
  required: ['contract_version', 'request_id', 'capability_digest', 'operation', 'scope', 'inputs', 'deadline_utc'],
  additionalProperties: false,
};
const rpcError = (requestId, code, message) => ({ jsonrpc: '2.0', id: requestId ?? null, error: { code, message } });

// Inward MCP frontend. Tools encode the same semantic request as the API frontend and call the same
// admission boundary, so decisions, refusals and ledger revisions are identical across transports.
export function createGatewayMcp({ gateway }) {
  requireThat(gateway?.admit && gateway?.discover && gateway?.authenticate, 'GATEWAY_REQUIRED');
  const tools = () => {
    const operations = [...new Set(gateway.discover().flatMap(record => record.operations))];
    return operations.map(operation => ({ name: operation, description: `Semantic ${operation} over reviewed capabilities`, inputSchema: SEMANTIC_SCHEMA }));
  };
  async function callTool(params, authorization) {
    const name = params?.name, request = boundedJson(params?.arguments ?? {});
    if (!id(name) || request.operation !== name) {
      const refused = { request_id: id(request.request_id) ? request.request_id : null, status: 'REFUSED', error: { code: 'UNSUPPORTED' }, provenance: null, ledger_revision: null };
      return { content: [{ type: 'text', text: JSON.stringify(refused) }], structuredContent: refused, isError: true };
    }
    let result;
    try { result = await gateway.admit(request, authorization); }
    catch (error) { result = { request_id: id(request.request_id) ? request.request_id : null, status: 'REFUSED', error: { code: error.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'UNQUALIFIED' }, provenance: null, ledger_revision: null }; }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.status === 'REFUSED' };
  }
  return Object.freeze({
    protocols: [...PROTOCOLS],
    async handle(message, authorization) {
      let msg;
      try { msg = boundedJson(message); } catch { return rpcError(null, -32700, 'Parse error'); }
      if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
      const isRequest = Object.hasOwn(msg, 'id');
      if (!gateway.authenticate(authorization)) return isRequest ? rpcError(msg.id, -32001, 'UNAUTHORIZED') : null;
      if (!isRequest) return null;
      switch (msg.method) {
        case 'initialize': {
          const requested = msg.params?.protocolVersion;
          const protocolVersion = PROTOCOLS.includes(requested) ? requested : PROTOCOLS[PROTOCOLS.length - 1];
          return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'trading-gateway', version: '1.0.0' } } };
        }
        case 'ping': return { jsonrpc: '2.0', id: msg.id, result: {} };
        case 'tools/list': return { jsonrpc: '2.0', id: msg.id, result: { tools: tools() } };
        case 'tools/call': return { jsonrpc: '2.0', id: msg.id, result: await callTool(msg.params, authorization) };
        default: return rpcError(msg.id, -32601, 'Method not found');
      }
    },
  });
}