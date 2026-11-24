import { mountCoverageRecords } from './coverage-routes-view.mjs';

const fileLimit = 480000;
const memberFields = [
  ['symbol', 'Symbol', 'code'], ['name', 'Name'], ['market', 'Market', 'select'], ['stock_type', 'Security type', 'select'],
  ['stock_id', 'Security ID', 'code'], ['lot_size', 'Lot size', 'number'], ['stock_owner', 'Underlying', 'code'],
  ['option_type', 'Option type'], ['strike_price', 'Strike price'], ['strike_time', 'Strike date'],
  ['listing_date', 'Listing date'], ['last_trade_time', 'Last trading date'], ['stock_child_type', 'Subtype'],
  ['main_contract', 'Main contract'], ['sc_name', 'Simplified Chinese name'], ['tc_name', 'Traditional Chinese name'],
];

function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

function control(caption, input) {
  const label = node('label', caption + ' ');
  label.append(input);
  return label;
}

function picker() {
  const input = node('input');
  input.type = 'file'; input.accept = '.json,application/json';
  return input;
}

async function read(file, tool, inputs) {
  if (!file || !file.size || file.size > fileLimit) throw Error('FILE_SIZE');
  const { projectMoomooWatchlistResponse } = await import('../owners/gateway/moomoo-watchlist.mjs');
  const wire = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  return projectMoomooWatchlistResponse(tool, inputs, wire).rows;
}

function failure(error) {
  if (error.message === 'FILE_SIZE') return 'Choose a nonempty JSON file up to 480 kB.';
  if (error.code === 'PERMISSION_DENIED') return 'The saved response records a permission refusal.';
  if (error.code === 'INCOMPLETE_PAGE') return 'The saved response contains a partial page.';
  return 'Could not read this file as the selected watchlist response.';
}

export function mountWatchlists(host) {
  const directory = picker(), members = picker(), group = node('select'), clear = node('button', 'Clear watchlists');
  const status = node('p'), result = node('div'), memberStatus = node('p'), controls = node('div');
  status.setAttribute('role', 'status'); memberStatus.setAttribute('role', 'status');
  controls.className = 'agentic-dashboard-actions agentic-form-controls';
  clear.type = 'button';
  controls.append(control('Saved group directory', directory), control('Watchlist group', group),
    control('Saved group members', members), clear);
  host.replaceChildren(node('p', 'Open a saved directory, select the group used for the request, then open its saved members. The membership file omits the owner and group name. Contents stay in this tab.'), controls, status, memberStatus, result);
  let directoryVersion = 0, memberVersion = 0, view;
  function resetMembers() {
    memberVersion++;
    view?.destroy(); view = undefined;
    members.value = ''; members.disabled = group.selectedIndex < 1;
    memberStatus.textContent = ''; result.replaceChildren();
  }
  function reset() {
    directoryVersion++;
    directory.value = ''; group.replaceChildren(node('option', 'Choose a group')); group.disabled = true;
    clear.disabled = true; status.textContent = ''; resetMembers();
  }
  reset(); clear.onclick = reset; window.addEventListener('pagehide', reset);
  group.onchange = resetMembers;
  directory.onchange = async () => {
    const [file] = directory.files;
    reset();
    if (!file) return;
    const version = directoryVersion;
    clear.disabled = false;
    try {
      const rows = await read(file, 'quote_user_security_group', {});
      if (version !== directoryVersion) return;
      for (const row of rows) {
        const option = node('option', row.group_name + ' · ' + row.group_type);
        option.value = row.group_name; group.append(option);
      }
      group.disabled = !rows.length;
      status.textContent = rows.length === 1 ? '1 saved group' : rows.length + ' saved groups';
    } catch (error) { if (version === directoryVersion) status.textContent = failure(error); }
  };
  members.onchange = async () => {
    const [file] = members.files;
    resetMembers();
    if (!file || group.selectedIndex < 1) return;
    const version = memberVersion, groupName = group.value;
    try {
      const items = await read(file, 'quote_user_security', { group_name: groupName });
      if (version !== memberVersion) return;
      memberStatus.textContent = groupName + ' · ' + items.length + (items.length === 1 ? ' saved member' : ' saved members');
      if (!items.length) return;
      const rows = items.map(row => ({ ...row, label: row.symbol, market: row.symbol.includes('.') ? row.symbol.split('.')[0] : 'Unknown',
        stock_type: row.stock_type ?? 'Unknown' }));
      const columns = memberFields.map(([id, name, kind]) => ({ id, name, kind: kind === 'code' ? 'text' : kind ?? 'text',
        ...(kind === 'code' && { format: 'code-list' }) }));
      view = mountCoverageRecords(result, rows, node, { id: 'watchlist-member', title: 'Watchlist members',
        singular: 'member', plural: 'members', rowDimension: 'market', groupDimension: 'stock_type', boardPageSize: 12, columns },
      (row, detail) => { detail.append(node('h4', row.symbol), node('p', row.name)); });
    } catch (error) { if (version === memberVersion) memberStatus.textContent = failure(error); }
  };
}
