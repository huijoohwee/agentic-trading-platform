import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '../scripts/serve.mjs';
import { sha } from '../runtime/core.mjs';
import { DAY } from '../src/market.mjs';
export async function verifyLaboratory(browser) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-webmcp-')),
    partDir = join(dir, 'partitions');
  mkdirSync(partDir);
  const rows = Array.from({ length: 800 }, (_, i) => {
    const close = 100 + i * 0.1 + 10 * Math.sin(i * 0.25);
    return {
      time: Date.UTC(2021, 0, 1) + i * DAY,
      open: close - 0.5,
      low: close - 3,
      high: close + 2,
      close,
      volume: 100 + (i % 11)
    };
  });
  const bytes = JSON.stringify(rows);
  writeFileSync(join(partDir, 'fixture.json'), bytes);
  writeFileSync(
    join(partDir, 'manifest.json'),
    JSON.stringify({
      schema: 'trading-partitions/v1',
      timeUnit: 'UTC_ms',
      partitions: [
        {
          file: 'fixture.json',
          first: rows[0].time,
          last: rows.at(-1).time,
          sha256: sha(bytes),
          source: 'test fixture',
          creator: 'test',
          license: 'CC0-1.0',
          symbol: 'BTC.USDT',
          venue: 'fixture',
          marketType: 'spot',
          frame: '1d',
          kind: 'ohlcv'
        }
      ]
    })
  );
  const server = await serve(0, { practiceDirectory: dir }),
    origin = 'http://127.0.0.1:' + server.address().port,
    ctx = await browser.newContext(),
    guest = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const seen = new Set();
  try {
    await ctx.addInitScript(() => {
      const tools = new Map();
      window.testTools = tools;
      window.unregisteredTools = [];
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool(tool, { signal }) {
            if (tools.has(tool.name)) throw Error('Duplicate tool');
            tools.set(tool.name, tool);
            signal.addEventListener('abort', () => tools.delete(tool.name));
            return Promise.resolve();
          },
          unregisterTool(name) {
            window.unregisteredTools.push(name);
            tools.delete(name);
          }
        }
      });
    });
    const page = await ctx.newPage();
    const errors = [],
      envelopes = new Map(),
      compared = new Set();
    page.on('request', (req) => {
      if (req.url() === origin + '/api/practice/gateway' && req.method() === 'POST') {
        const body = req.postDataJSON();
        envelopes.set(body.operation, body);
      }
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    const tool = async (name, inputs = {}) => {
      seen.add(name);
      const result = await page.evaluate(
        async ([name, inputs]) => window.testTools.get(name).execute(inputs),
        [name, inputs]
      );
      const op = name.replace('_', '.'),
        body = envelopes.get(op);
      if (body && !compared.has(op) && result.request_id === body.request_id) {
        const post = (route, data) =>
          ctx.request
            .post(origin + '/api/practice/' + route, { data, headers: { Origin: origin } })
            .then((r) => r.json());
        const ui = await post('ui', body);
        const rpc = await post('mcp', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: op, arguments: body }
        });
        for (const other of [ui, rpc.result.structuredContent]) {
          assert.equal(other.status, result.status, op);
          assert.equal(other.ledger_revision, result.ledger_revision, op);
          assert.equal(other.request_id, result.request_id);
          if (result.data?.id) assert.equal(other.data.id, result.data.id);
          if (result.data?.session) assert.deepEqual(other.data.session.fills, result.data.session.fills);
          if (result.error) assert.equal(other.error.code, result.error.code);
        }
        compared.add(op);
      }
      return result;
    };
    const ok = async (name, inputs) => {
      const out = await tool(name, inputs);
      assert.equal(out.status, 'OK', name + ' ' + JSON.stringify(out.error));
      return out;
    };
    const id = () => crypto.randomUUID();
    await page.goto(origin);
    await page.waitForFunction(() => window.testTools.size === 2);
    await ok('desk_discover');
    await Promise.all([page.waitForURL('**/desk.html'), tool('desk_enter').catch(() => {})]);
    await page.waitForFunction(() => window.testTools.size === 23);
    const desc = await ok('desk_describe');
    assert.equal(desc.data.frames.length, 12);
    assert.equal((await tool('desk_describe', { unknown: true })).error.code, 'INVALID_INPUT');
    await ok('read_catalog', { query: 'ALD', venue: 'synthetic', count: 10 });
    await ok('practice_select', {
      symbol: 'ALD.USD',
      marketType: 'perpetual',
      venue: 'synthetic',
      frame: '10m',
      revision: 0,
      requestId: id()
    });
    assert.equal(await page.locator('#frame').inputValue(), '10m');
    assert.equal(await page.locator('#market-type').inputValue(), 'perpetual');
    await ok('desk_studies', { studies: ['ema20'], revision: 1, requestId: id() });
    const chart = await ok('desk_chart', { count: 20 });
    assert.equal(chart.data.bars.length, 20);
    assert.ok(chart.data.forming.time > chart.data.bars.at(-1).time);
    assert.equal((await ok('read_depth', { symbol: 'ALD.USD', count: 20 })).data.rows.bids.length, 20);
    assert.ok((await ok('read_tape', { symbol: 'ALD.USD', count: 10 })).data.volumes.buyer >= 0);
    const calendar = await ok('read_calendar', {
      market: 'US',
      begin_date: '2026-11-19',
      end_date: '2026-11-21',
      sort_type: 'HOT',
      count: 10
    });
    assert.equal(calendar.data.rows.length, 3);
    assert.equal(calendar.data.rows[0].published, true);
    assert.equal(calendar.data.rows[1].eps_actual, null);
    assert.equal(
      (await tool('read_calendar', { market: 'US', begin_date: '2026-11-19', end_date: '2026-11-27' })).error.code,
      'INVALID_PARAMETER'
    );
    const placed = {
      symbol: 'ALD.USD',
      marketType: 'perpetual',
      qty: 2,
      leverage: 2,
      side: 'BUY',
      type: 'MARKET',
      explicitIntent: true,
      revision: 2,
      requestId: id()
    };
    const fill = await ok('practice_order', placed);
    assert.equal(fill.data.notice, 'FILLED');
    assert.equal((await ok('practice_order', placed)).ledger_revision, fill.ledger_revision);
    assert.equal((await tool('practice_order', { ...placed, qty: 3 })).error.code, 'CONFLICT');
    assert.equal(
      (
        await tool('practice_order', {
          ...placed,
          qty: 3,
          side: 'SELL',
          reduceOnly: true,
          revision: 3,
          requestId: id()
        })
      ).error.code,
      'REDUCE_ONLY'
    );
    assert.equal(
      (await tool('practice_order', { ...placed, qty: 1000000, revision: 3, requestId: id() })).error.code,
      'LEVERAGE_LIMIT'
    );
    assert.equal(
      (await tool('practice_order', { ...placed, explicitIntent: false, revision: 3, requestId: id() })).error.code,
      'EXPLICIT_INTENT_REQUIRED'
    );
    const pending = await ok('practice_order', {
      ...placed,
      type: 'LIMIT',
      trigger: 1,
      revision: 3,
      requestId: id()
    });
    await ok('practice_cancel', {
      id: pending.data.session.orders[0].id,
      explicitIntent: true,
      revision: 4,
      requestId: id()
    });
    await ok('practice_funds', { amount: 12, explicitIntent: true, revision: 5, requestId: id() });
    await ok('practice_prediction', {
      symbol: 'ALD.USD',
      direction: 'up',
      confidence: 60,
      note: 'private note',
      horizon: '5m',
      explicitIntent: true,
      revision: 6,
      requestId: id()
    });
    assert.equal((await ok('practice_portfolio', {})).data.holdings[0].marketType, 'perpetual');
    assert.equal((await ok('desk_history', { count: 1, offset: 0 })).data.rows.length, 1);
    const observer = await ok('desk_observer');
    const monitor = await guest.newPage();
    await monitor.goto(origin + observer.data.path);
    await monitor.locator('#context').filter({ hasText: 'perpetual' }).waitFor();
    assert.ok(!(await monitor.locator('body').innerText()).includes('private note'));
    const bad = await monitor.evaluate(() =>
      fetch('/api/practice/observe', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + location.hash.slice(1) }
      }).then((r) => r.status)
    );
    assert.equal(bad, 403);
    assert.equal(
      (await tool('practice_reset', { explicitIntent: true, confirm: 'almost', revision: 7, requestId: id() }))
        .error.code,
      'CONFIRM_RESET'
    );
    await ok('practice_reset', {
      explicitIntent: true,
      confirm: 'RESET PAPER SESSION',
      revision: 7,
      requestId: id()
    });
    const code =
      'import numpy as np\ndef average(v):\n    return np.mean(v)\ndef strategy(candles):\n    print(average([1,2]))\n    return []';
    const version = await ok('research_save', { name: 'Offline test', code, requestId: id() });
    assert.equal(version.data.hash, sha(code));
    assert.equal((await ok('research_strategies')).data.catalog.length, 20);
    const input = { venue: 'fixture', start: '2021-01-01', end: '2023-02-28', capital: 10000 };
    const run = await ok('research_start', { ...input, hypothesis: 8, requestId: id() });
    const wait = async (run) => {
      for (let i = 0; i < 120; i++) {
        const out = await ok('research_get', { id: run.data.id });
        if (!['queued', 'running'].includes(out.data.status)) return out.data;
        await new Promise((r) => setTimeout(r, 75));
      }
      throw Error('Run never completed');
    };
    const single = await wait(run);
    assert.equal(single.rows.length, 1);
    assert.ok(single.receipt.scientificHash);
    const url = origin + '/api/practice/artifact?id=' + single.id;
    const original = await ctx.request.get(url);
    assert.equal(original.status(), 200);
    assert.equal(sha(await original.body()), single.receipt.compressedHash);
    assert.notEqual((await guest.request.get(url)).status(), 200);
    await ok('practice_select', {
      symbol: 'BTC.USDT',
      venue: 'fixture',
      marketType: 'spot',
      frame: '1d',
      revision: 8,
      requestId: id()
    });
    const overlay = await ok('research_overlay', { id: run.data.id, hypothesis: 8, requestId: id() });
    assert.ok(overlay.data.markers.length > 0);
    await monitor.locator('#context').filter({ hasText: 'BTC.USDT' }).waitFor();
    const suite = await ok('research_suite', { ...input, requestId: id() });
    assert.equal((await wait(suite)).rows.length, 20);
    // A cancelled run can be queued atomically with respect to the browser event loop.
    const pendingSuite = await ok('research_suite', { ...input, requestId: id() });
    const cancelled = await tool('research_cancel', { id: pendingSuite.data.id, requestId: id() });
    if (cancelled.status === 'OK') assert.equal(cancelled.data.status, 'cancelled');
    else assert.equal(cancelled.error.code, 'RUN_FINISHED');
    assert.equal((await ok('practice_portfolio')).ledger_revision, 9);
    assert.equal(seen.size, 25);
    assert.equal(compared.size, 23);
    await page.reload();
    await page.waitForFunction(() => window.testTools.size === 23);
    const records = [];
    const route = '**/api/practice/session';
    async function intercept(req) {
      if (req.request().method() !== 'POST') return req.continue();
      const body = req.request().postDataJSON();
      if (body.command.kind !== 'funds') return req.continue();
      records.push(body);
      if (records.length === 1) {
        await req.fetch();
        return req.abort('connectionreset');
      }
      return req.continue();
    }
    await page.route(route, intercept);
    async function addFunds() {
      await page.locator('#funds').evaluate((f) => {
        f.closest('details').open = true;
      });
      await page.locator('#funds input').fill('7.25');
      await page.locator('#funds button').click();
    }
    await addFunds();
    await page.locator('#notice').filter({ hasText: 'SAVE_UNKNOWN' }).waitFor();
    await page.reload();
    await page.waitForFunction(() => window.testTools.size === 23);
    await addFunds();
    await page.waitForFunction(() => sessionStorage.getItem('trading-practice-pending/v1') === null);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], records[1]);
    assert.equal((await ok('practice_portfolio')).ledger_revision, 10);
    // N5: navigation removes every WebMCP action; returning to the page re-registers them.
    const hidden = await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return { tools: window.testTools.size, unregistered: window.unregisteredTools.length };
    });
    assert.equal(hidden.tools, 0);
    assert.equal(hidden.unregistered, 23);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(() => window.testTools.size === 23);
    assert.deepEqual(errors, []);
  } finally {
    await guest.close();
    await ctx.close();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}
