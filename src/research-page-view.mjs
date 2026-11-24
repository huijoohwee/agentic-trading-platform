import { exampleCalendarPage, readResearchPage } from './research-page.mjs';

const labels = {
  code: 'Symbol', pub_type: 'Publication session', earnings_date: 'Market-local earnings date',
  earnings_timestamp: 'Publication time (Unix µs)', eps_actual: 'Actual EPS', eps_predict: 'Estimated EPS',
  period_text: 'Fiscal period', capital_flow_item_time: 'Flow time (Unix ms)', in_flow: 'Net inflow',
  factor: 'Factor', raw: 'Source integer', value: 'Value', item_list: 'Statement items'
};
const label = key => labels[key] ?? (key[0].toUpperCase() + key.slice(1)).replaceAll('_', ' ');
function show(value) {
  if (value === null) return 'Unknown';
  return value === '' ? 'Empty text' : String(value);
}

function rowList(parent, rows, node) {
  const list = node('div'), range = node('p');
  range.setAttribute('role', 'status');
  const previous = node('button', 'Previous rows'), next = node('button', 'Next rows');
  previous.type = next.type = 'button';
  let offset = 0;
  function render() {
    const end = Math.min(offset + 10, rows.length);
    range.textContent = rows.length ? 'Rows ' + (offset + 1) + '–' + end + ' of ' + rows.length : 'No rows on this page';
    list.replaceChildren();
    for (let index = offset; index < end; index++) {
      const row = rows[index], item = node('details');
      const identity = [row.symbol, row.code, row.factor, row.display_name, row.category_name, row.name, row.holding_name, row.timestamp]
        .find(value => value != null && String(value).trim() !== '');
      const detail = row.earnings_date ?? row.capital_flow_item_time ?? row.period_text ?? (row.factor ? row.value : undefined);
      const summary = [identity ?? 'Row ' + (index + 1), detail].filter(value => value != null).join(' · ');
      item.append(node('summary', summary));
      item.addEventListener('toggle', function expand() {
        if (!item.open) return;
        item.removeEventListener('toggle', expand);
        const facts = node('dl'); facts.className = 'facts';
        item.append(facts);
        for (const [key, value] of Object.entries(row)) {
          if (Array.isArray(value)) {
            const group = node('section'); group.append(node('h5', label(key)));
            rowList(group, value, node); item.append(group);
          } else facts.append(node('dt', label(key)), node('dd', show(value)));
        }
      });
      list.append(item);
    }
    previous.disabled = offset === 0;
    next.disabled = end === rows.length;
  }
  previous.addEventListener('click', () => { offset = Math.max(0, offset - 10); render(); });
  next.addEventListener('click', () => { if (offset + 10 < rows.length) offset += 10; render(); });
  parent.append(range);
  if (rows.length > 10) parent.append(previous, next);
  parent.append(list);
  render();
}

export function mountResearchPageView(parent, node) {
  const picker = node('input'), clear = node('button', 'Clear preview'), sample = node('button', 'Open example calendar');
  picker.type = 'file'; picker.accept = '.json,application/json'; clear.type = sample.type = 'button'; clear.disabled = true;
  const fileLabel = node('label', 'Research result JSON file '); fileLabel.append(picker);
  const status = node('p'), result = node('section'); status.setAttribute('role', 'status');
  parent.append(node('p', 'Open a saved Gateway HTTP or MCP research result, or a synthetic calendar export, under 500 kB. The preview stays in this tab.'),
    sample, fileLabel, clear, status, result);
  let generation = 0;
  async function refresh(example = false) {
    if (example) picker.value = '';
    const reading = ++generation, file = picker.files[0];
    status.textContent = ''; result.replaceChildren(); clear.disabled = !file && !example;
    if (!file && !example) return;
    try {
      let page;
      if (example) page = await exampleCalendarPage();
      else {
        if (file.size >= 500000) throw Error('The file must be under 500 kB.');
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
        catch { throw Error('Expected a UTF-8 JSON file.'); }
        if (reading !== generation) return;
        page = await readResearchPage(parsed);
      }
      if (reading !== generation) return;
      const facts = node('dl'); facts.className = 'facts';
      const fact = (key, value) => facts.append(node('dt', key), node('dd', show(value)));
      fact('Reported source', page.binding);
      if (page.revision !== undefined) fact('Ledger revision', page.revision);
      if (page.symbol) fact('Symbol', page.symbol);
      if (page.observed) fact('Observed (UTC)', page.observed);
      if (Object.hasOwn(page, 'lastValid')) fact('Last valid time (UTC)', page.lastValid);
      if (page.pagination) {
        fact('Provider page', page.pagination.completed ? 'Final page' : 'More results available');
        if (page.pagination.total !== null) fact('Reported total', page.pagination.total);
        if (page.pagination.cursor !== null) fact('Continuation cursor', page.pagination.cursor);
      }
      result.append(facts, node('p', page.units)); rowList(result, page.rows, node);
      status.textContent = example ? 'Synthetic example · ' + page.operation : 'Local file · ' + page.operation + ' · origin unverified';
    } catch (error) {
      if (reading === generation) { result.replaceChildren(); status.textContent = 'Cannot display this result. ' + error.message; }
    }
  }
  picker.addEventListener('change', () => refresh());
  sample.addEventListener('click', () => refresh(true));
  clear.addEventListener('click', () => { picker.value = ''; refresh(); });
}
