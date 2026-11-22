import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../scripts/serve.mjs';
import { verifyTradingSkills } from './skills-browser.mjs';
export async function verifyDesk(browser) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-browser-')),
    server = await serve(0, { practiceDirectory: dir });
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const mobile of [false, true]) {
      const ctx = await browser.newContext({
        viewport: mobile ? { width: 360, height: 780 } : { width: 1300, height: 900 },
        isMobile: mobile,
        hasTouch: mobile
      });
      try {
        const page = await ctx.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
          if (!r.url().startsWith(origin + '/')) errors.push('Outside origin');
        });
        await page.goto(origin);
        await page.getByRole('link', { name: 'Open paper trading desk' }).click();
        await page.locator('#storage').filter({ hasText: 'Saved on loopback' }).waitFor();
        await page.locator('#stream').filter({ hasText: 'Synthetic event stream' }).waitFor();
        await page.getByRole('navigation', { name: 'Desk sections' }).getByRole('link', { name: 'Market', exact: true }).click();
        assert.ok(await page.locator('#market').evaluate(section => section.getBoundingClientRect().top >=
          document.querySelector('.agentic-toolbar').getBoundingClientRect().bottom), 'Market anchor clears the toolbar');
        await verifyTradingSkills(page, mobile);
        const read = () => page.evaluate(() => fetch('/api/practice/session').then((r) => r.json()));
        const wait = (predicate) => page.waitForFunction(predicate, null, { timeout: 8000 });
        // A failed stream can use the independently readable local snapshot, then recover.
        if (!mobile) {
          await page.route('**/api/practice/events?*', (route) => route.abort());
          await page.reload();
          await page.locator('#stream').filter({ hasText: 'Loopback synthetic stream' }).waitFor();
          await page.unroute('**/api/practice/events?*');
          await page.reload();
          await page.locator('#stream').filter({ hasText: 'Synthetic event stream' }).waitFor();
        }
        await page.locator('#search').fill('bir');
        await page.locator('#instrument').selectOption('BIR.USD');
        await wait(() => document.querySelector('#symbol').textContent === 'BIR.USD');
        await page.locator('#frame').selectOption('3h');
        await page.locator('#preset').selectOption('Momentum');
        await page.locator('[data-pane=macd]').waitFor();
        await page.locator('#expand').click();
        assert.equal(await page.locator('#expand').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        await page.locator('#flow summary').click();
        await page.locator('#bids .table-view').waitFor();
        await page.locator('#tape .table-view').waitFor();
        await page.locator('#place').click();
        await wait(() => document.querySelector('#notice').textContent === 'FILLED');
        assert.equal((await read()).session.fills.length, 1);
        await page.locator('#ticket [name=type]').selectOption('LIMIT');
        await page.locator('#ticket [name=trigger]').fill('0.5');
        await page.locator('#place').click();
        await page.locator('#working button').waitFor();
        await page.locator('#working button').click();
        await wait(() => document.querySelector('#notice').textContent === 'CANCELLED');
        await page.locator('#ticket [name=type]').selectOption('STOP');
        await page.locator('#ticket [name=trigger]').fill('800');
        await page.locator('#place').click();
        await page.locator('#working button').waitFor();
        await page.locator('#run').click();
        await page.locator('#report').filter({ hasText: 'closed' }).waitFor();
        assert.equal((await read()).session.fills.length, 1);
        await page.locator('#prediction [name=note]').fill('manual signal');
        await page.locator('#prediction button').click();
        await page.locator('#calls .table-view').waitFor();
        assert.equal((await read()).session.predictions[0].note, 'manual signal');
        assert.equal((await read()).session.predictions[0].confidence, 50);
        const downloading = page.waitForEvent('download');
        await page.locator('#csv').click();
        const file = await downloading;
        assert.match(await readFile(await file.path(), 'utf8'), /BIR\.USD/);
        const sheet = page.waitForEvent('download');
        await page.locator('#sheets').click();
        assert.match(await readFile(await (await sheet).path(), 'utf8'), /Paper trade journal/);
        await page.locator('#funds').evaluate((f) => (f.parentElement.open = true));
        await page.locator('#funds input').fill('100');
        await page.locator('#funds button').click();
        await wait(() => document.querySelector('#notice').textContent === 'SAVED');
        await page.reload();
        await page.locator('#storage').filter({ hasText: 'Saved on loopback' }).waitFor();
        assert.equal(await page.locator('#frame').inputValue(), '3h');
        assert.equal(await page.locator('#preset').inputValue(), 'Momentum');
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
          'desktop/mobile width'
        );
        await page.evaluate(() => scrollTo(0, 0));
        if (process.env.TRADING_SCREENSHOT_DIR)
          await page.screenshot({
            path: join(process.env.TRADING_SCREENSHOT_DIR, 'practice-' + (mobile ? 'mobile' : 'desktop') + '.png')
          });
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        });
        await ctx.setOffline(true);
        await page.reload();
        await page.locator('#storage').filter({ hasText: 'cached revision' }).waitFor();
        await page.locator('#stream').filter({ hasText: 'sealed synthetic replay' }).waitFor();
        await verifyTradingSkills(page, mobile);
        await page.locator('#run').click();
        await page.locator('#report').filter({ hasText: 'closed' }).waitFor();
        assert.equal(await page.locator('#symbol').textContent(), 'BIR.USD');
        assert.deepEqual(errors, []);
        console.log(
          (mobile ? 'Mobile' : 'Desktop') + ' practice: stream, orders, research, exports and offline readback passed.'
        );
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
