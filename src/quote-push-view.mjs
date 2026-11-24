import { mountPrivateReceipt } from './private-receipt-view.mjs';
import { replayMoomooPush } from '../owners/gateway/moomoo.mjs';

const previewLimit = 40;
const display = value => value == null ? 'Unknown' : String(value);

function present(parent, type, replay, { node, table, diagram, diagrams }) {
  const facts = node('dl');
  facts.className = 'facts';
  const fact = (name, value) => facts.append(node('dt', name), node('dd', display(value)));
  fact(replay.market ? 'Market' : 'Symbol', replay.market ?? replay.symbol);
  if ('marketTimeUtc' in replay) fact('Market time (UTC)', replay.marketTimeUtc);
  parent.append(facts);
  const preview = (label, rows) => {
    if (rows == null) { fact(label, 'Not supplied'); return []; }
    fact(label, rows.length > previewLimit ? `Showing first ${previewLimit} of ${rows.length}` : rows.length);
    return rows.slice(0, previewLimit);
  };
  if (type === 'MARKET_STATE') {
    fact('Trading state', replay.statusName ?? 'Unrecognized');
    fact('Provider state code', replay.statusCode);
    fact('Local trading date', replay.tradeDate);
  } else if (type === 'BROKER_QUEUE') {
    const bid = preview('Bid brokers', replay.bids), ask = preview('Ask brokers', replay.asks);
    const rows = (side, list) => list.map(row => [side, row.rank, row.brokerId, row.brokerName]);
    table(parent, 'Broker queue details', ['Side', 'Rank', 'Broker ID', 'Broker name'], [...rows('Bid', bid), ...rows('Ask', ask)]);
  } else if (type === 'QUOTE') {
    for (const [label, key] of [['Last','last'], ['Open','open'], ['High','high'], ['Low','low'],
      ['Previous close','previousClose'], ['Volume','volume'], ['Turnover','turnover'], ['Suspended','suspended'], ['Security status','status']]) {
      fact(label, replay[key]);
    }
  } else if (type === 'ORDER_BOOK') {
    const bid = preview('Bid levels', replay.bids), ask = preview('Ask levels', replay.asks);
    diagram(parent, 'Order book depth', diagrams.depth({ bid, ask }));
    const rows = (side, levels) => levels.map(row => [side, row.price, row.volume, row.orderCount]);
    table(parent, 'Order book details', ['Side', 'Price', 'Volume', 'Orders'], [...rows('Bid', bid), ...rows('Ask', ask)]);
  } else if (type === 'TICKER') {
    const ticks = preview('Ticks', replay.ticks);
    diagram(parent, 'Trade volume', diagrams.tape(ticks));
    const signedTicks = ticks.some(t => Object.hasOwn(t, 'sequence'));
    table(parent, 'Trade details', ['Time (UTC)', 'Side', 'Price', 'Volume', 'Turnover', ...(signedTicks ? ['Sequence', 'Trade type'] : [])],
      ticks.map(t => [t.marketTimeUtc, t.direction, t.price, t.volume, t.turnover, ...(signedTicks ? [t.sequence, t.tradeType] : [])]));
  } else if (type === 'KLINE') {
    fact('Period', replay.period);
    fact('Adjustment', replay.adjust);
    const bars = preview('Bars', replay.bars);
    const intraday = /^\d+m$/.test(replay.period);
    const candles = bars.map(bar => ({ ...bar,
      date: intraday ? bar.marketTimeUtc?.slice(11, 19) : bar.marketTimeUtc?.slice(0, 10) }));
    diagram(parent, 'Candlesticks', diagrams.candles(candles, `${replay.period} candlestick chart · ${bars.length} bars`));
    table(parent, 'Bar details', ['Time (UTC)', 'Open', 'High', 'Low', 'Close', 'Volume', 'Turnover'],
      bars.map(b => [b.marketTimeUtc, b.open, b.high, b.low, b.close, b.volume, b.turnover]));
  }
}

export function mountQuotePushView(parent, symbol, ui) {
  const { node } = ui;
  const target = node('input'), picker = node('input'), clear = node('button', 'Clear file');
  target.value = symbol;
  target.spellcheck = false;
  picker.type = 'file';
  picker.accept = '.json,application/json';
  clear.type = 'button';
  const targetLabel = node('label', 'Expected symbol or market ');
  const fileLabel = node('label', 'Quote push JSON file ');
  targetLabel.append(target);
  fileLabel.append(picker);
  const status = node('p'), result = node('div');
  status.setAttribute('role', 'status');
  parent.append(node('p', 'Choose one saved JSON frame under 500 kB. The preview stays in this tab.'),
    targetLabel, fileLabel, clear, status, result);
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    result.replaceChildren();
    const file = picker.files[0];
    clear.disabled = !file;
    status.textContent = '';
    if (!file) return;
    try {
      if (file.size >= 500000) throw Error('File must be under 500 kB.');
      let frame;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
      catch { throw Error('Expected a UTF-8 file containing one JSON frame.'); }
      if (current !== generation) return;
      const expected = target.value.trim();
      const market = /^[A-Z][A-Z0-9]{0,11}(?:\.[A-Z0-9][A-Z0-9.-]{0,31})?$/.exec(expected);
      const key = frame?.type === 'MARKET_STATE' && market ? expected.split('.')[0] : expected;
      const replay = replayMoomooPush(key, frame);
      if (!replay) throw Error('Unsupported quote push type.');
      const body = document.createDocumentFragment();
      present(body, frame.type, replay, ui);
      result.replaceChildren(body);
      status.textContent = `Local file · ${frame.type} · origin unverified`;
    } catch (error) {
      if (current === generation) status.textContent = 'Cannot preview this frame. ' + error.message;
    }
  }
  picker.addEventListener('change', refresh);
  target.addEventListener('input', () => {
    generation++;
    result.replaceChildren();
    status.textContent = picker.files.length ? 'Press Enter or leave the target field to refresh.' : '';
  });
  target.addEventListener('change', refresh);
  target.addEventListener('keydown', event => { if (event.key === 'Enter') target.blur(); });
  clear.addEventListener('click', () => { picker.value = ''; refresh(); });
  refresh();
}

export function mountQuoteStreamReceipt(host, panel, ui) {
  const { node } = ui;
  mountPrivateReceipt(host, panel, node, { endpoint: '/api/gateway/quote-stream-receipt', label: 'Quote stream receipt',
    accepts: operation => operation === 'read.quote-stream', kind: 'quote stream', controls: 'socket control calls',
    render(output, request, receipt) {
      const capture = receipt.data.receipt?.payload, { type, symbol, period, adjust } = request.inputs;
      const key = capture?.subscription?.[type]?.[0];
      if (capture?.kind !== 'quote-stream-capture' || capture.definition_digest !== receipt.provenance.definition_digest ||
        !['quote', 'ticker', 'order_book', 'kline'].includes(type) || !Array.isArray(capture.frames) || capture.frames.length > 64 ||
        (type === 'kline' ? key?.symbol !== symbol || key.period !== period || key.adjust !== adjust : key !== symbol) ||
        !capture.frames.every(frame => frame?.symbol === symbol)) throw Error('Receipt identity mismatch.');
      output.append(node('h4', symbol + ' · ' + type.toUpperCase()),
        node('p', 'Captured ' + capture.issued_utc + ' · Ledger revision ' + receipt.ledger_revision));
      if (capture.recovery) {
        const link = capture.recovery;
        const note = node('p');
        note.append('Resumed after ', node('code', link.previous_request_id), ' using the ',
          node('code', link.operation), ' snapshot ', node('code', link.request_id), ' received ' + link.observed_utc + '.');
        output.append(note);
      }
      if (!capture.frames.length) { output.append(node('p', 'No quote frames arrived during this capture.')); return; }
      const frameView = node('div');
      function show(index) {
        frameView.replaceChildren();
        present(frameView, type.toUpperCase(), capture.frames[index], ui);
      }
      if (capture.frames.length > 1) {
        const label = node('label', 'Captured frame '), select = node('select');
        capture.frames.forEach((_, i) => select.append(node('option', (i + 1) + ' of ' + capture.frames.length)));
        select.addEventListener('change', () => show(select.selectedIndex));
        label.append(select); output.append(label);
      }
      output.append(frameView); show(0);
    },
  });
}
