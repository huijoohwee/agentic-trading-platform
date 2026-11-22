import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {verifyLaboratory} from './laboratory-browser.mjs';
import { verifyDesk } from './desk-browser.mjs';
import { verifyWorksheets } from './worksheets-browser.mjs';
import { verifyTradingSkills } from './skills-browser.mjs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assemble, ownerRoot } from '../scripts/build.mjs';
import { serve } from '../scripts/serve.mjs';

const journalCss = await readFile(new URL('../web/journal.css', import.meta.url), 'utf8');
assert.doesNotMatch(journalCss, /(?:--agentic-font-[\w-]+|font-family|font)\s*:|\.agentic-(?:mono(?:-detail)?|text-detail)\b/u,
  'Trading must inherit font families and data roles from the pinned Design System');

assert.doesNotMatch(journalCss, /\.agentic-(?:ktv-|base-data-table|panel-section-)/u,
  'The replay log must use the owner styles for its inspector, table and disclosure');

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

async function checkOverlayStyle(page) {
  const color = await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    try {
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = 'span { color: rgb(13, 57, 91) }';
      const label = document.createElement('span');
      shadow.append(style, label);
      return getComputedStyle(label).color;
    } finally { host.remove(); }
  });
  assert.equal(color, 'rgb(13, 57, 91)');
}

async function openAnnotationTarget(page, id, mobile) {
  const summary = page.locator('#' + id + ' > summary');
  const selected = page.locator('#' + id + ' > summary[data-agentic-annotation-target="true"]');
  assert.equal(await selected.count(), 0);
  await summary.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const point = await summary.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return { x, y, height: rect.height, hit: el.contains(document.elementFromPoint(x, y)),
      edgeHit: el.contains(document.elementFromPoint(x, rect.bottom - 1)) };
  });
  assert.equal(point.hit, true);
  assert.equal(point.edgeHit, true);
  assert.ok(point.height >= (mobile ? 48 : 28));
  if (mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await selected.waitFor();
  assert.equal(await selected.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await summary.press('Enter');
  await selected.waitFor({ state: 'detached' });
  assert.equal(await summary.evaluate(el => el.parentElement.open), false);
  await summary.press('Enter');
  await selected.waitFor();
}

try {
  const { id: releaseId, assets } = await assemble();
  assert.doesNotMatch(assets.get('index.html').toString(), /unsafe-inline/);
  const devManifest = await (await fetch(origin + '/asset-manifest.json')).json();
  assert.notEqual(devManifest.id, releaseId);
  const policy = (await fetch(origin)).headers.get('content-security-policy');
  const strict = (await fetch(origin + '/src/browser.mjs')).headers.get('content-security-policy');
  assert.equal(policy, strict + "; style-src-elem 'self' 'unsafe-inline'");
  assert.doesNotMatch(strict, /unsafe-inline/);
  for (const [name,viewport,mobile] of [['desktop',{width:1240,height:900},false],['mobile',{width:360,height:780},true]]) {
    const context = await browser.newContext({ viewport,isMobile:mobile,hasTouch:mobile });
    watch(context);
    const page = await context.newPage();
    await page.goto(origin);
    await checkOverlayStyle(page);
    await expectText(page,'offline-status','Offline ready');
    await expectText(page,'state','PASS');
    await page.waitForFunction(() => !document.querySelector('#fields').disabled);
    await checkDashboard(page, mobile ? 1 : 3);
    await verifyTradingSkills(page, mobile);
    console.log(name + ': online lazy Skills & Commands reference, controls, source digest and focus passed.');
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
    const preview = await context.newPage();
    await preview.goto(origin + '/#replay-dashboard');
    await preview.getByRole('region', {name:'Replay dashboard'}).waitFor();
    await expectText(preview, 'replay-status', 'Verified run B · 26 synthetic events');
    assert.equal(await preview.evaluate(() => localStorage.getItem('trading-rehearsal/1/last-verified')), null);
    await preview.close();
    const reopened = await context.newPage();
    await reopened.goto(origin); await expectText(reopened,'revision','Revision 1');
    await checkOverlayStyle(reopened);
    assert.equal(await reopened.getByLabel('Quantity').inputValue(),'4');
    assert.equal(await reopened.getByLabel('Evaluation time (UTC)').inputValue(),'09:05:01');
    await expectText(reopened,'state','FAIL');
    await checkDashboard(reopened, name === 'mobile' ? 1 : 3);
    assert.equal(server.listening, false);
    assert.equal(await reopened.evaluate(() => navigator.onLine), false);
    await verifyTradingSkills(reopened, name === 'mobile');
    console.log(name + ': first offline Skills & Commands load after server shutdown, controls and verified instructions passed.');
    await reopened.locator('#evidence summary').click();
    await reopened.waitForFunction(() => document.querySelector('#notional').textContent.includes('$100.00'));
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await reopened.locator('#rehearsal summary').first().click();
    await reopened.getByRole('button',{name:'Replay run'}).click();
    await expectText(reopened,'replay-status','Verified run A · 23 synthetic events');
    const grid = reopened.getByRole('list',{name:'Competition rehearsal snapshot'});
    assert.equal(await grid.locator(':scope > li.agentic-dashboard-card').count(),3);
    assert.equal(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),name==='mobile' ? 1 : 3);
    const dashboard = reopened.getByRole('region', { name:'Replay dashboard', exact:true });
    const indicators = dashboard.getByRole('list', {name:'Run performance indicators'});
    const intervals = dashboard.getByRole('toolbar', {name:'Select an observed UTC day'}).getByRole('button');
    assert.equal(await dashboard.getAttribute('data-agentic-base-dashboard-layout'), 'true');
    assert.equal(await intervals.count(), 1);
    assert.match(await indicators.innerText(),/99985|99,985/);
    assert.match(await grid.innerText(),/BUY 1 TEST remaining/);
    assert.equal(await reopened.evaluate(() => performance.getEntriesByType('resource')
      .some(entry => entry.name.endsWith('/browser-data-view.js'))), false);
    await dashboard.getByRole('button', {name:'Inspect 23 source events'}).click();
    const logTable = reopened.getByRole('table', { name: 'Replay events' });
    const evidence = reopened.getByRole('region', { name: 'Event evidence' });
    const filter = reopened.getByLabel('Filter events');
    await logTable.waitFor();
    assert.equal(await filter.inputValue(), '2026-11-04');
    assert.equal(await logTable.locator('tbody tr').count(), 23);
    assert.match(await logTable.getAttribute('class'), /agentic-base-data-table/);
    await filter.fill('OFF_LIMIT');
    const secondFill = logTable.getByRole('row').filter({ hasText: 'second-fill' });
    await secondFill.press('Enter');
    await evidence.getByRole('heading', { name: 'Event evidence · second-fill' }).waitFor();
    assert.equal(await evidence.locator('dl').filter({ has: reopened.getByText('price', { exact: true }) }).locator('samp').textContent(), '26');
    await filter.fill('absent-event');
    await reopened.getByText('0 of 23 events', { exact: true }).waitFor();
    assert.equal(await evidence.locator('dl').count(), 0);
    await filter.fill('');
    await logTable.getByRole('cell', { name: 'opening', exact: true }).waitFor();
    const file = reopened.waitForEvent('download');
    await reopened.getByRole('button',{name:'Export replay'}).click();
    const bytes = await readFile(await (await file).path());
    const A = JSON.parse(bytes.toString());
    await reopened.getByLabel('Synthetic run').selectOption('B');
    await reopened.getByRole('button',{name:'Replay run'}).click();
    await expectText(reopened,'replay-status','Verified run B · 26 synthetic events');
    assert.match(await grid.innerText(),/100,835\.37105/);
    assert.match(await indicators.innerText(),/100,934\.36445/);
    assert.equal(await intervals.count(), 6);
    await intervals.last().evaluate(button => button.closest('[aria-label="Daily account equity"]').scrollIntoView());
    assert.equal(await intervals.last().evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, 'Closing interval is visible in the responsive plot');
    await intervals.last().press('Home');
    assert.equal(await intervals.first().getAttribute('aria-pressed'), 'true');
    if (name === 'mobile') await intervals.nth(2).tap(); else await intervals.nth(1).press('ArrowRight');
    await dashboard.getByRole('button', {name:'Inspect 2 source events'}).click();
    await reopened.getByText('2 of 26 events', {exact:true}).waitFor();
    assert.equal(await filter.inputValue(), '2026-11-06');
    assert.equal(await filter.evaluate(el => el === el.ownerDocument.activeElement), true);
    await intervals.last().click();
    await dashboard.getByRole('button', {name:'Inspect 14 source events'}).click();
    await reopened.getByText('14 of 26 events', {exact:true}).waitFor();
    assert.equal(await filter.inputValue(), '2026-11-13');
    await reopened.reload();
    await reopened.locator('#rehearsal summary').first().click();
    await expectText(reopened,'replay-status','Verified run B · 26 synthetic events');
    await openAnnotationTarget(reopened, 'schedule', name === 'mobile');
    const scheduleTable = reopened.getByRole('table', {name:'Schedule receipts'});
    const receiptEvidence = reopened.getByRole('region', {name:'Receipt evidence'});
    await scheduleTable.waitFor();
    assert.equal(await scheduleTable.locator('tbody tr').count(), 13);
    assert.equal(await scheduleTable.getByRole('cell', {name:'2027-05-01T01:00:00Z',exact:true}).count(), 2);
    const receiptFilter = reopened.getByRole('searchbox', {name:'Filter receipts'});
    await receiptFilter.fill('fixture-schedule/run');
    await reopened.getByText('1 of 13 receipts', {exact:true}).waitFor();
    await receiptEvidence.getByRole('heading', {name:'Receipt evidence · manual · 00:59:00Z'}).waitFor();
    const exportTable = async label => {
      const ready = reopened.waitForEvent('download');
      await reopened.getByRole('button', {name:label, exact:true}).click();
      return JSON.parse(await readFile(await (await ready).path(), 'utf8'));
    };
    const receipts = await exportTable('Export receipts to Sheets');
    assert.deepEqual([receipts.rows, receipts.columns], [14, 7]);
    assert.equal(receipts.cells.E14.value, 'fixture-event-3');
    assert.equal(receipts.cells.B6.value, 'duplicate_trigger');
    assert.equal(receipts.cells.E2, undefined);
    assert.equal(JSON.parse(receipts.cells.G2.value).execution.max_concurrent_runs, 1);
    await openAnnotationTarget(reopened, 'rule-boundaries', name === 'mobile');
    const boundaries = reopened.getByRole('table', {name:'Verified rule boundaries'});
    const boundaryEvidence = reopened.getByRole('region', {name:'Boundary evidence'});
    await boundaries.waitFor();
    assert.equal(await boundaries.locator('tbody tr').count(), 59);
    await reopened.getByRole('searchbox', {name:'Filter boundaries'}).fill('4.8% daily, 365');
    await reopened.getByText('1 of 59 boundaries', {exact:true}).waitFor();
    const match = boundaries.getByRole('row').filter({hasText:'4800000'});
    if (name === 'mobile') await match.getByRole('cell').first().tap(); else await match.press('Enter');
    await boundaryEvidence.getByRole('heading', {name:'Boundary evidence · 4.8% daily, 365 convention'}).waitFor();
    assert.equal(await boundaryEvidence.locator('samp').filter({hasText:'[36500,0,365]'}).count(), 1);
    const rules = await exportTable('Export boundaries to Sheets');
    assert.deepEqual([rules.rows, rules.columns, Object.keys(rules.cells).length], [60, 4, 240]);
    assert.equal(rules.cells.A60.value, 'Worthless put');
    assert.deepEqual(rules.cells.B44, {type:'text', value:'null'});
    assert.deepEqual(rules.cells.B42, {type:'number', value:4800000});
    await reopened.getByRole('searchbox', {name:'Filter boundaries'}).fill('missing-boundary');
    await reopened.getByText('0 of 59 boundaries', {exact:true}).waitFor();
    assert.equal(await boundaryEvidence.locator('dl').count(), 0);
    const daily = await exportTable('Export daily equity to Sheets');
    assert.deepEqual([daily.rows, daily.columns], [7, 6]);
    const replay = JSON.parse(await reopened.evaluate(() => localStorage.getItem('trading-rehearsal/1/last-verified')));
    const observations = Map.groupBy(replay.snapshot.curve, point => point.at.slice(0, 10));
    for (const [i, [date, points]] of [...observations].entries()) {
      const values = points.map(point => point.equity / 1e6);
      const cells = Array.from('ABCDEF', column => daily.cells[column + (i + 2)]);
      assert.deepEqual(cells.map(cell => cell.type), ['text', 'number', 'number', 'number', 'number', 'number']);
      assert.deepEqual(cells.map(cell => cell.value), [date, values[0], Math.max(...values), Math.min(...values), values.at(-1), points.length]);
    }
    const cash = grid.getByText('$94,934.36445', {exact:true});
    const route = receiptEvidence.getByText('POST /api/v1/forward/schedules/fixture-schedule/run', {exact:true});
    const typography = el => {
      const { fontFamily, fontSize, lineHeight, fontWeight, fontVariantNumeric } = getComputedStyle(el);
      return { fontFamily, fontSize, lineHeight, fontWeight, fontVariantNumeric };
    };
    const reference = await cash.evaluate(typography);
    assert.equal(reference.fontVariantNumeric, 'tabular-nums');
    assert.equal(reference.fontSize, '12px');
    assert.equal(reference.lineHeight, '16px');
    assert.deepEqual(await route.evaluate(typography), reference);
    const logSummary = reopened.locator('#replay-log > summary');
    assert.equal(await logSummary.getByRole('heading', {name:'Decision and execution log (26)'}).count(), 1);
    await logSummary.click();
    await logTable.waitFor();
    assert.equal(await logTable.locator('tbody tr').count(), 26);
    assert.equal(await logSummary.getAttribute('data-agentic-annotation-target'), 'true');
    await filter.fill('stock');
    const fill = logTable.getByRole('cell', {name:'stock-fill', exact:true});
    if (name === 'mobile') await fill.tap(); else await fill.click();
    await evidence.getByRole('heading', { name:'Event evidence · stock-fill' }).waitFor();
    assert.equal(await evidence.getByRole('img', {name:'Date and time',exact:true}).count(), 1);
    const workbookFile = reopened.waitForEvent('download');
    await reopened.getByRole('button', {name:'Export run to Sheets'}).click();
    const downloaded = await workbookFile;
    assert.equal(downloaded.suggestedFilename(), 'run-B-events.sheets.json');
    const workbook = JSON.parse(await readFile(await downloaded.path(), 'utf8'));
    assert.equal(workbook.contract, 'sheets/workbook/v1');
    assert.deepEqual([workbook.rows, workbook.columns], [27, 5]);
    assert.equal(workbook.cells.A2.value, 'opening');
    assert.deepEqual(workbook.cells.E27, {type:'number',value:100934.36445});
    assert.equal(Object.keys(workbook.cells).length, 27 * 5);
    await filter.fill('');
    await logTable.getByRole('row').filter({has:reopened.getByRole('cell', {name:'opening',exact:true})}).press('Enter');
    await evidence.getByRole('heading', { name:'Event evidence · opening' }).waitFor();
    const labelType = await grid.getByText('Cash', {exact:true}).evaluate(typography);
    assert.equal(labelType.fontSize, '12px');
    assert.equal(labelType.lineHeight, '16px');
    assert.equal(labelType.fontWeight, '400');
    assert.notEqual(labelType.fontFamily, reference.fontFamily);
    assert.deepEqual(await reopened.locator('dt:visible').filter({hasText:/^account$/}).evaluate(typography), labelType);
    const openingTime = reopened.locator('dd:visible').filter({hasText:/^2026-11-04T15:00:00Z$/});
    const drawdown = grid.getByText('0.001%', {exact:true});
    assert.deepEqual(await openingTime.evaluate(typography), await drawdown.evaluate(typography));
    const openingLabel = evidence.locator('time').filter({hasText:'2026-11-04T15:00:00Z'});
    assert.equal(await openingLabel.getAttribute('datetime'), await openingTime.textContent());
    assert.deepEqual(await openingLabel.evaluate(typography), reference);
    assert.equal(await receiptEvidence.locator('time').getAttribute('datetime'), '2027-05-01T00:59:00Z');
    for (const value of await reopened.locator('dd, code, pre, kbd, samp, time').all()) {
      assert.deepEqual(await value.evaluate(typography), reference, await value.textContent());
    }
    const input = reopened.getByLabel('Restore replay file');
    await input.setInputFiles({name:'tampered.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...A,sha256:'changed'}))});
    await expectText(reopened,'replay-status','Archive integrity or binding mismatch');
    assert.match(await grid.innerText(),/fixture-competition/);
    await input.setInputFiles({name:'practice.json',mimeType:'application/json',buffer:bytes});
    await expectText(reopened,'replay-status','Verified run A · 23 synthetic events');
    assert.match(await grid.innerText(),/fixture-practice/);
    const savedDashboard = await context.newPage();
    await savedDashboard.goto(origin + '/#replay-dashboard');
    await expectText(savedDashboard, 'replay-status', 'Verified run A · 23 synthetic events');
    await savedDashboard.close();
    assert.equal(await reopened.getByRole('heading',{name:'Run A · practice'}).count(),1);
    await expectText(reopened,'revision','Revision 1');
    await openAnnotationTarget(reopened, 'audit', name === 'mobile');
    await expectText(reopened,'audit-status','T-20261119-001 · PASS · PRICE_OUT_OF_LIMIT');
    assert.match(await reopened.locator('#audit-results').innerText(),/order-unbound/);
    assert.deepEqual(await reopened.locator('#audit-results').getByText('Equity in base currency', {exact:true}).evaluate(typography), labelType);
    for (const term of await reopened.locator('dt').all()) {
      assert.deepEqual(await term.evaluate(typography), labelType, await term.textContent());
    }
    const paste = reopened.getByLabel('Paste snapshot JSON');
    const synthetic = JSON.parse(await paste.inputValue());
    const importRun = reopened.getByRole('button',{name:'Import run'});
    await importRun.click();
    await expectText(reopened,'audit-feedback','Verified run manual-A');
    const downloadJSON = async name => {
      const ready = reopened.waitForEvent('download');
      await reopened.getByRole('button',{name,exact:true}).click();
      return readFile(await (await ready).path());
    };
    const auditFile = await downloadJSON('Export audit');
    const witnessFile = await downloadJSON('Save witness');
    await paste.fill(JSON.stringify({ ...synthetic, halt:'HALT' }));
    await importRun.click();
    await expectText(reopened,'audit-feedback','Run ID already has different evidence');
    const runB = structuredClone(synthetic);
    runB.run_id = 'manual-B'; runB.halt = 'HALT';
    for (const group of ['IN_Quotes','IN_Positions','IN_Balance','IN_Orders','executions'])
      for (const row of runB[group]) row.run_id = runB.run_id;
    await paste.fill(JSON.stringify(runB)); await importRun.click();
    await expectText(reopened,'audit-feedback','Verified run manual-B');
    await reopened.reload();
    await reopened.locator('#audit summary').click();
    await expectText(reopened,'audit-status','T-20261119-001 · HALT · PRICE_OUT_OF_LIMIT');
    const upload = (name, file, bytes) => reopened.getByLabel(name, {exact:true}).setInputFiles({
      name:file,mimeType:'application/json',buffer:bytes });
    await upload('Audit archive','manual-A.json',auditFile);
    await upload('Retained witness','invalid.json',Buffer.from('{}'));
    await reopened.getByRole('button',{name:'Verify and restore'}).click();
    await expectText(reopened,'audit-feedback','Audit evidence differs from the retained witness');
    await upload('Retained witness','witness.json',witnessFile);
    await reopened.getByRole('button',{name:'Verify and restore'}).click();
    await expectText(reopened,'audit-feedback','Verified run manual-A');
    await expectText(reopened,'audit-status','T-20261119-001 · PASS · PRICE_OUT_OF_LIMIT');
    assert.deepEqual(JSON.parse(await paste.inputValue()), synthetic);
    console.log(name + ': manual A/B imports, same-ID conflict, persisted halt, witness rejection and archive restore passed.');
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    console.log(name + ': first offline replay, drill-down, export A, reopen B, tamper rejection and exact restore A passed.');
    if (process.env.TRADING_SCREENSHOT_DIR) {
      await reopened.screenshot({path:join(process.env.TRADING_SCREENSHOT_DIR,name+'.png'),fullPage:true});
    }
    console.log(name + ': exact threshold, offline save, stale tab, evidence gaps, closed-tab reopen and lazy Sheets passed.');
    const worksheets = await context.newPage();
    await worksheets.goto(origin + '/#replay-dashboard');
    await verifyWorksheets(worksheets);
    console.log(name + ': worksheet tabs, chart setup and customization, pivot fields and options, typed exports and offline reload passed.');
    await context.close();
  }
  assert.deepEqual(errors,[]);
  await verifyDesk(browser);
  await verifyLaboratory(browser);console.log('Landing and desk WebMCP actions, paper revision parity, observer and research workflows passed.');
} finally { if (server.listening) server.close(); await browser.close(); }
