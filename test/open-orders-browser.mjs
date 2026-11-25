import assert from 'node:assert/strict';

export async function verifyOpenOrders(page) {
  const panel = page.locator('#private-open-orders');
  await panel.locator('summary').click();
  const account = panel.getByLabel('Expected securities account ID'), market = panel.getByLabel('Trading market');
  const path = panel.getByLabel('Original GET path with query'), file = panel.getByLabel('Saved JSON response');
  const read = panel.getByRole('button', { name: 'Read page' }), status = panel.getByRole('status').first();
  const table = panel.getByRole('table', { name: 'Saved orders table' });
  const id = '9007199254740997', base = '/api/v1.0/accounts/' + id + '/orders?trd_market=US';
  const order = { order_id: 'private-A', code: 'US.FIXTURE', order_type: 'LIMIT', order_status: 'FILLED_PART', side: 'BUY',
    currency: 'USD', qty: '4.0000000000000001', dealt_qty: '1', price: '180.000', create_time: 1, updated_time: 2 };
  async function add(request, rows, flags = { completed: true }, key = 'orders') {
    await path.fill(request);
    await file.setInputFiles({ name: 'local.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ s: 'ok', d: { [key]: rows, ...flags } })) });
    await read.click();
  }
  await account.fill(id); await market.fill('US');
  const requests = [], record = request => requests.push(request.url());
  page.on('request', record);
  await add(base, [order], { completed: false, page_flag: 'two +/' });
  await status.getByText(/Read page 1/).waitFor();
  assert.equal(await table.count(), 0);
  const second = base + '&page_flag=two+%2B%2F';
  await add(second.replace(id, '7'), []);
  await status.getByText(/Check the account/).waitFor();
  assert.equal(await table.count(), 0);
  await add(second, [{ ...order, order_id: 'private-B', order_status: 'CANCELLED_PART' }]);
  await status.getByText(/1 working · 1 terminal/).waitFor();
  assert.equal(await table.getByText('4.0000000000000001', { exact: true }).count(), 2);
  await table.getByRole('row').filter({ hasText: 'FILLED_PART' }).press('Enter');
  await panel.getByText('LIMIT', { exact: true }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /private-[AB]/);
  const layout = panel.getByLabel('View layout');
  await layout.selectOption('multiDimensional');
  await panel.getByRole('table', { name: 'Saved orders counts' }).waitFor();
  await layout.selectOption('kanban');
  await panel.getByText('US.FIXTURE', { exact: true }).first().waitFor();
  assert.equal(await account.inputValue(), '');
  assert.equal(await path.inputValue(), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= page.viewportSize().width);
  await panel.locator('summary').click();
  await page.waitForFunction(() => !document.querySelector('#saved-order-views'));
  await panel.locator('summary').click();
  assert.equal(await panel.getByText('LIMIT', { exact: true }).count(), 0);
  await account.fill(id); await market.fill('US'); await add(base, []);
  await status.getByText(/0 working · 0 terminal/).waitFor();
  await panel.getByRole('button', { name: 'Clear listing' }).click();
  assert.equal(await status.innerText(), '');
  const source = panel.getByLabel('Saved account data');
  await source.selectOption('account_orders_history');
  await account.fill(id); await market.fill('US');
  const orderHistory = base.replace('orders?', 'orders_history?') + '&start=1&end=5';
  await add(orderHistory, [{ ...order, updated_time: '9007199254740993' }]);
  await status.getByText('Saved page 1 · 1 record · Final page', { exact: true }).waitFor();
  const historyTable = panel.getByRole('table', { name: 'Order history table' });
  await historyTable.getByRole('columnheader', { name: /Order creation time/ }).waitFor();
  await historyTable.getByRole('row').filter({ hasText: 'US.FIXTURE' }).press('Enter');
  await panel.getByText('9007199254740993', { exact: true }).waitFor();
  await source.selectOption('account_fills_history');
  assert.equal(await historyTable.count(), 0);
  await account.fill(id); await market.fill('US');
  const fills = orderHistory.replace('orders_history?', 'fills_history?');
  const fill = { deal_id: 'private-fill', order_id: order.order_id, code: order.code, trd_side: 'BUY', status: 'CHANGED',
    qty: '0.00000000000000001', price: order.price, create_time: 1, update_time: 3 };
  await add(fills + '&page_flag=prior', [fill], { completed: false, page_flag: 'next' }, 'order_fills');
  await status.getByText(/More pages available · Earlier pages omitted/).waitFor();
  const fillTable = panel.getByRole('table', { name: 'Fill history table' });
  await fillTable.getByText(fill.qty, { exact: true }).waitFor();
  await fillTable.getByRole('row').filter({ hasText: 'CHANGED' }).press('Enter');
  await panel.getByText('Order 1', { exact: true }).waitFor();
  await add(fills.replace('end=5','end=6') + '&page_flag=next', [], { completed: true }, 'order_fills');
  await status.getByText(/time window changed/).waitFor();
  await add(fills + '&page_flag=next', [{ ...fill, deal_id: 'private-fill-2', status: 'CANCELLED' }], { completed: true }, 'order_fills');
  await status.getByText(/Saved page 2 .*Final page · Earlier pages omitted/).waitFor();
  await fillTable.getByRole('row').filter({ hasText: 'CANCELLED' }).press('Enter');
  await panel.getByText('Order 1', { exact: true }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /private-fill|private-A/);
  assert.equal(await account.inputValue(), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= page.viewportSize().width);
  await panel.locator('summary').click();
  page.off('request', record);
  assert.ok(requests.every(url => new URL(url).origin === new URL(page.url()).origin &&
    /\/(journal\.css|browser-data-view\.css)$/.test(new URL(url).pathname)));
  const stored = JSON.stringify(await page.context().storageState({ indexedDB: true })) +
    await page.evaluate(() => JSON.stringify(sessionStorage));
  for (const value of [id, 'private-A', 'private-B', 'private-fill', order.qty, fill.qty, second]) assert.ok(!stored.includes(value));
}
