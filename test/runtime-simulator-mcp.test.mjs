import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fields from 'agentic-gateway/connectors/moomoo-fields.json' with { type: 'json' };
import { accountOperation, ordersOperation, historyOperation, powerOperation, simulatorBindingDigest,
  simulatorMcpSpecs, simulatorSpecs, verifySimulatorDescriptor, verifySimulatorMcpSpec } from '../runtime/moomoo-simulator-read.mjs';
import { canonical, sha } from '../runtime/core.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';

const origin = 'https://mcp.moomoo.com/mcp', protocol = '2025-11-25';
const cashOp = 'read.simulator-balances', positionsOp = 'read.simulator-positions';
const account = { account_id: 'private-mcp-account', account_type: 1, market_id: 100 };
const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'practice/selected' };
const provider = 'moomoo-simulator-fixture', candidate = sha('simulator MCP fixture candidate');
const secret = 'test-only-transport-bound-identity-secret', audience = 'local-test-only-gateway-audience';
const utc = time => new Date(Math.floor(time / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const listed = Object.values(simulatorMcpSpecs).map(({ tool }) => {
  const params = fields.tools.find(row => row.name === tool).params;
  return { name: tool, description: 'Local simulator fixture', inputSchema: { type: 'object',
    properties: Object.fromEntries(params.map(p => [p.name, { type: p.type === 'int' ? 'integer' : p.type }])),
    required: params.filter(p => p.required).map(p => p.name) } };
});
const position = { pstn_id: 'private-position', pstn_type: 0, market: 2, symbol: 'AAPL', stock_name: 'Apple',
  qty: '1.50', qty_avbl: '1', cost_price: '10.01', buy_avg_price: '10.01', cur_price: '12', mv: '18', profit: '2.985',
  profit_ratio: '0.1988011988', today_turnover: '0' };
const order = { order_id: 'private-order', symbol: 'AAPL', stock_name: 'Apple', market: 2, order_type: 1, side: 1, status: 3,
  qty: '9007199254740993.000', cum_qty: '0.25', price: '10.0100', avg_fill_price: '10.009999999999999',
  create_time: '9007199254740994', update_time: '9007199254740995', text: 'private-order-memo' };
const cash = { balance: '9007199254740993.0500', hold: '0', max_power_long: '1000000', total_asset: '1000000.50',
  mv: '0', long_mv: '0', short_mv: '0', realized_profit: null, unrealized_profit: '0.00' };
const power = { max_cash_buy_qty_round_lot: '1234.00', max_sell_qty_round_lot: '1', max_sell_short_qty: '0', max_buy_back_qty: '0' };
const providerCursor = 'private-destination-cursor=';
const window = { time_begin: '9007199254740993', time_end: '9007199254740997', page_size: 1 };
const size = { symbol: 'US.AAPL', order_type: 1, price: '19.000001000' };

test('only documented private simulator tools bind the reviewed hosted MCP origin and projection', () => {
  assert.equal(Object.keys(simulatorMcpSpecs).length, 5);
  const descriptor = listed.find(row => row.name === simulatorMcpSpecs[positionsOp].tool);
  verifySimulatorDescriptor(descriptor);
  for (const inputSchema of [{ type: 'object' }, { ...descriptor.inputSchema, required: ['market'] },
    { ...descriptor.inputSchema, properties: { ...descriptor.inputSchema.properties, market: { type: 'string' } } }]) {
    assert.throws(() => verifySimulatorDescriptor({ ...descriptor, inputSchema }), /SCHEMA_DRIFT/);
  }
  for (const [op, spec] of Object.entries(simulatorMcpSpecs)) {
    verifySimulatorMcpSpec(op, spec, origin);
    for (const delta of [{ tool: 'sim_trade_input_order' }, { pin_inputs: false }, { projection_digest: sha('changed') }]) {
      assert.throws(() => verifySimulatorMcpSpec(op, { ...spec, ...delta }, origin), /INVALID_MAPPING/);
    }
    assert.throws(() => verifySimulatorMcpSpec(op, spec, 'https://webapi.moomoo.com/'), /INVALID_MAPPING/);
  }
  assert.throws(() => verifySimulatorMcpSpec(ordersOperation, simulatorSpecs[ordersOperation], origin), /INVALID_MAPPING/);
});

test('signed hosted MCP simulator reads verify discovery and account selection before private dispatch and receipt lookup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-mcp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json'), expires = utc(Date.now() + 3600000);
  const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
  const keys = Object.fromEntries(Object.entries(pairs).map(([role, key]) => [role, { role, principal: role, runtime: role,
    publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) }]));
  const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
    privateKey: pairs.integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const mapping = { protocol, operations: simulatorMcpSpecs };
  const capability = { provider, protocol, transport: 'MCP', source: 'PROVIDER', mode: 'account', schema_digest: sha(listed),
    mapping_digest: sha(mapping), adapter_version: '1', adapter_digest: sha('mcp-simulator-fixture'),
    operations: Object.keys(simulatorMcpSpecs), allowlist: listed.map(row => row.name), cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('local-mcp-qual'), expires_utc: expires } };
  const { protocol: version, ...identity } = capability;
  const definition = { ...identity, schema: 'trading-provider-definition/v1', transport: { kind: 'MCP', protocol: version, origin }, mapping };
  const definitionExpiry = Date.now() + 120000;
  definition.qualification = { ...definition.qualification, expires_utc: utc(definitionExpiry) };
  const credential = { token: 'fixture-simulator-mcp-secret', simulator_account: account, alias_secret: secret, attestation };
  const config = { schema: 'trading-runtime-config/v1', database: 'ledger.sqlite', scope, candidate, keys,
    providers: [definition], provider_credentials: { [provider]: { transports: { MCP: credential } } },
    viewer_token: 'private-local-test-viewer-token-for-mcp-only', gateway: { audience_token: audience, capabilities: [capability] } };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const calls = [], network = globalThis.fetch;
  let expireAtTool;
  let accounts = [account], descriptors = listed, splitCatalog = false, responseCash = cash;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return network(url, options);
    assert.equal(url, origin); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + credential.token);
    const body = JSON.parse(options.body, (key, value, context) => ['time_begin', 'time_end'].includes(key) ? context.source : value);
    calls.push(body);
    const rpc = result => Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers: { 'Mcp-Session-Id': 'fixture-session' } });
    if (body.method === 'initialize') return rpc({ protocolVersion: protocol, capabilities: { tools: {} } });
    assert.equal(options.headers['Mcp-Session-Id'], 'fixture-session'); assert.equal(options.headers['MCP-Protocol-Version'], protocol);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') {
      if (splitCatalog && !body.params.cursor) return rpc({ tools: descriptors.slice(0, 1), nextCursor: 'catalog-next' });
      return rpc({ tools: splitCatalog ? descriptors.slice(1) : descriptors });
    }
    assert.equal(body.method, 'tools/call');
    const { name, arguments: args } = body.params;
    const source = { ret_code: 0 };
    switch (name) {
      case 'sim_trade_account_list': assert.deepEqual(args, {}); source.data = { accounts }; break;
      case 'sim_trade_cash_info': assert.deepEqual(args, { acc_id: account.account_id }); source.data = responseCash; break;
      case 'sim_trade_position_list': assert.deepEqual(args, { acc_id: account.account_id, market: 100 }); source.data = { positions: [position] }; break;
      case 'sim_trade_history_order_list': {
        const next = Object.hasOwn(args, 'next_key');
        assert.deepEqual(args, { acc_id: account.account_id, market: 100, ...window, ...(next && { next_key: providerCursor }) });
        source.data = { orders: next ? [] : [order] }; source.pagination = { has_more: !next, next_key: next ? '' : providerCursor };
        break;
      }
      case 'sim_trade_max_buy_sell': assert.deepEqual(args, { acc_id: account.account_id, market: 100, ...size }); source.data = power; break;
      default: assert.fail('Unexpected tool ' + name);
    }
    if (expireAtTool === name) t.mock.method(Date, 'now', () => definitionExpiry + 1000);
    return rpc(name === 'sim_trade_cash_info' ? { content: [{ type: 'text', text: JSON.stringify(source) }] } : { structuredContent: source });
  });

  const server = await runtimeCommand(['gateway', path, '0']); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (route, data) => (await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST',
    headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
  let sequence = 0;
  const binding = { provider, scope, account, secret, transport: 'MCP' };
  function request(operation, parameters = {}, change = () => {}) {
    const nonce = 'test-' + ++sequence;
    const tools = [...new Set([accountOperation, operation])].map(op => {
      const name = simulatorMcpSpecs[op].tool;
      return { name, operation: op, effect: 'read', schema_digest: sha(listed.find(row => row.name === name)),
        inputs_digest: sha(op === operation ? parameters : {}), account_binding_digest: simulatorBindingDigest(binding) };
    });
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 1000), expires_utc: expires, nonce, mapping_digest: sha(mapping), tools,
      limits: { max_calls: 5, timeout_ms: 3000 }, cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 8 },
      proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind + nonce), expires_utc: expires })) };
    change(payload);
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), pairs.operator.privateKey).toString('base64url') };
    return { contract_version: '1', scope, operation, request_id: nonce, capability_digest: sha(capability),
      inputs: { grant, ...parameters }, deadline_utc: utc(Date.now() + 300000) };
  }
  const run = req => post('/api/gateway', req);
  const inspect = req => post('/api/gateway/simulator-receipt', req);
  for (const req of [
    request(powerOperation, { ...size, order_ref: sha('existing') }), request(cashOp, { acc_id: 'caller-private-account' }),
    request(cashOp, {}, grant => { grant.tools.shift(); }),
    request(cashOp, {}, grant => { grant.tools[0].account_binding_digest = simulatorBindingDigest({ ...binding, transport: 'REST' }); }),
    request(historyOperation, { ...window, cursor: 'copied-raw-key' }),
    request(cashOp, {}, grant => { grant.limits.max_calls = 4; }),
  ]) assert.equal((await run(req)).status, 'REFUSED');
  assert.deepEqual(calls, []);
  for (const [op, params] of [[accountOperation, {}], [cashOp, {}], [positionsOp, {}], [historyOperation, window], [powerOperation, size]]) {
    const start = calls.length, req = request(op, params), receipt = await run(req);
    assert.equal(receipt.status, 'OK', JSON.stringify(receipt.error)); assert.equal(receipt.data.cost.tool_calls, op === accountOperation ? 4 : 5);
    assert.equal(calls.length - start, receipt.data.cost.tool_calls);
    assert.deepEqual(calls.slice(start + 3).map(row => row.params.name), [...new Set([simulatorMcpSpecs[accountOperation].tool, simulatorMcpSpecs[op].tool])]);
    assert.deepEqual(receipt.data.account, { ...scope, account_market_id: 100, currency: null });
    const row = receipt.data.rows[0];
    if (op === cashOp) assert.equal(row.balance, cash.balance);
    if (op === positionsOp) { assert.equal(row.qty, position.qty); assert.match(row.position_ref, /^[0-9a-f]{64}$/); }
    if (op === historyOperation) {
      assert.equal(row.create_time_us, order.create_time); assert.equal(row.avg_fill_price, order.avg_fill_price);
      assert.match(row.order_ref, /^[0-9a-f]{64}$/); assert.equal(row.has_remark, true);
      const cursor = receipt.data.pagination.next_cursor, before = calls.length;
      assert.equal((await run(request(op, { ...window, page_size: 2, cursor }))).status, 'REFUSED');
      assert.equal(calls.length, before);
      const next = await run(request(op, { ...window, cursor }));
      assert.deepEqual(next.data.pagination, { completed: true, next_cursor: null });
    }
    if (op === powerOperation) { assert.equal(row.price, size.price); assert.equal(row.max_cash_buy_qty_round_lot, power.max_cash_buy_qty_round_lot); }
    for (const token of [order.text, order.order_id, position.pstn_id, account.account_id, providerCursor, credential.token]) assert(!JSON.stringify(receipt).includes(token));
    const count = calls.length;
    assert.deepEqual((await inspect(req)).data, receipt.data);
    const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: req } });
    assert.deepEqual(replay.result.structuredContent, receipt); assert.equal(calls.length, count);
  }
  descriptors = listed.map(row => ({ ...row, description: 'changed' }));
  assert.equal((await run(request(cashOp))).status, 'REFUSED'); assert.equal(calls.at(-1).method, 'tools/list');
  descriptors = listed;
  splitCatalog = true;
  assert.equal((await run(request(cashOp))).status, 'REFUSED'); assert.equal(calls.at(-1).method, 'tools/list');
  const paged = await run(request(cashOp, {}, grant => { grant.limits.max_calls = 6; }));
  assert.equal(paged.data.cost.tool_calls, 6);
  accounts = [{ ...account, market_id: 1 }]; splitCatalog = false;
  assert.equal((await run(request(cashOp))).status, 'REFUSED'); assert.equal(calls.at(-1).params.name, 'sim_trade_account_list');
  accounts = [account]; responseCash = { ...cash, balance: 1.25 };
  assert.equal((await run(request(cashOp))).status, 'REFUSED');
  responseCash = cash;
  for (const name of ['sim_trade_account_list', 'sim_trade_cash_info']) {
    expireAtTool = name;
    assert.equal((await run(request(cashOp))).status, 'REFUSED');
    assert.equal(calls.at(-1).params.name, name);
    Date.now.mock.restore();
  }
});
