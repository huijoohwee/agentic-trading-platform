import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ownerRoot } from '../scripts/build.mjs';

export async function verifyReceiptBrowser({ base, audience, current, history, sizing, missing, privateStrings }) {
  const { chromium } = createRequire(join(ownerRoot(), 'agentic-graph/package.json'))('playwright');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
  try {
    for (const width of [360, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 850 } });
      const page = await context.newPage(), outside = [], errors = [], posts = [];
      page.on('request', request => {
        if (!request.url().startsWith(base + '/')) outside.push(request.url());
        if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#offline-status')?.textContent === 'Offline ready');
      const runtime = page.locator('#runtime-readback');
      await runtime.locator(':scope > summary').click();
      const panel = runtime.locator('details').filter({ has: page.getByText('Inspect a completed simulator read', { exact: true }) }).first();
      await panel.locator('summary').first().click();
      async function lookup(request) {
        await panel.getByLabel('Original signed request file').setInputFiles({ name: 'fixture-request.json',
          mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(request)) });
        await panel.getByLabel('Local gateway token').fill(audience);
        await panel.getByRole('button', { name: 'Look up completed read' }).click();
      }
      await lookup(current);
      await panel.getByRole('heading', { name: 'Current orders' }).waitFor();
      await panel.getByText('AAPL · Buy · Partially filled', { exact: true }).click();
      await panel.getByText('42.000000000000001', { exact: true }).waitFor();
      assert.equal(await panel.getByLabel('Local gateway token').inputValue(), '');
      assert.equal(await panel.getByLabel('Original signed request file').inputValue(), '');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await panel.getByRole('button', { name: 'Clear receipt' }).click();
      assert.equal(await panel.getByText('42.000000000000001').count(), 0);
      await lookup(missing); await panel.getByText('No matching completed read.').waitFor();
      await lookup(history); await panel.getByText('More orders are available with a separately signed continuation.').waitFor();
      await lookup(sizing);
      await panel.getByRole('heading', { name: 'Buying power' }).waitFor();
      await panel.getByRole('region', { name: 'Simulator receipt' }).locator('summary').filter({ hasText: 'US.AAPL' }).click();
      await panel.getByText('9007199254740993', { exact: true }).waitFor();
      await runtime.locator(':scope > summary').click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Simulator receipt"]').childElementCount === 0);
      const durable = JSON.stringify(await context.storageState({ indexedDB: true }));
      for (const value of [audience, current.inputs.grant.signature, ...privateStrings]) assert(!durable.includes(value));
      const urls = await page.evaluate(async () => {
        const results = [];
        for (const name of await caches.keys()) results.push(...(await (await caches.open(name)).keys()).map(request => request.url));
        return results;
      });
      assert(urls.every(url => !new URL(url).pathname.startsWith('/api/')));
      assert.deepEqual(posts, Array(4).fill('/api/gateway/simulator-receipt'));
      assert.deepEqual(outside, []); assert.deepEqual(errors, []);
      await context.close();
      console.log(width + 'px private simulator receipt lookup, clear, isolation and storage checks passed.');
    }
  } finally { await browser.close(); }
}
