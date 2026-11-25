import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, sha } from '../runtime/core.mjs';
import { createRestMarketReadAdapter } from '../runtime/rest-market-read.mjs';
import { marketRestMapping, marketRestSpecs } from '../runtime/moomoo-market-rest.mjs';
import { openStore } from '../runtime/store.mjs';
import { readBudgetScope, reserveHistoryRead } from '../runtime/read-budget.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { readResearchPage } from '../src/research-page.mjs';
import { buildMoomooMarketRequest, describeMoomooArk, describeMoomooRanking } from 'agentic-gateway/connectors/moomoo-market-rest';
import { arkTools } from '../src/moomoo-research-tools.mjs';

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

test('history quota reservations share a durable provider-user pool across local aliases and refresh after pending calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'trading-history-pool-'));
  const path = join(dir, 'state.sqlite'), store = openStore(path), second = openStore(path);
  t.after(async () => { store.close(); second.close(); await rm(dir, { recursive: true, force: true }); });
  const firstAlias = readBudgetScope(scope), secondAlias = readBudgetScope({ ...scope, account_alias: 'other-alias' });
  const symbol = 'HK.00700', start = Date.UTC(2026, 10, 24), pool = sha('one-provider-user');
  const rights = { kind: 'rights', scope: 'quote:read', symbol, display: true, private_ledger: true };
  const cost = { kind: 'cost', digest: sha('history-call-allowance') };
  const quota = { kind: 'history-quota', symbol, pool_digest: pool, observed_utc: utc(start),
    active_target: false, remaining_targets: 1, deny_at_exhaustion: true };
  const grant = (change = {}, permission = rights) => ({ proofs: [permission, cost, { ...quota, ...change }],
    cost: { remaining_calls: 6 }, limits: { max_calls: 3, timeout_ms: 1000 }, expires_utc: utc(start + 60000) });
  assert.equal(reserveHistoryRead(store, firstAlias, grant(), symbol, start), start + 1000);
  assert.throws(() => reserveHistoryRead(second, secondAlias, grant(), symbol, start), /BUDGET_HALT/);
  assert.equal(second.read(secondAlias).revision, 0);
  assert.throws(() => reserveHistoryRead(second, secondAlias, grant({ observed_utc: utc(start - 1000) }), symbol, start), /STALE_EVIDENCE/);
  // An active target consumes calls, but takes no further target slot. Its in-flight window also counts.
  reserveHistoryRead(second, secondAlias, grant({ active_target: true }), symbol, start + 500);
  assert.throws(() => reserveHistoryRead(store, firstAlias, grant({ observed_utc: utc(start + 1000) }), symbol, start + 2000), /STALE_EVIDENCE/);
  const fresh = { observed_utc: utc(start + 2000) };
  assert.throws(() => reserveHistoryRead(second, secondAlias, grant(fresh, { ...rights, private_ledger: false }), symbol, start + 2000), /SCOPE_DENIED/);
  assert.throws(() => reserveHistoryRead(second, secondAlias, grant({ ...fresh, symbol: 'US.DIA' }), symbol, start + 2000), /MISSING_ADMISSION_PROOF/);
  reserveHistoryRead(store, firstAlias, grant(fresh), symbol, start + 2000);
  assert.equal(store.read(firstAlias).telemetry[cost.digest].calls, 6);
  assert.equal(second.read(secondAlias).telemetry[cost.digest].calls, 3);
});

test('running gateway signs current and historical market REST reads, replays them across inbound interfaces and preserves exact saved values', async t => {
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
  const token = 'ab'.repeat(24), history = 'read.candle-history', pool = sha('shared historic slot observation');
  const historyInputs = { symbol, start: '2026-06-03', end: '2026-06-04', ktype: 110, count: 1 };
  const observation = utc(Date.now() - 2000);
  const historicBar = { time_key: time, date: 20260603, time_zone: 480, open: 344, high: 346, low: 343, close: '345.0000',
    volume: '9007199254740993', turnover: '34500.0' };
  const distribution = Object.fromEntries(['in', 'out'].flatMap(side =>
    ['super', 'big', 'mid', 'small'].map(size => ['capital_' + side + '_' + size, '9007199254740993.1000'])));
  const flowTime = time - 1000;
  const cases = [
    ['read.dividend-calendar', { market: 'US', date: '2026-06-03', page_size: 1, page_flag: 'a/1' }, 'GET',
      'dividend-calendar?market=US&date=2026-06-03&page_size=1&page_flag=a%2F1', null,
      { items: [{ code: 'US.AAPL', name: 'Example', statement: 'USD 0.1000', ex_date: '2026-06-03',
        record_date: '', dividend_payable_date: '2026-07-01' }] }],
    ['read.economic-calendar', { begin_date: '2026-06-03', star: 3, page_size: 1 }, 'GET',
      'economic-calendar/list?begin_date=2026-06-03&star=3&page_size=1', null,
      { items: [{ article_id: '1000200030004000', item_type: 'ECONOMIC_DATA', title: 'Release', timestamp: Math.floor(time / 1000),
        country: 'US', star: 3, previous: '0.1200%', actual: '' }] }],
    ['read.capital-distribution', { symbol }, 'GET', symbol + '/capital-distribution', null, { ...distribution, update_time: time }],
    ['read.capital-flow-history', { symbol, period_type: 'WEEK', count: 2, next_time: time }, 'GET',
      symbol + '/capital-flow/history?period_type=WEEK&count=2&next_time=' + time, null,
      { flow_list: [{ capital_flow_item_time: flowTime, in_flow: '-9007199254740993.1000', main_in_flow: '-3.000',
        super_in_flow: '1.000', big_in_flow: '-4.000', mid_in_flow: '0', sml_in_flow: '-2.00', main_deal_ratio: '0.5000' }], next_time: flowTime }],
    ['read.market-state', { symbols: [symbol, 'CC.BTCUSD'], is_need_crypto_multi_broker: true }, 'POST', 'market-state',
      { code_list: [symbol, 'CC.BTCUSD'], is_need_crypto_multi_broker: true }, { market_state_list: [
        { code: symbol, market_state: 'AFTERNOON' }, { code: 'CC.BTCUSD', market_state: 'TRADING', broker_id: 1 },
        { code: 'CC.BTCUSD', market_state: 'REST', broker_id: 2 }] }],
    ['read.trading-days', { market: 'HK', start: '2025-12-22', end: '2025-12-24' }, 'GET',
      'trading-days?market=HK&start=2025-12-22&end=2025-12-24', null,
      { trading_days: [{ time: '2025-12-24', trade_date_type: 'MORNING', trade_second: 14400 }] }],
    [history, historyInputs, 'GET', symbol + '/history-kline?start=2026-06-03&end=2026-06-04&ktype=110&num=1', null,
      { kline_list: [historicBar], volume_precision: 3, next_time: time }],
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
  for (const [region, code, requestType] of [['us', 'US.NEW', 11], ['cn', 'SH.601077', 1],
    ['my', 'BMS.MYIPO007', 9], ['sg', 'SG.1V2', 10], ['jp', 'JP.7203', null]]) {
    const inputs = requestType === null ? {} : { request_type: requestType };
    const price = ['cn', 'my'].includes(region) ? 'ipo_price' : 'ipo_price_min';
    cases.push(['read.ipo-' + region, inputs, 'GET', 'ipo-list/' + region + (requestType === null ? '' : '?request_type=' + requestType),
      null, [{ code, name: 'Fixture', [price]: '9007199254740993.1000', is_user_applied: true }]]);
  }
  const rankings = {
    'top-movers': { market: 'US' }, 'us-pre-market': {}, 'us-after-hours': {}, 'us-overnight': {},
    'period-change': { market: 'SH' }, dividend: { market: 'US', rank_type: 'HIGH_YIELD' },
    'high-dividend-soe': {}, 'earnings-beat': { market: 'HK', beat_type: 'EPS' }, 'short-selling': { market: 'US' },
  };
  for (const [name, selectors] of Object.entries(rankings)) {
    const op = 'read.rank-' + name, inputs = { ...selectors, page_flag: 'prior/1', page_size: 1 };
    const fields = describeMoomooRanking(marketRestSpecs[op].tool);
    const row = Object.fromEntries([...fields.textFields.map(key => [key, '1.2000']),
      ...fields.decimalFields.map(key => [key, '-9007199254740993.1000']), ...fields.integerFields.map(key => [key, 17])]);
    row.code = (selectors.market ?? (name === 'high-dividend-soe' ? 'HK' : 'US')) + '.ABC';
    row.name = 'Fixture';
    cases.push([op, inputs, 'GET', 'rank/' + name + '?' + new URLSearchParams(inputs), null, { items: [row] }]);
  }
  for (const [op, tool] of Object.entries(arkTools)) {
    const descriptor = describeMoomooArk(tool), inputs = descriptor.symbol_path ? { symbol: 'US.AAPL' } : {};
    for (const [name, rule] of Object.entries(descriptor.params)) {
      if (name === 'page_size') inputs[name] = 1;
      else if (name === 'page_flag') inputs[name] = 'prior/1';
      else if (rule.enum) inputs[name] = rule.enum[0];
      else if (rule.integer) inputs[name] = rule.integer[0];
      else if (rule.boolean) inputs[name] = true;
      else if (rule.string) inputs[name] = 'fixture';
    }
    const row = {};
    for (const name of descriptor.field_names) {
      if (descriptor.fields[name]?.source === 'input' || descriptor.optional_fields.includes(name)) continue;
      row[name] = descriptor.decimal_text.includes(name) ? '9007199254740993.1000'
        : descriptor.date.includes(name) ? '2026-11-24'
          : descriptor.integers.includes(name) ? 17 : 'Fixture ' + name;
    }
    const context = names => Object.fromEntries(names.map(name => [name,
      descriptor.decimal_text.includes(name) ? name === 'max_abs_value_change' ? '12.3400' : '9007199254740993.1000'
        : descriptor.date.includes(name) ? '2026-11-24'
          : descriptor.integers.includes(name) ? 17 : 'Fixture ' + name]));
    const data = descriptor.single_row ? { ...row }
      : descriptor.groups ? { increased: [row], decreased: [] }
        : { items: [row] };
    if (descriptor.metadata_fields) Object.assign(data, context(descriptor.metadata_fields));
    if (descriptor.summary_fields) Object.assign(data, context(descriptor.summary_fields));
    const expected = buildMoomooMarketRequest(tool, inputs);
    cases.push([op, inputs, 'GET', expected.path.replace(/^\/api\/v1\.0\/quote\//, ''), null, data]);
  }
  const calls = [], network = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return network(url, options);
    const entry = cases.find(x => url === origin + 'api/v1.0/quote/' + x[3]);
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body), token: options.headers.Authorization, redirect: options.redirect });
    const wire = JSON.stringify({ ret_code: 0, data: entry?.[5], ...((entry?.[0].startsWith('read.rank-') || Object.hasOwn(arkTools, entry?.[0]) || ['read.dividend-calendar', 'read.economic-calendar'].includes(entry?.[0])) &&
      { pagination: { total: 2, completed: false, page_flag: Object.hasOwn(arkTools, entry?.[0]) ? 'next/2' : 'next/2' } }), ...(entry?.[0] === 'read.capital-flow-history' && { pagination: { has_more: true } }), ...(entry?.[0] === history && { pagination: { has_more: true, next_page_token: token } }) }).replace(/"(764705696406055802[23]|-?9007199254740993\.1000)"/g, '$1');
    return new Response(wire, { headers: { 'content-type': 'application/json' } });
  });
  const server = await runtimeCommand(['gateway', path, '0']); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (route, body) => {
    const reply = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' } });
    assert.ok(reply.ok); return reply.json();
  };
  function request(operation, id, parameters, digest, quotaChanges = {}) {
    const spec = marketRestSpecs[operation];
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', scope, candidate, principal: 'operator', runtime: 'operator',
      issued_utc: utc(Date.now() - 2000), expires_utc: expires, nonce: id, mapping_digest: provider.mapping_digest,
      tools: [{ operation, name: spec.tool, schema_digest: spec.schema_digest, effect: 'read', ...(digest && { inputs_digest: digest }) }],
      limits: { max_calls: 3, timeout_ms: 10000 }, proofs: ['cost', 'rights', 'account'].map(kind =>
        ({ kind, digest: sha(kind + operation), expires_utc: expires })), cost: { hard_cap_usd: 0, deny_at_exhaustion: true, remaining_calls: 3 } };
    if (operation === history) {
      Object.assign(payload.proofs.find(p => p.kind === 'rights'), { scope: 'quote:read', symbol, private_ledger: true, display: true });
      payload.proofs.push({ kind: 'history-quota', symbol, pool_digest: pool, observed_utc: observation, digest: sha('quota evidence'),
        active_target: false, remaining_targets: 1, deny_at_exhaustion: true, expires_utc: expires, ...quotaChanges });
      payload.cost.remaining_calls = 12;
    }
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), operator.privateKey).toString('base64url') };
    return { contract_version: '1', scope, operation, request_id: id, capability_digest: sha(capability),
      inputs: { ...parameters, grant }, deadline_utc: utc(Date.now() + 60000) };
  }
  const pages = {};
  for (const [op, inputs, method, path, body, data] of cases) {
    const before = calls.length;
    for (const [suffix, args, digest] of [['-missing', inputs, null], ['-changed', inputs, sha({ ...inputs, account: 'other' })],
      ['-extra', { ...inputs, account: 'other' }, sha({ ...inputs, account: 'other' })]]) {
      const refused = await post('/api/gateway', request(op, op + suffix, args, digest)); assert.equal(refused.status, 'REFUSED');
    }
    assert.equal(calls.length, before);
    if (op === history) {
      for (const [name, change] of [['absent', { kind: 'unrelated' }], ['wrong-target', { symbol: 'US.QQQ' }],
        ['no-slots', { remaining_targets: 0 }], ['expired', { expires_utc: utc(Date.now() - 5000) }]]) {
        const refused = await post('/api/gateway', request(op, op + name, inputs, sha(inputs), change));
        assert.equal(refused.status, 'REFUSED');
      }
      assert.equal(calls.length, before);
    }
    const admitted = request(op, op, inputs, sha(inputs)), result = await post('/api/gateway', admitted);
    assert.equal(result.status, 'OK', op + ': ' + JSON.stringify(result.error)); assert.equal(result.data.cost.tool_calls, 1);
    const replay = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: admitted } });
    assert.deepEqual(replay.result.structuredContent, result); assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), { url: origin + 'api/v1.0/quote/' + path, method,
      body: body ?? undefined, token: 'Bearer fixture-market-rest-credential', redirect: 'error' });
    let display;
    try { display = await readResearchPage(replay); } catch (error) {
      throw Error(op + ': ' + error.message + '; projected context=' + JSON.stringify(replay.result.structuredContent.data.metadata), { cause: error });
    }
    if (op.startsWith('read.ipo-')) {
      assert.deepEqual(display.rows[0], { code: data[0].code, name: 'Fixture',
        [op === 'read.ipo-cn' || op === 'read.ipo-my' ? 'ipo_price' : 'ipo_price_min']: '9007199254740993.1000' });
    }
    pages[op] = display.rows;
    if (op.startsWith('read.rank-')) {
      assert.deepEqual(display.pagination, { completed: false, cursor: 'next/2', total: 2 });
      assert.equal(display.rows[0].code, cases.find(entry => entry[0] === op)[5].items[0].code);
      const { decimalFields, integerFields } = describeMoomooRanking(marketRestSpecs[op].tool);
      for (const key of decimalFields) assert.equal(display.rows[0][key], '-9007199254740993.1000');
      for (const key of integerFields) assert.equal(display.rows[0][key], '17');
    }
    if (['read.dividend-calendar', 'read.economic-calendar'].includes(op)) {
      assert.deepEqual(display.pagination, { completed: false, cursor: 'next/2', total: 2 });
      if (op === 'read.dividend-calendar') assert.equal(display.rows[0].statement, 'USD 0.1000');
      else assert.equal(display.rows[0].previous, '0.1200%');
    }
    if (Object.hasOwn(arkTools, op)) {
      const descriptor = describeMoomooArk(arkTools[op]);
      const attested = replay.result.structuredContent.data.market_attestation?.header;
      assert.equal(display.rows.length, 1, op);
      for (const field of descriptor.decimal_text) {
        if (Object.hasOwn(display.rows[0], field)) assert.equal(display.rows[0][field], '9007199254740993.1000', op + ' ' + field);
      }
      if (descriptor.symbol_path) assert.equal(display.rows[0].symbol, inputs.symbol);
      if (descriptor.groups) assert.equal(display.rows[0].direction, 'INCREASED');
      if (descriptor.metadata_fields) {
        assert.deepEqual(Object.keys(display.metadata).sort(), descriptor.metadata_fields.slice().sort());
        assert.deepEqual(display.metadata, attested.metadata, op + ' metadata must come from the signed page');
      }
      if (descriptor.summary_fields) {
        assert.deepEqual(Object.keys(display.summary).sort(), descriptor.summary_fields.slice().sort());
        assert.deepEqual(display.summary, attested.summary, op + ' summary must come from the signed page');
      }
      assert.deepEqual(display.pagination, descriptor.pagination ? { completed: false, cursor: 'next/2', total: 2 } : null);
    }
    if (op === 'read.capital-flow-history') {
      assert.deepEqual(display.pagination, { completed: false, cursor: String(flowTime), total: null, nextTime: flowTime });
      assert.equal(display.rows[0].in_flow, '-9007199254740993.1000');
      assert.equal(display.rows[0].main_deal_ratio, '0.5000');
      assert.equal(Object.hasOwn(display.rows[0], 'acc_main_in_flow'), false);
    }
    if (op === 'read.capital-distribution') assert.equal(display.rows[0].capital_in_super, '9007199254740993.1000');
    if (op === history) {
      assert.deepEqual(display.pagination, { completed: false, cursor: token, total: null, token, nextTime: time });
      const exhausted = await post('/api/gateway', request(op, op + '-exhausted', inputs, sha(inputs)));
      assert.equal(exhausted.error.code, 'BUDGET_HALT'); assert.equal(calls.length, before + 1);
      const active = await post('/api/gateway', request(op, op + '-active', inputs, sha(inputs), { active_target: true }));
      assert.equal(active.status, 'OK', JSON.stringify(active.error)); assert.equal(calls.length, before + 2);
    }
  }
  assert.deepEqual(pages['read.market-state'].map(row => [row.symbol, row.broker_id]), [[symbol, null], ['CC.BTCUSD', 1], ['CC.BTCUSD', 2]]);
  assert.deepEqual(pages['read.trading-days'][0], { market: 'HK', market_date: '2025-12-24', trade_date_type: 'MORNING', trade_second: 14400 });
  assert.equal(pages[history][0].volume, '9007199254740.993'); assert.equal(pages[history][0].close, '345.0000');
  assert.equal(pages['read.ticker'][0].volume, '9007199254740993');
  assert.equal(pages['read.ticker'][0].last, '345.600');
  assert.deepEqual(pages['read.depth'].map(row => row.exchange), ['A', 'B']); assert.equal(pages['read.depth'][0].bids[0].volume, '12.80');
  assert.deepEqual(pages['read.tape'].map(row => row.sequence), ['7647056964060558023', '7647056964060558022']);
  assert.equal(pages['read.candles'][0].close, '345.000'); assert.equal(pages['read.candles'][0].ktype, 26);
});
