import assert from 'node:assert/strict';

export async function verifyRouteViews(page) {
  const routes = page.locator('#coverage-routes');
  const layout = routes.getByRole('combobox', { name: 'View layout' });
  const family = page.locator('#coverage-families'), reference = page.locator('#coverage-references');
  const operations = ['read.catalog', 'read.candles', 'read.ticker', 'read.depth', 'read.tape', 'read.candle-history'];
  const firstCell = family.getByRole('row').filter({ hasText: 'Realtime quotes, history, book and tape' }).getByRole('cell').nth(3);
  await firstCell.locator('code').first().waitFor();
  assert.deepEqual(await firstCell.locator('code').allTextContents(), operations);
  assert.equal(await firstCell.textContent(), operations.join(', '));
  await firstCell.click();
  assert.deepEqual(await family.getByRole('region', { name: 'Selected family evidence' }).locator('dd code').allTextContents(), operations);
  await family.getByRole('columnheader', { name: 'Mapped reads' }).waitFor();
  await reference.getByRole('cell', { name: '/', exact: true }).click();
  await reference.getByText('This catalog reference lists no routes.').waitFor();
  const hashCell = reference.getByRole('cell', { name: /^[A-Fa-f0-9]{64}$/ }).first();
  assert(await hashCell.locator('span').first().evaluate(el =>
    el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1));

  for (const grid of [
    { id: 'references', count: 305, cell: '/', record: /Card: \/api-reference$/, evidence: 'Selected reference evidence', link: '/api-reference' },
    { id: 'families', count: 26, cell: 'Earnings calendar', record: /Card: Earnings calendar$/, evidence: 'Selected family evidence', link: 'api/quote/calendar/earnings-calendar.md' },
  ]) {
    const surface = page.locator('#coverage-' + grid.id);
    await surface.getByText('1–12 of ' + grid.count, { exact: true }).waitFor();
    await surface.getByRole('cell', { name: grid.cell, exact: true }).first().waitFor();
    const choose = surface.getByLabel('View layout');
    await choose.selectOption('multiDimensional');
    await surface.getByRole('cell', { name: String(grid.count), exact: true }).first().waitFor();
    if (grid.id === 'families') {
      await surface.getByLabel('Count', { exact: true }).selectOption({ label: 'Distinct mapped reads' });
      await surface.getByRole('cell', { name: '43', exact: true }).first().waitFor();
    }
    await surface.getByRole('button', { name: /Current table orientation/ }).click();
    await choose.selectOption('kanban');
    const card = surface.getByRole('button', { name: grid.record });
    if (grid.id === 'families') await card.locator('code').filter({ hasText: /^read\.calendar$/ }).waitFor();
    await card.click();
    const details = surface.getByRole('region', { name: grid.evidence });
    await details.getByRole('link', { name: grid.link, exact: true }).waitFor();
    assert.match(await details.textContent(), /SHA-256 [a-f0-9]{64}/);
    await choose.selectOption('table');
  }
  await routes.getByText('1–12 of 389', { exact: true }).waitFor();
  await routes.getByRole('button', { name: 'Next', exact: true }).click();
  await routes.getByText('13–24 of 389', { exact: true }).waitFor();
  await layout.selectOption('multiDimensional');
  const matrix = routes;
  for (const total of ['258', '107', '24', '389']) await matrix.getByRole('cell', { name: total, exact: true }).first().waitFor();
  await matrix.getByRole('button', { name: /Current table orientation/ }).click();
  await matrix.getByText('389', { exact: true }).first().waitFor();
  await layout.selectOption('kanban');
  const board = routes.getByRole('region', { name: 'Routes by disposition', exact: true });
  await board.getByRole('heading', { name: /offline replay.*24/ }).waitFor();
  const more = board.getByRole('button', { name: 'Show more candidate records' });
  const before = await board.locator('[data-base-card]').count(); await more.click();
  assert.equal(await board.locator('[data-base-card]').count(), before + 12);
  await routes.getByRole('button', { name: 'Filter routes' }).click();
  await routes.getByLabel('Transport', { exact: true }).selectOption('Push');
  await routes.getByText('24 matching routes').waitFor();
  await board.getByRole('heading', { name: /offline replay.*24/ }).waitFor();
  await board.getByRole('heading', { name: /Ungrouped.*0/ }).waitFor();
  assert.equal(await board.getByRole('heading').count(), 2);
  await board.locator('[data-base-card]').first().click();
  await routes.getByRole('region', { name: 'Selected route evidence' }).getByRole('link').first().waitFor();
  await routes.getByLabel('Transport', { exact: true }).selectOption('All');
  await layout.selectOption('table');
  await routes.getByRole('button', { name: 'Search routes' }).click();
  await routes.getByRole('searchbox', { name: 'Route or tool', exact: true }).fill('quote_stock_quote');
  await routes.getByRole('cell', { name: 'quote_stock_quote', exact: true }).click();
  await routes.getByText('quote:read · Desktop and hosted captures').waitFor();
  await routes.getByText('POST /api/v1.0/quote/stock-quote', { exact: true }).last().waitFor();
  const fields = page.locator('#coverage-fields'), routeDetail = routes.getByRole('region', { name: 'Selected route evidence' });
  await routeDetail.getByRole('link', { name: 'View fields for quote_stock_quote', exact: true }).click();
  await fields.getByText('1–12 of 23', { exact: true }).waitFor();
  await fields.getByRole('cell', { name: 'code_list', exact: true }).click();
  const fieldDetail = fields.getByRole('region', { name: 'Selected field evidence' });
  await fieldDetail.getByText('Minimum items 1 · Maximum items 400', { exact: true }).waitFor();
  await fieldDetail.getByRole('link', { name: 'MCP · quote_stock_quote', exact: true }).click();
  await routes.locator('tr[aria-selected=true]:focus').getByRole('cell', { name: 'quote_stock_quote', exact: true }).waitFor();
  await routeDetail.getByRole('heading', { name: 'quote_stock_quote', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await routes.getByRole('searchbox', { name: 'Route or tool', exact: true }).fill('/rt-ticker');
  await routes.getByRole('cell', { name: 'GET /api/v1.0/quote/{symbol}/rt-ticker', exact: true }).click();
  await routes.getByText('quote:read · Signed local market REST fixture').waitFor();
  await routes.getByRole('searchbox', { name: 'Route or tool', exact: true }).fill('news_search');
  await routes.getByRole('cell', { name: 'news_search', exact: true }).click();
  await routes.getByText('review news access · Signed local MCP research fixture').waitFor();
  await routes.getByRole('combobox', { name: 'Disposition', exact: true }).selectOption('excluded');
  await routes.getByText('No matching routes').waitFor();
  await routes.getByRole('searchbox', { name: 'Route or tool', exact: true }).fill('trading_order_place');
  await routes.getByRole('cell', { name: 'trading_order_place', exact: true }).waitFor();

  // A document link can reach an off-page route even while the routes view excludes it.
  const doc = '/api/quote/basic-data/search-hot-stocks', get = 'GET /api/v1.0/quote/search-hot-stocks';
  await reference.getByRole('button', { name: 'Search references' }).click();
  await reference.getByRole('searchbox').fill(doc);
  await reference.getByRole('cell', { name: doc, exact: true }).click();
  const refDetail = reference.getByRole('region', { name: 'Selected reference evidence' });
  await refDetail.getByRole('link', { name: get, exact: true }).click();
  await routes.locator('tr[aria-selected=true]:focus').getByRole('cell', { name: get, exact: true }).waitFor();
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('route'), 'REST ' + get);
  await routeDetail.getByRole('link', { name: doc, exact: true }).click();
  await reference.getByRole('row', { name: 'Data row: ' + doc, selected: true }).waitFor();
  await page.goBack();
  await routes.locator('tr[aria-selected=true]:focus').getByRole('cell', { name: get, exact: true }).waitFor();
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('route'), 'REST ' + get);

  const earnings = '/api/quote/calendar/earnings-calendar';
  await family.getByRole('cell', { name: 'Earnings calendar', exact: true }).click();
  const selectedFamily = family.getByRole('region', { name: 'Selected family evidence' });
  await selectedFamily.getByRole('link', { name: earnings.slice(1) + '.md', exact: true }).click();
  await reference.locator('tr[aria-selected=true]:focus').getByText(earnings, { exact: true }).waitFor();
  await refDetail.getByText('Original mirror · ' + earnings.slice(1) + '.md', { exact: true }).waitFor();
  const earningsRoute = 'GET /api/v1.0/quote/earnings-calendar';
  await refDetail.getByRole('link', { name: earningsRoute, exact: true }).click();
  await routes.locator('tr[aria-selected=true]:focus').getByText(earningsRoute, { exact: true }).waitFor();
  await routeDetail.getByRole('link', { name: earnings, exact: true }).click();
  await refDetail.getByRole('link', { name: 'Earnings calendar', exact: true }).click();
  await family.locator('tr[aria-selected=true]:focus').getByText('Earnings calendar', { exact: true }).waitFor();
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('family'), 'calendar');

  const cancel = 'DELETE /api/v1/crypto/accounts/{acc_id}/orders/{order_id}', tool = 'crypto_account_cancel_order';
  await routes.getByRole('searchbox').fill(cancel);
  await routes.getByRole('cell', { name: cancel, exact: true }).click();
  const forward = routeDetail.locator('a[href^="#provider-coverage?fields="]');
  await fields.getByRole('table', { name: 'HTTP fields table', exact: true }).waitFor();
  assert.deepEqual(await fields.locator('tbody tr td:first-child code').allTextContents(), ['acc_id', 'orderId', 'req_id']);
  await forward.click();
  await fields.getByText('1–3 of 3', { exact: true }).waitFor();
  await fields.getByRole('cell', { name: 'orderId', exact: true }).click();
  await fieldDetail.getByText(tool + ' · Path · string · Required', { exact: true }).waitFor();
  const fieldUrl = page.url();
  await fieldDetail.getByRole('link', { name: 'REST · ' + cancel, exact: true }).click();
  await routes.getByRole('row', { name: 'Data row: ' + cancel, selected: true }).waitFor();
  await routeDetail.getByText('trade:write · Live effect excluded', { exact: true }).waitFor();

  const bookmark = await page.context().newPage();
  try {
    await bookmark.goto(page.url());
    const linkedFields = bookmark.locator('#coverage-fields');
    await linkedFields.scrollIntoViewIfNeeded();
    await linkedFields.getByText('1–3 of 3', { exact: true }).waitFor();
    assert.deepEqual(await linkedFields.locator('tbody tr td:first-child code').allTextContents(), ['acc_id', 'orderId', 'req_id']);
    await bookmark.goto(fieldUrl);
    const restored = bookmark.locator('#coverage-fields');
    await restored.getByRole('row', { name: 'Data row: orderId', selected: true }).waitFor();
    await restored.getByRole('combobox', { name: 'View layout' }).selectOption('multiDimensional');
    await restored.getByRole('cell', { name: '3', exact: true }).first().waitFor();
    await restored.getByLabel('Tool', { exact: true }).selectOption('All');
    await restored.getByRole('cell', { name: '1568', exact: true }).first().waitFor();
    await restored.getByRole('combobox', { name: 'View layout' }).selectOption('kanban');
    await restored.getByText('1–48 of 1568', { exact: true }).waitFor();
    await restored.getByRole('button', { name: 'Next', exact: true }).click();
    await restored.getByText('49–96 of 1568', { exact: true }).waitFor();
  } finally { await bookmark.close(); }
}
