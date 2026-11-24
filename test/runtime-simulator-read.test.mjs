import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, sha } from '../runtime/core.mjs';
import { accountOperation, ordersOperation, historyOperation, powerOperation, historyPagination, simulatorPath, simulatorBindingDigest, simulatorSpecs, simulatorPage, verifySimulatorSpec } from '../runtime/moomoo-simulator-read.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { readResearchPage } from '../src/research-page.mjs';

const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'practice/fixture' };
const candidate = sha('private simulator fixture');
const account = { account_id: 'sim-fixture-71873', account_type: 1, market_id: 100 };
const other = { ...account, account_id: 'different-id', account_title: 'other-account-title' };
const secret = 'a-fixture-only-secret-for-this-test';
const provider = 'moomoo-simulator-fixture', origin = 'https://webapi.moomoo.com/';
const binding = { account, secret, provider, scope }, bindingDigest = simulatorBindingDigest(binding);
const cash = { balance: '9007199254740993.000', hold: '0', max_power_long: '2000000', total_asset: '1000000',
  mv: '0', long_mv: '0', short_mv: '0', unrealized_profit: null, realized_profit: '-0.0100' };
const position = { pstn_id: 'private-position-139', pstn_type: 1, market: 2, symbol: 'AAPL', stock_name: 'Apple',
  qty: '5.000', qty_avbl: '2.125', cost_price: '24.64', buy_avg_price: '24.64', cur_price: '24.62', mv: '12310',
  profit: '-10', profit_ratio: '-0.08116883116883117', today_turnover: '-10', unrealized_profit: null };
const order = { order_id: 'order-private-1294505', side: 1, market: 2, symbol: 'AAPL', stock_name: 'Apple', order_type: 1,
  status: 3, qty: '1.0000', cum_qty: '0.2500', price: '42.1000', avg_fill_price: '42.000000000000001', aux_price: null,
  time_in_force: 0, order_trade_time_type: 1, create_time: '9007199254740992', update_time: '9007199254740993', text: 'private remark' };
const capacity = { max_cash_buy_qty_round_lot: '9007199254740993', max_margin_buy_qty_round_lot: null, max_sell_qty_round_lot: '12',
  max_sell_short_qty: '0', max_buy_back_qty: '0', required_im_long: null, required_im_short: null };
const providerCursor = 'private provider cursor +/=';
const balanceOp = 'read.simulator-balances', positionOp = 'read.simulator-positions';
const utc = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('simulator mapping pins native GETs and keeps exact account and instrument fields', () => {
  for (const [operation, spec] of Object.entries(simulatorSpecs)) {
    verifySimulatorSpec(operation, spec, origin);
    for (const delta of [{ path: '/api/v1.0/accounts/{acc_id}/funds' }, { method: 'POST' }, { pin_inputs: false }]) {
      assert.throws(() => verifySimulatorSpec(operation, { ...spec, ...delta }, origin), /INVALID_MAPPING/);
    }
    assert.throws(() => verifySimulatorSpec(operation, spec, 'https://example.invalid/'), /INVALID_MAPPING/);
  }
  assert.throws(() => simulatorBindingDigest({ ...binding, scope: { ...scope, profile: 'competition' } }), /ACCOUNT_BINDING/);
  const page = (op, data) => simulatorPage(op, { ret_code: 0, data }, binding);
  assert.deepEqual(page(positionOp, { positions: [] }), []);
  const pageBody = { data: { orders: [order] }, pagination: { has_more: true, next_key: providerCursor } };
  const first = historyPagination(pageBody, { page_size: 1 }, { ...binding, candidate });
  const next = { page_size: 1, cursor: first.next_cursor };
  for (const changed of [{ ...binding, account: other, candidate }, { ...binding, candidate: sha('other candidate') }]) {
    assert.throws(() => simulatorPath(historyOperation, changed.account, next, changed), /SCOPE_DENIED/);
  }
  assert.throws(() => historyPagination(pageBody, next, { ...binding, candidate }), /INVALID_PAGE/);
  assert.throws(() => historyPagination({ ...pageBody, data: { orders: [order, order] } }, { page_size: 1 }, binding), /INVALID_PAGE/);
  assert.throws(() => page(ordersOperation, { orders: [order, order] }), /INVALID_PAGE/);
  assert.throws(() => page(ordersOperation, { orders: [{ ...order, account_id: other.account_id }] }), /ACCOUNT_BINDING/);
  assert.throws(() => page(ordersOperation, { orders: [{ ...order, update_time: 9007199254740992 }] }), /PRECISION_UNKNOWN/);
  assert.throws(() => page(positionOp, { positions: [position, position] }), /INVALID_PAGE/);
  assert.throws(() => page(positionOp, { positions: [{ ...position, account_id: other.account_id }] }), /ACCOUNT_BINDING/);
  assert.throws(() => page(balanceOp, { ...cash, balance: 1.25 }), /PRECISION_UNKNOWN/);
  assert.throws(() => simulatorPage(balanceOp, { ret_code: -3, data: cash }, binding), /INVALID_PAGE/);
});

test('private simulator gateway reads the selected account, positions, orders, history and buying power and inspects completed receipts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trading-private-sim-')), path = join(dir, 'config.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = generateKeyPairSync('ed25519'), integration = generateKeyPairSync('ed25519');
  const keys = Object.fromEntries(Object.entries({ operator, integration }).map(([role, pair]) => [role, {
    role, principal: role, runtime: role, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  }]));
  const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
    privateKey: integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const expires = utc(Date.now() + 3600000), mapping = { protocol: '1.0', operations: simulatorSpecs };
  const capability = { provider, adapter_version: '1', adapter_digest: sha('fixture-adapter'), schema_digest: sha(simulatorSpecs),
    mapping_digest: sha(mapping), operations: Object.keys(simulatorSpecs), allowlist: Object.values(simulatorSpecs).map(spec => spec.tool),
    source: 'PROVIDER', mode: 'account', transport: 'REST', protocol: '1.0', cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
    qualification: { status: 'QUALIFIED', receipt_digest: sha('fixture-qualification'), expires_utc: expires } };
  const { protocol, ...identity } = capability;
  const definition = { ...identity, schema: 'trading-provider-definition/v1', mapping, transport: { kind: 'REST', origin, protocol } };
  const credential = { simulator_account: account, alias_secret: secret, token: 'fixture-selected-simulator-token', attestation };
  const audience = 'fixture-private-gateway-audience';
  const config = { schema: 'trading-runtime-config/v1', scope, candidate, keys, database: 'state.sqlite',
    viewer_token: 'fixture-private-viewer-token-only-for-this-test', providers: [definition], provider_credentials: { [provider]: { transports: { REST: credential } } },
    gateway: { audience_token: audience, capabilities: [capability] } };
  const calls = [], network = globalThis.fetch;
  let accounts = [other, account], server;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1') return network(url, options);
    assert.equal(target.origin + '/', origin); assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + credential.token); assert.equal(options.redirect, 'error');
    calls.push(target.pathname + target.search);
    const prefix = '/api/v1.0/sim-trade/';
    if (target.pathname === prefix + account.account_id + '/history-orders') {
      const more = !target.searchParams.has('next_key');
      return Response.json({ ret_code: 0, data: { orders: more ? [order] : [] }, pagination: { has_more: more, next_key: more ? providerCursor : '0' } });
    }
    if (target.pathname === prefix + account.account_id + '/max-buy-sell') return Response.json({ ret_code: 0, data: capacity });
    const resources = { [prefix + account.account_id + '/orders?market=100']: { orders: [order] }, [prefix + 'accounts']: { accounts }, [prefix + account.account_id + '/cash-info']: cash,
      [prefix + account.account_id + '/positions?market=100']: { positions: [position] } };
    assert(Object.hasOwn(resources, calls.at(-1)));
    return Response.json({ ret_code: 0, data: resources[calls.at(-1)] });
  });
  async function start() {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    server = await runtimeCommand(['gateway', path, '0']);
  }
  const stop = () => new Promise(resolve => server.close(resolve));
  await start(); t.after(() => stop());
  async function post(route, body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json();
  }
  let sequence = 0;
  function request(operation, modify = () => {}, extra = {}) {
    const nonce = 'request-' + ++sequence;
    const required = [accountOperation, operation];
    if (operation === powerOperation && extra.order_ref) required.push(ordersOperation);
    const tools = [...new Set(required)].map(op => ({ operation: op, name: simulatorSpecs[op].tool,
      schema_digest: simulatorSpecs[op].schema_digest, effect: 'read', inputs_digest: sha(op === operation ? extra : {}), account_binding_digest: bindingDigest }));
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 1000), expires_utc: expires, nonce, mapping_digest: sha(mapping), tools,
      limits: { max_calls: 3, timeout_ms: 3000 }, proofs: ['cost', 'rights', 'account'].map(kind =>
        ({ kind, digest: sha(kind + nonce), expires_utc: expires })), cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 3 } };
    modify(payload);
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    return { contract_version: '1', scope, operation, request_id: nonce, capability_digest: sha(capability),
      inputs: { grant, ...extra }, deadline_utc: utc(Date.now() + 60000) };
  }
  const run = request => post('/api/gateway', request);
  for (const invalid of [request(balanceOp, p => p.tools.shift()), request(balanceOp, p => { p.tools[0].account_binding_digest = sha('another'); }),
    request(positionOp, undefined, { market: 1 }), request(positionOp, undefined, { account_id: other.account_id }),
    request(balanceOp, p => { p.scope = { ...scope, profile: 'competition' }; })]) assert.equal((await run(invalid)).status, 'REFUSED');
  assert.deepEqual(calls, []);
  for (const bad of [[other], [account, account], [{ ...account, market_id: 1 }], [{ ...account, account_type: 2 }]]) {
    accounts = bad;
    assert.equal((await run(request(balanceOp))).status, 'REFUSED'); assert.equal(calls.at(-1), '/api/v1.0/sim-trade/accounts');
  }
  assert.equal(calls.length, 4);
  accounts = [other, account];
  const cached = request(positionOp);
  for (const [op, req] of [[accountOperation, request(accountOperation)], [balanceOp, request(balanceOp)], [positionOp, cached]]) {
    const before = calls.length, result = await run(req);
    assert.equal(result.status, 'OK', JSON.stringify(result.error));
    assert.deepEqual(result.data.account, { ...scope, account_market_id: 100, currency: null }); assert.equal(result.data.market, undefined);
    assert.equal(result.data.cost.tool_calls, op === accountOperation ? 1 : 2);
    assert.equal(calls.length - before, result.data.cost.tool_calls);
    assert(![account.account_id, other.account_id, other.account_title, position.pstn_id, secret].some(text => JSON.stringify(result).includes(text)));
    if (op === balanceOp) assert.deepEqual(result.data.rows[0], cash);
    if (op === positionOp) {
      const [row] = result.data.rows;
      assert.match(row.position_ref, /^[0-9a-f]{64}$/); assert.equal(row.side, 'short'); assert.equal(row.instrument_market, 2);
      assert.deepEqual([row.qty_avbl, row.profit_ratio, row.today_buy_qty], ['2.125', '-0.08116883116883117', null]);
    }
    const count = calls.length;
    const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: req } });
    assert.deepEqual(replay.result.structuredContent, result); assert.equal(calls.length, count);
    await assert.rejects(readResearchPage(result));
  }
  const window = { time_begin: '9007199254740992', time_end: '9007199254740999', page_size: 1 };
  const sizing = { symbol: 'US.AAPL', order_type: 1, price: '1.0000' };
  const lookupPath = '/api/gateway/simulator-receipt';
  const beforeOrders = calls.length;
  for (const bad of [
    request(historyOperation, undefined, { time_begin: '23', time_end: '22' }),
    request(historyOperation, undefined, { time_begin: 9007199254740992 }),
    request(historyOperation, undefined, { page_size: 601 }),
    request(historyOperation, undefined, { next_key: 'caller-cursor' }),
    request(powerOperation, undefined, { symbol: 'US.AAPL', order_type: 1 }),
    request(powerOperation, undefined, { ...sizing, price: 1 }),
    request(powerOperation, undefined, { ...sizing, order_id: order.order_id }),
    request(powerOperation, undefined, { ...sizing, price: '0.0000' }),
    request(ordersOperation, undefined, { market: 100 }),
  ]) assert.equal((await run(bad)).status, 'REFUSED');
  const changedSignedPrice = request(powerOperation, undefined, sizing);
  changedSignedPrice.inputs.price = '1.00'; assert.equal((await run(changedSignedPrice)).status, 'REFUSED');
  const currentRequest = request(ordersOperation);
  assert.equal((await post(lookupPath, currentRequest)).error.code, 'FINAL_READ_REQUIRED');
  assert.equal(calls.length, beforeOrders);
  const current = await run(currentRequest), [today] = current.data.rows;
  assert.equal(current.data.cost.tool_calls, 2); assert.equal(today.status, 3); assert.match(today.order_ref, /^[a-f0-9]{64}$/);
  assert.deepEqual([today.cum_qty, today.avg_fill_price, today.update_time_us, today.has_remark], ['0.2500', '42.000000000000001', '9007199254740993', true]);
  const historyRequest = request(historyOperation, undefined, window);
  const first = await run(historyRequest); assert.equal(first.status, 'OK', JSON.stringify(first.error));
  assert.equal(first.data.rows[0].order_ref, today.order_ref);
  assert.equal(first.data.pagination.completed, false); const token = first.data.pagination.next_cursor;
  const protection = [order.order_id, order.text, providerCursor];
  assert(protection.every(secret => !JSON.stringify([current, first]).includes(secret)));
  const afterFirst = calls.length;
  for (const selectors of [{ ...window, time_end: '9007199254741000', cursor: token }, { ...window, page_size: 2, cursor: token }]) {
    assert.equal((await run(request(historyOperation, undefined, selectors))).status, 'REFUSED');
  }
  assert.equal(calls.length, afterFirst);
  const next = await run(request(historyOperation, undefined, { ...window, cursor: token }));
  assert.equal(next.status, 'OK', JSON.stringify(next.error)); assert.deepEqual(next.data.pagination, { completed: true, next_cursor: null });
  assert.deepEqual(next.data.rows, []); assert.equal(new URL(calls.at(-1), origin).searchParams.get('next_key'), providerCursor);
  const marketPower = await run(request(powerOperation, undefined, { symbol: 'AAPL', order_type: 3 }));
  assert.equal(marketPower.status, 'OK'); assert.equal(marketPower.data.cost.tool_calls, 2); assert.equal(marketPower.data.rows[0].price, null);
  const forTicket = { ...sizing, order_ref: today.order_ref };
  const missingPermit = request(powerOperation, p => { p.tools = p.tools.filter(row => row.operation !== ordersOperation); }, forTicket);
  const beforeSizing = calls.length;
  assert.equal((await run(missingPermit)).status, 'REFUSED'); assert.equal(calls.length, beforeSizing);
  assert.equal((await run(request(powerOperation, undefined, { ...forTicket, symbol: 'US.MSFT' }))).status, 'REFUSED');
  assert.equal(calls.length, beforeSizing + 2); assert.ok(calls.at(-1).includes('/orders?'));
  const sizingRequest = request(powerOperation, undefined, forTicket);
  const sized = await run(sizingRequest); assert.equal(sized.status, 'OK', JSON.stringify(sized.error)); assert.equal(sized.data.cost.tool_calls, 3);
  assert.deepEqual(sized.data.rows[0], { ...forTicket, ...capacity });
  assert.deepEqual([...new URL(calls.at(-1), origin).searchParams], [['market', '100'], ['symbol', 'US.AAPL'], ['order_type', '1'], ['price', '1.0000'], ['order_id', order.order_id]]);
  const afterSizing = calls.length;
  for (const [req, receipt] of [[currentRequest, current], [historyRequest, first], [sizingRequest, sized]]) {
    const display = await post(lookupPath, req);
    const { display_until_utc, ...checkpoint } = display;
    assert(Date.parse(display_until_utc) <= Date.parse(expires)); assert.deepEqual(checkpoint, receipt);
    const rpc = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: req.operation, arguments: req } });
    assert.deepEqual(rpc.result.structuredContent, receipt); await assert.rejects(readResearchPage(receipt));
  }
  const altered = { ...currentRequest, deadline_utc: utc(Date.now() + 180000) };
  assert.equal((await post(lookupPath, altered)).error.code, 'FINAL_READ_REQUIRED');
  const future = Date.now() + 120000;
  const time = t.mock.method(Date, 'now', () => future);
  try {
    assert.equal((await run(currentRequest)).error.code, 'STALE');
    assert.equal((await post(lookupPath, currentRequest)).status, 'OK');
    time.mock.mockImplementation(() => future + 3600000);
    assert.equal((await post(lookupPath, currentRequest)).error.code, 'STALE');
  } finally { time.mock.restore(); }
  assert.equal(calls.length, afterSizing);
  if (process.env.TRADING_SIMULATOR_BROWSER === '1') {
    const { verifyReceiptBrowser } = await import('./simulator-receipt-browser.mjs');
    await verifyReceiptBrowser({ base: 'http://127.0.0.1:' + server.address().port, audience, current: currentRequest,
      history: historyRequest, sizing: sizingRequest, missing: request(historyOperation, undefined, window),
      privateStrings: [order.order_id, order.text, today.order_ref, '42.000000000000001'] });
    assert.equal(calls.length, afterSizing);
  }
  await stop(); credential.simulator_account = other; await start();
  const count = calls.length;
  assert.equal((await run(cached)).status, 'REFUSED');
  assert.equal((await post(lookupPath, currentRequest)).status, 'REFUSED'); assert.equal(calls.length, count);
});
