import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the same offline worksheet entry points in the regression suite and the live dev server.
export async function verifyWorksheets(page, capture = async () => {}) {
  await page.getByLabel('Synthetic run').selectOption('B');
  await page.getByRole('button', { name: 'Replay run', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('trading-rehearsal/1/last-verified'))?.snapshot.run === 'B'
    && document.getElementById('replay-status').textContent.includes('Verified run B'));
  const { receipts, curve } = await page.evaluate(() => JSON.parse(localStorage.getItem('trading-rehearsal/1/last-verified')).snapshot);
  const work = page.locator('#replay-worksheets');
  const tab = name => work.getByRole('tab', { name, exact: true });
  const field = name => work.getByLabel(name, { exact: true });
  const table = work.getByRole('table', { name: 'Replay pivot results' });
  const image = name => work.getByRole('img', { name });
  const dates = [...new Set(receipts.map(receipt => receipt.at.slice(0, 10)))];
  const types = [...new Set(receipts.map(receipt => receipt.type))];
  async function exportSheet(name) {
    const download = page.waitForEvent('download');
    await work.getByRole('button', { name, exact: true }).click();
    return JSON.parse(await readFile(await (await download).path(), 'utf8'));
  }
  await tab('Daily equity').press('Home');
  await work.getByRole('table', { name: 'Replay events' }).waitFor();
  assert.equal(await work.getByRole('row').count(), receipts.length + 1);
  assert.equal(await page.locator('#replay-log').count(), 1);
  await tab('Source records').press('End');
  await image('Dashboard bar chart').waitFor();
  assert.equal(await image('Dashboard bar chart').getByRole('button').count(), dates.length);
  const axes = await image('Dashboard bar chart').locator('g[role="button"] text').evaluateAll(ticks =>
    ticks.map(tick => ({ left: tick.getBoundingClientRect().left, right: tick.getBoundingClientRect().right })));
  assert.ok(axes.length > 1 && axes.every((tick, i) => !i || axes[i - 1].right <= tick.left));
  await capture('chart', work);
  await field('Chart type').selectOption('line');
  await image('Dashboard line chart').waitFor();
  assert.equal(await image('Dashboard line chart').locator('path').count(), 1);
  await field('Chart type').selectOption('area');
  await image('Dashboard line chart').locator('path:nth-of-type(2)').waitFor();
  await field('Category').selectOption('type');
  await tab('Customize').click();
  await field('Series color').selectOption('rose');
  await field('Show gridlines').uncheck();
  await field('Show values').check();
  const line = image('Dashboard line chart');
  const readout = work.locator('.worksheet-stage:visible dl.facts');
  await readout.waitFor();
  assert.equal(await readout.locator('dt').count(), types.length);
  assert.equal(await line.locator('line[stroke-width="0.8"]').count(), 0);
  assert.equal(await line.locator('circle').count(), types.length);
  const currentColor = await line.locator('circle').first().getAttribute('fill');
  await field('Series color').selectOption('green');
  await page.waitForFunction(color => document.querySelector('.worksheet-series circle')?.getAttribute('fill') !== color, currentColor);
  const counts = await exportSheet('Export chart data to Sheets');
  assert.equal(counts.rows, types.length + 1);
  assert.equal(counts.cells.A2.value, receipts[0].type);
  assert.deepEqual(counts.cells.B2, { type: 'number', value: receipts.filter(r => r.type === receipts[0].type).length });

  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await tab('Pivot table').tap();
  else await tab('Pivot table').click();
  await field('Rows').selectOption('day');
  await field('Columns').selectOption('type');
  await table.waitFor();
  const pivotHeaders = await table.getByRole('columnheader').allTextContents();
  assert.deepEqual(new Set(pivotHeaders.slice(1)), new Set(types));
  await tab('Options').click();
  await field('Descending row order').check();
  await field('Include grand total').check();
  await table.getByText('Grand total', {exact:true}).waitFor();
  assert.equal(await table.getByRole('row').nth(1).getByRole('cell').first().textContent(), dates.at(-1));
  const pivot = await exportSheet('Export pivot to Sheets');
  assert.deepEqual([pivot.rows, pivot.columns], [dates.length + 2, types.length + 1]);
  for (let i = 1; i < pivotHeaders.length; i++) {
    const column = String.fromCharCode(65 + i);
    assert.deepEqual(pivot.cells[column + pivot.rows], { type: 'number', value: receipts.filter(r => r.type === pivotHeaders[i]).length });
  }
  await tab('Fields').click();
  await capture('pivot', work);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await field('Values').selectOption('close');
  const balances = await exportSheet('Export pivot to Sheets');
  for (let i = 2; i < balances.rows; i++) {
    for (let j = 1; j < balances.columns; j++) {
      const column = String.fromCharCode(65 + j), date = balances.cells['A' + i].value;
      const last = receipts.findLastIndex(r => r.at.startsWith(date) && r.type === balances.cells[column + '1'].value);
      const expected = last === -1 ? undefined : { type: 'number', value: curve[last].equity / 1e6 };
      assert.deepEqual(balances.cells[column + i], expected);
    }
  }
  await field('Event type filter').selectOption('fill');
  const filtered = await exportSheet('Export pivot to Sheets');
  const lastFill = receipts.findLastIndex(r => r.type === 'fill');
  assert.equal(filtered.columns, 2);
  assert.deepEqual(filtered.cells['B' + filtered.rows], { type: 'number', value: curve[lastFill].equity / 1e6 });
  assert.equal(filtered.cells.B1.value, 'fill');
  await page.reload();
  await tab('Event activity').click();
  await table.waitFor();
  assert.equal(await field('Values').inputValue(), 'close');
  assert.equal(await field('Event type filter').inputValue(), 'fill');
  assert.equal(await tab('Pivot table').getAttribute('aria-selected'), 'true');
  await tab('Options').click();
  assert.equal(await field('Include grand total').isChecked(), true);
  await tab('Daily equity').click();
  assert.equal(await field('Chart type').inputValue(), 'range');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  return { receipts: receipts.length, dates: dates.length, types: types.length, pivot };
}
