import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, verifyImports, verifyOwner } from '../scripts/build.mjs';
import { assessTicket, readFixture, evaluateFreshness, ticketInputs, utcMillis } from '../src/rules.mjs';

const { destination, assets } = await build();
const load = path => import(pathToFileURL(join(destination, path)));
const { MemoryAdapter } = await load('owners/base/src/index.mjs');
const { createTicketStore } = await load('src/tickets.mjs');
const fixture = await readFixture(await readFile(join(destination, 'src/fixture.json')));
const draft = ticketInputs(fixture);

test('R01 compares exact UTC seconds and fails closed on missing or invalid evidence', () => {
  const cases = [
    ['09:00:00','realtime','PASS','WITHIN_WINDOW'], ['09:05:00','realtime','PASS','WITHIN_WINDOW'],
    ['09:05:01','realtime','FAIL','STALE_QUOTE'], ['08:59:59','realtime','UNKNOWN','FUTURE_QUOTE'],
    ['09:00:00',null,'UNKNOWN','MISSING_CLASS'], ['09:01:00','delayed','FAIL','DELAYED_QUOTE'],
  ];
  for (const [time, freshness, state, reason] of cases) {
    const result = evaluateFreshness({ ...fixture.quote, freshness },fixture.policy,`2026-11-19T${time}Z`);
    assert.deepEqual([result.state,result.reason],[state,reason]);
  }
  for (const timestamp of ['2026-02-30T00:00:00Z','2026-11-19T09:00:00','2026-11-19T24:00:00Z','']) assert.equal(utcMillis(timestamp),null);
  for (const maxAgeMinutes of [null, -1, Infinity]) {
    assert.equal(evaluateFreshness(fixture.quote,{maxAgeMinutes},draft.evaluationAt).state,'UNKNOWN');
  }
  assert.equal(assessTicket({...draft,metadata:'missing'},fixture).state,'UNKNOWN');
});

test('the digest is tied to source bytes and the stored ticket cannot silently switch evidence', async () => {
  await assert.rejects(readFixture(new TextEncoder().encode('{}')), /integrity/);
  for (const key of ['symbol','fixtureId','fixtureDigest','policyRevision']) {
    assert.throws(() => assessTicket({...draft,[key]:'other'},fixture),/differs/);
  }
  assert.throws(() => assessTicket({...draft,quantity:0},fixture),/positive/);
});

test('two clients share one writer, reject stale create/update and reopen the same accepted revision', async () => {
  const adapter = new MemoryAdapter();
  const first = createTicketStore(adapter,fixture), other = createTicketStore(adapter,fixture);
  const [a,b] = await Promise.all([first.open(),other.open()]);
  assert.equal(a.record,null);
  const competing = await Promise.allSettled([first.save(a,draft), other.save(b,{...draft,quantity:2})]);
  assert.equal(competing.filter(item => item.status === 'fulfilled').length,1);
  assert.equal(competing.find(item => item.status === 'rejected').reason.code,'CONFLICT');
  const revision1 = await first.open();
  const advanced = { ...revision1.record.values, evaluationAt:'2026-11-19T09:05:01Z' };
  const revision2 = await other.save(revision1,advanced);
  await assert.rejects(first.save(revision1,{...advanced,quantity:99}),{code:'CONFLICT'});
  const reopened = await first.open();
  assert.equal(reopened.revision,revision2.revision);
  assert.equal(reopened.record.revision,2);
  assert.deepEqual(reopened.record.values,advanced);
  assert.equal(assessTicket(reopened.record.values,fixture).reason,'STALE_QUOTE');
});

test('unrecognized stored evidence locks reads and writes without rewriting the previous record', async () => {
  const adapter = new MemoryAdapter();
  const original = createTicketStore(adapter,fixture);
  const accepted = await original.save(await original.open(),draft);
  const newer = createTicketStore(adapter,{...fixture,digest:'unknown'});
  await assert.rejects(newer.open(),/differs/);
  await assert.rejects(newer.save(accepted,draft),/differs/);
  assert.deepEqual((await original.open()).record.values,draft);
});

test('the sealed graph rejects legacy Sheets imports and modified UI projection bytes', () => {
  const bad = new Map(assets);
  bad.set('src/browser.mjs',Buffer.from("import '@agentic-base/views-react/sheets';"));
  assert.throws(() => verifyImports(bad),/Unowned module/);
  const designSources = new Map([
    ['LICENSE',assets.get('owners/design/LICENSE')],
    ['site/favicon.svg',assets.get('owners/design/site/favicon.svg')],
    ['site/THIRD-PARTY-NOTICES.txt',assets.get('owners/design/site/THIRD-PARTY-NOTICES.txt')],
    ['site/vendor/shared-ui-profile.css',assets.get('owners/design/profile.css')],
    ['site/collection-layout.css',assets.get('owners/design/site/collection-layout.css')],
    ['site/dashboard.mjs',assets.get('owners/design/site/dashboard.mjs')],
  ]);
  verifyOwner('agentic-design-system',designSources);
  for (const path of ['site/vendor/shared-ui-profile.css', 'site/collection-layout.css', 'site/dashboard.mjs']) {
    const changed = new Map(designSources);
    changed.set(path, Buffer.from('body {}'));
    assert.throws(() => verifyOwner('agentic-design-system',changed),/Owner bytes/);
  }
  assert.equal([...assets.keys()].filter(key => key.endsWith('profile.css')).length,1);
});


test('the journal obtains its shell and cards from the executable Design System owner', () => {
  const template = assets.get('index.html').toString();
  assert.doesNotMatch(template, /agentic-dashboard-layout|data-agentic-base-dashboard-layout|agentic-dashboard-card/);
  const adapter = assets.get('src/dashboard.mjs').toString();
  assert.match(adapter, /import \{ createNativeDashboard \} from '\.\.\/owners\/design\/site\/dashboard\.mjs'/);
  assert.doesNotMatch(adapter, /agentic-base-dashboard-layout|agentic-dashboard-card/);
  const withoutRenderer = new Map(assets);
  withoutRenderer.delete('owners/design/site/dashboard.mjs');
  assert.throws(() => verifyImports(withoutRenderer), /Unowned module/);
});
