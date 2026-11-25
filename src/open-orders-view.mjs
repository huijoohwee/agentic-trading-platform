import { createMoomooOpenOrdersBaseline, createMoomooSecuritiesHistoryPages } from '../owners/gateway/moomoo-securities-history.mjs';
import { mountCoverageRecords } from './coverage-routes-view.mjs';

const orderColumns = [
  { id: 'symbol', name: 'Symbol', kind: 'text', format: 'code-list' },
  { id: 'state', name: 'Order state', kind: 'select' }, { id: 'status', name: 'Provider status', kind: 'select' },
  { id: 'side', name: 'Side', kind: 'select' }, { id: 'quantity', name: 'Quantity' },
  { id: 'filled_quantity', name: 'Filled quantity' }, { id: 'price', name: 'Order price' }, { id: 'currency', name: 'Currency' },
];
const fillColumns = orderColumns.filter(field => ['symbol', 'status', 'side', 'quantity', 'price'].includes(field.id))
  .map(field => field.id === 'price' ? { ...field, name: 'Fill price' } : field);
const sources = { account_orders: 'Open orders', account_orders_history: 'Order history', account_fills_history: 'Fill history' };
const errors = {
  INVALID_CONTINUATION: 'The page flag does not continue this listing.',
  REQUEST_MISMATCH: 'Check the account, market and selected route against the original GET.',
  ACCOUNT_MISMATCH: 'The response names a different account.', MARKET_MISMATCH: 'The response names a different market.',
  DUPLICATE_ORDER: 'An order appears twice in the listing. Clear the listing and use a consistent capture.',
  DUPLICATE_HISTORY_ROW: 'A history record appears on more than one row. Check the saved pages.',
  HISTORY_SELECTION_CHANGED: 'The symbol or time window changed. Use the continuation of the original request.',
  OUTSIDE_HISTORY_WINDOW: 'A record falls outside the time window of the original GET.',
  SYMBOL_MISMATCH: 'A record names a different symbol from the original GET.',
  UNKNOWN_ORDER_STATUS: 'The provider status is unknown. The working orders cannot be classified.',
  PROVIDER_ERROR: 'The saved response records a provider refusal.',
};

export function mountOpenOrders(panel, node) {
  const controls = node('div'), status = node('p'), output = node('div');
  output.className = 'rehearsal-table-content';
  controls.className = 'agentic-dashboard-actions agentic-form-controls'; status.setAttribute('role', 'status');
  function input(label, type) {
    const el = node('input'), field = node('label', label + ' ');
    el.type = type; el.autocomplete = 'off'; el.spellcheck = false;
    field.append(el); controls.append(field); return el;
  }
  const source = node('select'), sourceLabel = node('label', 'Saved account data ');
  for (const [key, label] of Object.entries(sources)) {
    const option = node('option', label); option.value = key; source.append(option);
  }
  sourceLabel.append(source); controls.append(sourceLabel);
  const account = input('Expected securities account ID', 'password'), market = input('Trading market', 'text');
  const path = input('Original GET path with query', 'password'), file = input('Saved JSON response', 'file');
  account.inputMode = 'numeric'; market.placeholder = 'US'; file.accept = '.json,application/json';
  const add = node('button', 'Read page'), clear = node('button', 'Clear listing');
  add.type = clear.type = 'button'; controls.append(add, clear);
  panel.append(node('p', 'Choose a saved response and enter its original GET path, account and market. Open orders require the complete listing. History shows one saved page at a time. Files stay in this tab, up to 480 kB per listing.'),
    controls, status, output);
  let listing, view, bytes = 0, generation = 0;
  const orderLabels = new Map();
  function discardView() {
    view?.destroy(); view = null; output.replaceChildren(); status.textContent = '';
  }
  function reset(eraseScope = true) {
    generation++; listing = null; bytes = 0; discardView();
    orderLabels.clear();
    path.value = ''; file.value = ''; add.disabled = false;
    if (eraseScope) { account.value = ''; market.value = ''; }
  }
  clear.onclick = () => reset();
  source.onchange = () => reset();
  account.oninput = market.oninput = () => reset(false);
  path.oninput = file.onchange = () => { generation++; add.disabled = false; discardView(); };
  const outer = panel.parentElement.closest('details');
  for (const disclosure of [panel, outer]) {
    disclosure?.addEventListener('toggle', () => { if (!disclosure.open) reset(); });
  }
  window.addEventListener('pagehide', () => reset());
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

  function showRows(records, title, fields, rowDimension) {
    if (!records.length) return;
    const rows = records.map(record => {
      if (!orderLabels.has(record.order_id)) orderLabels.set(record.order_id, 'Order ' + (orderLabels.size + 1));
      return { ...record, label: record.symbol, local_order: orderLabels.get(record.order_id) };
    });
    view = mountCoverageRecords(output, rows, node, { id: 'saved-order', title,
      singular: 'record', plural: 'records', rowDimension, groupDimension: 'status', boardPageSize: 12, columns: fields },
    (record, detail) => {
      const facts = node('dl');
      for (const [label, value] of [['Order in this listing', record.local_order], ['Order type', record.type],
        ['Created (Unix µs)', record.created_us], ['Updated (Unix µs)', record.updated_us], ['Average fill price', record.average_fill_price]]) {
        if (value != null) facts.append(node('dt', label), node('dd', value));
      }
      detail.append(facts);
    });
  }
  add.onclick = async () => {
    const selected = file.files[0], turn = ++generation;
    if (!selected?.size || bytes + selected.size > 480000) {
      status.textContent = 'Choose a nonempty response within the 480 kB listing limit.'; return;
    }
    const request = { method: 'GET', path: path.value.trim() };
    add.disabled = true;
    try {
      const scope = { acc_id: account.value.trim(), trd_market: market.value.trim() };
      const history = source.value !== 'account_orders', fills = source.value === 'account_fills_history';
      listing ??= history ? createMoomooSecuritiesHistoryPages(source.value, scope) : createMoomooOpenOrdersBaseline(scope);
      const wire = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
      if (generation !== turn || !panel.open || (outer && !outer.open) || document.hidden) return;
      const page = listing.append({ request, wire });
      bytes += selected.size; path.value = ''; file.value = '';
      discardView();
      if (history) {
        const basis = fills ? 'Fill update time' : 'Order creation time';
        const period = page.window_start_us === null ? '90 days ending at the original request time (time unavailable)'
          : page.window_start_us + '–' + page.window_end_us + ' Unix µs';
        const fields = fills ? fillColumns : orderColumns.filter(field => field.id !== 'state');
        status.textContent = 'Saved page ' + page.page_count + ' · ' + page.rows.length + (page.rows.length === 1 ? ' record · ' : ' records · ') +
          (page.completed ? 'Final page' : 'More pages available') + (page.started_at_continuation ? ' · Earlier pages omitted' : '');
        output.append(node('p', [page.market, page.symbol, basis, period].filter(Boolean).join(' · ')));
        showRows(page.rows, sources[source.value], [...fields, { id: page.time_basis, name: basis + ' (Unix µs)' }], 'side');
      } else if (!page.completed) {
        status.textContent = 'Read page ' + page.page_count + '. Add the next request path and response.'; return;
      } else {
        const result = listing.result(), rows = [];
        for (const [state, orders] of [['Working', result.working_orders], ['Terminal', result.terminal_orders]]) {
          for (const order of orders) rows.push({ ...order, state });
        }
        status.textContent = result.working_orders.length + ' working · ' + result.terminal_orders.length +
          ' terminal · ' + result.market + ' · local files, account supplied by request';
        showRows(rows, 'Saved orders', orderColumns, 'state');
      }
      if (page.completed) {
        listing = null; bytes = 0; account.value = ''; market.value = ''; orderLabels.clear();
      }
    } catch (error) {
      if (generation === turn) status.textContent = errors[error.code] ?? 'Check the original GET path, market, account and saved JSON response.';
    } finally { if (generation === turn) add.disabled = false; }
  };
}
