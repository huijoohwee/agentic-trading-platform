import { mountDataView } from '../owners/base/packages/views-react/dist/browser-data-view.js';
import { bindWorkbookExport } from './rehearsal-workbook.mjs';
import { estimate, feeRate, portfolio, journalCsv, journalHeaders, journalRecords } from './practice-account.mjs';
import { assessPrediction, horizons } from './predictions.mjs';
import { microstructure } from './market.mjs';
import { example } from './strategy-example.mjs';

const el = (id) => document.getElementById(id);
const f = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : 'Unknown');
const pct = (n) => (Number.isFinite(n) ? f(n * 100) + '%' : '—');
const utc = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function table(id, headers, rows) {
  const host = el(id);
  if (!rows.length) {
    host.replaceChildren(document.createTextNode('No records'));
    delete host._table;
    return;
  }
  const view = {
    ariaLabel: id,
    columns: headers.map((name, i) => ({ id: String(i), name })),
    rows: rows.map((cells, i) => ({ id: String(i), cells: cells.map(String) }))
  };
  if (!host._table) {
    const frame = document.createElement('div'),
      mount = document.createElement('div'),
      css = document.createElement('link');
    frame.className = 'table-view';
    css.rel = 'stylesheet';
    css.href = new URL('../owners/base/packages/views-react/dist/browser-data-view.css', import.meta.url);
    mount.setAttribute('part', 'mount');
    frame.attachShadow({ mode: 'open' }).append(css, mount);
    host.replaceChildren(frame);
    host._table = mountDataView(mount, view);
  } else host._table.update(view);
}
export function bindPanels({ state, act, onError, getBars, onMarkers, settingsChanged }) {
  let account,
    at,
    price,
    latest,
    worker,
    timeout,
    runSeq = 0;
  const ticket = el('ticket'),
    fields = ticket.elements,
    prediction = el('prediction').elements,
    code = el('code');
  function estimateTicket() {
    el('trigger-label').hidden = fields.type.value === 'MARKET';
    fields.trigger.required = !el('trigger-label').hidden;
    const input = fields.type.value === 'MARKET' ? price : Number(fields.trigger.value),
      qty = Number(fields.qty.value);
    if (!(qty > 0 && input > 0) || qty * input > 1e9) {
      el('estimate').textContent = 'Enter a valid quantity and price.';
      return;
    }
    const { notional, fee } = estimate(qty, input);
    el('estimate').textContent = 'Notional $' + f(notional) + ' · fee $' + f(fee);
  }
  for (const percent of [25, 50, 75, 100]) {
    const button = document.createElement('button');
    button.className = 'agentic-form-control';
    button.type = 'button';
    button.textContent = percent + '%';
    button.onclick = () => {
      const p = fields.type.value === 'MARKET' ? price : Number(fields.trigger.value);
      if (!p) return;
      const s = state(),
        held = s.positions[s.symbol]?.qty ?? 0,
        pending = s.orders.filter((o) => o.symbol === s.symbol && o.side === 'SELL').reduce((n, o) => n + o.qty, 0);
      const max = fields.side.value === 'BUY' ? account.available / (p * (1 + feeRate)) : Math.max(0, held - pending);
      fields.qty.value = Math.floor(((max * percent) / 100) * 1e6) / 1e6;
      estimateTicket();
    };
    el('allocation').append(button);
  }
  ticket.oninput = estimateTicket;
  ticket.onsubmit = (e) => {
    e.preventDefault();
    act({
      kind: 'order',
      symbol: state().symbol,
      type: fields.type.value,
      side: fields.side.value,
      qty: Number(fields.qty.value),
      trigger: Number(fields.trigger.value)
    });
  };
  el('funds').onsubmit = (e) => {
    e.preventDefault();
    act({ kind: 'funds', amount: Number(e.target.elements.amount.value) });
  };
  el('reset').onclick = () => {
    if (confirm('Reset the entire synthetic session, including orders, holdings, predictions and strategy source?'))
      act({ kind: 'reset', confirm: true });
  };
  el('csv').onclick = () => download(journalCsv(state().fills), 'practice-journal.csv', 'text/csv;charset=utf-8');
  for (const key of Object.keys(horizons)) prediction.horizon.add(new Option(key, key));
  prediction.confidence.oninput = () => (el('confidence-readout').textContent = prediction.confidence.value + '%');
  el('prediction').onsubmit = (e) => {
    e.preventDefault();
    act({
      kind: 'prediction',
      symbol: state().symbol,
      direction: prediction.direction.value,
      horizon: prediction.horizon.value,
      confidence: Number(prediction.confidence.value),
      note: prediction.note.value
    });
  };
  function lineNumbers() {
    el('numbers').textContent = code.value
      .split('\n')
      .map((_, i) => i + 1)
      .join('\n');
  }
  code.oninput = () => {
    lineNumbers();
    settingsChanged();
  };
  code.onscroll = () => (el('numbers').scrollTop = code.scrollTop);
  el('sample').onclick = () => {
    code.value = example;
    code.dispatchEvent(new Event('input'));
  };
  function stop() {
    runSeq++;
    worker?.terminate();
    worker = null;
    clearTimeout(timeout);
    el('run').disabled = false;
  }
  function clearExperiment() {
    stop();
    onMarkers([]);
    el('logs').textContent = '';
    el('report').textContent = '';
  }
  el('run').onclick = () => {
    clearExperiment();
    const seq = runSeq,
      bars = getBars();
    if (bars.length < 2) return onError('Need two closed candles');
    el('run').disabled = true;
    el('report').textContent = 'Running…';
    try {
      worker = new Worker(new URL('./experiment-worker.mjs', import.meta.url), { type: 'module' });
      timeout = setTimeout(() => {
        stop();
        el('report').textContent = 'TIMEOUT · worker stopped';
      }, 5000);
      worker.onerror = (e) => {
        stop();
        el('report').textContent = 'Worker failed';
        el('logs').textContent = e.message;
      };
      worker.onmessage = ({ data }) => {
        if (seq !== runSeq) return;
        stop();
        const r = data.report;
        el('logs').textContent = [...data.stdout, ...data.stderr].join('\n');
        el('report').textContent = r
          ? r.count +
            ' closed · ' +
            r.wins +
            ' wins · hit ' +
            pct(r.winRate) +
            ' · net USD/unit ' +
            f(r.net) +
            ' · return ' +
            pct(r.return) +
            ' · max drawdown ' +
            pct(r.maxDrawdown)
          : 'Experiment refused';
        onMarkers(data.signals);
      };
      worker.postMessage({ code: code.value, bars });
    } catch (e) {
      stop();
      onError(e.message);
    }
  };
  function flow() {
    if (!el('flow').open || !at) return;
    const book = microstructure(state().symbol, at);
    el('spread').textContent =
      'Best bid ' +
      f(book.bids[0].price) +
      ' · ask ' +
      f(book.asks[0].price) +
      ' · spread ' +
      f(book.spread) +
      ' · bid / ask pressure ' +
      pct(book.bidFraction) +
      ' / ' +
      pct(1 - book.bidFraction);
    for (const side of ['bids', 'asks'])
      table(
        side,
        ['Price', 'Amount', 'USD', 'Cum. qty'],
        book[side].map((v) => [v.price, v.amount, v.notional, v.cumulative].map(f))
      );
    table(
      'tape',
      ['UTC', 'Price', 'Amount', 'USD', 'Aggressor'],
      book.tape.map((v) => [utc(v.time), f(v.price), f(v.amount), f(v.notional), v.aggressor])
    );
  }
  el('flow').ontoggle = flow;
  function refresh(s, time, last) {
    at = time;
    price = last;
    account = portfolio(s, at);
    estimateTicket();
    flow();
    const metrics = [
      ['Equity', account.equity],
      ['Available cash', account.available],
      ['Open P&L', account.unrealized],
      ['Realized P&L', account.realized],
      ['Total P&L', account.total],
      ['Fees', account.fees],
      ['Closing win rate', pct(account.winRate)],
      ['Cash / assets', pct(account.cash / account.equity) + ' / ' + pct(account.assets / account.equity)]
    ];
    el('balances').replaceChildren(
      ...metrics.map(([label, value]) => {
        const group = document.createElement('div'),
          k = document.createElement('dt'),
          v = document.createElement('dd');
        k.textContent = label;
        v.textContent = typeof value === 'number' ? '$' + f(value) : value;
        group.append(k, v);
        return group;
      })
    );
    table(
      'holdings',
      ['Instrument', 'Quantity', 'Average entry', 'Mark', 'Value', 'Open P&L'],
      account.holdings.map((r) => [r.symbol, ...[r.quantity, r.average, r.mark, r.value, r.open].map(f)])
    );
    const calls = s.predictions.map((p) => ({ ...p, ...assessPrediction(p, at) })),
      closed = calls.filter((p) => p.state !== 'Tracking');
    el('hit-rate').textContent =
      'Hit rate ' +
      (closed.length ? pct(closed.filter((p) => p.state === 'Correct').length / closed.length) : '—') +
      ' · ' +
      closed.length +
      ' resolved';
    table(
      'calls',
      ['Recorded UTC', 'Market', 'Call', 'Horizon', 'Confidence', 'Entry', 'Move', 'State', 'Note'],
      calls
        .reverse()
        .map((p) => [
          utc(p.at),
          p.symbol,
          p.direction,
          p.horizon,
          p.confidence + '%',
          f(p.entry),
          f(p.move) + '%',
          p.state,
          p.note
        ])
    );
    if (s === latest) return;
    latest = s;
    el('working').replaceChildren(
      ...(s.orders.length
        ? s.orders.map((o) => {
            const div = document.createElement('div'),
              b = document.createElement('button');
            div.textContent = o.side + ' ' + o.qty + ' ' + o.symbol + ' · ' + o.type + ' ' + f(o.trigger) + ' ';
            b.className = 'agentic-form-control';
            b.textContent = 'Cancel';
            b.onclick = () => act({ kind: 'cancel', id: o.id });
            div.append(b);
            return div;
          })
        : [document.createTextNode('No working orders')])
    );
    const records = journalRecords(s.fills);
    table(
      'fills',
      journalHeaders,
      records
        .slice()
        .reverse()
        .map((r) => r.values)
    );
    bindWorkbookExport(
      el('sheets'),
      el('notice'),
      {
        workbookId: 'practice-journal',
        sheetId: 'fills',
        name: 'Paper trade journal',
        headers: journalHeaders,
        records,
        filename: 'practice-journal.json'
      },
      (text, file) => download(text, file, 'application/json')
    );
  }
  return { refresh, lineNumbers, clearExperiment };
}
