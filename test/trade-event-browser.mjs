import assert from 'node:assert/strict';

const accountId = '987654321098765433', stamp = '9007199254740993';
const order = { code: 'US.EXAMPLE', order_id: 'private-original-order', side: 'BUY', order_type: 'LIMIT',
  order_status: 'FILLED_ALL', qty: '1.5', price: '39.000000000000001', currency: 'USD', dealt_qty: '1.0',
  dealt_avg_price: '39', create_time: 12345, updated_time: JSON.rawJSON(stamp), remark: 'private-remark-in-file' };
const fill = { code: order.code, order_id: order.order_id, side: 'BUY', deal_id: 'private-original-fill',
  qty: '1.0', price: '38.999999999999999', status: 'CHANGED', create_time: 12345, updated_time: JSON.rawJSON(stamp) };
const corrected = { event_type: 'EVENT_FILL_CORRECT', event_id: 'private-event-one', event_time_us: JSON.rawJSON(stamp),
  user_info: { uid: 123, acc_id: JSON.rawJSON(accountId) }, order_info: order, fill_infos: [fill] };
const earlier = { ...corrected, event_type: 'EVENT_NEW', event_id: 'private-event-two', event_time_us: 12345,
  order_info: { ...order, order_status: 'SUBMITTED', dealt_qty: '0', dealt_avg_price: '', updated_time: 12345 }, fill_infos: [] };
const json = (name, frame) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(frame)) });

// Run from the service-worker-backed reopened page after the server stops.
export async function verifyTradeEvents(page) {
  const parent = page.locator('#runtime-readback');
  await parent.locator(':scope > h2').scrollIntoViewIfNeeded();
  const panel = parent.locator('#private-trade-events'), summary = panel.locator(':scope > summary');
  await summary.click();
  const format = panel.getByLabel('Frame format'), account = panel.getByLabel('Expected securities account ID');
  const files = panel.getByLabel('Saved trade-event files'), show = panel.getByRole('button', { name: 'Read local files' });
  const output = panel.getByRole('region', { name: 'Private trade-event preview' }), status = panel.getByRole('status');
  await files.waitFor();
  const cacheUrls = () => page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map(entry => entry.url));
    }
    return urls.sort();
  });
  const cacheBefore = await cacheUrls(), observed = [];
  const watch = request => observed.push([request.method(), request.url()]);
  page.on('request', watch);
  try {
    async function select(rows, id = accountId) {
      await account.fill(id); await files.setInputFiles(rows); await show.click();
    }
    const first = json('corrected.json', corrected);
    await select([first, json('copy.json', corrected), json('earlier.json', earlier),
      json('future.json', { ...corrected, event_type: 'EVENT_FUTURE' })]);
    await status.filter({ hasText: '2 unique · 1 duplicate · 1 unsupported' }).waitFor();
    await output.getByRole('heading', { name: 'Order accepted' }).waitFor();
    await output.getByLabel('Event', { exact: true }).selectOption('1');
    await output.getByRole('heading', { name: 'Fill corrected' }).waitFor();
    await output.locator('summary').click();
    assert.match(await output.innerText(), /38\.999999999999999 · CHANGED/);
    assert.match(await output.innerText(), new RegExp(stamp));
    const privateValues = [accountId, order.order_id, order.remark, corrected.event_id, fill.deal_id];
    for (const value of privateValues) assert(!(await panel.innerText()).includes(value));
    assert.equal(await account.inputValue(), ''); assert.equal(await files.inputValue(), '');
    await select([first, json('conflict.json', { ...corrected, fill_infos: [{ ...fill, qty: '2' }] })]);
    await status.filter({ hasText: 'Conflicting copies' }).waitFor(); assert.equal(await output.innerText(), '');
    await select([first], '987654321098765432');
    await status.filter({ hasText: 'account differs' }).waitFor(); assert.equal(await output.innerText(), '');
    await format.selectOption('crypto');
    const binary = Buffer.from('CgNldnQiQQoDb3JkEAEaA0JUQyIDVVNEKhQxLjAwMDAwMDAwMDAwMDAwMDAwMTIBMjgBQAJYgYCAgICAgBBgAGoBMXIDMS4wMARSNQoDb3JkEgRmaWxsGhQxLjAwMDAwMDAwMDAwMDAwMDAwMSIBMSoBMTABSgQxLjAwUgRmbG93', 'base64');
    await files.setInputFiles({ name: 'partial.pb', mimeType: 'application/octet-stream', buffer: binary }); await show.click();
    await output.getByRole('heading', { name: 'Partial fill' }).waitFor();
    await panel.getByText(/wire format omits the account ID and event time/).waitFor();
    assert(!(await output.innerText()).includes('Event time (Unix µs)'));
    await output.locator('summary').click(); assert.match(await output.innerText(), /1 remaining/);
    await summary.click(); await page.waitForFunction(() => !document.querySelector('#private-trade-events section')?.childElementCount);
    await summary.click(); await format.selectOption('securities'); await select([first]);
    await output.getByRole('heading', { name: 'Fill corrected' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); await page.waitForFunction(() => !document.querySelector('#private-trade-events section')?.childElementCount);
    const persisted = JSON.stringify(await page.context().storageState({ indexedDB: true })) +
      await page.evaluate(() => JSON.stringify(sessionStorage));
    assert.deepEqual(await cacheUrls(), cacheBefore);
    for (const value of [...privateValues, fill.price]) assert(!persisted.includes(value));
    assert.deepEqual(observed, []);
  } finally { page.off('request', watch); }
}
