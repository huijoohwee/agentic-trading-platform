import { STOCK_SCREEN_TOOL, buildMoomooStockScreen, projectMoomooStockScreen } from 'agentic-gateway/connectors/moomoo-stock-screen';
import { rankingTools, regionalIpoTools } from '../src/moomoo-research-tools.mjs';
import { requiresMarketRest, sessionMcpSpecs, isSessionMcp, verifySessionMcp, sessionMcpArguments, marketPage } from './moomoo-market-rest.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { accountOperation, historyOperation, simulatorOperation, verifySimulatorMcpSpec, verifySimulatorDescriptor,
  validateSimulatorRead, simulatorMcpArguments, selectedSimulatorAccount, simulatorPage, historyPagination } from './moomoo-simulator-read.mjs';
import { listReviewedTools, ownPath, rpcResponse } from './mcp-read.mjs';
import { validateProviderDefinition } from './provider-mapping.mjs';
import { researchGetProfile, researchMapping, researchMcpMapping, researchToolArguments } from './moomoo-research.mjs';
import { projectMarketReadPage } from './market-read-projection.mjs';
import { boundedJson, canonical, current, fail, id, requireProofs, requireThat, scopeKey, sha } from './core.mjs';

// Labelled provider adapter for operation-shaped market reads. It shares the sheet adapter's
// transport owner (endpoint/protocols/ownPath/rpcResponse) and never exposes raw provider tools:
// the reviewed private mapping binds each native operation to one read-only tool and projection.
export const MARKET_READ_OPERATIONS = [...Object.keys(sessionMcpSpecs), ...Object.keys(rankingTools), ...Object.keys(regionalIpoTools), 'read.catalog', 'read.candles', 'read.candle-history', 'read.ticker', 'read.depth', 'read.tape', 'read.calendar', 'read.dividend-calendar', 'read.economic-calendar', 'read.capital-flow', 'read.capital-distribution', 'read.capital-flow-history', 'read.rank', 'read.stock-screen',
  'read.plate', 'read.ipo', 'read.news', 'read.research', 'read.financials', 'read.corporate-actions', 'read.holders',
  'read.financial-statements', 'read.influencer', 'read.macro', 'read.derivatives', 'read.option-chain', 'read.option-expiries', 'read.option-events',
  'read.futures-positions', 'read.futures-seasonality', 'read.futures-correlation', 'read.etf', 'read.event-contract', 'read.crypto-market',
  'read.valuation', 'read.short', 'read.stock-connect', 'read.top-brokers', 'read.chip', 'read.cbbc'];
const writeBan = /(?:place|submit|cancel|modify|withdraw|transfer|unlock|reset|delete|amend)(?:_|$)/i;
const decimalPattern = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

// The public directory names some fields in camelCase. Preserve scalar bytes and reject ambiguous aliases.
function providerFields(source, depth = 0) {
  if (source === null || typeof source !== 'object') return source;
  requireThat(depth < 40, 'INVALID_PAGE');
  if (Array.isArray(source)) return source.map(value => providerFields(value, depth + 1));
  const result = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    const name = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    requireThat(!Object.hasOwn(result, name), 'INVALID_PAGE');
    result[name] = providerFields(value, depth + 1);
  }
  return result;
}

export function createMcpMarketReadAdapter({ provider, token, mapping, attestation, scope, candidate, simulatorAccount, aliasSecret, fetchImpl = fetch, now = Date.now }) {
  const { definition } = validateProviderDefinition(provider);
  requireThat(definition.transport.kind === 'MCP', 'INVALID_TRANSPORT_PIN');
  const endpoint = definition.transport.origin;
  scope = boundedJson(scope); scopeKey(scope);
  requireThat(!scope.account_alias.startsWith('runtime-budget/'), 'ACCOUNT_BINDING');
  requireThat(typeof token === 'string' && token.length >= 16 && !/[\r\n]/.test(token), 'READ_CREDENTIAL_REQUIRED');
  requireThat(id(attestation?.key_id) && id(attestation.principal) && id(attestation.runtime), 'ATTESTATION_REQUIRED');
  const privateKey = createPrivateKey(attestation.privateKey);
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'ATTESTATION_REQUIRED');
  requireThat(mapping?.protocol === definition.transport.protocol && mapping.operations && typeof mapping.operations === 'object', 'INVALID_MAPPING');
  for (const [operation, spec] of Object.entries(mapping.operations)) {
    requireThat(!requiresMarketRest(operation, spec.tool), 'INVALID_MAPPING');
    if (isSessionMcp(operation, spec)) { verifySessionMcp(operation, spec); continue; }
    if (simulatorOperation(operation) || spec.tool?.startsWith('sim_trade_') || spec.profile === 'moomoo-simulator-mcp-read/v1') {
      verifySimulatorMcpSpec(operation, spec, endpoint);
      continue;
    }
    requireThat(MARKET_READ_OPERATIONS.includes(operation) && id(spec.tool) && Array.isArray(spec.rows_path), 'INVALID_MAPPING');
    requireThat((operation === 'read.stock-screen') === (spec.tool === STOCK_SCREEN_TOOL), 'INVALID_MAPPING');
    if (spec.profile === researchGetProfile) {
      const reviewed = researchMcpMapping.operations[operation];
      requireThat(reviewed?.profile === researchGetProfile && sha(spec) === sha(reviewed), 'INVALID_MAPPING');
    }
    requireThat(!writeBan.test(spec.tool), 'SCOPE_DENIED');
  }
  const binding = { provider: definition.provider, scope, candidate, transport: 'MCP', account: simulatorAccount, secret: aliasSecret };
  let session, version, sequence = 0, calls = 0, grant, beforeCall, selected;
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
  async function callTool(name, args, signal) {
    const response = await rpc('tools/call', { name, arguments: args }, signal);
    requireThat(!response.isError, 'PROVIDER_ERROR');
    let source = response.structuredContent;
    if (source === undefined) {
      requireThat(response.content?.length === 1 && response.content[0].type === 'text', 'SOURCE_MAPPING_REQUIRED');
      try { source = JSON.parse(response.content[0].text); } catch { fail('SOURCE_MAPPING_REQUIRED'); }
    }
    return { source, response };
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
  function researchArguments(operation, inputs, allowed) {
    const { grant: envelope, ...parameters } = inputs;
    requireThat(allowed.name === mapping.operations[operation].tool, 'SCHEMA_DRIFT');
    requireThat(allowed.inputs_digest === sha(parameters), 'SCOPE_DENIED');
    return researchToolArguments(operation, parameters);
  }
  return {
    validateInputs(operation, inputs, allowed, admitted) {
      if (simulatorOperation(operation)) {
        validateSimulatorRead(operation, inputs, admitted, binding);
        requireThat(admitted.limits.max_calls >= (operation === accountOperation ? 4 : 5), 'BUDGET_HALT');
      }
      if (Object.hasOwn(sessionMcpSpecs, operation)) sessionMcpArguments(mapping.operations[operation], inputs, allowed);
      if (mapping.operations[operation]?.profile === researchGetProfile) researchArguments(operation, inputs, allowed);
    },
    async open({ grant: admitted, operation, inputs = {}, signal, beforeCall: revalidate }) {
      requireThat(admitted.mapping_digest === sha(mapping), 'MAPPING_DRIFT');
      grant = admitted; beforeCall = revalidate; session = undefined; version = undefined; calls = 0;
      selected = null;
      const privateRead = simulatorOperation(operation);
      const needsAccount = privateRead && operation !== accountOperation;
      if (privateRead) {
        validateSimulatorRead(operation, inputs, admitted, binding);
        requireThat(admitted.limits.max_calls >= (needsAccount ? 5 : 4), 'BUDGET_HALT');
      }
      const initialized = await rpc('initialize', { protocolVersion: mapping.protocol, capabilities: {},
        clientInfo: { name: 'trading-market-read-boundary', version: '1.0.0' } }, signal);
      requireThat(initialized?.protocolVersion === mapping.protocol && initialized.capabilities?.tools, 'PROTOCOL_UNQUALIFIED');
      version = initialized.protocolVersion;
      await rpc('notifications/initialized', null, signal, true);
      const listed = await listReviewedTools(rpc, grant.tools, grant.limits.max_calls - calls - (needsAccount ? 2 : 1), signal);
      for (const allowed of grant.tools) {
        const spec = mapping.operations[allowed.operation];
        const descriptor = listed.get(allowed.name);
        requireThat(spec && descriptor && sha(descriptor) === allowed.schema_digest && spec.tool === allowed.name && allowed.effect === 'read', 'SCHEMA_DRIFT');
        if (simulatorOperation(allowed.operation)) verifySimulatorDescriptor(descriptor);
        requireThat(!writeBan.test(allowed.name), 'SCOPE_DENIED');
      }
      if (needsAccount) {
        const { source } = await callTool(mapping.operations[accountOperation].tool, {}, signal);
        selected = selectedSimulatorAccount(providerFields(source), binding);
      }
      return issue('read-capabilities', { tools: grant.tools, calls });
    },
    async read({ operation, inputs, signal }) {
      const spec = mapping.operations[operation], allowed = grant.tools.find(tool => tool.operation === operation);
      requireThat(grant && spec && allowed, 'SCOPE_DENIED');
      const { grant: envelopeInput, ...request } = boundedJson(inputs);
      const screen = operation === 'read.stock-screen';
      const privateRead = simulatorOperation(operation);
      const sessionRead = Object.hasOwn(sessionMcpSpecs, operation);
      const research = spec.profile === researchGetProfile;
      if (screen || allowed.inputs_digest !== undefined) requireThat(allowed.inputs_digest === sha(request), 'SCOPE_DENIED');
      let parameters;
      if (privateRead) {
        validateSimulatorRead(operation, request, grant, binding);
        requireThat(operation === accountOperation || selected, 'ACCOUNT_BINDING');
        parameters = simulatorMcpArguments(operation, request, binding);
      } else if (sessionRead) {
        parameters = sessionMcpArguments(spec, request, allowed);
      } else if (screen) {
        requireThat(allowed.name === STOCK_SCREEN_TOOL, 'SCHEMA_DRIFT');
        parameters = buildMoomooStockScreen(request);
      } else if (research) {
        parameters = researchArguments(operation, request, allowed);
      } else {
        parameters = boundedJson(spec.parameters ?? {});
        for (const [parameter, inputKey] of Object.entries(spec.input_map ?? {})) {
          requireThat(id(parameter) && id(inputKey) && Object.hasOwn(inputs, inputKey), 'SOURCE_MAPPING_REQUIRED');
          const value = inputs[inputKey];
          parameters[parameter] = spec.array_parameters?.includes(parameter) ? [value] : value;
        }
      }
      const { source, response } = await callTool(allowed.name, parameters, signal);
      const raw = privateRead || screen || research || sessionRead ? undefined : ownPath(source, spec.rows_path);
      let rows, decimals = [], metadata = {};
      if (privateRead) {
        const body = providerFields(source);
        rows = simulatorPage(operation, body, binding, request);
        decimals = rows.map(() => ({}));
        metadata.account = operation === accountOperation ? rows[0] : selected;
        if (operation === historyOperation) metadata.pagination = historyPagination(body, request, binding);
      } else if (sessionRead) {
        ({ rows, decimals } = marketPage(spec, request, JSON.stringify(providerFields(source))));
      } else if (screen) {
        ({ rows, ...metadata } = projectMoomooStockScreen(request, source));
        decimals = rows.map(() => ({}));
      } else if (research) {
        ({ rows, decimals, ...metadata } = projectMarketReadPage(researchMapping.operations[operation], request, providerFields(source)));
      } else if (spec.object_result) {
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
      return issue('provider-market-page', { operation, rows, decimals, ...metadata, observed_utc,
        ...precision, source_event: 'market-' + sha({ operation, response_digest }), response_digest, schema_digest: allowed.schema_digest });
    },
  };
}
