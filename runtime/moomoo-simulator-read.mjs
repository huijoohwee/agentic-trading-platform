import { completedRead, refuseRead } from './completed-read.mjs';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import fieldRegister from 'agentic-gateway/connectors/moomoo-fields.json' with { type: 'json' };
import { canonical, fail, hash, id, requireProofs, requireThat, scopeKey, sha, utcMillis, verifyEnvelope } from './core.mjs';

const root = '/api/v1.0/sim-trade/';
export const accountOperation = 'read.simulator-account';
const balanceOperation = 'read.simulator-balances';
const positionOperation = 'read.simulator-positions';
export const ordersOperation = 'read.simulator-orders';
export const historyOperation = 'read.simulator-order-history';
export const powerOperation = 'read.simulator-buying-power';
export const simulatorSpecs = Object.fromEntries([
  [accountOperation, 'sim_trade_account_list', 'accounts'],
  [balanceOperation, 'sim_trade_cash_info', '{acc_id}/cash-info'],
  [positionOperation, 'sim_trade_position_list', '{acc_id}/positions'],
  [ordersOperation, 'simulator_today_orders', '{acc_id}/orders'],
  [historyOperation, 'sim_trade_history_order_list', '{acc_id}/history-orders'],
  [powerOperation, 'sim_trade_max_buy_sell', '{acc_id}/max-buy-sell'],
].map(([operation, tool, route]) => {
  const spec = { profile: 'moomoo-simulator-read/v1', tool, method: 'GET', path: root + route, rows_path: [], pin_inputs: true };
  return [operation, { ...spec, schema_digest: sha(spec) }];
}));

export const simulatorOperation = operation => Object.hasOwn(simulatorSpecs, operation);
export function verifySimulatorSpec(operation, spec, origin) {
  requireThat(simulatorOperation(operation) && sha(spec) === sha(simulatorSpecs[operation]) &&
    origin === 'https://webapi.moomoo.com/', 'INVALID_MAPPING');
}

const mcpOrigin = 'https://mcp.moomoo.com/mcp';
const mcpProfile = 'moomoo-simulator-mcp-read/v1';
const publicFields = new Map(fieldRegister.tools.map(row => [row.name, row]));
export const simulatorMcpSpecs = Object.fromEntries(Object.entries(simulatorSpecs)
  .filter(([operation]) => operation !== ordersOperation)
  .map(([operation, spec]) => {
    const fields = publicFields.get(spec.tool);
    requireThat(fields && fields.body.length === 0, 'INVALID_MAPPING');
    return [operation, { profile: mcpProfile, tool: spec.tool, pin_inputs: true,
      projection_digest: sha({ rest_schema: spec.schema_digest, fields }) }];
  }));

export function verifySimulatorMcpSpec(operation, spec, origin) {
  requireThat(origin === mcpOrigin && Object.hasOwn(simulatorMcpSpecs, operation) &&
    sha(spec) === sha(simulatorMcpSpecs[operation]), 'INVALID_MAPPING');
}

export function verifySimulatorDescriptor(descriptor) {
  const fields = publicFields.get(descriptor.name)?.params, schema = descriptor.inputSchema;
  requireThat(fields && schema?.type === 'object', 'SCHEMA_DRIFT');
  const properties = schema.properties ?? {}, required = schema.required ?? [];
  requireThat(Array.isArray(required) && required.length === fields.filter(field => field.required).length &&
    fields.every(field => required.includes(field.name) === field.required &&
      (field.type === 'int' ? ['integer', 'number'].includes(properties[field.name]?.type) :
        properties[field.name]?.type === field.type)), 'SCHEMA_DRIFT');
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const privateHash = (secret, value) => createHmac('sha256', secret).update(canonical(value)).digest('hex');

export function simulatorBindingDigest({ provider, scope, account, secret, transport }) {
  scopeKey(scope);
  requireThat(typeof secret === 'string' && secret.length >= 32 && opaqueId(account?.account_id) &&
    positiveInt(account.market_id) && scope.environment === 'SIMULATE' &&
    ({ practice: 1, competition: 2 })[scope.profile] === account.account_type, 'ACCOUNT_BINDING');
  const { account_id, market_id, account_type } = account;
  return privateHash(secret, { profile: 'moomoo-simulator-read/v1', ...(transport === 'MCP' && { transport }), provider, scope, account_id, market_id, account_type });
}

const maxPage = 600;
const decimalText = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const has = (value, key) => Object.hasOwn(value, key);
function micros(value) {
  const text = Number.isSafeInteger(value) ? String(value) : value;
  requireThat(typeof text === 'string' && /^\d{1,19}$/.test(text) && BigInt(text) <= 9223372036854775807n, 'INVALID_PARAMETER');
  return text;
}
function historyFrame(parameters) {
  const frame = {};
  for (const key of ['time_begin', 'time_end']) if (has(parameters, key)) frame[key] = micros(parameters[key]);
  if (has(frame, 'time_begin') && has(frame, 'time_end')) requireThat(BigInt(frame.time_begin) <= BigInt(frame.time_end), 'INVALID_PARAMETER');
  const size = has(parameters, 'page_size') ? parameters.page_size : 50;
  requireThat(Number.isSafeInteger(size) && size >= 1 && size <= maxPage, 'INVALID_PARAMETER');
  frame.page_size = size;
  return frame;
}

function cursorContext(binding, frame) {
  return Buffer.from(canonical({ operation: historyOperation, account: simulatorBindingDigest(binding), candidate: binding.candidate ?? null, frame }));
}
function cursorKey(binding) {
  return createHmac('sha256', binding.secret).update('moomoo-simulator-history/cursor-key/v1').digest();
}
function sealCursor(key, binding, frame) {
  requireThat(typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= 1024, 'INVALID_PAGE');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cursorKey(binding), iv);
  cipher.setAAD(cursorContext(binding, frame));
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function openCursor(token, binding, frame) {
  requireThat(typeof token === 'string' && /^[A-Za-z0-9_-]{39,1403}$/.test(token), 'SCOPE_DENIED');
  const bytes = Buffer.from(token, 'base64url');
  requireThat(bytes.toString('base64url') === token && bytes.length > 28 && bytes.length <= 1052, 'SCOPE_DENIED');
  try {
    const cipher = createDecipheriv('aes-256-gcm', cursorKey(binding), bytes.subarray(0, 12));
    cipher.setAAD(cursorContext(binding, frame));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  } catch { fail('SCOPE_DENIED'); }
}

function simulatorQuery(operation, parameters, binding) {
  const accepted = operation === historyOperation ? ['time_begin', 'time_end', 'page_size', 'cursor'] :
    operation === powerOperation ? ['symbol', 'order_type', 'price', 'order_ref'] : [];
  requireThat(Object.keys(parameters).every(key => accepted.includes(key)), 'SCOPE_DENIED');
  if (operation === historyOperation) {
    const query = historyFrame(parameters);
    if (has(parameters, 'cursor')) query.next_key = openCursor(parameters.cursor, binding, query);
    return query;
  }
  if (operation !== powerOperation) return {};
  const { symbol, order_type, price, order_ref } = parameters;
  requireThat(typeof symbol === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(symbol) && [1, 3].includes(order_type), 'INVALID_PARAMETER');
  if (order_type === 1 || has(parameters, 'price')) {
    requireThat(typeof price === 'string' && price.length <= 64 && decimalText.test(price) &&
      !price.startsWith('-') && /[1-9]/.test(price.split(/e/i)[0]), 'INVALID_PARAMETER');
  }
  if (has(parameters, 'order_ref')) requireThat(hash(order_ref), 'INVALID_PARAMETER');
  return { symbol, order_type, ...(has(parameters, 'price') && { price }) };
}

export function validateSimulatorRead(operation, inputs, grant, binding) {
  const { grant: envelope, ...parameters } = inputs;
  simulatorQuery(operation, parameters, binding);
  const mcp = binding.transport === 'MCP';
  if (mcp) requireThat(Object.hasOwn(simulatorMcpSpecs, operation) && !has(parameters, 'order_ref'), 'SCOPE_DENIED');
  const digest = simulatorBindingDigest(binding);
  const required = new Set([operation, accountOperation]);
  if (operation === powerOperation && parameters.order_ref) required.add(ordersOperation);
  for (const op of required) {
    const grants = grant.tools.filter(tool => tool.operation === op);
    const expected = simulatorSpecs[op];
    requireThat(grants.length === 1 && grants[0].effect === 'read' && grants[0].name === expected.tool &&
      (mcp ? hash(grants[0].schema_digest) : grants[0].schema_digest === expected.schema_digest) && grants[0].inputs_digest === sha(op === operation ? parameters : {}) &&
      grants[0].account_binding_digest === digest, 'SCOPE_DENIED');
  }
}
export function simulatorMcpArguments(operation, parameters, binding) {
  requireThat(Object.hasOwn(simulatorMcpSpecs, operation) && !has(parameters, 'order_ref'), 'SCOPE_DENIED');
  const query = simulatorQuery(operation, parameters, binding);
  if (operation === accountOperation) return {};
  const { account_id: acc_id, market_id: market } = binding.account;
  if (operation === balanceOperation) return { acc_id };
  // The native tool accepts int64 JSON numbers. Emit the original integer token even beyond 2^53.
  for (const key of ['time_begin', 'time_end']) {
    if (has(query, key)) query[key] = JSON.rawJSON(BigInt(query[key]).toString());
  }
  return { acc_id, market, ...query };
}

export function simulatorPath(operation, account, parameters = {}, binding, originalOrderId) {
  const spec = simulatorSpecs[operation];
  const path = spec.path.replace('{acc_id}', encodeURIComponent(account.account_id));
  if (operation === balanceOperation || operation === accountOperation) return path;
  const query = new URLSearchParams({ market: String(account.market_id), ...simulatorQuery(operation, parameters, binding) });
  if (operation === powerOperation && parameters.order_ref) {
    requireThat(opaqueId(originalOrderId), 'ACCOUNT_BINDING');
    query.set('order_id', originalOrderId);
  }
  return path + '?' + query;
}

function data(body) {
  requireThat(object(body) && body.ret_code === 0 && object(body.data), 'INVALID_PAGE');
  return body.data;
}

export function selectedSimulatorAccount(body, { account, scope }) {
  const accounts = data(body).accounts;
  requireThat(Array.isArray(accounts), 'INVALID_PAGE');
  const matches = accounts.filter(row => row?.account_id === account.account_id);
  requireThat(matches.length === 1 && matches[0].account_type === account.account_type &&
    matches[0].market_id === account.market_id, 'ACCOUNT_BINDING');
  return { ...scope, account_market_id: account.market_id, currency: null };
}

const balanceFields = ['balance', 'hold', 'max_power_long', 'total_asset', 'mv', 'long_mv', 'short_mv'];
const profitFields = ['unrealized_profit', 'realized_profit'];
const positionFields = ['qty', 'qty_avbl', 'cost_price', 'buy_avg_price', 'cur_price', 'mv', 'profit', 'profit_ratio', 'today_turnover'];
const dailyFields = ['today_buy_qty', 'today_sell_qty', 'today_buy_turnover', 'today_buy_avg_price',
  'today_sell_turnover', 'today_sell_avg_price', 'today_profit'];

function exactFields(row, required, nullable) {
  const fields = {};
  for (const key of [...required, ...nullable]) {
    const value = row[key];
    if (value == null && nullable.includes(key)) fields[key] = null;
    else {
      requireThat(typeof value === 'string' && value.length <= 64 && decimalText.test(value),
        'PRECISION_UNKNOWN');
      fields[key] = value;
    }
  }
  return fields;
}

function checkAccount(row, account) {
  requireThat(object(row) && ['acc_id', 'account_id'].every(key =>
    !has(row, key) || row[key] === account.account_id), 'ACCOUNT_BINDING');
}
function orderRows(payload, binding) {
  requireThat(Array.isArray(payload.orders) && payload.orders.length <= maxPage, 'INVALID_PAGE');
  const account = simulatorBindingDigest(binding), seen = new Set();
  return payload.orders.map(row => {
    checkAccount(row, binding.account);
    requireThat(opaqueId(row.order_id) && !seen.has(row.order_id) && [1, 2, 3, 4].includes(row.side) &&
      [1, 3].includes(row.order_type) && Number.isInteger(row.status) && row.status >= 1 && row.status <= 7 &&
      (row.market == null || positiveInt(row.market)) && (row.time_in_force == null || [0, 1].includes(row.time_in_force)) &&
      (row.order_trade_time_type == null || [0, 1, 2].includes(row.order_trade_time_type)) &&
      typeof row.symbol === 'string' && row.symbol.trim() && row.symbol.length <= 128 &&
      typeof row.stock_name === 'string' && row.stock_name.length <= 256 && typeof row.text === 'string', 'INVALID_PAGE');
    seen.add(row.order_id);
    requireThat(typeof row.create_time === 'string' && typeof row.update_time === 'string', 'PRECISION_UNKNOWN');
    const created = micros(row.create_time), updated = micros(row.update_time);
    requireThat(BigInt(created) <= BigInt(updated), 'INVALID_PAGE');
    return { order_ref: privateHash(binding.secret, { account, order: row.order_id }), side: row.side, status: row.status,
      order_type: row.order_type, instrument_market: row.market ?? null, symbol: row.symbol, stock_name: row.stock_name,
      ...exactFields(row, ['qty', 'cum_qty', 'price', 'avg_fill_price'], ['aux_price']), time_in_force: row.time_in_force ?? null,
      order_trade_time_type: row.order_trade_time_type ?? null, create_time_us: created, update_time_us: updated, has_remark: row.text.length > 0 };
  });
}

export function resolveOriginalOrder(body, binding, { order_ref, symbol }) {
  const rows = simulatorPage(ordersOperation, body, binding);
  const index = rows.findIndex(row => row.order_ref === order_ref);
  requireThat(index >= 0, 'ACCOUNT_BINDING');
  const row = rows[index];
  const prefix = ({ 1: 'HK', 2: 'US', 3: 'US' })[row.instrument_market];
  requireThat(symbol === row.symbol || (prefix && symbol === prefix + '.' + row.symbol), 'ACCOUNT_BINDING');
  return body.data.orders[index].order_id;
}

export function historyPagination(body, parameters, binding) {
  const frame = historyFrame(parameters), page = body.pagination;
  requireThat(Array.isArray(body.data?.orders) && body.data.orders.length <= frame.page_size &&
    object(page) && typeof page.has_more === 'boolean', 'INVALID_PAGE');
  if (!page.has_more) return { completed: true, next_cursor: null };
  const previous = has(parameters, 'cursor') ? openCursor(parameters.cursor, binding, frame) : null;
  requireThat(page.next_key !== previous, 'INVALID_PAGE');
  return { completed: false, next_cursor: sealCursor(page.next_key, binding, frame) };
}

export function simulatorPage(operation, body, binding, parameters = {}) {
  if (operation === accountOperation) return [selectedSimulatorAccount(body, binding)];
  const payload = data(body);
  checkAccount(payload, binding.account);
  if (operation === ordersOperation || operation === historyOperation) return orderRows(payload, binding);
  if (operation === powerOperation) {
    const { symbol, order_type, price = null, order_ref = null } = parameters;
    return [{ symbol, order_type, price, order_ref, ...exactFields(payload,
      ['max_cash_buy_qty_round_lot', 'max_sell_qty_round_lot', 'max_sell_short_qty', 'max_buy_back_qty'],
      ['max_margin_buy_qty_round_lot', 'required_im_long', 'required_im_short']) }];
  }
  if (operation === balanceOperation) return [exactFields(payload, balanceFields, profitFields)];
  requireThat(operation === positionOperation && Array.isArray(payload.positions) && payload.positions.length <= 600, 'INVALID_PAGE');
  const seen = new Set();
  return payload.positions.map(row => {
    checkAccount(row, binding.account);
    requireThat(opaqueId(row.pstn_id) && !seen.has(row.pstn_id) && [0, 1].includes(row.pstn_type) && positiveInt(row.market) &&
      typeof row.symbol === 'string' && row.symbol.trim() && row.symbol.length <= 128 &&
      typeof row.stock_name === 'string' && row.stock_name.length <= 256, 'INVALID_PAGE');
    seen.add(row.pstn_id);
    const position_ref = privateHash(binding.secret, { account: simulatorBindingDigest(binding), position: row.pstn_id });
    return { position_ref, side: row.pstn_type === 0 ? 'long' : 'short', instrument_market: row.market, symbol: row.symbol,
      stock_name: row.stock_name, ...exactFields(row, positionFields, [...profitFields, ...dailyFields]) };
  });
}

// Catalog discovery and account selection can span several calls. Both qualifications must
// still cover the next call and the completed page before it enters the private ledger.
export function qualifySimulatorAdapter(adapter, capability, definition) {
  const expiry = Math.min(utcMillis(capability.qualification.expires_utc), utcMillis(definition.qualification.expires_utc));
  const revalidate = () => requireThat(Date.now() < expiry, 'STALE_EVIDENCE');
  return { ...adapter,
    open(options) { return adapter.open({ ...options, beforeCall: revalidate }); },
    async read(options) {
      const page = await adapter.read(options);
      revalidate();
      return page;
    },
  };
}

// Authenticate private reads before the gateway can return a previous receipt. The same
// facade owns both inward transports. A replay checks current keys, scope and host binding.
export function withSimulatorAdmission(gateway, { store, scope, candidate, keys, providers, credentialFor }) {
  const capabilities = new Map(gateway.discover().map(record => [record.capability_digest, record]));
  function authorized(request) {
    requireThat(simulatorOperation(request?.operation) && id(request.request_id), 'SCOPE_DENIED');
    const record = capabilities.get(request.capability_digest), now = Date.now();
    requireThat(record?.source === 'PROVIDER' && ['REST', 'MCP'].includes(record.transport) && record.operations.includes(accountOperation) &&
      record.operations.includes(request.operation) && record.qualification.status === 'QUALIFIED', 'SCOPE_DENIED');
    const selected = providers.bind(record);
    if (record.transport === 'MCP') {
      for (const op of new Set([accountOperation, request.operation])) {
        verifySimulatorMcpSpec(op, selected.mapping.operations?.[op], selected.transport.origin);
      }
    }
    requireThat(selected.definition.qualification.status === 'QUALIFIED', 'SCOPE_DENIED');
    requireThat(scopeKey(request.scope) === scopeKey(scope), 'ACCOUNT_BINDING');
    const grant = verifyEnvelope(request.inputs?.grant, { keys, role: 'operator', kind: 'read', scope, candidate, now });
    requireProofs(grant, ['cost', 'rights', 'account'], now);
    const expires = Math.min(...[record.qualification, selected.definition.qualification, grant, ...grant.proofs].map(row => utcMillis(row.expires_utc)));
    requireThat(expires > now, 'STALE_EVIDENCE');
    requireThat(grant.mapping_digest === record.mapping_digest && Array.isArray(grant.tools) &&
      grant.tools.every(tool => tool?.effect === 'read' && record.allowlist.includes(tool.name)), 'SCOPE_DENIED');
    if (request.operation === powerOperation && has(request.inputs, 'order_ref')) {
      requireThat(record.operations.includes(ordersOperation), 'SCOPE_DENIED');
    }
    const credential = credentialFor(record);
    const signer = credential?.attestation, key = signer && keys[signer.key_id];
    requireThat(key?.role === 'integration' && key.revoked !== true && key.principal === signer.principal &&
      key.runtime === signer.runtime, 'SCOPE_DENIED');
    validateSimulatorRead(request.operation, request.inputs, grant, { provider: record.provider, transport: record.transport, scope,
      candidate, account: credential.simulator_account, secret: credential.alias_secret });
    return { record, definitionDigest: selected.definition_digest, expires };
  }
  return { ...gateway, async admit(request, authorization) {
    if (!simulatorOperation(request?.operation)) return gateway.admit(request, authorization);
    requireThat(gateway.authenticate(authorization), 'UNAUTHORIZED');
    try {
      authorized(request);
      requireThat(utcMillis(request.deadline_utc) > Date.now(), 'STALE_EVIDENCE');
    } catch (error) { return refuseRead(request, error); }
    return gateway.admit(request, authorization);
  }, inspectSimulatorReceipt(request, authorization) {
    requireThat(gateway.authenticate(authorization), 'UNAUTHORIZED');
    try {
      const { record, definitionDigest, expires } = authorized(request);
      const receipt = completedRead(store, scope, request, record, definitionDigest);
      const { data } = receipt;
      requireThat(data.account?.account_alias === scope.account_alias && data.account.profile === scope.profile &&
        data.account.environment === scope.environment, 'SCOPE_DENIED');
      return { ...receipt, display_until_utc: new Date(expires).toISOString() };
    } catch (error) { return refuseRead(request, error); }
  } };
}
