import { accountOperation, simulatorOperation, verifySimulatorSpec, validateSimulatorRead, simulatorPath, selectedSimulatorAccount, simulatorPage, historyOperation, ordersOperation, powerOperation, historyPagination, resolveOriginalOrder } from './moomoo-simulator-read.mjs';
import { STOCK_SCREEN_PATH, STOCK_SCREEN_TOOL, buildMoomooStockScreen, projectMoomooStockScreen } from 'agentic-gateway/connectors/moomoo-stock-screen';
import { createPrivateKey, sign } from 'node:crypto';
import { validateProviderDefinition } from './provider-mapping.mjs';
import { marketReadParameters, marketReadSymbol, projectMarketReadPage } from './market-read-projection.mjs';
import { isMarketRest, verifyMarketRest, marketRequest, marketPage } from './moomoo-market-rest.mjs';
import { MARKET_READ_OPERATIONS } from './mcp-market-read.mjs';
import { boundedJson, canonical, current, fail, id, requireProofs, requireThat, scopeKey, sha } from './core.mjs';

// Reviewed REST adapter for operation-shaped market reads (for example the earnings calendar, which
// has no MCP tool). It issues the same signed read-capabilities/provider-market-page envelopes as the
// MCP adapter, so the shared boundary, single durable $0 counter and gateway admission are unchanged.
// Every POST is bound to a fixed reviewed read profile.
const writeBan = /(?:place|submit|cancel|modify|withdraw|transfer|unlock|reset|delete|amend)(?:_|$)/i;
// Enforce the wire limit before parsing, including when no Content-Length is sent.
async function readResponse(response) {
  const chunks = [];
  let size = 0;
  requireThat(response.body, 'INVALID_RESPONSE');
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= 480_000, 'INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { fail('INVALID_RESPONSE'); }
}

export function createRestMarketReadAdapter({ provider, token, mapping, attestation, scope, candidate, simulatorAccount, aliasSecret, fetchImpl = fetch, now = Date.now }) {
  const { definition } = validateProviderDefinition(provider);
  requireThat(definition.transport.kind === 'REST', 'INVALID_TRANSPORT_PIN');
  const origin = definition.transport.origin;
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  requireThat(typeof token === 'string' && token.length >= 16 && !/[\r\n]/.test(token), 'READ_CREDENTIAL_REQUIRED');
  requireThat(id(attestation?.key_id) && id(attestation.principal) && id(attestation.runtime), 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(attestation.privateKey);
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'ATTESTATION_REQUIRED');
  requireThat(mapping?.protocol === definition.transport.protocol && mapping.operations && typeof mapping.operations === 'object', 'INVALID_MAPPING');
  for (const [operation, spec] of Object.entries(mapping.operations)) {
    const screen = operation === 'read.stock-screen';
    if (simulatorOperation(operation) || spec.profile === 'moomoo-simulator-read/v1' ||
      spec.path?.startsWith('/api/v1.0/sim-trade/') || spec.tool?.startsWith('sim_trade_')) verifySimulatorSpec(operation, spec, origin);
    else if (operation === 'read.candle-history' || isMarketRest(spec)) verifyMarketRest(operation, spec, origin);
    else if (screen) requireThat(spec.method === 'POST' && spec.path === STOCK_SCREEN_PATH && spec.tool === STOCK_SCREEN_TOOL &&
      spec.profile === 'moomoo-stock-screen/v1' && spec.pin_inputs === true, 'INVALID_MAPPING');
    else requireThat(spec.method === 'GET' && spec.tool !== STOCK_SCREEN_TOOL, 'INVALID_MAPPING');
    requireThat(id(spec.tool) && Array.isArray(spec.rows_path) && /^[a-f0-9]{64}$/.test(spec.schema_digest), 'INVALID_MAPPING');
    requireThat(typeof spec.path === 'string' && spec.path.startsWith('/') && !/[\s?#]/.test(spec.path) && spec.path.length <= 256, 'INVALID_MAPPING');
    requireThat(!writeBan.test(spec.tool), 'SCOPE_DENIED');
  }
  for (const operation of Object.keys(mapping.operations)) requireThat(MARKET_READ_OPERATIONS.includes(operation) || simulatorOperation(operation), 'INVALID_MAPPING');
  let calls = 0, grant, beforeCall, selected, originalOrderId;
  const privateBinding = { provider: definition.provider, scope, candidate, account: simulatorAccount, secret: aliasSecret };
  const issue = (kind, data) => {
    const issued_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const payload = { schema: 'trading-runtime-envelope/v1', kind, scope, candidate, principal: attestation.principal,
      runtime: attestation.runtime, issued_utc, expires_utc: grant.expires_utc, ...data };
    return { key_id: attestation.key_id, payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url') };
  };
  const issuePage = (operation, page, body, schema_digest) => {
    const response_digest = sha(body);
    const observed_utc = new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    return issue('provider-market-page', { operation, ...page, observed_utc,
      source_event: 'market-' + sha({ operation, response_digest }), response_digest, schema_digest });
  };
  async function send(url, method, requestBody, signal) {
    beforeCall?.();
    requireThat(!signal?.aborted, 'TIMEOUT');
    requireThat(grant.revoked !== true, 'REVOKED');
    requireProofs(grant, ['cost', 'rights', 'account'], now());
    requireThat(current(grant, now()) && calls < grant.limits.max_calls, 'BUDGET_HALT');
    calls++;
    let response;
    const options = { method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal, redirect: 'error' };
    if (requestBody) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(requestBody);
    }
    try { response = await fetchImpl(url, options); }
    catch { fail(signal?.aborted ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'); }
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); fail('SCOPE_DENIED'); }
    requireThat(response.ok && !response.redirected, 'PROVIDER_UNAVAILABLE');
    requireThat(response.headers.get('content-type')?.split(';')[0] === 'application/json', 'INVALID_RESPONSE');
    return readResponse(response);
  }
  function json(wire) {
    try { return JSON.parse(wire); } catch { fail('INVALID_RESPONSE'); }
  }
  async function simulatorWire(operation, signal, parameters = {}) {
    return send(new URL(simulatorPath(operation, simulatorAccount, parameters, privateBinding, originalOrderId), origin).href, 'GET', undefined, signal);
  }
  return {
    validateInputs(operation, inputs, allowed, admitted) {
      const spec = mapping.operations[operation];
      if (simulatorOperation(operation)) validateSimulatorRead(operation, inputs, admitted, privateBinding);
      if (isMarketRest(spec)) marketRequest(spec, inputs, allowed);
    },
    async open({ operation, inputs = {}, grant: admitted, signal, beforeCall: revalidate }) {
      requireThat(admitted.mapping_digest === sha(mapping), 'MAPPING_DRIFT');
      grant = admitted; beforeCall = revalidate; calls = 0;
      // The REST response schema is reviewed offline; there is no tools/list handshake. The grant must
      // pin the reviewed schema digest for each semantic tool, exactly as the MCP catalog pin does.
      for (const allowed of grant.tools) {
        const spec = mapping.operations[allowed.operation];
        requireThat(spec && allowed.effect === 'read' && allowed.name === spec.tool && allowed.schema_digest === spec.schema_digest, 'SCHEMA_DRIFT');
        if (allowed.operation === 'read.stock-screen') requireThat(new URL(origin).origin === 'https://webapi.moomoo.com', 'INVALID_MAPPING');
        requireThat(!writeBan.test(allowed.name), 'SCOPE_DENIED');
      }
      selected = null; originalOrderId = undefined;
      if (simulatorOperation(operation) && operation !== accountOperation) {
        validateSimulatorRead(operation, inputs, admitted, privateBinding);
        selected = selectedSimulatorAccount(json(await simulatorWire(accountOperation, signal)), privateBinding);
        if (operation === powerOperation && inputs.order_ref) {
          const orders = json(await simulatorWire(ordersOperation, signal));
          originalOrderId = resolveOriginalOrder(orders, privateBinding, inputs);
        }
      }
      return issue('read-capabilities', { tools: grant.tools, calls });
    },
    async read({ operation, inputs, signal }) {
      const spec = mapping.operations[operation], allowed = grant.tools.find(tool => tool.operation === operation);
      requireThat(grant && spec && allowed, 'SCOPE_DENIED');
      const screen = operation === 'read.stock-screen';
      const { grant: requestGrant, ...parameters } = boundedJson(inputs);
      if (screen || spec.pin_inputs || allowed.inputs_digest !== undefined) {
        requireThat(allowed.inputs_digest === sha(parameters), 'SCOPE_DENIED');
      }
      if (simulatorOperation(operation)) {
        validateSimulatorRead(operation, parameters, grant, privateBinding);
        requireThat(operation === accountOperation || selected, 'ACCOUNT_BINDING');
        const wire = await simulatorWire(operation, signal, parameters), body = json(wire);
        const rows = simulatorPage(operation, body, privateBinding, parameters);
        const metadata = operation === historyOperation ? { pagination: historyPagination(body, parameters, privateBinding) } : {};
        const account = operation === accountOperation ? rows[0] : selected;
        return issuePage(operation, { account, rows, ...metadata, decimals: rows.map(() => ({})) }, wire, allowed.schema_digest);
      }
      const market = isMarketRest(spec);
      const native = market ? marketRequest(spec, parameters, allowed) : null;
      const requestBody = native?.body ?? (screen ? buildMoomooStockScreen(parameters) : undefined);
      const search = screen || market ? '' : new URLSearchParams(marketReadParameters(spec, inputs)).toString();
      let path = native?.path ?? (screen ? STOCK_SCREEN_PATH : spec.path);
      if (spec.symbol_path) {
        requireThat(path.includes('{symbol}'), 'INVALID_MAPPING');
        path = path.replace('{symbol}', encodeURIComponent(marketReadSymbol(spec, inputs)));
      }
      const target = new URL(path, origin);
      requireThat(target.protocol === 'https:' && target.origin === new URL(origin).origin, 'INVALID_MAPPING');
      if (search) target.search = search;
      const url = target.href;
      if (screen) requireThat(url === 'https://webapi.moomoo.com' + STOCK_SCREEN_PATH && allowed.name === STOCK_SCREEN_TOOL, 'INVALID_MAPPING');
      const started = now();
      const wire = await send(url, native?.method ?? (screen ? 'POST' : 'GET'), requestBody, signal);
      if (market) return issuePage(operation, { ...marketPage(spec, parameters, wire),
        market_request: { started_ms: started, definition_digest: sha(definition), grant_digest: sha(grant), inputs_digest: sha(parameters) },
      }, wire, allowed.schema_digest);
      const body = json(wire);
      requireThat(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_RESPONSE');
      if (screen) {
        const { rows, pagination } = projectMoomooStockScreen(parameters, body);
        return issuePage(operation, { rows, decimals: rows.map(() => ({})), pagination }, body, allowed.schema_digest);
      }
      return issuePage(operation, projectMarketReadPage(spec, inputs, body), body, allowed.schema_digest);
    },
  };
}
