import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assemble } from '../scripts/build.mjs';
import { serveAssets } from '../scripts/local-server.mjs';
import { loadCommercePolicies } from '../scripts/serve.mjs';

const digest = body => createHash('sha256').update(body).digest('hex');

async function verifyChangedManifest(browser, origin, assets) {
  const original = assets.get('asset-manifest.json');
  const changed = JSON.parse(original);
  changed.files['index.html'] = digest('different document');
  assets.set('asset-manifest.json', Buffer.from(JSON.stringify(changed)));
  assets.set('probe.html', Buffer.from('<!doctype html><title>Offline install check</title>'));
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin + '/probe.html');
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const worker = registration.installing;
      if (!worker) throw Error('Expected a first install');
      window.installState = () => worker.state;
    });
    await page.waitForFunction(() => window.installState() === 'redundant');
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
  } finally {
    assets.set('asset-manifest.json', original); assets.delete('probe.html');
    await context.close();
  }
}

export async function verifyJournalUpdate(browser) {
  const { LOCAL_FIRST_DEV_CSP: policy } = await loadCommercePolicies();
  const { id, assets } = await assemble({ devDocumentPolicy: policy });
  const server = await serveAssets(0, { assets, documentPolicy: policy, resourcePolicy: policy });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const ready = 'Update ready. Save edits, close all Trading tabs at this address, then reopen.';
  try {
    await verifyChangedManifest(browser, origin, assets);
    const journal = await context.newPage(), second = await context.newPage();
    await journal.goto(origin);
    await journal.getByText('Offline ready', { exact: true }).waitFor();
    await second.goto(origin);
    await second.getByText('Offline ready', { exact: true }).waitFor();
    // Release a distinguishable document using the same integrity-checking worker.
    const previous = assets.get('index.html');
    const next = Buffer.from(previous.toString().replace('<html ', '<html data-test-release="next" '));
    assert.notEqual(digest(next), digest(previous));
    const manifest = JSON.parse(assets.get('asset-manifest.json'));
    const oldFiles = { ...manifest.files };
    delete oldFiles['sw.js'];
    const nextFiles = { ...oldFiles, 'index.html': digest(next) };
    const nextId = digest(id + 'next');
    const worker = assets.get('sw.js').toString().replace(id, nextId)
      .replace(digest(JSON.stringify(oldFiles)), digest(JSON.stringify(nextFiles)));
    assets.set('asset-manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: nextId, files: { ...nextFiles, 'sw.js': digest(worker) } })));
    assets.set('index.html', next);
    assets.set('sw.js', Buffer.from(worker));

    await context.setOffline(true);
    await journal.getByText('Working offline', { exact: true }).waitFor();
    await context.setOffline(false);
    await journal.getByText(ready, { exact: true }).waitFor();
    await second.getByText(ready, { exact: true }).waitFor();
    await journal.getByRole('button', { name: 'Save draft' }).click();
    await journal.getByText('Revision 1', { exact: true }).waitFor();
    await journal.reload();
    await journal.getByText(ready, { exact: true }).waitFor();
    assert.equal(await journal.locator('html').getAttribute('data-test-release'), null);

    await Promise.all([journal.close(), second.close()]);
    await context.setOffline(true);
    const reopened = await context.newPage();
    await reopened.goto(origin);
    await reopened.getByText('Working offline', { exact: true }).waitFor();
    assert.equal(await reopened.locator('html').getAttribute('data-test-release'), 'next');
    await reopened.getByText('Revision 1', { exact: true }).waitFor();
    console.log('Two open journals announce the verified update and preserve the saved revision on offline reopen.');
  } finally {
    await context.close();
    server.close();
  }
}
