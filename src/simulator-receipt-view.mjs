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
  const file = node('input'), fileLabel = node('label', 'Original signed request file '), token = node('input'), tokenLabel = node('label', 'Local gateway token ');
  file.type = 'file'; file.accept = '.json,application/json'; fileLabel.append(file);
  token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false; tokenLabel.append(token);
  const load = node('button', 'Look up completed read'), clear = node('button', 'Clear receipt');
  load.type = clear.type = 'button'; const controls = node('div'); controls.className = 'agentic-dashboard-actions agentic-form-controls';
  const status = node('p'), output = node('section'); status.setAttribute('role', 'status'); output.setAttribute('aria-label', 'Simulator receipt');
  controls.append(fileLabel, tokenLabel, load, clear);
  panel.append(node('p', 'Open a completed read from this local gateway. Closing the panel clears its contents.'), controls, status, output);
  let pending = null, expiration;
  function reset() {
    pending?.abort(); pending = null; clearTimeout(expiration); load.disabled = false;
    token.value = ''; file.value = ''; status.textContent = ''; output.replaceChildren();
  }
  function clearWhenClosed(event) { if (!event.currentTarget.open) reset(); }
  clear.addEventListener('click', reset);
  panel.addEventListener('toggle', clearWhenClosed);
  panel.parentElement.closest('details')?.addEventListener('toggle', clearWhenClosed);
  window.addEventListener('pagehide', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  file.addEventListener('change', () => { pending?.abort(); pending = null; clearTimeout(expiration); load.disabled = false; output.replaceChildren(); status.textContent = ''; });
  load.addEventListener('click', async () => {
    const selected = file.files?.[0], localToken = token.value;
    reset();
    if (location.hostname !== '127.0.0.1' || !selected || selected.size > 480000 || localToken.length < 32) {
      status.textContent = 'Open the local gateway and supply its token and original request file (up to 480 kB).'; return;
    }
    const controller = new AbortController(); pending = controller;
    load.disabled = true; status.textContent = 'Looking up receipt…';
    try {
      const request = JSON.parse(await selected.text());
      if (!operations.has(request.operation) || !request.inputs?.grant) throw Error('Select a signed simulator read request.');
      const reply = await fetch('/api/gateway/simulator-receipt', { method: 'POST', credentials: 'omit', cache: 'no-store',
        redirect: 'error', signal: controller.signal, headers: { Authorization: 'Bearer ' + localToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(request) });
      if (!reply.ok) throw Error(reply.status === 401 ? 'Local gateway token rejected.' : 'Receipt lookup unavailable on this gateway.');
      const receipt = await reply.json(), data = receipt.data, scope = request.scope;
      if (controller.signal.aborted) return;
      if (receipt.status !== 'OK') throw Error(receipt.error?.code === 'FINAL_READ_REQUIRED' ? 'No matching completed read.' : 'This request no longer admits the receipt.');
      if (receipt.request_id !== request.request_id || receipt.provenance?.operation !== request.operation ||
        receipt.provenance.capability_digest !== request.capability_digest || data?.source !== 'AUTHENTICATED_ADAPTER' ||
        scope?.environment !== 'SIMULATE' || data.account?.environment !== scope.environment || data.account.profile !== scope.profile ||
        data.account.account_alias !== scope.account_alias || !Array.isArray(data.rows) || data.rows.length > 600) throw Error('Receipt identity mismatch.');
      const until = Date.parse(receipt.display_until_utc);
      if (!Number.isFinite(until) || until <= Date.now()) throw Error('Receipt display expired.');
      const title = operations.get(request.operation), account = data.account;
      output.append(node('h4', title), node('p', account.account_alias + ' · ' + account.profile + ' · Account market ' + account.account_market_id),
        node('p', 'Observed ' + new Date(data.at).toISOString() + ' · Ledger revision ' + receipt.ledger_revision));
      rowsView(output, data.rows, node);
      if (data.pagination) output.append(node('p', data.pagination.completed ? 'Last provider page.' : 'More orders are available with a separately signed continuation.'));
      status.textContent = 'Completed read · ' + data.cost.tool_calls + ' original provider calls · 0 lookup calls to the provider';
      const expire = () => {
        if (until > Date.now()) expiration = setTimeout(expire, Math.min(until - Date.now(), 2147483647));
        else { reset(); status.textContent = 'Receipt display expired.'; }
      };
      expire();
    } catch (error) {
      if (!controller.signal.aborted) { output.replaceChildren(); status.textContent = error instanceof SyntaxError ? 'Invalid request file.' : error.message; }
    } finally { if (pending === controller) { pending = null; load.disabled = false; } }
  });
}
