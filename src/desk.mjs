import { bindLab } from './desk-lab.mjs';
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
  let lab,
    publicMarkets = [],
    lastPublicSequence = -1,
    lastPublicKey = '',
    hasForming = true,
    overlayBefore;
  const external = () => Boolean(saved.venue && saved.venue !== 'synthetic');
  const marketKey = () => [saved.venue ?? 'synthetic', saved.marketType ?? 'spot', symbol, frame].join('/');
  const effective = () => (symbol === saved.symbol ? saved : { ...saved, symbol });
  function series(at) {
    if (external()) {
      chart.update(bars, selection, markers, frame);
      return;
    }
    const key = marketKey();
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
    readFlow: async (input) => {
      const [b, t] = await Promise.all([lab.human('read.depth', input), lab.human('read.tape', input)]);
      return { ...b.rows, tape: t.rows, volumes: t.volumes };
    },
    onError: error,
    getBars: () => (external() && !hasForming ? [...bars] : bars.slice(0, -1)),
    onMarkers: (m) => {
      markers = m;
      if (lab && client?.online && m.length)
        void lab
          .human('desk.markers', {
            symbol,
            frame,
            venue: saved.venue ?? 'synthetic',
            marketType: saved.marketType ?? 'spot',
            markers: m.map(({ time, price, action }) => ({ time, price, action }))
          })
          .catch((e) => error(e.message));
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
    const query = value('search').toUpperCase();
    const matches = external()
        ? publicMarkets
            .filter((m) => m.venue === saved.venue && m.marketType === saved.marketType && m.symbol.includes(query))
            .map((m) => ({ ...m, name: m.base }))
        : searchCatalog(query),
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
      ...saved.watch
        .filter((v) =>
          external() ? publicMarkets.some((m) => m.venue === saved.venue && m.symbol === v) : v.endsWith('.USD')
        )
        .map((s) => {
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
  el('venue').onchange = async () => {
    const venue = value('venue'),
      market = publicMarkets.find((m) => m.venue === venue),
      next = market?.symbol ?? searchCatalog('')[0].symbol;
    if (
      !(await act({
        kind: 'select',
        venue,
        symbol: next,
        marketType: market?.marketType ?? saved.marketType ?? 'spot',
        frame: market?.frame ?? frame
      }))
    ) {
      el('venue').value = saved.venue ?? 'synthetic';
      return;
    }
    void poll();
  };
  el('market-type').onchange = async () => {
    if (!(await act({ kind: 'select', symbol, marketType: value('market-type') })))
      el('market-type').value = saved.marketType;
  };
  el('instrument').onchange = (e) => choose(e.target.value);
  el('frame').onchange = async (e) => {
    if (external()) {
      const next = e.target.value;
      e.target.value = frame;
      const accepted = await act({ kind: 'select', symbol, frame: next });
      if (accepted) {
        applySettings(accepted.session);
        overlayBefore = undefined;
        void poll();
      }
      return;
    }
    frame = e.target.value;
    clearSeries();
    if (external()) void poll();
    else series(latestTime);
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
        oldSymbol = symbol,
        oldKey = marketKey();
      saved = data.session;
      el('venue').value = saved.venue ?? 'synthetic';
      el('place').disabled =
        external() &&
        !publicMarkets.some(
          (m) => m.venue === saved.venue && m.symbol === saved.symbol && m.live && m.currency === 'USD'
        );
      el('prediction').querySelector('button').disabled = el('place').disabled;
      el('market-type').value = saved.marketType ?? 'spot';
      el('contract-options').hidden = saved.marketType !== 'perpetual';
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
      if (first || reset || newSession || oldSymbol !== symbol || oldKey !== marketKey()) {
        bars = [];
        overlayBefore = undefined;
        clearSeries();
      }
      recent();
      options();
      if (external()) {
        if (lab) void poll();
      } else refresh(quote(symbol, Date.now()));
    },
    (status) => (el('storage').textContent = status)
  );
  let lastRetry = 0,
    failures = 0,
    channel,
    streamSymbol,
    lastEvent = 0;
  function connect(target) {
    const key = marketKey();
    if (channel && streamSymbol === key) return;
    channel?.close();
    lastEvent = 0;
    streamSymbol = key;
    if (!navigator.onLine || typeof EventSource === 'undefined') {
      channel = null;
      return;
    }
    const params = new URLSearchParams({
      symbol: target,
      venue: 'synthetic',
      marketType: saved.marketType ?? 'spot',
      frame
    });
    channel = new EventSource('/api/practice/events?' + params);
    channel.onmessage = (event) => {
      if (key !== marketKey() || closed) return;
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
      target = symbol,
      bound = marketKey();
    if (external()) {
      channel?.close();
      channel = null;
      lastEvent = 0;
      try {
        const data = await lab.human('desk.chart', {
          symbol,
          venue: saved.venue,
          marketType: saved.marketType,
          frame,
          count: 300,
          ...(overlayBefore ? { before: overlayBefore } : {})
        });
        if (closed || bound !== marketKey() || seq !== sequence) return;
        if (data.sequence !== undefined) {
          if (lastPublicKey === bound && data.sequence < lastPublicSequence) throw Error('FEED_ROLLBACK');
          lastPublicKey = bound;
          lastPublicSequence = data.sequence;
        }
        hasForming = Boolean(data.forming);
        bars = data.forming ? [...data.bars, data.forming] : data.bars;
        markers = data.markers;
        seriesKey = bound;
        el('symbol').textContent = symbol;
        const last = bars.at(-1);
        el('price').textContent = last ? last.close.toLocaleString() + ' ' + symbol.split('.')[1] : 'Missing';
        el('ticker').textContent =
          saved.venue +
          ' · ' +
          saved.marketType +
          ' · ' +
          (last?.volume == null ? 'volume unavailable' : 'volume ' + last.volume.toLocaleString());
        el('stream').textContent =
          data.quality +
          ' · ' +
          data.source.id +
          ' · ' +
          data.source.license +
          ' · ' +
          (last ? new Date(data.asOf ?? last.lastObservation ?? last.time).toISOString() : 'no observations');
        series(last?.time ?? Date.now());
        panels.refresh(effective(), Date.now(), last?.close ?? 0);
        if (publicMarkets.some((m) => m.venue === saved.venue && m.live)) {
          const tick = await lab.human('read.ticker', {
            symbol,
            venue: saved.venue,
            marketType: saved.marketType,
            frame
          });
          if (bound !== marketKey() || seq !== sequence) return;
          const q = tick.rows;
          el('price').textContent = String(q.last);
          el('ticker').textContent =
            (tick.quality === 'stale' ? 'Stale ticker · ' : '') +
            '24h ' + q.change + '% · High ' + q.high + ' · Low ' + q.low + ' · Volume ' + q.volume;
          if (
            data.quality === 'live' && tick.quality === 'live' &&
            saved.orders.some(
              (o) =>
                o.venue === saved.venue &&
                o.symbol === symbol &&
                o.marketType === saved.marketType &&
                orderTriggers(o, q.last)
            )
          )
            await act({ kind: 'tick', symbol });
        }
      } catch (e) {
        error(e.message);
      }
      if (!closed && seq === sequence && publicMarkets.some((m) => m.venue === saved.venue && m.live))
        marketTimer = setTimeout(poll, 2500);
      return;
    }
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
    if (seq !== sequence || bound !== marketKey() || closed) return;
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
      saved.orders.some(
        (o) =>
          (o.marketType ?? 'spot') === (saved.marketType ?? 'spot') &&
          o.symbol === target &&
          orderTriggers(o, Number(el('price').textContent.slice(1)))
      ) &&
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
  lab = bindLab(client, (data) => {
    markers = data.markers;
    if (external() && markers.length) {
      overlayBefore = bucket(markers.at(-1).time, frame, 1);
      void poll();
    } else series(latestTime);
  });
  if (client.online) {
    const catalog = await lab.human('read.catalog', { count: 600 }).catch((e) => {
      error('Public catalog unavailable · ' + e.message);
      return { rows: [] };
    });
    publicMarkets = catalog.rows.filter((m) => m.venue !== 'synthetic');
    for (const venue of new Set(publicMarkets.map((m) => m.venue)))
      el('venue').add(new Option(venue + ' · market data', venue));
    el('venue').value = saved.venue ?? 'synthetic';
    options();
    recent();
  }
  for (const key of Object.keys(frames)) el('historical').elements.frame.add(new Option(key, key));
  await poll();
}
openDesk().catch((e) => {
  document.getElementById('storage').textContent = 'Desk unavailable · ' + e.message;
});
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    document.getElementById('stream').textContent = 'Offline installation unavailable · ' + e.message;
  });
