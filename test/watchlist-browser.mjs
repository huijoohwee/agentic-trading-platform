import assert from 'node:assert/strict';

export async function verifyOfflineWatchlists(page) {
  const section = page.locator('#private-watchlists');
  await section.scrollIntoViewIfNeeded();
  const directory = section.getByLabel('Saved group directory'), groups = section.getByLabel('Watchlist group');
  const members = section.getByLabel('Saved group members'), table = section.locator('#watchlist-member-views');
  const file = (data, raw) => ({ name: 'synthetic.json', mimeType: 'application/json',
    buffer: Buffer.from(raw ?? JSON.stringify({ ret_code: 0, data })) });
  const name = '選項 & /🪴';
  await directory.setInputFiles(file({ group_list: [{ group_name: name, group_type: 'CUSTOM' }, { group_name: 'All', group_type: 'SYSTEM' }] }));
  await section.getByText('2 saved groups', { exact: true }).waitFor();
  await groups.selectOption(name);
  const raw = '{"ret_code":0,"data":{"security_list":[{"code":"US.TEST","name":"Fixture","stock_type":"DRVT","stock_id":9007199254740993,"strike_price":12.000000000000000001}]}}';
  await members.setInputFiles(file(null, raw));
  await table.getByText('9007199254740993', { exact: true }).waitFor();
  await table.getByText('12.000000000000000001', { exact: true }).waitFor();
  const layout = table.getByLabel('View layout');
  await layout.selectOption('multiDimensional');
  await table.getByRole('table', { name: 'Watchlist members counts' }).waitFor();
  await layout.selectOption('kanban');
  await table.getByText('US.TEST', { exact: true }).first().waitFor();
  await groups.selectOption('All');
  assert.equal(await table.count(), 0);
  await members.setInputFiles(file({ security_list: [] }));
  await section.getByText('All · 0 saved members', { exact: true }).waitFor();
  await members.setInputFiles(file(null, '{"ret_code":-9}'));
  await section.getByText('The saved response records a permission refusal.').waitFor();
  await section.getByRole('button', { name: 'Clear watchlists' }).click();
  assert.equal(await groups.isDisabled(), true);
  assert.equal(await members.isDisabled(), true);
  assert.equal(await section.getByText(name, { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => location.hash.includes('TEST') || document.documentElement.scrollWidth > innerWidth), false);
}
