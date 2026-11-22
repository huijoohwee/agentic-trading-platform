// Exercise the desk and the immutable artifact route with the installed, rights-qualified observations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, linkSync, readdirSync, renameSync } from 'node:fs';
import { serve } from './serve.mjs';
import { ownerRoot } from './build.mjs';
import { sha } from '../runtime/core.mjs';

const source = resolve(process.argv[2] ?? '.runtime-private/desk');
const root = join(source, 'qualification');
mkdirSync(root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(root, 'historical-desk-'));
const parts = join(dir, 'partitions');
mkdirSync(parts);
for (const file of readdirSync(join(source, 'partitions')))
  linkSync(join(source, 'partitions', file), join(parts, file));
const manifestPath = join(parts, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath));
const alter = (file, bytes) => {
  writeFileSync(file + '.next', bytes, { flag: 'wx' });
  renameSync(file + '.next', file);
};
const { chromium } = createRequire(join(ownerRoot(), 'agentic-graph', 'package.json'))('playwright');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
let server = await serve(0, { practiceDirectory: dir });
const port = server.address().port,
  origin = 'http://127.0.0.1:' + port;
const stop = () => new Promise((done, fail) => server.close((e) => (e ? fail(e) : done())));
const ctx = await browser.newContext();
const external = [];
await ctx.route('**/*', (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push(route.request().url());
  return route.abort();
});
await ctx.addInitScript(() => {
  const drawText = CanvasRenderingContext2D.prototype.fillText;
  window.paintedSignals = new Set();
  CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
    if (this.canvas.closest('[data-pane="price"]') && typeof label === 'string' && /^(BUY · entry|SELL · (stop|target))$/.test(label))
      window.paintedSignals.add(label);
    return drawText.call(this, label, ...args);
  };
  const actions = new Map();
  window.qualificationActions = actions;
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool, { signal }) {
        actions.set(tool.name, tool);
        signal.addEventListener('abort', () => actions.delete(tool.name));
      }
    }
  });
});
let page;
async function enter() {
  page = await ctx.newPage();
  await page.goto(origin + '/desk.html');
  await page.waitForFunction(() => window.qualificationActions.size === 22);
}
const call = async (name, input = {}) => {
  const out = await page.evaluate(
    ([op, args]) => window.qualificationActions.get(op).execute(args),
    [name, input]
  );
  assert.equal(out.status, 'OK', name + ' ' + JSON.stringify(out.error));
  return out;
};
const change = (op, input) => call(op, { ...input, requestId: randomUUID() });
async function submitResearch(form, suite) {
  const operation = suite ? 'research.suite' : 'research.start';
  const response = page.waitForResponse((r) => r.url() === origin + '/api/practice/ui' &&
    r.request().method() === 'POST' && r.request().postDataJSON()?.operation === operation);
  await form.getByRole('button', { name: suite ? 'Queue all 20' : 'Queue hypothesis', exact: true }).click();
  const envelope = await (await response).json();
  assert.equal(envelope.status, 'OK', JSON.stringify(envelope.error));
  return finish(envelope.data.id);
}
async function finish(id) {
  for (let i = 0; i < 1250; i++) {
    const { data } = await call('research_get', { id });
    if (!['queued', 'running'].includes(data.status)) return data;
    await page.waitForTimeout(100);
  }
  throw Error('Research run deadline ' + id);
}
const getBytes = async (id) => {
  const response = await ctx.request.get(origin + '/api/practice/artifact?id=' + id);
  assert.equal(response.status(), 200);
  return response.body();
};
try {
  await enter();
  const market = { symbol: 'BTC.USDT', venue: 'hyperliquid', marketType: 'perpetual', frame: '1m' };
  const initial = await call('practice_portfolio');
  await change('practice_select', { ...market, revision: initial.ledger_revision });
  await page.locator('#stream').filter({ hasText: 'historical' }).waitFor();
  const code =
    'import numpy as np\ndef sample(values):\n    return np.mean(np.array(values) * 2)\ndef strategy(candles):\n    print(sample([c["close"] for c in candles]))\n    return []';
  await page.locator('#code').fill(code);
  await page.locator('#strategy-name').fill('Archive qualification');
  await page.locator('#save-source').click();
  await page
    .locator('#saved-source option')
    .filter({ hasText: 'Archive qualification' })
    .waitFor({ state: 'attached' });
  const saved = (await call('research_strategies')).data.saved.find((s) => s.code === code);
  assert.equal(saved.hash, sha(code));
  await page.locator('#run').click();
  const candles = (await call('desk_chart', { ...market, count: 300 })).data.bars;
  await page.waitForFunction(() => document.querySelector('#logs').textContent.length > 0);
  const measured = Number(await page.locator('#logs').innerText());
  const average = candles.reduce((s, c) => s + c.close * 2, 0) / candles.length;
  assert.ok(Math.abs(average - measured) < 1e-7, 'worker must use the closed venue candles');
  await page.locator('#storage').filter({ hasText: /saved/i }).waitFor();
  const revision = (await call('practice_portfolio')).ledger_revision;
  const singleInput = { ...market, hypothesis: 18, start: '2025-03-23', end: '2025-03-23', capital: 100000 };
  const single = await finish((await change('research_start', singleInput)).data.id);
  assert.ok(single.rows[0].metrics.tradeCount > 0);
  const overlay = (await change('research_overlay', { id: single.id, hypothesis: 18 })).data;
  const chart = (await call('desk_chart', { ...market, count: 300 })).data;
  assert.ok(overlay.markers.length && chart.markers.length);
  assert.equal(chart.quality, 'historical');
  assert.equal(chart.market.venue, market.venue);
  assert.deepEqual(chart.markers, overlay.markers);
  const input = { venue: market.venue, capital: 100000 };
  const request = { ...input, requestId: randomUUID() };
  const queued = (await call('research_suite', request)).data;
  assert.equal((await call('research_suite', request)).data.id, queued.id);
  const cold = await finish(queued.id);
  assert.deepEqual(
    cold.rows.map((r) => r.id),
    Array.from({ length: 20 }, (_, i) => i + 1)
  );
  assert.deepEqual(
    cold.trace.map((t) => t.status),
    ['queued', 'running', 'partial']
  );
  for (const id of [8, 12, 19, 20]) {
    const row = cold.rows[id - 1];
    assert.ok(row.status === 'blocked' && row.return === null && row.reason);
  }
  assert.ok(cold.rows[14].status === 'partial' && cold.rows[14].actual);
  const marchLiquidations = await finish(
    (
      await change('research_start', {
        venue: market.venue,
        hypothesis: 15,
        start: singleInput.start,
        end: singleInput.end
      })
    ).data.id
  );
  assert.equal(marchLiquidations.status, 'blocked');
  assert.deepEqual(
    cold.rows[16].latencyScenarios.map((x) => x.latency),
    [50, 100, 250, 500]
  );
  assert.ok(cold.rows[16].actual[1] - cold.rows[16].actual[0] <= 3600000);
  const artifact = await getBytes(cold.id);
  assert.equal(sha(artifact), cold.receipt.compressedHash);
  assert.equal(sha(gunzipSync(artifact)), cold.receipt.scientificHash);
  await page.close();
  await stop();
  server = await serve(port, { practiceDirectory: dir });
  await enter();
  const warm = await finish((await change('research_suite', input)).data.id);
  assert.equal(warm.receipt.originalRun, cold.id);
  assert.equal(warm.receipt.cached, true);
  assert.equal(cold.receipt.cached, false);
  assert.notEqual(warm.id, cold.id);
  assert.deepEqual(await getBytes(warm.id), artifact);
  const alternate = await finish(
    (await change('research_suite', { ...input, basket: ['UBTC.USDC', 'UETH.USDC', 'USOL.USDC'] })).data.id
  );
  assert.deepEqual(alternate.rows[18].basket, ['UBTC.USDC', 'UETH.USDC', 'USOL.USDC']);
  assert.ok(alternate.rows[7].metrics && alternate.rows[18].metrics);
  assert.equal(alternate.rows[19].status, 'blocked');
  let nativeSpot;
  if (process.argv.includes('--native-spot')) {
    const venue = 'bitmex';
    const form = page.locator('#historical');
    assert.equal(await form.locator('#hypothesis option').count(), 20);
    await page.getByRole('link', { name: 'Historical research', exact: true }).click();
    assert.equal(new URL(page.url()).hash, '#historical-research');
    assert.equal(await form.locator('[name=venue]').inputValue(), input.venue);
    assert.equal(await form.locator('[name=spotVenue]').inputValue(), venue);
    const run = await submitResearch(form, true);
    const carry = manifest.partitions.some((p) => p.venue === 'binance' && p.mapping === 'matched-hour-turnover/v1');
    assert.deepEqual(run.rows.filter((r) => r.status === 'blocked').map((r) => r.id), carry ? [20] : [12, 20]);
    if (carry) {
      const row = run.rows[11];
      assert.equal(row.market.venue, 'binance');
      assert.equal(row.status, 'partial');
      assert.ok(row.matchedObservations >= 128);
      assert.ok(row.warnings.some((warning) => warning.startsWith('Modeled liquidity')));
    }
    for (const row of run.rows.filter((r) => ![8, 19].includes(r.id) && !(carry && r.id === 12))) {
      assert.equal(row.market.venue, input.venue);
      assert.equal(row.status, cold.rows[row.id - 1].status);
      assert.equal(row.return, cold.rows[row.id - 1].return);
    }
    const previews = run.rows.filter((r) => [8, 19].includes(r.id));
    assert.equal(previews.length, 2);
    for (const row of previews) {
      assert.equal(row.market.venue, venue);
      assert.equal(row.market.marketType, 'spot');
      assert.equal(row.status, 'partial');
      assert.ok(row.actual && row.warnings.includes('Incomplete indicator warm-up'));
      assert.equal(row.return, null);
    }
    const days = {};
    for (const [symbol, count] of [['BTC.USDT', 11], ['ETH.USDT', 12], ['SOL.USDT', 14]]) {
      const { data } = await call('desk_chart', { venue, marketType: 'spot', symbol, frame: '1d', count: 90 });
      assert.equal(data.source.id, 'https://doi.org/10.21950/HFPJ2F');
      assert.equal(data.bars.length, count);
      days[symbol] = count;
    }
    nativeSpot = { venue, days, id: run.id, rows: previews, receipt: run.receipt,
      suiteOutcomes: run.rows.map(({ id, market, status, actual, return: result, reason, profitability }) =>
        ({ id, market, status, actual, result, reason, profitability })) };
  }
  const changed = await finish((await change('research_suite', { ...input, capital: input.capital / 2 })).data.id);
  assert.equal(changed.receipt.cached, false);
  assert.notEqual(changed.receipt.inputHash, cold.receipt.inputHash);
  const soon = (await change('research_suite', input)).data;
  await change('research_cancel', { id: soon.id });
  assert.equal((await finish(soon.id)).status, 'cancelled');
  const btc = manifest.partitions.find((p) => p.venue === market.venue && p.kind === 'taker');
  const file = join(parts, btc.file),
    bytes = readFileSync(file);
  alter(file, 'damaged test copy');
  const failed = await finish((await change('research_start', singleInput)).data.id);
  assert.equal(failed.error, 'ARCHIVE_DIGEST_MISMATCH');
  alter(file, bytes);
  alter(
    manifestPath,
    JSON.stringify({ ...manifest, partitions: manifest.partitions.filter((p) => p.kind !== 'taker') })
  );
  const missing = await finish((await change('research_start', singleInput)).data.id);
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.rows[0].return, null);
  assert.equal(missing.receipt.cached, false);
  assert.notEqual(missing.receipt.inputHash, single.receipt.inputHash);
  assert.equal((await call('practice_portfolio')).ledger_revision, revision);
  const beforeQuota = (await call('research_strategies')).data.runs.length;
  const quota = await page.evaluate(async () => {
    const tool = window.qualificationActions.get('research_start');
    const jobs = await Promise.all(
      Array.from({ length: 31 }, () =>
        tool.execute({
          hypothesis: 20,
          venue: 'hyperliquid',
          start: '2021-01-01',
          end: '2021-01-02',
          requestId: crypto.randomUUID()
        })
      )
    );
    return {
      accepted: jobs.filter((j) => j.status === 'OK').length,
      refused: jobs.filter((j) => j.error?.code === 'RESEARCH_QUOTA').length
    };
  });
  assert.equal(quota.accepted, 30 - beforeQuota);
  assert.equal(quota.accepted + quota.refused, 31);
  assert.equal((await call('practice_portfolio')).ledger_revision, revision);
  const catalogRuns = [];
  if (nativeSpot && process.argv.includes('--catalog')) {
    alter(manifestPath, JSON.stringify(manifest));
    await page.close();
    await ctx.clearCookies();
    await enter();
    const form = page.locator('#historical');
    await form.locator('[name=venue]').fill(input.venue);
    await form.locator('[name=spotVenue]').fill(nativeSpot.venue);
    const paper = await call('practice_portfolio');
    const currentSymbol = await page.locator('#symbol').innerText();
    for (const expected of nativeSpot.suiteOutcomes) {
      await page.evaluate(() => window.paintedSignals.clear());
      await form.locator('#hypothesis').selectOption(String(expected.id));
      const run = await submitResearch(form, false);
      assert.equal(run.rows.length, 1);
      const [row] = run.rows;
      assert.equal(row.id, expected.id);
      assert.deepEqual(row.market, expected.market);
      assert.equal(row.status, expected.status);
      assert.equal(row.return, expected.result);
      assert.deepEqual(row.actual, expected.actual);
      assert.equal(row.reason, expected.reason);
      if (row.status === 'blocked') {
        await page.locator('#lab-status').filter({ hasText: 'No chart for hypothesis ' + row.id + ' · ' }).waitFor();
        assert.equal(await page.locator('#view-run-chart').isHidden(), true);
        assert.equal(await page.locator('#run-chart').isHidden(), true);
      } else {
        await page.locator('#run-chart-title').filter({ hasText: 'H' + row.id + ' · ' }).waitFor();
        assert.ok((await page.locator('#run-chart-info').innerText()).includes(row.market.symbol));
        assert.ok((await page.locator('#ticket-market').innerText()).includes(currentSymbol));
        if (row.id === 18) {
          await page.locator('#view-run-chart').click();
          await page.waitForFunction(() => window.paintedSignals.has('BUY · entry') &&
            [...window.paintedSignals].some((label) => label.startsWith('SELL · ')));
          const projection = (await call('research_get', { id: run.id, hypothesis: 18 })).data;
          assert.ok(projection.bars.length && projection.markers.length);
          assert.equal(projection.source.license, chart.source.license);
          await page.locator('#resume-chart').click();
          await page.locator('#desk-quote').waitFor();
          assert.equal(await page.locator('#symbol').innerText(), currentSymbol);
          assert.equal((await call('practice_portfolio')).ledger_revision, paper.ledger_revision);
        }
      }
      catalogRuns.push({ hypothesis: row.id, runId: run.id, market: row.market,
        status: row.status, actual: row.actual, result: row.return, reason: row.reason,
        scientificHash: run.receipt.scientificHash });
    }
    await page.reload();
    const reopened = catalogRuns.find((row) => row.hypothesis === 18);
    const history = page.getByLabel('Run history');
    await history.locator('option').filter({ hasText: 'Aggressor-volume divergence' }).waitFor({ state: 'attached' });
    assert.equal(await history.locator('option').count(), 20);
    await history.selectOption(reopened.runId);
    await page.locator('#lab-status').filter({ hasText: reopened.scientificHash }).waitFor();
    assert.equal(await form.locator('#hypothesis').inputValue(), '18');
    assert.equal(await page.locator('#export-artifact').getAttribute('href'), '/api/practice/artifact?id=' + reopened.runId);
    if (manifest.partitions.some((p) => p.venue === 'bitmex' && p.marketType === 'perpetual' && p.frame === '1h')) {
      await form.locator('[name=carryVenue]').fill('bitmex');
      await form.locator('#hypothesis').selectOption('12');
      const carry = await submitResearch(form, false);
      assert.equal(carry.rows[0].reason, 'funding, liquidity');
      assert.equal(carry.rows[0].return, null);
      assert.ok(carry.rows[0].actual);
      nativeSpot.matchedCarry = { id: carry.id, row: carry.rows[0] };
    }
  }
  assert.deepEqual(external, []);
  const evidence = {
    strategyHash: saved.hash,
    nativeSpot,
    catalogRuns,
    revision,
    overlayMarkers: overlay.markers.length,
    source: chart.source,
    single: { id: single.id, row: single.rows[0], receipt: single.receipt },
    suite: {
      id: cold.id,
      range: cold.range,
      receipt: cold.receipt,
      trace: cold.trace,
      rows: cold.rows.map(({ id, status, reason, warnings, actual, profitability, return: result }) => ({
        id,
        status,
        reason,
        warnings,
        actual,
        profitability,
        return: result
      }))
    },
    warm: { id: warm.id, receipt: warm.receipt, trace: warm.trace },
    alternateSpot: {
      id: alternate.id,
      receipt: alternate.receipt,
      rows: alternate.rows.map(({ id, status, market, return: result }) => ({
        id,
        status,
        market,
        return: result
      }))
    },
    changed: changed.receipt,
    cancelled: soon.id,
    failed: failed.error,
    missing: missing.rows[0].reason,
    quota,
    externalRequests: external.length
  };
  writeFileSync(join(dir, 'verified.json'), JSON.stringify(evidence, null, 2));
  console.log(join(dir, 'verified.json'));
} finally {
  await browser.close();
  await stop();
}
