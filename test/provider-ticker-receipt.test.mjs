import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../runtime/core.mjs';
import { researchMapping } from '../runtime/moomoo-research.mjs';
import { openConfiguredRuntime, providerCredential } from '../runtime/config.mjs';
import { runtimeCommand } from '../scripts/runtime.mjs';
import { exportProviderTicker, providerTickerReceipt } from '../scripts/export-provider-ticker.mjs';

test('a single admitted provider dispatch survives HTTP/MCP retry and exports only its signed, rights-limited projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-receipt-'));
  const privateFile = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const configPath = join(directory, 'runtime.json'), requestPath = join(directory, 'request.json');
  const utc = offset => new Date(Date.now() + offset).toISOString().split('.')[0] + 'Z';
  const issued = utc(-3000), expiry = utc(3_600_000), retention = utc(4_000_000);
  const provider = 'conformance-feed', operation = 'read.ticker', symbol = 'US.AAPL';
  const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'private-conformance-alias' };
  const pairs = Object.fromEntries(['operator', 'integration'].map(role => [role, generateKeyPairSync('ed25519')]));
  const keys = Object.fromEntries(Object.entries(pairs).map(([role, pair]) => [role, { role, principal: role, runtime: role,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }]));
  const descriptor = { name: 'quote_stock_quote', inputSchema: { type: 'object' } };
  const mapping = { protocol: '2025-11-25', operations: { [operation]: { tool: descriptor.name,
    input_map: { code: 'symbol' }, rows_path: ['quotes'], fields: { price: { path: ['last'] }, currency: { path: ['currency'] },
      symbol: { path: ['code'] }, market_time_utc: { path: ['market_time'] } }, numeric: ['price'] } } };
  const cost = { hard_cap_usd: 0, deny_at_exhaustion: true };
  const definition = { schema: 'trading-provider-definition/v1', provider, adapter_version: '1',
    transport: { kind: 'MCP', origin: 'https://conformance.invalid/mcp', protocol: mapping.protocol },
    adapter_digest: sha('conformance-adapter'), schema_digest: sha(descriptor), mapping_digest: sha(mapping), mapping,
    operations: [operation], allowlist: [descriptor.name], mode: 'account', source: 'PROVIDER', cost,
    qualification: { status: 'QUALIFIED', receipt_digest: sha('conformance-only'), expires_utc: expiry } };
  const { schema, mapping: _mapping, ...cap } = definition;
  const capability = { ...cap, transport: 'MCP', protocol: mapping.protocol };
  const candidate = sha('conformance-' + randomUUID());
  const audience = randomBytes(32).toString('hex');
  const config = { schema: 'trading-runtime-config/v1', candidate, scope, database: 'receipt.sqlite', keys,
    providers: [definition], viewer_token: randomBytes(32).toString('hex'),
    provider_credentials: { [provider]: { token: randomBytes(32).toString('hex'), attestation: { key_id: 'integration',
      runtime: 'integration', principal: 'integration', privateKey: pairs.integration.privateKey.export({ type: 'pkcs8', format: 'pem' }) } } },
    gateway: { audience_token: audience, capabilities: [capability] } };
  const rankOp = 'read.rank', rankSpec = researchMapping.operations[rankOp];
  const rankDef = { ...definition, transport: { kind: 'REST', origin: 'https://research.invalid/', protocol: '1.0' },
    adapter_digest: sha('rank-adapter'), schema_digest: rankSpec.schema_digest, mapping_digest: sha(researchMapping),
    mapping: researchMapping, operations: [rankOp], allowlist: [rankSpec.tool] };
  const { schema: _schema, mapping: _research, ...rankBase } = rankDef;
  const rankCapability = { ...rankBase, transport: 'REST', protocol: '1.0' };
  const mcpCredential = config.provider_credentials[provider];
  assert.equal(providerCredential(config, provider, 'MCP'), mcpCredential);
  config.providers.push(rankDef);
  assert.throws(() => providerCredential(config, provider, 'REST'), /TRANSPORT_CREDENTIAL_REQUIRED/);
  config.gateway.capabilities.push(rankCapability);
  const restToken = randomBytes(32).toString('hex');
  config.provider_credentials[provider] = { transports: { MCP: mcpCredential, REST: { ...mcpCredential, token: restToken } } };
  const replayRight = { audience: 'graph-mainpanel', provider, symbol, display: true, offline_replay: true, retain_until_utc: retention };
  function requestWith(right, grantCost = cost) {
    const nonce = randomUUID();
    const payload = { schema: 'trading-runtime-envelope/v1', kind: 'read', principal: 'operator', runtime: 'operator',
      scope, candidate, issued_utc: issued, expires_utc: expiry, nonce, mapping_digest: sha(mapping),
      tools: [{ name: descriptor.name, operation, effect: 'read', schema_digest: sha(descriptor) }],
      cost: { ...grantCost, remaining_calls: 4 }, limits: { max_calls: 4, timeout_ms: 3000 },
      proofs: ['cost', 'rights', 'account'].map(kind => ({ kind, digest: sha(kind + nonce), expires_utc: expiry,
        ...(kind === 'rights' && right && { ticker_receipt: right }) })) };
    const grant = { key_id: 'operator', payload, signature: sign(null, Buffer.from(canonical(payload)), pairs.operator.privateKey).toString('base64url') };
    return { contract_version: '1', request_id: randomUUID(), operation, scope, capability_digest: sha(capability),
      inputs: { symbol, grant }, deadline_utc: utc(120_000) };
  }

  const price = '321.123456789012345600';
  let wirePrice = price;
  const methods = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).hostname === '127.0.0.1') return realFetch(url, options);
    if (new URL(url).origin === 'https://research.invalid') {
      assert.equal(options.headers.Authorization, 'Bearer ' + restToken);
      assert.equal(options.method, 'GET');
      assert.equal(new URL(url).pathname, '/api/v1.0/quote/rank/hot-list');
      return Response.json({ ret_code: 0, data: { items: [] }, pagination: { completed: true, page_flag: '', total: 0 } });
    }
    assert.equal(url, definition.transport.origin);
    assert.equal(options.headers.Authorization, 'Bearer ' + mcpCredential.token);
    const body = JSON.parse(options.body);
    methods.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') result = { protocolVersion: mapping.protocol, capabilities: { tools: {} } };
    else if (body.method === 'tools/list') result = { tools: [descriptor] };
    else {
      assert.equal(body.method, 'tools/call');
      assert.deepEqual(body.params, { name: descriptor.name, arguments: { code: symbol } });
      result = { structuredContent: { quotes: [{ code: symbol, last: wirePrice, currency: 'USD', market_time: issued, account: scope.account_alias }] } };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  let server;
  t.after(async () => {
    try { if (server) await new Promise(resolve => server.close(resolve)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await privateFile(configPath, config);
  server = await runtimeCommand(['gateway', configPath, '0']);
  async function post(path, body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, { method: 'POST',
      headers: { authorization: 'Bearer ' + audience, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok);
    return response.status === 202 ? null : response.json();
  }
  const rpc = (id, method, params) => post('/mcp', { jsonrpc: '2.0', id, method, params });
  const request = requestWith(replayRight);
  const http = await post('/api/gateway', request);
  assert.equal(http.status, 'OK', JSON.stringify(http.error));
  assert.equal(http.data.price_source, 'decimal-string');
  assert.equal((await rpc(1, 'initialize', { protocolVersion: mapping.protocol, capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.protocolVersion, mapping.protocol);
  await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await rpc(2, 'tools/list', {})).result.tools.map(item => item.name).sort(), [rankOp, operation].sort());
  const mcp = await rpc(3, 'tools/call', { name: operation, arguments: request });
  assert.deepEqual(mcp.result.structuredContent, http);
  assert.equal(mcp.result.isError, false);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  const rankRequest = requestWith(null);
  rankRequest.operation = rankOp;
  rankRequest.capability_digest = sha(rankCapability);
  const rankGrant = rankRequest.inputs.grant;
  rankGrant.payload.mapping_digest = rankDef.mapping_digest;
  rankGrant.payload.tools = [{ name: rankSpec.tool, operation: rankOp, effect: 'read', schema_digest: rankSpec.schema_digest }];
  rankGrant.signature = sign(null, Buffer.from(canonical(rankGrant.payload)), pairs.operator.privateKey).toString('base64url');
  rankRequest.inputs = { market: 'HK', grant: rankGrant };
  const rankHttp = await post('/api/gateway', rankRequest);
  assert.equal(rankHttp.status, 'OK', JSON.stringify(rankHttp.error));
  assert.deepEqual(rankHttp.data.pagination, { completed: true, next_cursor: null, total: 0 });
  const rankMcp = await rpc(4, 'tools/call', { name: rankOp, arguments: rankRequest });
  assert.deepEqual(rankMcp.result.structuredContent, rankHttp);
  await privateFile(requestPath, request);
  const output = join(directory, 'receipt.json');
  const cli = fileURLToPath(new URL('../scripts/export-provider-ticker.mjs', import.meta.url));
  execFileSync(process.execPath, [cli, configPath, requestPath, output]);
  await assert.rejects(exportProviderTicker(configPath, requestPath, output), { code: 'EEXIST' });
  const text = await readFile(output, 'utf8'), receipt = JSON.parse(text), p = receipt.payload;
  assert(verify(null, Buffer.from(canonical(p)), pairs.integration.publicKey, Buffer.from(receipt.signature, 'base64url')));
  assert.equal(p.price, price);
  assert.equal(p.retain_until_utc, expiry);
  assert.equal(p.delay_class, 'unknown');
  assert.equal(p.market_time_utc, issued);
  assert.equal(p.result_digest, http.data.digest);
  assert.equal(p.definition_digest, sha(definition));
  assert.equal(p.ledger_revision, http.ledger_revision);
  assert.equal(p.request_id, request.request_id);
  assert(!text.includes(scope.account_alias) && !text.includes('PRIVATE KEY') && !text.includes(audience) && Buffer.byteLength(text) <= 4096);
  assert.equal(methods.length, 4);

  // A number and its round-trip string display identically, but only the string supplies source decimals.
  wirePrice = 321.125;
  const numeric = requestWith(replayRight);
  const numericRead = await post('/api/gateway', numeric);
  assert.equal(numericRead.status, 'OK');
  assert.equal(numericRead.data.price_source, 'json-number');
  assert.equal(numericRead.data.decimals[0].price, '321.125');
  await privateFile(requestPath, numeric);
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /PRECISION_UNKNOWN/);

  wirePrice = '321.125';
  const sameDigits = requestWith(replayRight);
  const stringRead = await post('/api/gateway', sameDigits);
  assert.equal(stringRead.data.price_source, 'decimal-string');
  await privateFile(requestPath, sameDigits);
  assert.equal(providerTickerReceipt(configPath, requestPath).payload.price, '321.125');

  // A retained checkpoint from before the source type was recorded has no precision proof.
  const { store } = openConfiguredRuntime(configPath);
  try {
    store.transaction(scope, state => { delete state.checkpoints['gateway:' + sameDigits.request_id].result.data.price_source; });
  } finally { store.close(); }
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /PRECISION_UNKNOWN/);
  wirePrice = price;

  if (process.env.TRADING_RECEIPT_TEST_OUTPUT) {
    const dir = process.env.TRADING_RECEIPT_TEST_OUTPUT;
    await privateFile(join(dir, 'ticker.json'), receipt);
    await privateFile(join(dir, 'trust.json'), { candidate, provider, definition_digest: sha(definition),
      public_key: pairs.integration.publicKey.export({ format: 'jwk' }).x });
  }

  await privateFile(requestPath, { ...request, inputs: { ...request.inputs, symbol: 'US.OTHER' } });
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /FINAL_READ_REQUIRED/);
  const labelled = { ...requestWith(replayRight), request_id: 'internal/' + scope.account_alias };
  assert.equal((await post('/api/gateway', labelled)).status, 'OK');
  await privateFile(requestPath, labelled);
  const redacted = providerTickerReceipt(configPath, requestPath);
  assert.equal(redacted.payload.request_id, 'sha256:' + sha(labelled.request_id));
  assert(!JSON.stringify(redacted).includes(scope.account_alias));
  for (const right of [null, { ...replayRight, display: false }, { ...replayRight, offline_replay: false },
    { ...replayRight, symbol: 'US.OTHER' }, { ...replayRight, retain_until_utc: issued }]) {
    const other = requestWith(right);
    assert.equal((await post('/api/gateway', other)).status, 'OK');
    await privateFile(requestPath, other);
    assert.throws(() => providerTickerReceipt(configPath, requestPath), /TICKER_RIGHTS_REQUIRED|RECEIPT_EXPIRED/);
  }
  const denied = requestWith(replayRight, { ...cost, hard_cap_usd: 1 });
  assert.equal((await post('/api/gateway', denied)).error.code, 'BUDGET_HALT');
  await privateFile(requestPath, denied);
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /FINAL_READ_REQUIRED/);
  await privateFile(requestPath, request);
  config.keys.integration.revoked = true;
  await privateFile(configPath, config);
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /UNTRUSTED_SIGNER/);
  config.keys.operator.revoked = true;
  await privateFile(configPath, config);
  assert.throws(() => providerTickerReceipt(configPath, requestPath), /UNTRUSTED_PRINCIPAL/);
});
