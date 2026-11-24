import { replayMoomooSecuritiesEvent, replayMoomooCryptoReport } from '../owners/gateway/moomoo-trade-event.mjs';
import { canonical } from './rules.mjs';

const names = {
  EVENT_NEW: 'Order accepted', EVENT_REPLACED: 'Order amended', EVENT_CANCELED: 'Order cancelled',
  EVENT_EXPIRED: 'Order expired', EVENT_FILL: 'Fill', EVENT_NEW_REJECTED: 'Placement rejected',
  EVENT_REPLACE_REJECTED: 'Amendment rejected', EVENT_CANCEL_REJECTED: 'Cancellation rejected',
  EVENT_FILL_CORRECT: 'Fill corrected', EVENT_FILL_CANCEL: 'Fill cancelled', EVENT_WAIT_OPEN: 'Waiting to open',
  EVENT_PRICE_PROTECT: 'Price protection', EVENT_TRIGGER_WAITING: 'Waiting for trigger', EVENT_TRIGGER: 'Triggered',
  placed: 'Order accepted', 'placement-rejected': 'Placement rejected', cancelled: 'Order cancelled',
  'cancellation-rejected': 'Cancellation rejected', filled: 'Full fill', 'partial-fill': 'Partial fill', expired: 'Order expired',
};
const errorText = {
  ACCOUNT_BINDING: 'The securities account differs from the selected account.',
  PRECISION_UNKNOWN: 'An exact price, quantity, account number or timestamp is missing.',
  INVALID_WIRE: 'Choose a securities JSON frame.',
  INVALID_PROTOBUF: 'Choose a complete binary crypto report.',
  ORDER_BINDING: 'The report and order identifiers disagree.',
  INSTRUMENT_BINDING: 'A fill refers to a different instrument.',
  INVALID_TRADE_EVENT: 'The frame contains incomplete or inconsistent trade data.',
};
const eventName = event => names[event.outcome ?? event.topic];
const instrument = event => event.order.symbol ?? (event.order.coin + '/' + event.order.currency);

function renderEvent(parent, event, node) {
  const { order } = event, fields = node('dl');
  function fact(label, value) {
    if (value == null || value === '') return;
    fields.append(node('dt', label), node('dd', String(value)));
  }
  parent.replaceChildren(node('h4', eventName(event)), fields);
  fact('Instrument', instrument(event)); fact('Side', order.side); fact('Currency', order.currency);
  fact('Order quantity', order.quantity); fact('Order price', order.price); fact('Cumulative fill quantity', order.filled_quantity);
  fact('Average fill price', order.average_fill_price); fact('Order status', order.status);
  fact('Order state', order.closed == null ? null : order.closed ? 'Closed' : 'Open');
  fact('Order created (Unix µs)', order.created_us); fact('Order updated (Unix µs)', order.updated_us);
  fact('Event time (Unix µs)', event.event_time_us); fact('Provider result code', event.result);
  const fills = event.fills ?? (event.fill ? [event.fill] : []);
  if (!fills.length) return;
  const details = node('details');
  details.append(node('summary', 'Fill details (' + fills.length + ')'));
  const list = node('ol');
  // Pages keep a large valid fill event usable on a phone.
  const prev = node('button', 'Previous fills'), next = node('button', 'Next fills');
  prev.type = next.type = 'button';
  let start = 0;
  function page() {
    list.start = start + 1;
    list.replaceChildren(...fills.slice(start, start + 10).map(fill => {
      const parts = [fill.symbol ?? instrument(event), fill.quantity + ' at ' + fill.price, fill.status];
      if (fill.remaining_quantity != null) parts.push(fill.remaining_quantity + ' remaining');
      if (fill.amount != null) parts.push('Amount ' + fill.amount);
      if (fill.updated_us != null) parts.push(fill.updated_us + ' µs');
      return node('li', parts.filter(Boolean).join(' · '));
    }));
    prev.disabled = start === 0; next.disabled = start + 10 >= fills.length;
  }
  prev.onclick = () => { start -= 10; page(); };
  next.onclick = () => { start += 10; page(); };
  details.append(list); if (fills.length > 10) details.append(prev, next);
  page(); parent.append(details);
}

export function mountTradeEvents(panel, node) {
  const format = node('select'), account = node('input'), files = node('input');
  for (const [value, label] of [['securities', 'Securities JSON'], ['crypto', 'Crypto Protobuf']]) {
    const option = node('option', label); option.value = value; format.append(option);
  }
  function label(title, input) {
    const el = node('label', title + ' ');
    input.setAttribute('aria-label', title); el.append(input); return el;
  }
  account.type = 'password'; account.inputMode = 'numeric'; account.autocomplete = 'off'; account.spellcheck = false;
  const accountLabel = label('Expected securities account ID', account);
  files.type = 'file'; files.multiple = true;
  const show = node('button', 'Read local files'), clear = node('button', 'Clear'), status = node('p'), output = node('section');
  show.type = clear.type = 'button'; status.setAttribute('role', 'status'); output.setAttribute('aria-label', 'Private trade-event preview');
  const note = node('p'), outer = panel.parentElement.closest('details');
  panel.append(node('p', 'Choose up to 64 saved frames, 480 kB total. Private events stay in this tab until the preview closes.'),
    label('Frame format', format), accountLabel, label('Saved trade-event files', files), note, show, clear, status, output);
  let generation = 0;
  function reset(clearInputs = true) {
    generation++; show.disabled = false; status.textContent = ''; output.replaceChildren();
    if (clearInputs) { account.value = ''; files.value = ''; }
  }
  function configure() {
    reset();
    const securities = format.value === 'securities';
    accountLabel.hidden = !securities; files.accept = securities ? '.json,application/json' : '.bin,.pb,.protobuf,application/octet-stream';
    note.textContent = securities ? 'Events are ordered by provider event time. The account number must match every frame.' :
      'Crypto reports appear in file selection order. Their wire format omits the account ID and event time.';
  }
  configure();
  format.onchange = configure; account.oninput = files.onchange = () => reset(false); clear.onclick = () => reset();
  for (const details of [panel, outer]) details?.addEventListener('toggle', () => { if (!details.open) reset(); });
  window.addEventListener('pagehide', () => reset());
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  show.onclick = async () => {
    reset(false);
    const turn = generation, selected = [...files.files], expected = account.value, securities = format.value === 'securities';
    if (!selected.length || selected.length > 64 || selected.some(f => !f.size) || selected.reduce((sum, f) => sum + f.size, 0) > 480000) {
      status.textContent = 'Select 1–64 nonempty files, up to 480 kB in total.'; return;
    }
    if (securities && !/^[1-9]\d{0,19}$/.test(expected)) { status.textContent = 'Enter the exact securities account number.'; return; }
    const seen = new Map(), events = [];
    let duplicates = 0, unsupported = 0;
    show.disabled = true;
    try {
      for (const file of selected) {
        const wire = await file.arrayBuffer();
        if (turn !== generation) return;
        const event = securities ? replayMoomooSecuritiesEvent(expected, new TextDecoder('utf-8', { fatal: true }).decode(wire)) : replayMoomooCryptoReport(wire);
        if (event.status === 'unsupported') { unsupported++; continue; }
        const content = canonical(event);
        if (seen.has(event.event_id)) {
          if (seen.get(event.event_id) !== content) throw Error('CONFLICTING_EVENT');
          duplicates++;
        } else { seen.set(event.event_id, content); events.push(event); }
      }
      if (turn !== generation || document.hidden || !panel.open || (outer && !outer.open)) return;
      if (securities) events.sort((a,b) => {
        const x = BigInt(a.event_time_us), y = BigInt(b.event_time_us); return x < y ? -1 : x > y ? 1 : 0;
      });
      if (events.length) {
        const body = node('div');
        if (events.length > 1) {
          const picker = node('select');
          for (const [i, event] of events.entries()) {
            const option = node('option', (i + 1) + '. ' + eventName(event) + ' · ' + instrument(event));
            option.value = String(i); picker.append(option);
          }
          picker.onchange = () => renderEvent(body, events[Number(picker.value)], node);
          output.append(label('Event', picker));
        }
        output.append(body); renderEvent(body, events[0], node);
      }
      status.textContent = 'Local replay · origin and environment unverified · ' + events.length + ' unique · ' + duplicates + ' duplicate · ' + unsupported + ' unsupported';
    } catch (error) {
      if (turn !== generation) return;
      output.replaceChildren();
      status.textContent = error.message === 'CONFLICTING_EVENT' ? 'Conflicting copies of the same event. Preview stopped.' :
        errorText[error.code] ?? 'The selected files could not be decoded.';
    } finally {
      if (turn === generation) { show.disabled = false; account.value = ''; files.value = ''; }
    }
  };
}
