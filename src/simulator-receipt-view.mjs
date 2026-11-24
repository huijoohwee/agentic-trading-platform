import { mountPrivateReceipt } from './private-receipt-view.mjs';

const operations = new Map([
  ['read.simulator-account', 'Account'], ['read.simulator-balances', 'Cash and balances'],
  ['read.simulator-positions', 'Positions'], ['read.simulator-orders', 'Current orders'],
  ['read.simulator-order-history', 'Order history'], ['read.simulator-buying-power', 'Buying power']
]);
const labels = { qty: 'Quantity', qty_avbl: 'Available quantity', cum_qty: 'Filled quantity', avg_fill_price: 'Average fill price',
  order_ref: 'Account-scoped order reference', position_ref: 'Account-scoped position reference', profit_ratio: 'P&L (%)',
  create_time_us: 'Created (Unix µs)', update_time_us: 'Updated (Unix µs)', has_remark: 'Provider remark present' };
const sides = { 1: 'Buy', 2: 'Sell', 3: 'Sell short', 4: 'Buy back' };
const statuses = { 1: 'Pending new', 2: 'Submitted', 3: 'Partially filled', 4: 'Filled', 5: 'Cancelled', 6: 'Rejected', 7: 'Partially filled then cancelled' };
function rowsView(host, rows, node) {
  const list = node('div'), range = node('p'), previous = node('button', 'Previous rows'), next = node('button', 'Next rows');
  previous.type = next.type = 'button'; range.setAttribute('role', 'status');
  let offset = 0;
  function draw() {
    const end = Math.min(rows.length, offset + 10);
    range.textContent = rows.length ? 'Rows ' + (offset + 1) + '–' + end + ' of ' + rows.length : 'No rows in this receipt.';
    list.replaceChildren();
    for (const row of rows.slice(offset, end)) {
      const details = node('details'), fields = node('dl');
      const name = row.symbol ?? row.account_alias ?? (Object.hasOwn(row, 'balance') ? 'Balance' : 'Account values');
      details.append(node('summary', [name, sides[row.side] ?? row.side, statuses[row.status]].filter(Boolean).join(' · ')));
      fields.className = 'facts';
      for (const [key, value] of Object.entries(row)) {
        const caption = labels[key] ?? (key[0].toUpperCase() + key.slice(1)).replaceAll('_', ' ');
        const codes = key === 'side' ? sides : key === 'status' ? statuses : key === 'order_type' ? { 1: 'Limit', 3: 'Market' } : {};
        fields.append(node('dt', caption), node('dd', value === null ? 'Unknown' : Object.hasOwn(codes, value) ? codes[value] : String(value)));
      }
      details.append(fields); list.append(details);
    }
    previous.disabled = offset === 0; next.disabled = end === rows.length;
  }
  previous.addEventListener('click', () => { offset -= 10; draw(); });
  next.addEventListener('click', () => { offset += 10; draw(); });
  host.append(range); if (rows.length > 10) host.append(previous, next);
  host.append(list); draw();
}

export function mountSimulatorReceipts(panel, node) {
  mountPrivateReceipt(panel, panel, node, { endpoint: '/api/gateway/simulator-receipt', label: 'Simulator receipt',
    accepts: operation => operations.has(operation), kind: 'simulator', render(output, request, receipt) {
      const data = receipt.data, scope = request.scope;
      if (scope?.environment !== 'SIMULATE' || data.account?.environment !== scope.environment || data.account.profile !== scope.profile ||
        data.account.account_alias !== scope.account_alias || !Array.isArray(data.rows) || data.rows.length > 600) throw Error('Receipt identity mismatch.');
      const title = operations.get(request.operation), account = data.account;
      output.append(node('h4', title), node('p', account.account_alias + ' · ' + account.profile + ' · Account market ' + account.account_market_id),
        node('p', 'Observed ' + new Date(data.at).toISOString() + ' · Ledger revision ' + receipt.ledger_revision));
      rowsView(output, data.rows, node);
      if (data.pagination) output.append(node('p', data.pagination.completed ? 'Last provider page.' : 'More orders are available with a separately signed continuation.'));
    },
  });
}
