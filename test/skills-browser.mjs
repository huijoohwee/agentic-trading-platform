import assert from 'node:assert/strict';

const tokens = ['#read-only', '/skill.discover', '/skill.load', '@skill:trading'];
const summaries = [
  'No authored or shared-state mutation is requested.',
  'Read pinned portable skill metadata offline.',
  'Read the verified portable skill instructions offline.',
  'Set up provider-neutral API/MCP trading workflows for research, paper-account review, packaging, schedules, dashboards and independent risk review. Use for read-only gateway checks or guarded paper rehearsal, never live orders.',
];

export async function verifyTradingSkills(page, mobile) {
  const toolbar = page.getByRole('navigation', { name: 'Trading tools', exact: true });
  const trigger = toolbar.getByRole('button', { name: 'Skills & Commands', exact: true });
  const root = page.locator('#trading-skills-panel');
  const dialog = page.getByRole('dialog', { name: 'Agentic Trading Skills', exact: true });
  const panel = dialog.getByRole('tabpanel', { name: 'Skills & Commands', exact: true });
  const tab = dialog.getByRole('tab', { name: 'Skills & Commands', exact: true });
  const button = name => panel.getByRole('button', { name, exact: true });
  const rows = panel.locator('.agentic-skills-row');
  const titles = panel.locator('.agentic-collection-title');
  const activate = control => mobile ? control.tap() : control.click();
  const focused = control => control.evaluate(element => element === document.activeElement);
  const ticketValues = () => page.locator('#ticket').evaluate(form =>
    [...form.querySelectorAll('input, select, textarea')].map(field => [field.name, field.value, field.checked]));
  await trigger.waitFor();
  assert.equal(await toolbar.count(), 1);
  assert.deepEqual(await toolbar.locator(':scope > .agentic-toolbar-item').allTextContents(),
    ['Open paper trading desk', 'Decision journal', 'Skills & Commands']);
  const deskLink = toolbar.getByRole('link', { name: 'Open paper trading desk', exact: true });
  const journalLink = toolbar.getByRole('link', { name: 'Decision journal', exact: true });
  assert.equal(await deskLink.getAttribute('href'), './desk.html');
  assert.equal(await journalLink.getAttribute('href'), './');
  assert.equal(await toolbar.locator('[aria-current="page"]').count(), 1);
  const current = new URL(page.url()).pathname.endsWith('/desk.html') ? deskLink : journalLink;
  assert.equal(await current.getAttribute('aria-current'), 'page');
  const ticketBefore = await ticketValues();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await trigger.getAttribute('aria-controls'), 'trading-skills-panel');
  assert.equal(await root.evaluate(element => element.hidden && element.parentElement === document.body), true);
  assert.equal(await root.locator(':scope > *').count(), 0);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => entry.name.endsWith('/src/skills-panel.mjs'))), false, 'The skill panel must load only on first open');

  const effects = [];
  const onRequest = request => { if (request.method() !== 'GET') effects.push(request.method() + ' ' + request.url()); };
  page.on('request', onRequest);
  try {
    await activate(trigger);
    await dialog.waitFor();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await dialog.getAttribute('aria-modal'), 'false');
    assert.match(await dialog.getAttribute('class'), /\bagentic-base-floating-panel\b/);
    assert.equal(await root.getAttribute('data-agentic-floating-panel-placement'), 'viewport-overlay');
    assert.equal(await dialog.getByRole('tablist', { name: 'Agentic Trading Skills' }).getByRole('tab').count(), 1);
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await focused(tab), true);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
      .some(entry => entry.name.endsWith('/src/skills-panel.mjs'))), true);

    async function expectRows(expected) {
      assert.deepEqual((await titles.allTextContents()).sort(), [...expected].sort());
      for (const token of expected) await panel.getByText(token, { exact: true }).waitFor();
      assert.equal(await rows.locator('button, a, input, [role="button"], [contenteditable="true"]').count(), 0,
        'Catalog rows are references, not executable controls');
    }
    async function expectGroups(expected) {
      assert.deepEqual((await panel.getByRole('heading', { level: 3 }).allTextContents()).sort(),
        Object.entries(expected).map(([name, entries]) => `${name} (${entries.length})`).sort());
      for (const [name, entries] of Object.entries(expected)) {
        const group = panel.locator('details').filter({
          has: page.getByRole('heading', { name: `${name} (${entries.length})`, exact: true }),
        });
        assert.deepEqual((await group.locator('.agentic-collection-title').allTextContents()).sort(), [...entries].sort());
      }
    }
    async function withinViewport() {
      const bounds = await dialog.evaluate(element => ({
        ...element.getBoundingClientRect().toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0
        && bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight
        && bounds.documentWidth <= bounds.viewportWidth,
      'Floating panel stays inside the viewport without widening the document: ' + JSON.stringify(bounds));
    }
    await expectRows(tokens);
    for (const summary of summaries) await panel.getByText(summary, { exact: true }).waitFor();
    await expectGroups({ Trading: tokens });
    await panel.getByText('Agentic Trading Skills · agentic-os · @skill:trading. Pinned offline reference; commands run in the owning CLI, not this browser. No order authority.', { exact: true }).waitFor();

    const source = panel.getByRole('link', { name: 'Read verified trading skill instructions', exact: true });
    const href = await source.getAttribute('href');
    assert.equal(href, new URL('/owners/os/skills/trading/SKILL.md', page.url()).href);
    assert.equal(await source.getAttribute('target'), '_blank');
    assert.match(await source.getAttribute('rel'), /\bnoopener\b/);
    const proof = await page.evaluate(async href => {
      const response = await fetch(href, { redirect: 'error' });
      const bytes = await response.arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const catalogResponse = await fetch('/owners/os/catalog/invocation.json', { redirect: 'error' });
      const catalog = await catalogResponse.json();
      return {
        status: response.status, url: response.url, catalogStatus: catalogResponse.status,
        text: new TextDecoder().decode(bytes),
        digest: 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''),
        descriptor: catalog.entries.find(entry => entry.token === '@skill:').descriptor,
      };
    }, href);
    assert.equal(proof.status, 200);
    assert.equal(proof.catalogStatus, 200);
    assert.equal(proof.url, href);
    assert.equal(proof.descriptor.id, 'trading');
    assert.equal(proof.descriptor.owner, 'agentic-os');
    assert.equal(proof.descriptor.source, 'agentic-os/skills/trading/SKILL.md');
    assert.equal(proof.digest, proof.descriptor.digest, 'Linked instruction bytes match the sealed catalog digest');
    assert.match(proof.text, /^---\nname: trading\n/);
    assert.match(proof.text, /no\s+dispatch authority/i);
    assert.match(proof.text, /No live orders\./);
    await panel.getByText(`Read verified trading skill instructions · ${proof.descriptor.source} · ${proof.digest}`, { exact: true }).waitFor();
    assert.equal(await panel.getByRole('link').count(), 1);

    const prefixes = ['Slash commands', 'Hash semantics', 'At bindings'];
    for (const [name, expected] of [
      ['Slash commands', ['/skill.discover', '/skill.load']],
      ['Hash semantics', ['#read-only']],
      ['At bindings', ['@skill:trading']],
    ]) {
      await activate(button(name));
      await expectRows(expected);
      for (const prefix of prefixes) assert.equal(await button(prefix).getAttribute('aria-pressed'), String(prefix === name));
      await activate(button(name));
      await expectRows(tokens);
      for (const prefix of prefixes) assert.equal(await button(prefix).getAttribute('aria-pressed'), 'true');
    }

    for (const [facet, groups] of [
      ['Verb', { constrain: ['#read-only'], discover: ['/skill.discover'], load: ['/skill.load'], select: ['@skill:trading'] }],
      ['Object', { Authority: ['#read-only'], 'Portable skill': ['/skill.discover', '/skill.load', '@skill:trading'] }],
      ['Subject', { Trading: tokens }],
    ]) {
      await activate(button('Group by ' + facet));
      await expectGroups(groups);
      for (const choice of ['Subject', 'Verb', 'Object']) {
        assert.equal(await button('Group by ' + choice).getAttribute('aria-pressed'), String(choice === facet));
      }
    }

    await activate(button('Search skills and commands'));
    const search = panel.getByRole('searchbox', { name: 'Search commands', exact: true, includeHidden: true });
    assert.equal(await focused(search), true);
    await search.fill('  /SKILL.LOAD  ');
    await expectRows(['/skill.load']);
    await search.fill('not-a-trading-skill-000');
    await panel.getByText('No matching entries.', { exact: true }).waitFor();
    assert.equal(await rows.count(), 0);
    assert.equal(await button('Collapse All').isVisible(), false);
    await search.press('Escape');
    assert.equal(await search.isVisible(), false);
    assert.equal(await search.inputValue(), '');
    assert.equal(await button('Search skills and commands').getAttribute('aria-expanded'), 'false');
    assert.equal(await focused(button('Search skills and commands')), true);
    assert.equal(await dialog.isVisible(), true, 'Search Escape clears the query, not the panel');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await expectRows(tokens);
    await activate(button('Search skills and commands'));
    assert.equal(await search.inputValue(), '');
    await search.press('Escape');

    if (mobile) assert.equal(page.viewportSize().width, 360);
    for (const layout of ['card', 'grid', 'list']) {
      await activate(button(layout[0].toUpperCase() + layout.slice(1) + ' layout'));
      await expectRows(tokens);
      for (const choice of ['list', 'card', 'grid']) {
        assert.equal(await button(choice[0].toUpperCase() + choice.slice(1) + ' layout').getAttribute('aria-pressed'), String(choice === layout));
      }
      assert.deepEqual(await rows.evaluateAll(elements => elements.map(element => element.dataset.layout)), tokens.map(() => layout));
      assert.deepEqual(await panel.locator('details > .agentic-collection').evaluateAll(elements => elements.map(element => element.dataset.layout)), [layout]);
      await withinViewport();
      if (mobile) {
        const body = panel.locator('.agentic-skills-body');
        assert.equal(await body.evaluate(element => {
          element.scrollTop = 0;
          const scrollable = /auto|scroll/.test(getComputedStyle(element).overflowY)
            && element.scrollHeight > element.clientHeight && element.clientHeight > 0;
          element.scrollTop = element.scrollHeight;
          return scrollable && element.scrollTop > 0;
        }), true, 'Mobile catalog remains vertically scrollable');
        await source.scrollIntoViewIfNeeded();
        assert.equal(await source.evaluate(element => {
          const box = element.getBoundingClientRect(), frame = element.closest('[role="dialog"]').getBoundingClientRect();
          return box.top >= frame.top && box.bottom <= frame.bottom && box.left >= frame.left && box.right <= frame.right;
        }), true, 'Skill instructions are reachable inside the mobile panel');
        await body.evaluate(element => { element.scrollTop = 0; });
      }
    }

    await activate(button('Group by Verb'));
    await activate(button('Collapse All'));
    assert.deepEqual(await panel.locator('details').evaluateAll(elements => elements.map(element => element.open)), [false, false, false, false]);
    for (const token of tokens) assert.equal(await panel.getByText(token, { exact: true }).isVisible(), false);
    await activate(button('Expand All'));
    assert.deepEqual(await panel.locator('details').evaluateAll(elements => elements.map(element => element.open)), [true, true, true, true]);
    await expectRows(tokens);
    await activate(button('Group by Subject'));
    const summary = panel.locator('summary').filter({ has: page.getByRole('heading', { name: 'Trading (4)', exact: true }) });
    await summary.press('Enter');
    await button('Expand All').waitFor();
    assert.equal(await panel.getByText('/skill.discover', { exact: true }).isVisible(), false);
    await summary.press('Enter');
    await button('Collapse All').waitFor();
    await expectRows(tokens);

    const shell = await dialog.elementHandle();
    for (const close of [
      () => activate(dialog.getByRole('button', { name: 'Close', exact: true })),
      () => tab.press('Escape'),
    ]) {
      await close();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await focused(trigger), true);
      await activate(trigger);
      await dialog.waitFor();
      assert.equal(await root.getByRole('dialog', { includeHidden: true }).count(), 1);
      assert.equal(await root.getByRole('tab', { includeHidden: true }).count(), 1);
      assert.equal(await root.locator(':scope > *').count(), 1);
      assert.equal(await shell.evaluate(element => element === document.querySelector('#trading-skills-panel > [role="dialog"]')), true,
        'Reopening reuses the original shared shell');
      assert.equal(await focused(tab), true);
      await expectRows(tokens);
    }
    await shell.dispose();
    await tab.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await focused(trigger), true);
    assert.deepEqual(await ticketValues(), ticketBefore, 'Reference browsing preserves ticket inputs');
    assert.deepEqual(effects, [], 'Reference browsing never sends a mutation request');
  } finally {
    page.off('request', onRequest);
  }
}
