import { createBaseEngine } from '../owners/base/src/index.mjs';
import { verifyTicket } from './rules.mjs';

const baseId = 'trading-fixture-v1';
const tableId = 'draft-tickets';
const recordId = 'test-ticket';
const columns = ['symbol', 'side', 'quantity', 'limitPrice', 'evaluationAt'];
const fields = [
  ['symbol', 'Symbol', 'text'], ['side', 'Side', 'text'], ['quantity', 'Quantity', 'number'],
  ['limitPrice', 'Limit price', 'number'], ['evaluationAt', 'Evaluation time', 'text'],
  ['metadata', 'Quote metadata', 'text'], ['fixtureId', 'Fixture ID', 'text'],
  ['fixtureDigest', 'Fixture digest', 'text'], ['policyRevision', 'Policy revision', 'text'],
].map(([id, name, type]) => ({ id, name, type, required: true }));

export function createTicketStore(adapter, fixture) {
  const engine = createBaseEngine({ adapter, authorize: request =>
    request.actorId === 'local-owner' && request.baseId === baseId &&
    [null, tableId].includes(request.tableId) && [null, recordId].includes(request.recordId) });
  async function run(operation, payload) {
    const result = await engine.execute({ contractVersion: 1, actorId: 'local-owner', operation, payload });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data;
  }

  // Another tab may finish either initialization step first. Only a conflict is recoverable here.
  async function initialize(operation) {
    try { await operation(); } catch (error) { if (error.code !== 'CONFLICT') throw error; }
  }

  async function open() {
    let base;
    try { base = await run('base.get', { baseId }); }
    catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      await initialize(() => run('base.create', { id: baseId, name: 'Synthetic trading workspace' }));
      base = await run('base.get', { baseId });
    }
    let tables = await run('table.list', { baseId });
    if (!tables.length) {
      await initialize(() => run('table.create', { baseId, id: tableId, name: 'Draft tickets',
        expectedRevision: base.revision, fields }));
      tables = await run('table.list', { baseId });
    }
    const table = tables.find(item => item.id === tableId);
    if (!table || table.fields.length !== fields.length ||
        !fields.every((field, index) => ['id','type','required'].every(key => table.fields[index][key] === field[key]))) {
      throw new Error('Stored ticket schema is incompatible. Writing is locked.');
    }
    const { revision, total, projection } = await run('view.project', {
      baseId, tableId, view: { kind: 'table', columns },
    });
    const record = projection.rows[0] ?? null;
    if (total > 1 || (record && record.id !== recordId)) throw new Error('Unexpected ticket identity. Writing is locked.');
    if (record) verifyTicket(record.values, fixture);
    return { revision, record };
  }

  async function save(current, values) {
    verifyTicket(values, fixture);
    const payload = { baseId, tableId, expectedRevision: current.revision, values };
    const data = current.record
      ? await run('record.update', { ...payload, recordId, expectedRecordRevision: current.record.revision })
      : await run('record.create', { ...payload, id: recordId });
    return { revision: data.revision, record: data.record };
  }
  return { open, save };
}
