import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerRoot } from '../scripts/build.mjs';
import { serve } from '../scripts/serve.mjs';
import { sha } from '../runtime/core.mjs';
import { createRuntimeApi } from '../runtime/http.mjs';
import { appendEvent, openStore } from '../runtime/store.mjs';

// Local MOCK data only: no ingestion adapters, provider clients, orders or credentials.
const viewerToken = 'MOCK-local-viewer-' + sha('runtime-browser-viewer');
const invalidToken = 'MOCK-invalid-viewer-' + sha('runtime-browser-invalid');
const candidate = sha('MOCK-runtime-browser-candidate');
const observed = '2026-11-19T09:00:00Z';
const retrieved = Date.parse('2026-11-19T09:01:00Z');
const privateOrder = 'PRIVATE-MOCK-broker-order-007';
const privateRun = 'PRIVATE-MOCK-forward-run-008';
const privateThread = 'PRIVATE-MOCK-thread-009';
const privateSecret = 'PRIVATE-MOCK-server-secret-never-public';
const secrets = [viewerToken, invalidToken, privateOrder, privateRun, privateThread, privateSecret];
const failures = [];
let passed = 0, browser, server, store, api;

async function check(name, action) {
  try { await action(); passed++; console.log('PASS ' + name); return true; }
  catch (error) { failures.push({ name, error }); console.error('FAIL ' + name + ': ' + error.message); return false; }
}
async function bounded(action, label) {
  let timer;
  try { return await Promise.race([action, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Timed out: ' + label)), 15000);
  })]); } finally { clearTimeout(timer); }
}
const waitText = (page, id, text) => page.waitForFunction(([id, text]) =>
  document.getElementById(id)?.textContent.includes(text), [id, text], { timeout: 10000 });
const noSecrets = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Private canary escaped the runtime boundary');
};

function seedGolden(scope) {
  store.transaction(scope, state => {
    const snapshot = (at, equity) => ({ source: 'MOCK', observed_utc: at, digest: sha('MOCK-' + at),
      portfolio: { equity, cash: equity - 500, dayPnl: equity - 100000,
        positions: [{ symbol: 'MOCK', quantity: 2, value: 500, flags: [] },
          { symbol: 'MOCK-GAP', quantity: null, value: null, flags: ['MISSING_MARK'] }] },
      input: { IN_Orders: [{ broker_order_id: privateOrder, symbol_key: 'MOCK', side: 'BUY', qty: 3,
        filled_qty: 1, status_src: 'PARTIAL', raw_prompt: privateSecret }] }, raw_credentials: privateSecret });
    state.snapshots = { opening: snapshot('2026-11-18T09:00:00Z', 100000), closing: snapshot(observed, 99000) };
    state.currentSnapshot = 'closing'; state.halted = true; state.haltReason = 'MOCK_SAFETY_HALT';
    state.telemetry = {
      'forward:mock': { source: { provider: 'MOCK', run_ref: privateRun, stream: 'schedule_run' },
        latest: { status: 'completed', push_status: 'failed', usage: { total_credits: null }, raw_prompt: privateSecret },
        thread_refs: [privateThread] },
      'forward-thread:mock': { thread_ref: privateThread, role: 'reviewer', status: 'requires_action',
        usage: { total_credits: null }, raw_prompt: privateSecret },
    };
    state.configs = { MOCK: { credential: privateSecret } };
  });
  // Paper decisions are coordinated under the account's practice scope, including competition readbacks.
  store.transaction({ ...scope, profile: 'practice' }, state => {
    const decision = { scope, status: 'BLOCKED', reason: 'MOCK_REVIEW_REQUIRED', raw_prompt: privateSecret };
    appendEvent(state, { id: 'MOCK-decision', type: 'MOCK', at: observed, data: decision });
    state.decisions = [{ ...decision, event_id: 'MOCK-decision' }];
  });
}

// Traverse storage generically rather than depending on the owner's IndexedDB layout.
function storedProjections(storage) {
  const found = [];
  const visit = value => {
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); if (parsed?.schema === 'trading-runtime-view/v1') found.push(parsed); } catch {}
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(storage); return found;
}
async function storageState(context, page) {
  return { durable: await bounded(context.storageState({ indexedDB: true }), 'browser storage read'),
    session: await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))) };
}
async function surface(page) {
  return page.locator('#runtime-output').evaluate(element => {
    const visit = node => node.nodeType === Node.TEXT_NODE ? node.textContent :
      [...node.childNodes].map(visit).join(' ') + (node.shadowRoot ? visit(node.shadowRoot) : '');
    return visit(element).replace(/\s+/g, ' ').trim();
  });
}
async function openRuntime(page, mobile) {
  const summary = page.locator('#runtime-readback > summary');
  if (mobile) await summary.tap(); else await summary.press('Enter');
  await page.locator('#runtime-refresh').waitFor();
  await page.waitForFunction(() => !document.querySelector('#runtime-refresh').disabled);
}
async function readRuntime(page, token, expectedStatus) {
  await bounded(page.locator('#runtime-token').fill(token), 'fill viewer token');
  const responseReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runtime');
  await bounded(page.locator('#runtime-refresh').click(), 'click runtime read');
  const response = await bounded(responseReady, 'runtime response');
  assert.equal(response.status(), expectedStatus);
  assert.equal(response.fromServiceWorker(), false, 'Runtime responses must bypass the service-worker cache');
  assert.equal(response.headers()['cache-control'], 'no-store');
  assert.equal(response.headers().vary, 'Authorization');
  await bounded(page.waitForFunction(() => !document.querySelector('#runtime-refresh').disabled), 'read completion');
  // Chrome may leave an unconsumed 401 body pending under interception; the UI rejects on status alone.
  return expectedStatus === 200 ? bounded(response.json(), 'runtime response JSON') : null;
}
async function checkGolden(page, scope, projection) {
  assert.equal(projection.source, 'NO_PROVIDER_OBSERVATION', 'MOCK data must never claim authenticated provider provenance');
  assert.equal(projection.readiness, 'UNQUALIFIED');
  assert.equal(projection.candidate, candidate);
  assert.equal(projection.account_alias, scope.account_alias);
  assert.equal(projection.profile, scope.profile);
  assert.equal(projection.environment, 'SIMULATE');
  assert.equal(projection.observed_utc, observed);
  assert.equal(projection.retrieved_utc, new Date(retrieved).toISOString());
  assert.equal(projection.snapshot_digest, sha('MOCK-' + observed));
  assert.deepEqual([projection.equity, projection.cash, projection.day_pnl, projection.max_drawdown], [99000, 98500, -1000, 0.01]);
  assert.deepEqual(projection.curve, [
    { at: '2026-11-18T09:00:00Z', equity: 100000, drawdown: 0 }, { at: observed, equity: 99000, drawdown: 0.01 },
  ]);
  assert.deepEqual(projection.counts, { positions: 2, orders: 1, decisions: 1, runs: 1, threads: 1 });
  const { digest, ...data } = projection;
  assert.equal(digest, sha(data)); noSecrets(projection);
  await page.getByRole('heading', { name: scope.account_alias + ' · ' + scope.profile, exact: true }).waitFor();
  const indicators = page.getByRole('list', { name: 'Runtime indicators' });
  assert.deepEqual(await indicators.locator('h2, h3, h4').allTextContents(), ['$99,000.00', '-$1,000.00', '1.00%']);
  for (const [name, rows] of [
    ['Positions (2)', [['MOCK', '2', '$500.00', '—'], ['MOCK-GAP', 'UNKNOWN', 'UNKNOWN', 'MISSING_MARK']]],
    ['Orders (1)', [['order-' + sha(privateOrder).slice(0, 16), 'MOCK', 'BUY', '3', '1', 'PARTIAL']]],
    ['Decisions (1)', [['decision-1', observed, 'BLOCKED', 'MOCK_REVIEW_REQUIRED']]],
    ['Forward observations (1)', [['run-' + sha(privateRun).slice(0, 16), 'schedule_run', 'completed', 'failed', 'UNKNOWN', '1']]],
    ['Thread observations (1)', [['thread-' + sha(privateThread).slice(0, 16), 'reviewer', 'requires_action', 'UNKNOWN']]],
  ]) {
    const table = page.getByRole('table', { name, exact: true });
    await table.waitFor();
    assert.equal(await table.locator('tbody tr').count(), rows.length, name);
    for (const [index, cells] of rows.entries()) assert.deepEqual(await table.locator('tbody tr').nth(index).locator('td').allTextContents(), cells, name);
  }
  assert.match(await surface(page), /HALTED: MOCK_SAFETY_HALT/);
  assert.equal(await page.locator('#runtime-output .worksheet-series svg').count(), 1, 'Two observed marks render a chart');
  noSecrets(await surface(page));
}

async function malformedViews(page, valid) {
  // Rehash malformed inputs so these checks exercise nested schemas, not only digest rejection.
  const mutations = [
    ['extra top-level field', v => { v.raw_prompt = privateSecret; }],
    ['extra count field', v => { v.counts.private = 1; }],
    ['negative count', v => { v.counts.orders = -1; }],
    ['count smaller than rows', v => { v.counts.positions = 0; }],
    ['invalid revision', v => { v.revision = 0.5; }],
    ['live environment', v => { v.environment = 'LIVE'; }],
    ['invalid source', v => { v.source = 'MOCK'; }],
    ['authority claim', v => { v.readiness = 'QUALIFIED'; }],
    ['invalid time', v => { v.observed_utc = 'yesterday'; }],
    ['wrong candidate', v => { v.candidate = 'not-a-digest'; }],
    ['invalid snapshot digest', v => { v.snapshot_digest = 'not-a-digest'; }],
    ['scalar money string', v => { v.equity = '99000'; }],
    ['position flags object', v => { v.positions[0].flags = [{}]; }],
    ['position flags overflow', v => { v.positions[0].flags = Array(17).fill('MOCK'); }],
    ['position value string', v => { v.positions[0].value = '500'; }],
    ['order quantity object', v => { v.orders[0].quantity = {}; }],
    ['decision timestamp number', v => { v.decisions[0].at = 1; }],
    ['run negative threads', v => { v.runs[0].threads = -1; }],
    ['run fractional threads', v => { v.runs[0].threads = 0.5; }],
    ['thread usage string', v => { v.threads[0].usage = 'unknown'; }],
    ['curve equity object', v => { v.curve[0].equity = {}; }],
    ['curve overflow', v => { v.curve = Array(129).fill(v.curve[0]); }],
    ['oversized projection', v => { v.account_alias = 'x'.repeat(64001); }],
  ];
  for (const group of ['positions', 'orders', 'decisions', 'runs', 'threads', 'curve']) {
    mutations.push([group + ' extra field', v => { v[group][0].private = privateSecret; }]);
    mutations.push([group + ' null row', v => { v[group][0] = null; }]);
    mutations.push([group + ' missing field', v => { delete v[group][0][Object.keys(v[group][0])[0]]; }]);
    if (group !== 'curve') mutations.push([group + ' overflow', v => { v[group] = Array(51).fill(v[group][0]); v.counts[group] = 51; }]);
  }
  const cases = mutations.map(([name, mutate]) => {
    const value = structuredClone(valid); mutate(value);
    const { digest: ignored, ...data } = value;
    value.digest = sha(data); return { name, value };
  });
  cases.push({ name: 'tampered digest', value: { ...valid, digest: '0'.repeat(64) } });
  const result = await page.evaluate(async ({ valid, cases }) => {
    const { validateRuntimeView } = await import('/src/runtime-view.mjs');
    await validateRuntimeView(valid);
    const accepted = [];
    for (const { name, value } of cases) {
      try { await validateRuntimeView(value); accepted.push(name); } catch {}
    }
    return accepted;
  }, { valid, cases });
  assert.deepEqual(result, [], 'Malformed projections accepted by the browser validator');
}

async function checkCaches(page, manifest) {
  const inventory = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) result.push({ name, url: request.url, body: await (await cache.match(request)).text() });
    }
    return result;
  });
  assert.ok(inventory.length > 0, 'Offline shell cache exists');
  assert.ok(inventory.some(item => new URL(item.url).pathname === '/src/runtime-view.mjs'));
  for (const item of inventory) {
    const url = new URL(item.url);
    assert.equal(url.origin, new URL(page.url()).origin);
    assert.ok(Object.hasOwn(manifest.files, url.pathname.slice(1)), 'Unexpected cached resource: ' + url.pathname);
    assert.doesNotMatch(url.pathname, /^\/(?:api|runtime)\/|\.(?:sqlite|db)(?:-|$)|\.env|\/config/);
    noSecrets(item.body);
  }
}
async function checkPrivatePaths(origin, manifest, directory) {
  const runtimeFiles = await readdir(new URL('../runtime/', import.meta.url), { recursive: true });
  const paths = [...runtimeFiles.map(name => '/runtime/' + name), '/ledger.sqlite', '/ledger.sqlite-wal', '/ledger.sqlite-shm',
    directory + '/ledger.sqlite', '/.env', '/.git/config', '/runtime.config.json', '/config.json',
    '/src/../runtime/store.mjs', '/%2e%2e/runtime/store.mjs', '/runtime%2fstore.mjs'];
  assert.ok(Object.hasOwn(manifest.files, 'src/runtime-view.mjs'));
  for (const name of Object.keys(manifest.files)) assert.doesNotMatch(name, /^runtime\/|\.(?:sqlite|db)(?:-|$)|^\.env|(?:^|\/)config/);
  for (const path of paths) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(origin + path, { method, redirect: 'error' });
      assert.equal(response.status, 404, method + ' must not serve ' + path);
      noSecrets(await response.text());
    }
  }
}

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(join(ownerRoot(), 'agentic-graph', 'package.json'))('playwright')); }
const directory = await mkdtemp(join(tmpdir(), 'trading-runtime-browser-'));
try {
  await chmod(directory, 0o700);
  store = openStore(join(directory, 'ledger.sqlite'));
  assert.equal((await stat(join(directory, 'ledger.sqlite'))).mode & 0o077, 0);
  server = await serve(0, { runtimeApi: (request, response) => api?.(request, response) ?? false });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const manifest = await (await fetch(origin + '/asset-manifest.json')).json();
  await check('private runtime modules, SQLite and configuration are not served', () => checkPrivatePaths(origin, manifest, directory));
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
  const sessions = [];
  for (const [name, viewport, mobile, profile] of [
    ['desktop', { width: 1240, height: 900 }, false, 'practice'],
    ['mobile360', { width: 360, height: 780 }, true, 'competition'],
  ]) {
    const scope = { environment: 'SIMULATE', profile, account_alias: 'MOCK-' + name };
    api = createRuntimeApi({ store, scope, candidate, viewerToken, now: () => retrieved });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'allow' });
    context.setDefaultTimeout(10000);
    const errors = [], requests = [], expectedHttpErrors = new Set();
    context.on('request', request => {
      const url = new URL(request.url()); requests.push({ url: request.url(), method: request.method() });
      if (url.origin !== origin) errors.push('Outside-origin request: ' + request.url());
      if (!['GET', 'HEAD'].includes(request.method())) errors.push('Unexpected write: ' + request.url());
      if (request.headers().authorization && url.href !== origin + '/api/runtime') errors.push('Authorization sent outside runtime endpoint');
      if (secrets.some(secret => request.url().includes(secret))) errors.push('Private canary leaked in a request URL');
    });
    context.on('requestfailed', request => errors.push('Failed request: ' + request.url() + ' ' + request.failure()?.errorText));
    context.on('page', page => {
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (secrets.some(secret => message.text().includes(secret))) errors.push('Private canary leaked to the console');
        if (message.type() !== 'error') return;
        const status = message.text().match(/^Failed to load resource: the server responded with a status of (\d+) /)?.[1];
        if (message.location().url === origin + '/api/runtime' && expectedHttpErrors.has(Number(status))) return;
        errors.push(message.location().url + ' ' + message.text());
      });
    });
    // Block and record regressions before any outside-origin request can reach a provider.
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    const runtimeRequests = () => requests.filter(request => new URL(request.url).pathname === '/api/runtime').length;
    const session = { name, context, page, mobile, scope, errors, requests, runtimeRequests, saved: null };
    sessions.push(session);
    await check(name + ': runtime browser scenario', async () => {
      await page.goto(origin);
      await waitText(page, 'offline-status', 'Offline ready'); await waitText(page, 'state', 'PASS');
      await page.waitForFunction(() => !document.querySelector('#fields').disabled);
      assert.equal(await page.locator('#runtime-output').count(), 0);
      assert.equal(await page.locator('#runtime-readback').evaluate(element => element.open), false);
      assert.equal(await page.locator('#runtime-token').count(), 0);
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/src/runtime-view.mjs'))), false);
      assert.equal(runtimeRequests(), 0, 'No automatic runtime read before disclosure');
      await openRuntime(page, mobile);
      await waitText(page, 'runtime-status', 'No runtime observation saved');
      assert.equal(await page.locator('#runtime-output').textContent(), '');
      assert.equal(await page.locator('#runtime-token').getAttribute('type'), 'password');
      assert.equal(await page.locator('#runtime-token').getAttribute('autocomplete'), 'off');
      assert.equal(runtimeRequests(), 0, 'Opening the disclosure does not make an authenticated read');
      const empty = await readRuntime(page, viewerToken, 200);
      await waitText(page, 'runtime-status', 'Read-only observation');
      assert.equal(empty.revision, 0); assert.equal(empty.observed_utc, null); assert.equal(empty.snapshot_digest, null);
      assert.equal(empty.source, 'NO_PROVIDER_OBSERVATION'); assert.equal(empty.equity, null);
      assert.deepEqual(empty.counts, { positions: 0, orders: 0, decisions: 0, runs: 0, threads: 0 });
      assert.match(await surface(page), /UNKNOWN/);
      assert.match(await surface(page), /at least two complete observed marks/);
      for (const group of ['positions', 'orders', 'decisions', 'runs', 'threads', 'curve']) assert.deepEqual(empty[group], []);
      assert.equal(await page.locator('#runtime-token').inputValue(), '');
      seedGolden(scope);
      const projection = await readRuntime(page, viewerToken, 200);
      await checkGolden(page, scope, projection);
      session.projection = projection;
      session.saved = await storageState(context, page);
      assert.deepEqual(storedProjections(session.saved), [projection]); noSecrets(session.saved);
      assert.equal(await page.locator('#runtime-token').inputValue(), '', 'Successful read clears the in-memory input');
      const reads = runtimeRequests();
      await page.locator('#runtime-refresh').click();
      await waitText(page, 'runtime-status', 'Enter the local runtime viewer token');
      assert.equal(runtimeRequests(), reads, 'A second read cannot reuse the previous token');
      await check(name + ': malformed nested rows and extra fields rejected', () => malformedViews(page, projection));
      const lastOutput = await surface(page), closing = store.read(scope).snapshots.closing;
      for (const kind of ['invalid viewer', 'failed read', 'corrupt projection']) {
        if (kind === 'failed read') store.transaction(scope, state => { state.snapshots.closing = null; });
        if (kind === 'corrupt projection') store.transaction(scope, state => { state.halted = 'not-a-boolean'; });
        const code = kind === 'invalid viewer' ? 401 : kind === 'failed read' ? 503 : 200;
        expectedHttpErrors.add(code);
        try {
          await readRuntime(page, kind === 'invalid viewer' ? invalidToken : viewerToken, code);
          await waitText(page, 'runtime-status', 'Last saved observation was not replaced.');
          assert.match(await page.locator('#runtime-status').textContent(), kind === 'invalid viewer' ? /Viewer token rejected/ :
            kind === 'failed read' ? /Runtime unavailable/ : /Invalid projection/);
          assert.equal(await surface(page), lastOutput, kind + ' must preserve the rendered golden observation');
          assert.deepEqual(await storageState(context, page), session.saved, kind + ' must preserve persisted data');
          await check(name + ': ' + kind + ' clears viewer input', async () => {
            assert.equal((await page.locator('#runtime-token').inputValue()).length, 0, 'Viewer input retained after ' + kind);
          });
        } finally {
          if (kind === 'failed read') store.transaction(scope, state => { state.snapshots.closing = closing; });
          if (kind === 'corrupt projection') store.transaction(scope, state => { state.halted = true; });
        }
      }
      await check(name + ': responsive read-only controls', async () => {
        assert.deepEqual(await page.locator('#runtime-body input').evaluateAll(inputs => inputs.map(input => input.type)), ['password']);
        assert.equal(await page.locator('#runtime-body').getByRole('button', { name: /submit|cancel|execute|approve|buy|sell|trade/i }).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Runtime overflows viewport');
      });
      await check(name + ': runtime and private data absent from SW cache', () => checkCaches(page, manifest));
      // The original journal remains independent of the runtime database and failure state.
      await page.getByLabel('Evaluation time (UTC)').fill('09:05:00'); await waitText(page, 'state', 'PASS');
      await page.getByRole('button', { name: 'Advance 1 s' }).click(); await waitText(page, 'state', 'FAIL');
      await page.getByLabel('Quantity', { exact: true }).fill('4');
      await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await waitText(page, 'revision', 'Revision 1');
      await page.locator('#evidence > summary').click(); await waitText(page, 'notional', '$100.00');
      assert.deepEqual(storedProjections(await storageState(context, page)), [projection]);
    });
  }
  // Close the real server, not just the page: successful reopen must be entirely local.
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  for (const session of sessions) {
    const { name, context, page, mobile, scope, errors, projection, runtimeRequests } = session;
    if (session.saved && projection) await check(name + ': closed-tab offline reopen and journal persistence', async () => {
      const reads = runtimeRequests();
      await context.setOffline(true); await waitText(page, 'offline-status', 'Working offline');
      await page.close();
      const reopened = await context.newPage();
      const response = await reopened.goto(origin);
      assert.equal(response.fromServiceWorker(), true);
      await waitText(reopened, 'offline-status', 'Working offline');
      await waitText(reopened, 'revision', 'Revision 1'); await waitText(reopened, 'state', 'FAIL');
      assert.equal(await reopened.getByLabel('Quantity', { exact: true }).inputValue(), '4');
      assert.equal(await reopened.getByLabel('Evaluation time (UTC)').inputValue(), '09:05:01');
      assert.equal(await reopened.locator('#runtime-token').count(), 0);
      await openRuntime(reopened, mobile); await waitText(reopened, 'runtime-status', 'Stored observation');
      await checkGolden(reopened, scope, projection);
      assert.equal(await reopened.locator('#runtime-token').inputValue(), '');
      const storage = await storageState(context, reopened);
      assert.deepEqual(storedProjections(storage), [projection]); noSecrets(storage);
      assert.equal(runtimeRequests(), reads, 'Offline restore does not fetch the API');
      await checkCaches(reopened, manifest);
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    await check(name + ': no unexpected console errors or outside-origin network requests', async () => assert.deepEqual(errors, []));
    await context.close();
  }
} finally {
  try { await browser?.close(); }
  finally {
    if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
    try { store?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
console.log(`Runtime browser: ${passed} checks passed; ${failures.length} failed. MOCK-only; no provider requests.`);
if (failures.length) throw new AggregateError(failures.map(({ name, error }) => new Error(name, { cause: error })), 'Runtime browser regressions');
