import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ownerRoot } from '../scripts/build.mjs';
import { serve } from '../scripts/serve.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(join(ownerRoot(),'agentic-graph','package.json'))('playwright')); }
const browser = await chromium.launch({ channel:process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless:true });
const server = await serve(0);
const origin = 'http://127.0.0.1:' + server.address().port;
const pages = [];
const errors = [];
const watch = context => context.on('page', page => {
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.location().url + ' ' + message.text()); });
  page.on('requestfailed', request => errors.push(request.url() + ' ' + request.failure()?.errorText));
  page.on('request', request => { if (!request.url().startsWith(origin + '/')) errors.push(request.url()); });
});
async function checkDashboard(page, columns) {
  const dashboard = page.getByRole('region', { name: 'Dashboard content', exact: true });
  assert.equal(await dashboard.getAttribute('data-agentic-base-dashboard-layout'), 'true');
  assert.equal(await dashboard.locator(':scope > header .agentic-base-dashboard-layout-heading h1').innerText(), 'Decision journal');
  assert.equal(await dashboard.getByRole('region', {name:'Dashboard highlight'}).locator('#window').count(), 1);
  assert.equal(await dashboard.locator(':scope > .agentic-base-dashboard-layout-sections #evidence').count(), 1);
  const cards = dashboard.getByRole('list', { name: 'Trading ticket workflow' });
  assert.deepEqual(await cards.locator('li h2').allTextContents(), [
    'Quote freshness', 'Draft ticket', 'Saved observation',
  ]);
  assert.equal(await cards.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), columns);
  assert.equal(await dashboard.evaluate(element => getComputedStyle(element).containerName), 'agentic-dashboard');
  assert.equal(await cards.locator(':scope > li.agentic-collection-item.agentic-dashboard-card').count(), 3);
}

const expectText = (page, id, value) => page.waitForFunction(([id, value]) =>
  document.getElementById(id)?.textContent === value,[id,value],{timeout:8000});

try {
  for (const [name,viewport,mobile] of [['desktop',{width:1240,height:900},false],['mobile',{width:360,height:780},true]]) {
    const context = await browser.newContext({ viewport,isMobile:mobile,hasTouch:mobile });
    watch(context);
    const page = await context.newPage();
    await page.goto(origin);
    await expectText(page,'offline-status','Offline ready');
    await expectText(page,'state','PASS');
    await page.waitForFunction(() => !document.querySelector('#fields').disabled);
    await checkDashboard(page, mobile ? 1 : 3);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
      .some(e => e.name.endsWith('/src/rehearsal-view.mjs'))),false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    if (mobile) {
      const advance = page.getByRole('button',{name:'Advance 1 s'});
      await advance.tap(); await expectText(page,'state','FAIL');
    } else {
      await page.getByLabel('Side',{exact:true}).focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.getByLabel('Quantity').evaluate(el => el === document.activeElement),true);
    }
    const second = await context.newPage();
    await second.goto(origin); await expectText(second,'state','PASS');
    await context.setOffline(true);
    await expectText(page,'offline-status','Working offline');
    pages.push({name,context,page,second});
  }

  // Stop the loopback HTTP server as well as disconnecting both browser contexts.
  const closed = once(server, 'close');
  server.close(); server.closeAllConnections();
  await closed;
  for (const {name,context,page,second} of pages) {
    await page.getByLabel('Evaluation time (UTC)').fill('09:05:00');
    await expectText(page,'state','PASS');
    await page.getByRole('button',{name:'Advance 1 s'}).click();
    await expectText(page,'state','FAIL');
    assert.equal(await page.locator('#age').textContent(),'301 s');
    await page.getByLabel('Quantity').fill('4');
    await page.getByRole('button',{name:'Save draft'}).click();
    await expectText(page,'revision','Revision 1');
    await second.getByLabel('Quantity').fill('99');
    await second.getByRole('button',{name:'Save draft'}).click();
    await second.waitForFunction(() => document.querySelector('#feedback').textContent.includes('Another tab saved first'));
    assert.equal(await second.getByLabel('Quantity').inputValue(),'99');
    assert.equal(await second.locator('#save').isDisabled(),true);
    await second.getByRole('button',{name:'Load saved revision'}).click();
    await expectText(second,'revision','Revision 1');
    assert.equal(await second.getByLabel('Quantity').inputValue(),'4');
    await second.getByLabel('Evaluation time (UTC)').fill('08:59:59');
    await expectText(second,'state','UNKNOWN');
    assert.match(await second.locator('#reason').textContent(), /after the evaluation/);
    await second.getByLabel('Evaluation time (UTC)').fill('09:00:00');
    await second.getByLabel('Quote metadata').selectOption('missing');
    await expectText(second,'state','UNKNOWN');
    assert.match(await second.locator('#reason').textContent(), /class/);
    await page.close(); await second.close();
    const reopened = await context.newPage();
    await reopened.goto(origin); await expectText(reopened,'revision','Revision 1');
    assert.equal(await reopened.getByLabel('Quantity').inputValue(),'4');
    assert.equal(await reopened.getByLabel('Evaluation time (UTC)').inputValue(),'09:05:01');
    await expectText(reopened,'state','FAIL');
    await checkDashboard(reopened, name === 'mobile' ? 1 : 3);
    await reopened.locator('#evidence summary').click();
    await reopened.waitForFunction(() => document.querySelector('#notional').textContent.includes('$100.00'));
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await reopened.locator('#rehearsal summary').first().click();
    await reopened.getByRole('button',{name:'Replay run'}).click();
    await expectText(reopened,'replay-status','Verified run A · 23 synthetic events');
    const grid = reopened.getByRole('list',{name:'Competition rehearsal snapshot'});
    assert.equal(await grid.locator(':scope > li.agentic-dashboard-card').count(),3);
    assert.equal(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),name==='mobile' ? 1 : 3);
    assert.match(await grid.innerText(),/99985|99,985/);
    assert.match(await grid.innerText(),/BUY 1 TEST remaining/);
    await reopened.getByText('Decision and execution log (23)',{exact:true}).click();
    const detail = reopened.locator('#rehearsal summary').filter({hasText:'second-fill · OFF_LIMIT'});
    await detail.click();
    assert.match(await detail.locator('..').innerText(),/26/);
    const file = reopened.waitForEvent('download');
    await reopened.getByRole('button',{name:'Export replay'}).click();
    const bytes = await readFile(await (await file).path());
    const A = JSON.parse(bytes.toString());
    await reopened.getByLabel('Synthetic run').selectOption('B');
    await reopened.getByRole('button',{name:'Replay run'}).click();
    await expectText(reopened,'replay-status','Verified run B · 26 synthetic events');
    assert.match(await grid.innerText(),/100,835\.37105/);
    assert.match(await grid.innerText(),/100,934\.36445/);
    await reopened.reload();
    await reopened.locator('#rehearsal summary').first().click();
    await expectText(reopened,'replay-status','Verified run B · 26 synthetic events');
    const input = reopened.getByLabel('Restore replay file');
    await input.setInputFiles({name:'tampered.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...A,sha256:'changed'}))});
    await expectText(reopened,'replay-status','Archive integrity or binding mismatch');
    assert.match(await grid.innerText(),/fixture-competition/);
    await input.setInputFiles({name:'practice.json',mimeType:'application/json',buffer:bytes});
    await expectText(reopened,'replay-status','Verified run A · 23 synthetic events');
    assert.match(await grid.innerText(),/fixture-practice/);
    assert.equal(await reopened.getByRole('heading',{name:'Run A · practice'}).count(),1);
    await expectText(reopened,'revision','Revision 1');
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    console.log(name + ': first offline replay, drill-down, export A, reopen B, tamper rejection and exact restore A passed.');
    if (process.env.TRADING_SCREENSHOT_DIR) {
      await reopened.screenshot({path:join(process.env.TRADING_SCREENSHOT_DIR,name+'.png'),fullPage:true});
    }
    console.log(name + ': exact threshold, offline save, stale tab, evidence gaps, closed-tab reopen and lazy Sheets passed.');
    await context.close();
  }
  assert.deepEqual(errors,[]);
} finally { if (server.listening) server.close(); await browser.close(); }
