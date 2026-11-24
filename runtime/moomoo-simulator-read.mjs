import { createHmac } from 'node:crypto';
import { canonical, id, requireProofs, requireThat, scopeKey, sha, utcMillis, verifyEnvelope } from './core.mjs';

const root = '/api/v1.0/sim-trade/';
export const accountOperation = 'read.simulator-account';
const balanceOperation = 'read.simulator-balances';
const positionOperation = 'read.simulator-positions';
export const simulatorSpecs = Object.fromEntries([
  [accountOperation, 'sim_trade_account_list', 'accounts'],
  [balanceOperation, 'sim_trade_cash_info', '{acc_id}/cash-info'],
  [positionOperation, 'sim_trade_position_list', '{acc_id}/positions'],
].map(([operation, tool, route]) => {
  const spec = { profile: 'moomoo-simulator-read/v1', tool, method: 'GET', path: root + route, rows_path: [], pin_inputs: true };
  return [operation, { ...spec, schema_digest: sha(spec) }];
}));

export const simulatorOperation = operation => Object.hasOwn(simulatorSpecs, operation);
export function verifySimulatorSpec(operation, spec, origin) {
  requireThat(simulatorOperation(operation) && sha(spec) === sha(simulatorSpecs[operation]) &&
    origin === 'https://webapi.moomoo.com/', 'INVALID_MAPPING');
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const privateHash = (secret, value) => createHmac('sha256', secret).update(canonical(value)).digest('hex');

export function simulatorBindingDigest({ provider, scope, account, secret }) {
  scopeKey(scope);
  requireThat(typeof secret === 'string' && secret.length >= 32 && opaqueId(account?.account_id) &&
    positiveInt(account.market_id) && scope.environment === 'SIMULATE' &&
    ({ practice: 1, competition: 2 })[scope.profile] === account.account_type, 'ACCOUNT_BINDING');
  const { account_id, market_id, account_type } = account;
  return privateHash(secret, { profile: 'moomoo-simulator-read/v1', provider, scope, account_id, market_id, account_type });
}

export function validateSimulatorRead(operation, inputs, grant, binding) {
  requireThat(Object.keys(inputs).every(key => key === 'grant'), 'SCOPE_DENIED');
  const digest = simulatorBindingDigest(binding);
  for (const op of new Set([operation, accountOperation])) {
    const grants = grant.tools.filter(tool => tool.operation === op);
    const expected = simulatorSpecs[op];
    requireThat(grants.length === 1 && grants[0].effect === 'read' && grants[0].name === expected.tool &&
      grants[0].schema_digest === expected.schema_digest && grants[0].inputs_digest === sha({}) &&
      grants[0].account_binding_digest === digest, 'SCOPE_DENIED');
  }
}
export function simulatorPath(operation, account) {
  const path = simulatorSpecs[operation].path.replace('{acc_id}', encodeURIComponent(account.account_id));
  return operation === positionOperation ? path + '?market=' + account.market_id : path;
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
      requireThat(typeof value === 'string' && value.length <= 64 && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value),
        'PRECISION_UNKNOWN');
      fields[key] = value;
    }
  }
  return fields;
}

export function simulatorPage(operation, body, binding) {
  if (operation === accountOperation) return [selectedSimulatorAccount(body, binding)];
  const payload = data(body);
  const checkAccount = row => {
    requireThat(object(row) && ['acc_id', 'account_id'].every(key =>
      !Object.hasOwn(row, key) || row[key] === binding.account.account_id), 'ACCOUNT_BINDING');
  };
  checkAccount(payload);
  if (operation === balanceOperation) return [exactFields(payload, balanceFields, profitFields)];
  requireThat(operation === positionOperation && Array.isArray(payload.positions) && payload.positions.length <= 600, 'INVALID_PAGE');
  const seen = new Set();
  return payload.positions.map(row => {
    checkAccount(row);
    requireThat(opaqueId(row.pstn_id) && !seen.has(row.pstn_id) && [0, 1].includes(row.pstn_type) && positiveInt(row.market) &&
      typeof row.symbol === 'string' && row.symbol.trim() && row.symbol.length <= 128 &&
      typeof row.stock_name === 'string' && row.stock_name.length <= 256, 'INVALID_PAGE');
    seen.add(row.pstn_id);
    const position_ref = privateHash(binding.secret, { account: simulatorBindingDigest(binding), position: row.pstn_id });
    return { position_ref, side: row.pstn_type === 0 ? 'long' : 'short', instrument_market: row.market, symbol: row.symbol,
      stock_name: row.stock_name, ...exactFields(row, positionFields, [...profitFields, ...dailyFields]) };
  });
}

// Authenticate private reads before the gateway can return a previous receipt. The same
// facade owns both inward transports. A replay checks current keys, scope and host binding.
export function withSimulatorAdmission(gateway, { scope, candidate, keys, credentialFor }) {
  const capabilities = new Map(gateway.discover().map(record => [record.capability_digest, record]));
  return { ...gateway, async admit(request, authorization) {
    if (!simulatorOperation(request?.operation)) return gateway.admit(request, authorization);
    requireThat(gateway.authenticate(authorization), 'UNAUTHORIZED');
    try {
      const record = capabilities.get(request.capability_digest), now = Date.now();
      requireThat(record?.source === 'PROVIDER' && record.transport === 'REST' && record.operations.includes(accountOperation) &&
        record.operations.includes(request.operation) && record.qualification.status === 'QUALIFIED', 'SCOPE_DENIED');
      requireThat(utcMillis(request.deadline_utc) > now && utcMillis(record.qualification.expires_utc) > now, 'STALE_EVIDENCE');
      requireThat(scopeKey(request.scope) === scopeKey(scope), 'ACCOUNT_BINDING');
      const grant = verifyEnvelope(request.inputs?.grant, { keys, role: 'operator', kind: 'read', scope, candidate, now });
      requireProofs(grant, ['cost', 'rights', 'account'], now);
      requireThat(grant.mapping_digest === record.mapping_digest && Array.isArray(grant.tools) &&
        grant.tools.every(tool => tool?.effect === 'read' && record.allowlist.includes(tool.name)), 'SCOPE_DENIED');
      const credential = credentialFor(record);
      validateSimulatorRead(request.operation, request.inputs, grant, { provider: record.provider, scope,
        account: credential?.simulator_account, secret: credential?.alias_secret });
    } catch (error) {
      return { request_id: id(request.request_id) ? request.request_id : null, status: 'REFUSED',
        error: { code: error.code === 'STALE_EVIDENCE' ? 'STALE' : error.code === 'BUDGET_HALT' ? 'BUDGET_HALT' : 'UNAUTHORIZED' },
        provenance: null, ledger_revision: null };
    }
    return gateway.admit(request, authorization);
  } };
}
