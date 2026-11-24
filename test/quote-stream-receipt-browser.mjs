import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ownerRoot } from '../scripts/build.mjs';

export async function verifyStreamBrowser({ base, audience, request, frameCount = 1 }) {
  const { chromium } = createRequire(join(ownerRoot(), 'agentic-graph/package.json'))('playwright');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
  const { type, symbol } = request.inputs;
  try {
    for (const width of [360, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage(), outside = [], posts = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', event => {
        if (!event.url().startsWith(base + '/')) outside.push(event.url());
        if (event.method() === 'POST') posts.push(new URL(event.url()).pathname);
      });
      await page.goto(base + '/#provider-desk');
      const panel = page.locator('#quote-stream-receipt');
      await panel.locator('summary').first().click();
      await panel.getByLabel('Original signed request file').setInputFiles({ name: 'signed.json',
        mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(request)) });
      await panel.getByLabel('Local gateway token').fill(audience);
      assert.deepEqual(posts, []);
      await panel.getByRole('button', { name: 'Look up completed read' }).click();
      await panel.getByRole('heading', { name: symbol + ' · ' + type.toUpperCase() }).waitFor();
      if (frameCount === 0) await panel.getByText('No quote frames arrived during this capture.').waitFor();
      else if (type === 'quote') {
        await panel.getByText('302.5', { exact: true }).waitFor();
        if (frameCount > 1) {
          await panel.getByLabel('Captured frame').selectOption({ index: 1 });
          await panel.getByText('308.125', { exact: true }).waitFor();
        }
      }
      else await panel.getByRole('img').waitFor();
      if (type === 'ticker') {
        await panel.locator('summary', { hasText: 'Trade details' }).click();
        await panel.getByText('7647056964060558023', { exact: true }).waitFor();
      }
      assert.equal(await panel.getByLabel('Local gateway token').inputValue(), '');
      assert.equal(await panel.getByLabel('Original signed request file').inputValue(), '');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await panel.locator(':scope > summary').click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Quote stream receipt"]').childElementCount);
      const durable = JSON.stringify(await context.storageState({ indexedDB: true }));
      for (const value of [audience, request.inputs.grant.signature, '7647056964060558023']) assert(!durable.includes(value));
      assert.deepEqual(posts, ['/api/gateway/quote-stream-receipt']);
      assert.deepEqual(outside, []); assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
}
