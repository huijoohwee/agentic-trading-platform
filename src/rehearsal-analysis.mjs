import { projectMatrix } from '../owners/base/src/projectors.mjs';
import { MICRO } from './competition-rules.mjs';

export const dimensions = { day: 'UTC date', type: 'Event type', decision: 'Decision' };
export const measures = { count: 'Event count', open: 'Opening equity', high: 'High equity', low: 'Low equity', close: 'Closing equity' };

// A pivot cell contains record IDs. Opening and closing equity follow the verified
// replay sequence, including events with equal timestamps.
export function replayAnalysis(pack) {
  const { receipts, curve } = pack.snapshot;
  const records = receipts.map((receipt, index) => {
    const point = curve[index];
    if (point.event !== receipt.id || point.at !== receipt.at) throw Error('Replay event and equity evidence disagree.');
    return { id: receipt.id, index, equity: point.equity, values: {
      day: receipt.at.slice(0, 10), type: receipt.type, decision: receipt.reason, all: 'All events',
    } };
  });
  const byId = new Map(records.map(record => [record.id, record]));
  const table = { id: 'replay-events', fields: Object.entries({ ...dimensions, all: 'All events' })
    .map(([id, name]) => ({ id, name, type: 'text' })) };
  function value(rows, measure) {
    if (measure === 'count') return rows.length;
    if (!rows.length) return undefined;
    const equity = rows.map(row => row.equity);
    switch (measure) {
      case 'high': return Math.max(...equity) / MICRO;
      case 'low': return Math.min(...equity) / MICRO;
      case 'open': return rows.reduce((first, row) => row.index < first.index ? row : first).equity / MICRO;
      case 'close': return rows.reduce((last, row) => row.index > last.index ? row : last).equity / MICRO;
      default: throw new RangeError('Unknown replay measure');
    }
  }
  function groups(rows, key) {
    const result = new Map();
    for (const record of rows) {
      const category = record.values[key];
      if (!result.has(category)) result.set(category, []);
      result.get(category).push(record);
    }
    return result;
  }
  const days = [...groups(records, 'day')].map(([label, group]) => {
    const equity = group.map(record => record.equity);
    return { label, tickLabel: label.slice(5), open: equity[0], high: Math.max(...equity), low: Math.min(...equity),
      close: equity.at(-1), events: group.length };
  });
  function series(groupBy, measure) {
    return [...groups(records, groupBy)].map(([label, group]) => ({ label, value: value(group, measure) }));
  }
  function pivot({ row, column, measure, filter, descending, total }) {
    const selected = filter ? records.filter(record => record.values.type === filter) : records;
    const matrix = projectMatrix({ table, records: selected, view: { kind: 'matrix', rowFieldId: row, columnFieldId: column || 'all' } });
    const cells = new Map(matrix.cells.map(cell => [JSON.stringify([cell.rowKey, cell.columnKey]), cell.recordIds.map(id => byId.get(id))]));
    const columns = matrix.columns;
    const headers = [dimensions[row], ...columns.map(c => column ? c.value : measures[measure])];
    const axes = descending ? [...matrix.rows].reverse() : matrix.rows;
    const rows = axes.map(axis => ({
      id: axis.key, values: [axis.value, ...columns.map(c => value(cells.get(JSON.stringify([axis.key, c.key])) ?? [], measure))],
    }));
    if (total && selected.length) {
      const grouped = groups(selected, column || 'all');
      rows.push({ id: 'total', values: ['Grand total', ...columns.map(c => value(grouped.get(c.value), measure))] });
    }
    return { headers, records: rows };
  }
  return { days, types: [...groups(records, 'type').keys()].sort(), series, pivot };
}
