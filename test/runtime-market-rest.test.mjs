import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, sha } from '../runtime/core.mjs';
import { createRestMarketReadAdapter } from '../runtime/rest-market-read.mjs';
import { marketRestMapping, marketRestSpecs } from '../runtime/moomoo-market-rest.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { readResearchPage } from '../src/research-page.mjs';

const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture-market-rest' };
const candidate = sha('market-rest-fixture'), operator = generateKeyPairSync('ed25519'), integration = generateKeyPairSync('ed25519');
const keys = Object.fromEntries(Object.entries({ operator, integration }).map(([role, pair]) => [role, {
  role, principal: role, runtime: role, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
}]));
const attestation = { key_id: 'integration', principal: 'integration', runtime: 'integration',
  privateKey: integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const utc = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
const expires = utc(Date.now() + 3600000), mapping = marketRestMapping;
const operationList = Object.keys(marketRestSpecs), origin = 'https://webapi.moomoo.com/';
const provider = { schema: 'trading-provider-definition/v1', provider: 'market-rest-fixture', adapter_version: '1',
  adapter_digest: sha('market-rest-adapter'), schema_digest: sha(marketRestSpecs), mapping_digest: sha(mapping), mapping,
  operations: operationList, allowlist: operationList.map(op => marketRestSpecs[op].tool), source: 'PROVIDER', mode: 'account',
  transport: { kind: 'REST', origin, protocol: '1.0' }, cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
  qualification: { status: 'QUALIFIED', receipt_digest: sha('fixture-qualification'), expires_utc: expires } };

test('each native market REST method, origin, route and operation are pinned', () => {
  const adapter = p => createRestMarketReadAdapter({ provider: p, token: 'fixture-token-market-rest', attestation, scope, candidate, mapping: p.mapping });
  assert.throws(() => adapter({ ...provider, transport: { ...provider.transport, origin: 'https://example.invalid/' } }), /INVALID_MAPPING/);
  for (const delta of [{ path: '/api/v1.0/accounts/order' }, { method: 'GET' }, { tool: 'quote_rt_ticker' }, { pin_inputs: false }]) {
    const map = { ...mapping, operations: { 'read.depth': { ...marketRestSpecs['read.depth'], ...delta } } };
    assert.throws(() => adapter({ ...provider, mapping: map, mapping_digest: sha(map) }), /INVALID_MAPPING/);
  }
});

test('running gateway signs all four REST reads, replays them across inbound interfaces and preserves exact saved values', async t => {
  const { schema, mapping: definitions, transport, ...identity } = provider;
  const capability = { ...identity, transport: transport.kind, protocol: transport.protocol };
  const audience = 'fixture-market-rest-local-gateway-audience';
  const dir = await mkdtemp(join(tmpdir(), 'trading-market-rest-')), path = join(dir, 'config.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({ schema: 'trading-runtime-config/v1', scope, candidate, keys,
    database: 'state.sqlite', viewer_token: 'fixture-market-rest-local-viewer-secret', providers: [provider],
    provider_credentials: { [provider.provider]: { transports: { REST: { token: 'fixture-market-rest-credential', attestation } } } },
    gateway: { audience_token: audience, capabilities: [capability] } }), { mode: 0o600 });
  const symbol = 'HK.00700', time = 1780469195226;
  const cases = [
    ['read.ticker', { symbol }, 'POST', 'stock-quote', { code_list: [symbol] }, { quote_list: [{ code: symbol, name: 'Example', last_price: '345.600',
      data_time: time, data_date: '2026-06-03', volume: '9007199254740993' }] }],
    ['read.depth', { symbol, count: 2 }, 'POST', 'order-book', { code: symbol, num: 2 }, [{ code: symbol, name: 'Example',
      books: ['A', 'B'].map(exchange => ({ exchange, exchange_data_time_ms: time, order_volume_precision: 2, bid_flag: 1, ask_flag: 0,
        bid_list: [{ price: '345.5000', volume: 1280, order_count: 2 }], ask_list: [] })) }]],
    ['read.tape', { symbol, count: 2, period: ['NORMAL', 'AFTER'] }, 'GET', symbol + '/rt-ticker?num=2&period=NORMAL&period=AFTER', null,
      { code: symbol, volume_precision: 0, ticker_list: ['7647056964060558023', '7647056964060558022'].map(sequence => ({ sequence, time,
        price: '465.800', volume: 100, turnover: 46580, ticker_direction: 'SELL', period_type: 'NORMAL', tick_type: 'LATE' })) }],
    ['read.candles', { symbol, count: 1, ktype: 26, autype: 0 }, 'GET', symbol + '/cur-kline?num=1&ktype=26&autype=0', null,
      { kline_list: [{ code: symbol, date: 20260603, time_key: time, open_price: '345.50', high_price: 346, low_price: 344,
        close_price: '345.000', volume: 100, turnover: '34500.00' }] }],
  ];
  const calls = [], network = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return network(url, options);
    const entry = cases.find(x => url === origin + 'api/v1.0/quote/' + x[3]);
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body), token: options.headers.Authorization, redirect: options.redirect });
    const wire = JSON.stringify({ ret_code: 0, data: entry?.[5] }).replace(/"(764705696406055802[23])"/g, '$1');
    return new Response(wire, { headers: { 'content-type': 'application/json' } });
  });
  const server = await runtimeCommand(['gateway', path, '0']); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (route, body) => {
    const reply = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' } });
    assert.ok(reply.ok); return reply.json();
  };
  function request(operation, id, parameters, digest) {
    const spec = marketRestSpecs[operation];
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 2000), expires_utc: expires, nonce: id, mapping_digest: provider.mapping_digest,
      tools: [{ operation, name: spec.tool, schema_digest: spec.schema_digest, effect: 'read', ...(digest && { inputs_digest: digest }) }],
      limits: { max_calls: 3, timeout_ms: 10000 }, proofs: ['cost', 'rights', 'account'].map(kind =>
        ({ kind, digest: sha(kind + operation), expires_utc: expires })), cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 3 } };
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    return { contract_version: '1', scope, operation, request_id: id, capability_digest: sha(capability),
      inputs: { ...parameters, grant }, deadline_utc: utc(Date.now() + 60000) };
  }
  const pages = {};
  for (const [op, inputs, method, path, body] of cases) {
    const before = calls.length;
    for (const [suffix, args, digest] of [['-missing', inputs, null], ['-changed', inputs, sha({})],
      ['-extra', { ...inputs, account: 'other' }, sha({ ...inputs, account: 'other' })]]) {
      const refused = await post('/api/gateway', request(op, op + suffix, args, digest)); assert.equal(refused.status, 'REFUSED');
    }
    assert.equal(calls.length, before);
    const admitted = request(op, op, inputs, sha(inputs)), result = await post('/api/gateway', admitted);
    assert.equal(result.status, 'OK', JSON.stringify(result.error)); assert.equal(result.data.cost.tool_calls, 1);
    const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: admitted } });
    assert.deepEqual(replay.result.structuredContent, result); assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), { url: origin + 'api/v1.0/quote/' + path, method,
      body: body ?? undefined, token: 'Bearer fixture-market-rest-credential', redirect: 'error' });
    pages[op] = (await readResearchPage(replay)).rows;
  }
  assert.equal(pages['read.ticker'][0].volume, '9007199254740993');
  assert.equal(pages['read.ticker'][0].last, '345.600');
  assert.deepEqual(pages['read.depth'].map(row => row.exchange), ['A', 'B']); assert.equal(pages['read.depth'][0].bids[0].volume, '12.80');
  assert.deepEqual(pages['read.tape'].map(row => row.sequence), ['7647056964060558023', '7647056964060558022']);
  assert.equal(pages['read.candles'][0].close, '345.000'); assert.equal(pages['read.candles'][0].ktype, 26);
});
