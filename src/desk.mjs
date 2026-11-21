import { orderTriggers } from './practice-account.mjs';
import { searchCatalog, frames, history, quote, bucket, SOURCE } from './market.mjs';
import { studies, presets } from './indicators.mjs';
import { mountChart } from './chart.mjs';
import { bindPanels } from './desk-panels.mjs';
import { deskSession } from './desk-session.mjs';
import { initialPractice } from './practice-defaults.mjs';

const el = (id) => document.getElementById(id),
  value = (id) => el(id).value;
async function openDesk() {
  let saved = initialPractice(),
    symbol = saved.symbol,
    frame = saved.frame,
    selection = saved.studies,
    markers = [],
    bars = [],
    seriesKey = '';
  let client,
    panels,
    latestTime = Date.now(),
    sessionId,
    revision = -1,
    settingsTimer,
    dirty = false,
    version = 0,
    marketTimer,
    sequence = 0,
    closed = false;
  const chart = mountChart(el('chart'), el('ohlc'), el('expand'));
  const error = (message) => {
    el('notice').textContent = message;
  };
  const effective = () => (symbol === saved.symbol ? saved : { ...saved, symbol });
  function series(at) {
    const key = symbol + '/' + frame;
    if (key !== seriesKey || !bars.length || at < bars.at(-1).time || bucket(at, frame) !== bars.at(-1).time) {
      bars = history(symbol, frame, at, 300);
      seriesKey = key;
    } else bars[bars.length - 1] = history(symbol, frame, at, 1)[0];
    chart.update(bars, selection, markers, frame);
  }
  function refresh(q) {
    latestTime = q.at;
    el('symbol').textContent = symbol;
    el('price').textContent = '$' + q.last.toFixed(4);
    el('ticker').textContent =
      '24h ' +
      q.change.toFixed(2) +
      '% · High ' +
      q.high +
      ' · Low ' +
      q.low +
      ' · Volume ' +
      q.volume.toLocaleString();
    series(q.at);
    panels.refresh(effective(), q.at, q.last);
  }
  const pending = new Set();
  async function act(command) {
    if (!client || (pending.has(command.kind) && ['order', 'prediction', 'funds', 'reset'].includes(command.kind)))
      return;
    pending.add(command.kind);
    try {
      const data = await client.command(command);
      if (data.notice && data.notice !== 'MONITORING') el('notice').textContent = data.notice;
      return data;
    } catch (e) {
      error(e.message);
      return null;
    } finally {
      pending.delete(command.kind);
    }
  }
  const readSettings = () => ({ kind: 'settings', frame, studies: [...selection], code: value('code') });
  function settingsChanged() {
    dirty = true;
    const v = ++version;
    clearTimeout(settingsTimer);
    if (!client?.online) {
      el('storage').textContent = 'Offline research · settings on this page';
      return;
    }
    el('storage').textContent = 'Saving settings…';
    settingsTimer = setTimeout(async () => {
      const next = await act(readSettings());
      if (v === version) {
        if (next) dirty = false;
        else el('storage').textContent = 'Settings unsaved · see practice notice';
      }
    }, 350);
  }
  panels = bindPanels({
    state: effective,
    act,
    onError: error,
    getBars: () => bars.slice(0, -1),
    onMarkers: (m) => {
      markers = m;
      if (bars.length) chart.update(bars, selection, markers, frame);
    },
    settingsChanged
  });
  function clearSeries() {
    seriesKey = '';
    panels.clearExperiment();
    chart.reset();
  }
  function renderStudies() {
    for (const input of el('studies').querySelectorAll('input')) input.checked = selection.includes(input.value);
    el('preset').value =
      Object.keys(presets).find(
        (key) => presets[key].length === selection.length && presets[key].every((id) => selection.includes(id))
      ) ?? 'Custom';
  }
  function applySettings(s) {
    frame = s.frame;
    selection = [...s.studies];
    el('frame').value = frame;
    el('code').value = s.code;
    panels.lineNumbers();
    renderStudies();
  }
  function options() {
    const matches = searchCatalog(value('search')),
      select = el('instrument');
    select.replaceChildren(
      ...matches.map((a) => new Option((a.featured ? '★ ' : '') + a.symbol + ' · ' + a.name, a.symbol))
    );
    if (matches.some((a) => a.symbol === symbol)) select.value = symbol;
    if (!matches.length) select.add(new Option('No matching instruments', ''));
    // Keep search and selection distinct, including when only one instrument matches.
    if (matches.length && !matches.some((a) => a.symbol === symbol)) {
      const prompt = new Option('Select a market', '', true, true);
      select.prepend(prompt);
      select.value = '';
    }
  }
  function recent() {
    el('watch').replaceChildren(
      ...saved.watch.map((s) => {
        const b = document.createElement('button');
        b.className = 'agentic-form-control';
        b.textContent = s;
        b.setAttribute('aria-pressed', String(s === symbol));
        b.onclick = () => choose(s);
        return b;
      })
    );
  }
  async function choose(next) {
    if (!next) return;
    if (client?.online) {
      if (!(await act({ kind: 'select', symbol: next }))) return;
    }
    symbol = next;
    el('search').value = '';
    options();
    recent();
    clearSeries();
    void poll();
  }
  for (const id of Object.keys(frames)) el('frame').add(new Option(id, id));
  for (const id of [...Object.keys(presets), 'Custom']) el('preset').add(new Option(id, id));
  for (const [id, name] of Object.entries(studies)) {
    const label = document.createElement('label'),
      input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.onchange = () => {
      selection = [...el('studies').querySelectorAll(':checked')].map((x) => x.value);
      renderStudies();
      series(latestTime);
      settingsChanged();
    };
    label.append(input, document.createTextNode(name));
    el('studies').append(label);
  }
  el('search').oninput = options;
  el('instrument').onchange = (e) => choose(e.target.value);
  el('frame').onchange = (e) => {
    frame = e.target.value;
    clearSeries();
    series(latestTime);
    settingsChanged();
  };
  el('preset').onchange = (e) => {
    if (e.target.value === 'Custom') return;
    selection = [...presets[e.target.value]];
    renderStudies();
    series(latestTime);
    settingsChanged();
  };
  applySettings(saved);
  options();
  recent();
  client = await deskSession(
    (data) => {
      const first = revision === -1,
        newSession = data.sessionId !== sessionId,
        reset = data.notice === 'RESET',
        oldSymbol = symbol;
      saved = data.session;
      symbol = saved.symbol;
      revision = data.revision;
      sessionId = data.sessionId;
      if (first || reset || newSession) {
        clearTimeout(settingsTimer);
        version++;
        dirty = false;
        applySettings(saved);
      } else if (
        !dirty &&
        (saved.code !== value('code') ||
          saved.frame !== frame ||
          JSON.stringify(saved.studies) !== JSON.stringify(selection))
      )
        applySettings(saved);
      if (first || reset || newSession || oldSymbol !== symbol) clearSeries();
      recent();
      options();
      refresh(quote(symbol, Date.now()));
    },
    (status) => (el('storage').textContent = status)
  );
  let lastRetry = 0,
    failures = 0,
    channel,
    streamSymbol,
    lastEvent = 0;
  function connect(target) {
    if (channel && streamSymbol === target) return;
    channel?.close();
    lastEvent = 0;
    streamSymbol = target;
    if (!navigator.onLine || typeof EventSource === 'undefined') {
      channel = null;
      return;
    }
    channel = new EventSource('/api/practice/events?symbol=' + encodeURIComponent(target));
    channel.onmessage = (event) => {
      if (target !== symbol || closed) return;
      try {
        const tick = JSON.parse(event.data);
        if (tick.source !== SOURCE || tick.rows?.symbol !== target || tick.at !== tick.rows.at) throw Error();
        refresh(tick.rows);
        lastEvent = Date.now();
        const age = lastEvent - tick.at;
        el('stream').textContent =
          'Synthetic event stream · ' +
          (age >= 0 ? age + ' ms event age' : 'unknown event age') +
          ' · ' +
          new Date(tick.at).toISOString().slice(11, 19) +
          ' UTC';
      } catch {
        lastEvent = 0;
      }
    };
    channel.onerror = () => {
      lastEvent = 0;
    };
  }
  async function poll() {
    if (closed) return;
    clearTimeout(marketTimer);
    const seq = ++sequence,
      target = symbol;
    connect(target);
    let q, source;
    if (Date.now() - lastEvent < 4500) {
      failures = 0;
    } else
      try {
        if (!navigator.onLine) throw Error('OFFLINE');
        const resp = await fetch('/api/practice/market?symbol=' + encodeURIComponent(target), {
          cache: 'no-store',
          signal: AbortSignal.timeout(2500)
        });
        if (!resp.ok) throw Error('FEED_UNAVAILABLE');
        const tick = await resp.json();
        if (tick.source !== SOURCE || tick.rows?.symbol !== target || !Number.isSafeInteger(tick.at))
          throw Error('UNQUALIFIED_FEED');
        q = tick.rows;
        const latency = Date.now() - tick.at;
        source = 'Loopback synthetic stream · ' + (latency >= 0 ? latency + ' ms event age' : 'unknown event age');
        failures = 0;
      } catch {
        q = quote(target, Date.now());
        source = 'Loopback feed unavailable · sealed synthetic replay';
        failures++;
      }
    if (seq !== sequence || target !== symbol || closed) return;
    if (q && Date.now() - lastEvent >= 4500) {
      el('stream').textContent = source + ' · ' + new Date(q.at).toISOString().slice(11, 19) + ' UTC';
      refresh(q);
    }
    if (!client.online && navigator.onLine && Date.now() - lastRetry > 8000) {
      lastRetry = Date.now();
      await client.reconnect();
    }
    if (
      client.online &&
      saved.orders.some((o) => o.symbol === target && orderTriggers(o, Number(el('price').textContent.slice(1)))) &&
      !failures
    )
      await act({ kind: 'tick', symbol: target });
    if (seq === sequence && !closed)
      marketTimer = setTimeout(poll, failures ? Math.min(15000, 1000 * 2 ** Math.min(4, failures)) : 2000);
  }
  window.addEventListener('online', poll);
  window.addEventListener('offline', poll);
  window.addEventListener('pagehide', () => {
    closed = true;
    channel?.close();
    channel = null;
    clearTimeout(marketTimer);
  });
  window.addEventListener('pageshow', () => {
    if (closed) {
      closed = false;
      void poll();
    }
  });
  await poll();
}
openDesk().catch((e) => {
  document.getElementById('storage').textContent = 'Desk unavailable · ' + e.message;
});
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    document.getElementById('stream').textContent = 'Offline installation unavailable · ' + e.message;
  });
