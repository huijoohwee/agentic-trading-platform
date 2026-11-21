// Verify the public, read-only depth path against the same raw responses delivered by the publisher.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sha } from '../runtime/core.mjs';
import { publicFeed } from '../runtime/public-feed.mjs';
import { ownerRoot } from './build.mjs';
import { serve } from './serve.mjs';

const root = resolve(process.argv[2] ?? '.runtime-private/desk/qualification');
mkdirSync(root, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(join(root, 'live-depth-'));
const collector = fileURLToPath(new URL('./collect-public-market.py', import.meta.url));
function collect(...args) {
  return JSON.parse(execFileSync('python3', [collector, directory, ...args], { encoding: 'utf8', timeout: 30000 }));
}
const grant = collect('--admit-costdepth');
let service, browser;
try {
  const { chromium } = createRequire(join(ownerRoot(), 'agentic-graph', 'package.json'))('playwright');
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium-headless-shell' });
  service = await serve(0, { practiceDirectory: directory });
  const origin = 'http://127.0.0.1:' + service.address().port;
  const ctx = await browser.newContext(), external = [];
  await ctx.route('**/*', (r) => {
    if (new URL(r.request().url()).origin === origin) return r.continue();
    external.push(r.request().url());
    return r.abort();
  });
  await ctx.addInitScript(() => {
    window.tools = new Map();
    Object.defineProperty(navigator, 'modelContext', { value: {
      registerTool(tool) { window.tools.set(tool.name, tool); }
    } });
    Object.defineProperty(window, 'modelContext', { value: navigator.modelContext });
  });
  const page = await ctx.newPage();
  const invoke = (op, input) => page.evaluate(([key, data]) => window.tools.get(key).execute(data), [op, input]);
  const verified = [];
  for (const marketType of ['spot', 'perpetual']) {
    const input = { venue: 'bybit', symbol: 'ETH.USDT', marketType };
    const capture = join(directory, marketType + '.json');
    const result = collect(input.venue, input.symbol, marketType, '--capture', capture);
    const bytes = readFileSync(capture), { book } = JSON.parse(bytes);
    if (marketType === 'spot') {
      await page.goto(origin + '/desk.html');
      await page.locator('#venue option[value=bybit]').waitFor({ state: 'attached' });
      await page.locator('#venue').selectOption(input.venue);
      await page.locator('#flow > summary').click();
    } else await page.locator('#market-type').selectOption(marketType);
    await page.waitForFunction((kind) => document.getElementById('ticker').textContent.includes('Order book only')
      && document.getElementById('market-type').value === kind, marketType);
    await page.locator('#tape').filter({ hasText: 'unavailable' }).waitFor();
    await page.locator('#spread a').filter({ hasText: 'CostDepth' }).waitFor();
    await page.waitForFunction((at) => document.querySelector('#spread').textContent
      .includes(new Date(at).toISOString().slice(0, 19).replace('T', ' ')), book.ts);
    assert.equal(await page.locator('#bids [role=row], #bids tr').count() >= 20, true);
    assert.equal(await page.locator('#asks [role=row], #asks tr').count() >= 20, true);
    const depth = await invoke('read_depth', { ...input, count: 20 });
    assert.equal(depth.status, 'OK');
    assert.equal(depth.data.quality, 'live');
    assert.equal(depth.data.market.marketType, marketType);
    assert.equal(depth.data.source.rightsDigest, grant.rightsDigest);
    assert.equal(depth.data.source.upstreamSha256, sha(bytes));
    assert.equal(depth.data.at, book.ts);
    for (const side of ['bids', 'asks']) {
      const rows = depth.data.rows[side];
      assert.deepEqual(rows.map((v) => [v.price, v.amount]), book[side].slice(0, 20));
      assert.equal(rows.length, 20);
      let total = 0;
      for (const row of rows) {
        assert.equal(row.cumulative, total += row.amount);
        assert.equal(row.notional, row.price * row.amount);
      }
    }
    const sum = (side) => book[side].slice(0, 20).reduce((n, pair) => n + pair[1], 0);
    assert.equal(depth.data.rows.imbalance, (sum('bids') - sum('asks')) / (sum('bids') + sum('asks')));
    assert.equal(depth.data.rows.spread, book.asks[0][0] - book.bids[0][0]);
    const feed = publicFeed(directory);
    try { assert.throws(() => feed.query('read.ticker', input), /FEED_TICKER_UNAVAILABLE/); } finally { feed.close(); }
    const tape = await invoke('read_tape', input);
    const chart = await invoke('desk_chart', { ...input, frame: '1m', count: 20 });
    assert.equal(tape.data.total, null);
    assert.equal(chart.data.quality, 'missing');
    assert.equal(await page.locator('#place').isDisabled(), true);
    assert.equal(await page.locator('#stream a').getAttribute('href'), 'https://www.costdepth.io/developers#license');
    const later = publicFeed(directory, () => book.ts + 16000);
    try { assert.equal(later.query('read.depth', input).quality, 'stale'); } finally { later.close(); }
    verified.push({ ...input, ...result, upstreamSha256: sha(bytes), levelsPerSide: 20, ticker: 'FEED_TICKER_UNAVAILABLE',
      tape: tape.data.quality, chart: chart.data.quality, spread: depth.data.rows.spread, imbalance: depth.data.rows.imbalance });
  }
  assert.deepEqual(external, []);
  const receipt = join(directory, 'verified.json');
  writeFileSync(receipt, JSON.stringify({ grant, verified, outsideOriginBrowserRequests: external.length }, null, 2));
  console.log(receipt);
} finally {
  await browser?.close();
  if (service) await new Promise((done) => service.close(done));
}
