import { createPrivateKey, sign } from 'node:crypto';
import { listReviewedTools, ownPath, rpcResponse } from './mcp-read.mjs';
import { validateProviderDefinition } from './provider-mapping.mjs';
import { boundedJson, canonical, current, fail, id, requireProofs, requireThat, scopeKey, sha } from './core.mjs';

// Labelled provider adapter for operation-shaped market reads. It shares the sheet adapter's
// transport owner (endpoint/protocols/ownPath/rpcResponse) and never exposes raw provider tools:
// the reviewed private mapping binds each native operation to one read-only tool and projection.
export const MARKET_READ_OPERATIONS = ['read.catalog', 'read.candles', 'read.ticker', 'read.depth', 'read.tape', 'read.calendar', 'read.capital-flow', 'read.rank',
  'read.plate', 'read.ipo', 'read.news', 'read.research', 'read.financials', 'read.corporate-actions', 'read.holders',
  'read.financial-statements', 'read.influencer', 'read.macro', 'read.derivatives', 'read.option-chain', 'read.option-expiries', 'read.option-events',
  'read.etf', 'read.event-contract', 'read.crypto-market',
  'read.valuation', 'read.short', 'read.stock-connect', 'read.top-brokers', 'read.chip', 'read.cbbc'];
const writeBan = /(?:place|submit|cancel|modify|withdraw|transfer|unlock|reset|delete|amend)(?:_|$)/i;
const decimalPattern = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

export function createMcpMarketReadAdapter({ provider, token, mapping, attestation, scope, candidate, fetchImpl = fetch, now = Date.now }) {
  const { definition } = validateProviderDefinition(provider);
  const endpoint = definition.transport.origin;
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  requireThat(typeof token === 'string' && token.length >= 16 && !/[\r\n]/.test(token), 'READ_CREDENTIAL_REQUIRED');
  requireThat(id(attestation?.key_id) && id(attestation.principal) && id(attestation.runtime), 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(attestation.privateKey);
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'ATTESTATION_REQUIRED');
  requireThat(mapping?.protocol === definition.transport.protocol && mapping.operations && typeof mapping.operations === 'object', 'INVALID_MAPPING');
  for (const [operation, spec] of Object.entries(mapping.operations)) {
    requireThat(MARKET_READ_OPERATIONS.includes(operation) && id(spec.tool) && Array.isArray(spec.rows_path), 'INVALID_MAPPING');
    requireThat(!writeBan.test(spec.tool), 'SCOPE_DENIED');
  }
  let session, version, sequence = 0, calls = 0, grant, beforeCall;
  const issue = (kind, data) => {
    const issued_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate, principal: attestation.principal,
      runtime: attestation.runtime, issued_utc, expires_utc: grant.expires_utc, ...data };
    return { key_id: attestation.key_id, payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url') };
  };
  async function rpc(method, params, signal, notification = false) {
    beforeCall?.();
    requireThat(!signal?.aborted, 'TIMEOUT');
    requireThat(grant.revoked !== true, 'REVOKED');
    requireProofs(grant, ['cost', 'rights', 'account'], now());
    requireThat(current(grant, now()) && calls < grant.limits.max_calls, 'BUDGET_HALT');
    calls++;
    const requestId = ++sequence;
    const body = { jsonrpc: '2.0', ...(!notification && { id: requestId }), method, ...(params && { params }) };
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      ...(session && { 'Mcp-Session-Id': session }), ...(version && { 'MCP-Protocol-Version': version }) };
    let response;
    try { response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' }); }
    catch { fail(signal?.aborted ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'); }
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); fail('SCOPE_DENIED'); }
    requireThat(response.ok && !response.redirected, 'PROVIDER_UNAVAILABLE');
    if (method === 'initialize') {
      session = response.headers.get('mcp-session-id') ?? undefined;
      requireThat(!session || /^[\x21-\x7e]{1,256}$/.test(session), 'INVALID_SESSION');
    }
    if (notification) { requireThat(response.status === 202, 'INVALID_RESPONSE'); await response.body?.cancel(); return; }
    return rpcResponse(response, requestId);
  }
  const project = (raw, spec) => {
    if (!spec.fields) return boundedJson(raw);
    const row = {}, precise = {};
    for (const [target, projection] of Object.entries(spec.fields)) {
      requireThat(id(target) && !['__proto__', 'prototype', 'constructor'].includes(target), 'INVALID_MAPPING');
      const value = Object.hasOwn(projection, 'constant') ? projection.constant : ownPath(raw, projection.path);
      if (spec.numeric?.includes(target)) {
        requireThat(!Object.hasOwn(projection, 'constant'), 'PRECISION_UNKNOWN');
        let text;
        if (typeof value === 'string') { requireThat(value.length <= 64 && decimalPattern.test(value), 'PRECISION_UNKNOWN'); text = value; }
        else if (typeof value === 'number' && Number.isFinite(value)) { text = String(value); requireThat(decimalPattern.test(text), 'PRECISION_UNKNOWN'); }
        else fail('PRECISION_UNKNOWN');
        const number = Number(text);
        requireThat(Number.isFinite(number), 'PRECISION_UNKNOWN');
        precise[target] = text;
        row[target] = number;
      } else row[target] = value;
    }
    return { row, precise };
  };
  return {
    async open({ grant: admitted, signal, beforeCall: revalidate }) {
      requireThat(admitted.mapping_digest === sha(mapping), 'MAPPING_DRIFT');
      grant = admitted; beforeCall = revalidate; session = undefined; version = undefined; calls = 0;
      const initialized = await rpc('initialize', { protocolVersion: mapping.protocol, capabilities: {},
        clientInfo: { name: 'trading-market-read-boundary', version: '1.0.0' } }, signal);
      requireThat(initialized?.protocolVersion === mapping.protocol && initialized.capabilities?.tools, 'PROTOCOL_UNQUALIFIED');
      version = initialized.protocolVersion;
      await rpc('notifications/initialized', null, signal, true);
      const listed = await listReviewedTools(rpc, grant.tools, grant.limits.max_calls - calls - 1, signal);
      for (const allowed of grant.tools) {
        const spec = mapping.operations[allowed.operation];
        const descriptor = listed.get(allowed.name);
        requireThat(spec && descriptor && sha(descriptor) === allowed.schema_digest && spec.tool === allowed.name && allowed.effect === 'read', 'SCHEMA_DRIFT');
        requireThat(!writeBan.test(allowed.name), 'SCOPE_DENIED');
      }
      return issue('read-capabilities', { tools: grant.tools, calls });
    },
    async read({ operation, inputs, signal }) {
      const spec = mapping.operations[operation], allowed = grant.tools.find(tool => tool.operation === operation);
      requireThat(grant && spec && allowed, 'SCOPE_DENIED');
      const parameters = boundedJson(spec.parameters ?? {});
      for (const [parameter, inputKey] of Object.entries(spec.input_map ?? {})) {
        requireThat(id(parameter) && id(inputKey) && Object.hasOwn(inputs, inputKey), 'SOURCE_MAPPING_REQUIRED');
        const value = inputs[inputKey];
        parameters[parameter] = spec.array_parameters?.includes(parameter) ? [value] : value;
      }
      const response = await rpc('tools/call', { name: allowed.name, arguments: parameters }, signal);
      requireThat(!response.isError, 'PROVIDER_ERROR');
      let source = response.structuredContent;
      if (source === undefined) {
        requireThat(response.content?.length === 1 && response.content[0].type === 'text', 'SOURCE_MAPPING_REQUIRED');
        try { source = JSON.parse(response.content[0].text); } catch { fail('SOURCE_MAPPING_REQUIRED'); }
      }
      const raw = ownPath(source, spec.rows_path);
      const decimals = [];
      let rows;
      if (spec.object_result) {
        requireThat(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_PAGE');
        const { row, precise } = project(raw, spec);
        rows = row; decimals.push(precise);
      } else {
        requireThat(Array.isArray(raw) && raw.length <= 600, 'INVALID_PAGE');
        rows = raw.map(item => { const { row, precise } = project(item, spec); decimals.push(precise); return row; });
      }
      const response_digest = sha(response);
      const observed_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
      const precision = {};
      if (operation === 'read.ticker' && decimals.length === 1 && typeof decimals[0]?.price === 'string') {
        const wirePrice = ownPath(spec.object_result ? raw : raw[0], spec.fields.price.path);
        precision.price_source = typeof wirePrice === 'string' ? 'decimal-string' : 'json-number';
      }
      return issue('provider-market-page', { operation, rows, decimals, observed_utc,
        ...precision, source_event: 'market-' + sha({ operation, response_digest }), response_digest, schema_digest: allowed.schema_digest });
    },
  };
}
