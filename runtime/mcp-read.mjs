import { createHmac, createPrivateKey, sign } from 'node:crypto';
import { SHEETS } from './ingestion.mjs';
import { boundedJson, canonical, current, fail, id, requireProofs, requireThat, scopeKey, sha } from './core.mjs';

export const endpoint = 'https://mcp.moomoo.com/mcp';
export const protocols = ['2025-03-26', '2025-06-18', '2025-11-25'];
const numbers = new Set(['last', 'prev_close', 'qty', 'avg_cost', 'cash', 'total_assets', 'limit_price', 'filled_qty', 'avg_fill_price']);
export const ownPath = (object, path) => {
  requireThat(Array.isArray(path) && path.length > 0 && path.length <= 12, 'INVALID_MAPPING');
  let value = object;
  for (const key of path) {
    requireThat(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key) &&
      value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'SOURCE_MAPPING_REQUIRED');
    value = value[key];
  }
  return value;
};
export async function rpcResponse(response, requestId) {
  const type = response.headers.get('content-type')?.split(';')[0];
  requireThat(['application/json', 'text/event-stream'].includes(type), 'INVALID_RESPONSE');
  const reader = response.body?.getReader();
  requireThat(reader, 'INVALID_RESPONSE');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffer = '';
  const check = text => {
    let message;
    try { message = JSON.parse(text); } catch { fail('INVALID_RESPONSE'); }
    requireThat(message?.jsonrpc === '2.0', 'INVALID_RESPONSE');
    if (message.method === 'notifications/tools/list_changed') fail('SCHEMA_DRIFT');
    if (message.method && Object.hasOwn(message, 'id')) fail('SERVER_REQUEST_DENIED');
    if (message.id !== requestId) return null;
    requireThat(!message.error && Object.hasOwn(message, 'result'), 'PROVIDER_ERROR');
    return { result: message.result };
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      requireThat(bytes <= 480_000, 'INPUT_TOO_LARGE');
      buffer += decoder.decode(part.value, { stream: true });
      if (type === 'text/event-stream') {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { const found = check(data); if (found) return found.result; }
        }
      }
    }
    buffer += decoder.decode();
    requireThat(type === 'application/json', 'INCOMPLETE_RESPONSE');
    const found = check(buffer);
    requireThat(found, 'RESPONSE_ID_MISMATCH');
    return found.result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createMcpReadAdapter({ token, mapping, attestation, aliasSecret, scope, candidate, fetchImpl = fetch, now = Date.now }) {
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  requireThat(typeof token === 'string' && token.length >= 16 && !/[\r\n]/.test(token), 'READ_CREDENTIAL_REQUIRED');
  requireThat(typeof aliasSecret === 'string' && aliasSecret.length >= 32, 'ALIAS_SECRET_REQUIRED');
  requireThat(id(attestation?.key_id) && id(attestation.principal) && id(attestation.runtime), 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(attestation.privateKey);
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'ATTESTATION_REQUIRED');
  requireThat(protocols.includes(mapping?.protocol) && SHEETS.every(sheet => mapping.sheets?.[sheet]), 'INVALID_MAPPING');
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
  return {
    async open({ grant: admitted, signal, beforeCall: revalidate }) {
      requireThat(admitted.mapping_digest === sha(mapping), 'MAPPING_DRIFT');
      grant = admitted; beforeCall = revalidate; session = undefined; version = undefined; calls = 0;
      const initialized = await rpc('initialize', { protocolVersion: mapping.protocol, capabilities: {},
        clientInfo: { name: 'trading-read-boundary', version: '1.0.0' } }, signal);
      requireThat(initialized?.protocolVersion === mapping.protocol && initialized.capabilities?.tools, 'PROTOCOL_UNQUALIFIED');
      version = initialized.protocolVersion;
      await rpc('notifications/initialized', null, signal, true);
      const listed = await rpc('tools/list', {}, signal);
      requireThat(Array.isArray(listed?.tools) && !listed.nextCursor, 'TOOL_CATALOG_INCOMPLETE');
      for (const allowed of grant.tools) {
        const descriptor = listed.tools.find(tool => tool.name === allowed.name);
        requireThat(descriptor && sha(descriptor) === allowed.schema_digest && mapping.sheets[allowed.sheet]?.tool === allowed.name, 'SCHEMA_DRIFT');
        requireThat(!/(?:place|submit|cancel|modify|withdraw|transfer|unlock|reset|delete|amend)(?:_|$)/i.test(allowed.name), 'SCOPE_DENIED');
      }
      return issue('read-capabilities', { tools: grant.tools, calls });
    },
    async read({ sheet, cursor, run_id, limit, signal }) {
      requireThat(grant && SHEETS.includes(sheet) && limit === 50, 'SCOPE_DENIED');
      const spec = mapping.sheets[sheet], allowed = grant.tools.find(tool => tool.sheet === sheet);
      const parameters = boundedJson(spec.parameters ?? {});
      if (cursor !== null) { requireThat(id(spec.cursor_parameter), 'UNSUPPORTED_PAGINATION'); parameters[spec.cursor_parameter] = cursor; }
      if (spec.limit_parameter) parameters[spec.limit_parameter] = limit;
      const response = await rpc('tools/call', { name: allowed.name, arguments: parameters }, signal);
      requireThat(!response.isError, 'PROVIDER_ERROR');
      let source = response.structuredContent;
      if (source === undefined) {
        requireThat(response.content?.length === 1 && response.content[0].type === 'text', 'SOURCE_MAPPING_REQUIRED');
        try { source = JSON.parse(response.content[0].text); } catch { fail('SOURCE_MAPPING_REQUIRED'); }
      }
      const rawRows = ownPath(source, spec.rows_path);
      requireThat(Array.isArray(rawRows) && rawRows.length <= 50, 'INVALID_PAGE');
      const decimals = [], rows = rawRows.map(raw => {
        if (sheet !== 'IN_Quotes') requireThat(canonical(ownPath(raw, spec.account_path)) === canonical(mapping.account_identity), 'ACCOUNT_BINDING');
        const row = { run_id }, precise = {};
        for (const [target, projection] of Object.entries(spec.fields)) {
          requireThat(id(target) && !['__proto__', 'prototype', 'constructor', 'run_id', 'account_alias', 'source_id'].includes(target), 'INVALID_MAPPING');
          let value = Object.hasOwn(projection, 'constant') ? projection.constant : ownPath(raw, projection.path);
          if (target === 'broker_order_id') value = 'order-' + createHmac('sha256', aliasSecret).update(canonical(value)).digest('hex');
          if (numbers.has(target) && !(sheet === 'IN_Orders' && target === 'avg_fill_price' && value === null)) {
            requireThat(!Object.hasOwn(projection, 'constant') && typeof value === 'string' && value.length <= 64 &&
              /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value), 'PRECISION_UNKNOWN');
            precise[target] = value; value = Number(value);
            requireThat(Number.isFinite(value), 'PRECISION_UNKNOWN');
          }
          row[target] = value;
        }
        if (sheet === 'IN_Quotes') row.source_id = 'PROVIDER';
        else row.account_alias = scope.account_alias;
        decimals.push(precise); return row;
      });
      const next = spec.next_path ? ownPath(source, spec.next_path) : null;
      requireThat(next === null || id(next), 'INVALID_PAGE');
      const response_digest = sha(response);
      const observed_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
      return issue('provider-page', { sheet, run_id, cursor, next, rows, decimals, observed_utc,
        source_event: 'read-' + sha({ run_id, sheet, cursor, response_digest }), response_digest, schema_digest: allowed.schema_digest });
    },
  };
}
