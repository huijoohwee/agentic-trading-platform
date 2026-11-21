import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../scripts/serve.mjs';
import { example } from '../src/experiment.mjs';
import { catalog } from '../src/market.mjs';
test('one session, one guard and one revision across browser HTTP, gateway and MCP', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'practice-gateway-')),
    server = await serve(0, { practiceDirectory: dir });
  t.after(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port,
    base = origin + '/api/practice/';
  const first = await fetch(base + 'session'),
    cookie = first.headers.get('set-cookie').split(';')[0];
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const { scope, capabilities } = await (await fetch(base + 'capabilities', { headers: { cookie } })).json();
  const cap = capabilities[0],
    symbol = catalog[0].symbol;
  const post = (route, value, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value)
    });
  const req = (operation, inputs) => ({
    request_id: crypto.randomUUID(),
    contract_version: '1',
    scope,
    capability_digest: cap.capability_digest,
    operation,
    inputs,
    deadline_utc: new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  });
  const rpc = async (request) =>
    (
      await (
        await post('mcp', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: request.operation, arguments: request }
        })
      ).json()
    ).result.structuredContent;
  const listed = (await (await post('mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools.map(
    (tool) => tool.name
  );
  assert.deepEqual(listed.sort(), cap.operations.slice().sort());
  assert.equal(listed.includes('release'), false);
  const order = req('practice.order', { revision: 0, explicitIntent:true, symbol, side: 'BUY', type: 'MARKET', qty: 1 });
  const accepted = await (await post('gateway', order)).json();
  assert.equal(accepted.status, 'OK');
  assert.equal(accepted.data.notice, 'FILLED');
  const duplicate = await rpc(order);
  assert.deepEqual(duplicate.data, accepted.data);
  assert.equal(duplicate.ledger_revision, accepted.ledger_revision);
  const local = await (await fetch(base + 'session', { headers: { cookie } })).json();
  assert.equal(local.session.fills.length, 1);
  assert.equal(local.revision, accepted.ledger_revision);
  assert.equal((await rpc(req('practice.order', { ...order.inputs }))).error.code, 'CONFLICT');
  assert.equal((await rpc(req('practice.portfolio', {}))).data.holdings.length, 1);
  assert.ok((await rpc(req('practice.journal', {}))).data.csv.includes(symbol));
  assert.equal((await rpc(req('practice.experiment', { code: example }))).data.authority, false);
  assert.equal((await rpc(req('read.depth', { symbol }))).data.rows.bids.length, 20);
  const cross = await (await post('session', {}, { origin: 'http://foreign.invalid' })).json();
  assert.equal(cross.error, 'ORIGIN_DENIED');
  const noCookie = await post('gateway', order, { cookie: '' });
  assert.equal(noCookie.status, 401);
  const other = await fetch(base + 'session'),
    foreignCookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await post('gateway', order, { cookie: foreignCookie })).json()).status, 'REFUSED');
  assert.equal((await other.json()).session.fills.length, 0);
  assert.equal((await rpc(req('release', {}))).error.code, 'UNSUPPORTED');
  assert.equal((await rpc({ ...order, scope: { ...scope, account_alias: 'outside' } })).status, 'REFUSED');
});
