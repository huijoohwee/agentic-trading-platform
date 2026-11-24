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
      const detail = row.earnings_date ?? row.capital_flow_item_time ?? row.exchange ?? row.sequence ?? row.time_ms ?? row.period_text ?? (row.factor ? row.value : undefined);
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

function marketChart(parent, page, node, { diagrams, diagram, volumeChart }) {
  const { operation, rows } = page;
  if (!rows.length || !['read.depth', 'read.tape', 'read.candles', 'read.candle-history'].includes(operation)) return;
  const usable = value => value !== null && Number.isFinite(Number(value));
  const volumeKnown = row => usable(row.volume) && Number(row.volume) >= 0;
  const symbol = rows[0].symbol;
  if (!rows.every(row => row.symbol === symbol && (!page.symbol || page.symbol === symbol))) {
    parent.append(node('p', 'These rows have different symbols. Inspect their values below.')); return;
  }
  if (operation === 'read.depth') {
    const select = node('select'), chart = node('section');
    rows.forEach((row, i) => { const option = node('option', row.exchange || 'Aggregated book'); option.value = String(i); select.append(option); });
    if (rows.length > 1) { const label = node('label', 'Exchange book '); label.append(select); parent.append(label); }
    parent.append(chart);
    const draw = () => {
      const row = rows[Number(select.value)], bid = row.bids.slice(0, 10), ask = row.asks.slice(0, 10);
      chart.replaceChildren();
      if (![...bid, ...ask].every(volumeKnown)) { chart.append(node('p', 'Book size is unknown. Raw levels are available below.')); return; }
      if (!bid.length && !ask.length) { chart.append(node('p', 'No reported book levels.')); return; }
      diagram(chart, symbol + ' · ' + (row.exchange || 'Aggregated book') + ' · First 10 levels per side', diagrams.depth({ bid, ask }));
    };
    select.addEventListener('change', draw); draw(); return;
  }
  if (operation === 'read.tape') {
    const tape = rows.slice(0, 40);
    if (tape.every(volumeKnown)) diagram(parent, symbol + ' · Volume of first ' + tape.length + ' of ' + rows.length + ' trades', diagrams.tape(tape));
    else parent.append(node('p', 'Trade size is unknown. Raw volumes are available below.'));
    return;
  }
  const bars = rows.slice(-30);
  if (!bars.every(row => ['open', 'high', 'low', 'close'].every(key => usable(row[key])) &&
    row.ktype === bars[0].ktype && row.autype === bars[0].autype && row.extended_time === bars[0].extended_time && row.pred_side === bars[0].pred_side)) {
    parent.append(node('p', 'The selected bars have inconsistent prices or settings. Inspect the rows below.')); return;
  }
  const intraday = ![2, 3, 4, 5, 11].includes(bars[0].ktype);
  const chartRows = bars.map(row => ({ ...row, date: intraday || !row.market_date ? new Date(row.time_ms).toISOString() : row.market_date }));
  const title = symbol + ' · Last ' + bars.length + ' of ' + rows.length + ' candles in file order';
  diagram(parent, title, diagrams.candles(chartRows, title));
  if (chartRows.every(volumeKnown)) volumeChart(parent, 'Candle volume', chartRows);
  else parent.append(node('p', 'Volume scale unavailable. Raw quantities are shown in the rows.'));
}

export function mountResearchPageView(parent, node, charts) {
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
        if (Object.hasOwn(page.pagination, 'token')) {
          if (page.pagination.token !== null) fact('Next page token', page.pagination.token);
          if (page.pagination.nextTime !== null) fact('Backward cursor (Unix ms)', page.pagination.nextTime);
        } else if (page.pagination.cursor !== null) fact('Continuation cursor', page.pagination.cursor);
      }
      result.append(facts, node('p', page.units));
      marketChart(result, page, node, charts);
      rowList(result, page.rows, node);
      status.textContent = example ? 'Synthetic example · ' + page.operation : 'Local file · ' + page.operation + ' · origin unverified';
    } catch (error) {
      if (reading === generation) { result.replaceChildren(); status.textContent = 'Cannot display this result. ' + error.message; }
    }
  }
  picker.addEventListener('change', () => refresh());
  sample.addEventListener('click', () => refresh(true));
  clear.addEventListener('click', () => { picker.value = ''; refresh(); });
}
