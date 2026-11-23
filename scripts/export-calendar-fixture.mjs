import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha } from '../runtime/core.mjs';
import { runtimeCommand } from './runtime.mjs';

const operation = 'read.calendar';
const fixtureInputs = { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-21' };
const utcSeconds = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export async function captureCalendarFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'trading-calendar-'));
  let server;
  try {
    const audience = randomBytes(32).toString('hex');
    const scope = { environment: 'SIMULATE', profile: 'practice', account_alias: 'fixture' };
    const deadline = utcSeconds(Date.now() + 300_000);
    const capability = {
      source: 'MOCK', provider: 'synthetic', mode: 'account', adapter_version: '1',
      operations: [operation], allowlist: [operation],
      adapter_digest: sha('synthetic-market/v1'), schema_digest: sha('trading-calendar-fixture/v1'),
      mapping_digest: sha(fixtureInputs), cost: { hard_cap_usd: 0, deny_at_exhaustion: true },
      qualification: { status: 'QUALIFIED', receipt_digest: sha('synthetic-fixture'), expires_utc: deadline }
    };
    const config = {
      schema: 'trading-runtime-config/v1', candidate: sha(capability), database: 'fixture.sqlite',
      scope, keys: {}, viewer_token: randomBytes(32).toString('hex'),
      gateway: { audience_token: audience, capabilities: [capability] }
    };
    const configPath = join(directory, 'fixture.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    server = await runtimeCommand(['gateway', configPath, '0']);
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function call(path, payload) {
      const response = await fetch(origin + path, {
        method: payload ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + audience, 'Content-Type': 'application/json' },
        body: payload && JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw Error('Fixture gateway returned HTTP ' + response.status);
      if (response.status === 202) return;
      return response.json();
    }
    const rpc = (id, method, params) => call('/mcp', { jsonrpc: '2.0', id, method, params });
    const { capabilities } = await call('/api/gateway/capabilities');
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'calendar-fixture', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    await call('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await rpc(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map(tool => tool.name), [operation]);
    const request = { contract_version: '1', request_id: randomUUID(), operation, scope, inputs: fixtureInputs,
      capability_digest: capabilities[0].capability_digest, deadline_utc: deadline };
    const http = await call('/api/gateway', request);
    const mcp = await rpc(3, 'tools/call', { name: operation, arguments: request });
    assert.equal(http.status, 'OK');
    assert.equal(mcp.result.isError, false);
    assert.deepEqual(mcp.result.structuredContent, http);
    assert.equal(http.provenance.source, 'MOCK');
    const changed = await call('/api/gateway', { ...request, inputs: { ...fixtureInputs, market: 'HK' } });
    assert.equal(changed.error?.code, 'CONFLICTING_EVENT');

    // Feature the second synthetic row: its EPS actual is null, demonstrating that a missing estimate
    // is preserved as null rather than coerced to zero. Market-local date and microsecond time survive.
    const row = http.data.rows[1];
    const receipt = { schema: 'trading-calendar-fixture/v1', operation, source: http.data.source,
      market: fixtureInputs.market, begin_date: fixtureInputs.begin_date, end_date: fixtureInputs.end_date,
      code: row.code, name: row.name, earnings_date: row.earnings_date, earnings_timestamp: row.earnings_timestamp,
      pub_type: row.pub_type, period_text: row.period_text, eps_actual: row.eps_actual, eps_predict: row.eps_predict,
      price: row.price, published: row.published, request_id: http.request_id, ledger_revision: http.ledger_revision };
    return { ...receipt, digest: sha(receipt) };
  } finally {
    try {
      if (server) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function exportNewFile(path) {
  const fixture = await captureCalendarFixture();
  const staging = await mkdtemp(join(dirname(path), '.calendar-export-'));
  try {
    const complete = join(staging, 'receipt.json');
    await writeFile(complete, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
    await link(complete, path);
  } finally { await rm(staging, { recursive: true, force: true }); }
  console.log('Saved synthetic read.calendar · SHA-256 ' + fixture.digest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/export-calendar-fixture.mjs <new-receipt.json>');
  await exportNewFile(resolve(process.argv[2]));
}