import { IndexedDBAdapter } from '../owners/base/src/adapters/indexeddb.mjs';
import { localFixtureTable } from './tickets.mjs';
import { SOURCE } from './market.mjs';

export async function practiceCache() {
  const baseId = 'practice-readback',
    tableId = 'sessions',
    id = 'latest';
  const fields = [{ id: 'snapshot', name: 'Local server readback', type: 'text', required: true }];
  const { run, ensureTable } = localFixtureTable(new IndexedDBAdapter({ databaseName: 'trading-practice-cache' }), {
    baseId,
    tableId,
    title: 'Practice readback',
    fields,
    permitRecord: (key) => key === null || key === id
  });
  await ensureTable();
  const load = async () =>
    await run('view.project', { baseId, tableId, view: { kind: 'table', columns: ['snapshot'] } });
  const parse = (row) => {
    if (!row) return null;
    const data = JSON.parse(row.values.snapshot);
    if (
      !['practice-session/v1', 'practice-session/v2'].includes(data.session?.schema) ||
      data.session.source !== SOURCE ||
      !Number.isSafeInteger(data.revision)
    )
      throw Error('INVALID_READBACK');
    return data;
  };
  return {
    async read() {
      return parse((await load()).projection.rows[0]);
    },
    async put(data) {
      const stored = await load(),
        row = stored.projection.rows[0];
      const previous = parse(row);
      if (previous?.sessionId === data.sessionId && previous.revision >= data.revision) return;
      const payload = {
        baseId,
        tableId,
        expectedRevision: stored.revision,
        values: { snapshot: JSON.stringify(data) }
      };
      if (row) await run('record.update', { ...payload, recordId: id, expectedRecordRevision: row.revision });
      else await run('record.create', { ...payload, id });
    }
  };
}
