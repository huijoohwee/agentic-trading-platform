import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, sha } from '../runtime/core.mjs';
import { accountOperation, simulatorBindingDigest, simulatorSpecs, simulatorPage, verifySimulatorSpec } from '../runtime/moomoo-simulator-read.mjs';
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
  assert.throws(() => page(positionOp, { positions: [position, position] }), /INVALID_PAGE/);
  assert.throws(() => page(positionOp, { positions: [{ ...position, account_id: other.account_id }] }), /ACCOUNT_BINDING/);
  assert.throws(() => page(balanceOp, { ...cash, balance: 1.25 }), /PRECISION_UNKNOWN/);
  assert.throws(() => simulatorPage(balanceOp, { ret_code: -3, data: cash }, binding), /INVALID_PAGE/);
});

test('private gateway verifies the selected simulator before a cash or position GET and revalidates receipt replay', async t => {
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
    const resources = { [prefix + 'accounts']: { accounts }, [prefix + account.account_id + '/cash-info']: cash,
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
    const tools = [...new Set([accountOperation, operation])].map(op => ({ operation: op, name: simulatorSpecs[op].tool,
      schema_digest: simulatorSpecs[op].schema_digest, effect: 'read', inputs_digest: sha({}), account_binding_digest: bindingDigest }));
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
  await stop(); credential.simulator_account = other; await start();
  const count = calls.length;
  assert.equal((await run(cached)).status, 'REFUSED'); assert.equal(calls.length, count);
});
