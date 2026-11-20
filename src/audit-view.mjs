import { IndexedDBAdapter } from '../owners/base/src/index.mjs';
import { localFixtureTable } from './tickets.mjs';
import { auditSnapshot, restoreAudit } from './local-audit.mjs';
import { digest, canonical } from './rules.mjs';

const baseId = 'trading-manual-fixture-v1', tableId = 'accepted-runs';
const fields = [
  { id: 'accepted', name: 'Accepted revision', type: 'number', required: true },
  { id: 'archive', name: 'Synthetic run', type: 'text', required: true },
];
const maxBytes = 480_000;
const size = text => new TextEncoder().encode(text).length;
const identity = input => digest(canonical([input.account_alias, input.run_id]));

// One append per run identity. Its accepted revision also selects the most recent complete run.
export function auditStore(adapter) {
  const scope = { baseId, tableId };
  const { ensureTable, run } = localFixtureTable(adapter, { ...scope, title: 'Manual synthetic runs', fields,
    permitRecord: (id, op) => (id === null || /^[a-f0-9]{64}$/.test(id)) && !['record.update','record.delete'].includes(op) });
  async function latest() {
    await ensureTable();
    const { revision, items } = await run('record.list', { ...scope, sort:[{ fieldId:'accepted', direction:'desc' }], limit:1 });
    if (!items.length) return { revision, pack:null };
    const pack = JSON.parse(items[0].values.archive);
    if (await identity(pack.input) !== items[0].id) throw Error('Stored run identity differs');
    await restoreAudit(pack, pack.audit.witness);
    return { revision, pack };
  }
  async function accept(pack, revision) {
    const archive = JSON.stringify(pack);
    if (size(archive) > maxBytes) throw Error('Audit exceeds the local record budget');
    const accepted = JSON.parse(archive);
    const audit = await restoreAudit(accepted, accepted.audit.witness);
    if (audit.rowsRejected.length) throw Error('Import refused: ' + audit.rowsRejected.length + ' invalid landing rows');
    const id = await identity(accepted.input);
    try {
      const result = await run('record.create', { ...scope, id, expectedRevision:revision, values:{ archive, accepted:revision + 1 } });
      return result.revision;
    } catch (error) {
      if (error.code !== 'CONFLICT') throw error;
      let existing;
      try { existing = await run('record.get', { ...scope, recordId:id }); }
      catch (lookup) { if (lookup.code === 'NOT_FOUND') throw Error('Another tab imported first. Reopen this page before importing.'); throw lookup; }
      if (canonical(JSON.parse(existing.values.archive)) !== canonical(accepted)) throw Error('Run ID already has different evidence');
      return revision; // Duplicate delivery adds no record and advances no cursor.
    }
  }
  return { latest, accept };
}

export async function mountAudit(panel) {
  const el = id => panel.querySelector('#audit-' + id);
  const store = auditStore(new IndexedDBAdapter({ databaseName:baseId }));
  let { revision, pack } = await store.latest();
  if (!pack) {
    const response = await fetch('./src/audit-fixture.json');
    if (!response.ok) throw Error('Audit fixture unavailable');
    const input = await response.json();
    pack = { input, audit:await auditSnapshot(input) };
  }
  function render() {
    const { input, audit } = pack;
    el('input').value = JSON.stringify(input, null, 2);
    const verdict = audit.decisions.map(d => [d.id, d.outcome, d.match].join(' · '));
    el('status').textContent = verdict.join(' / ') || 'No tickets in this run';
    const facts = [['Run',input.run_id],['Equity in base currency',audit.totals.equity ?? 'UNKNOWN'],
      ['Observed at',input.evaluated_utc],['Policy revision',input.policy.revision],
      ['Rejected landing rows',audit.rowsRejected.length],['Unbound orders',audit.orphanOrders.join(', ') || 'None']];
    for (const decision of audit.decisions) {
      facts.push([decision.id, Object.entries(decision.checks).map(([k,v]) => k + ' ' + v).join(' · ')]);
      if (decision.flags.length) facts.push(['Flags',decision.flags.join(', ')]);
    }
    facts.push(['Audit head',audit.witness.head]);
    el('results').replaceChildren(...facts.map(([label,value]) => {
      const row=document.createElement('div'), term=document.createElement('dt'), result=document.createElement('dd');
      term.textContent=label; result.textContent=value; row.append(term,result); return row;
    }));
  }
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)],{ type:'application/json' }));
    const a = document.createElement('a'); a.href=url; a.download=name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function readSelection(id) {
    const file = el(id).files[0];
    if (!file || file.size > maxBytes) throw Error('Select the audit archive and its separately saved witness within 480 kB each');
    return JSON.parse(await file.text());
  }
  async function update(load) {
    el('files').disabled = true;
    try {
      const candidate = await load();
      revision = await store.accept(candidate, revision);
      pack = candidate; render();
      el('feedback').textContent = 'Verified run ' + pack.input.run_id;
    } catch (error) { el('feedback').textContent = error.message; }
    finally { el('files').disabled = false; }
  }
  el('accept').onclick = () => update(async () => {
    const text = el('input').value;
    if (size(text) > maxBytes) throw Error('Snapshot exceeds 480 kB');
    const input = JSON.parse(text);
    return { input, audit:await auditSnapshot(input) };
  });
  el('restore').onclick = () => update(async () => {
    const archive = await readSelection('archive');
    await restoreAudit(archive, await readSelection('proof'));
    return archive;
  });
  el('export').onclick = () => download(pack,'local-audit.json');
  el('witness').onclick = () => download(pack.audit.witness,'audit-witness.json');
  render();
  el('files').disabled = false;
}
