import { bucket } from './market.mjs';
import { calculateStudies } from './indicators.mjs';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
});
export function mountChart(root, summary, expand) {
  let frame = '5m',
    currency = 'USD',
    bars = [],
    lines = [],
    signals = [],
    count = 70,
    offset = 0,
    cursor = null,
    pan = null,
    gesture = null;
  const panes = new Map(),
    pointers = new Map();
  function zoom(next) {
    count = clamp(Math.round(next), 12, Math.max(12, bars.length));
    offset = clamp(offset, 0, Math.max(0, bars.length - count));
    draw();
  }
  function expanded(on) {
    root.parentElement.classList.toggle('chart-expanded', on);
    expand.setAttribute('aria-pressed', String(on));
    expand.textContent = on ? 'Collapse chart' : 'Expand chart';
  }
  expand.onclick = () => expanded(!root.parentElement.classList.contains('chart-expanded'));
  root.ondblclick = () => expand.click();
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') expanded(false);
  });
  const observer = new ResizeObserver(draw);
  function pane(name) {
    const region = document.createElement('section'),
      legend = document.createElement('small'),
      canvas = document.createElement('canvas');
    region.className = 'chart-pane';
    region.dataset.pane = name;
    legend.className = 'agentic-text-detail';
    canvas.setAttribute('aria-label', name === 'price' ? 'Candles and strategy markers' : name + ' indicator chart');
    canvas.setAttribute('role', 'img');
    region.append(legend, canvas);
    root.append(region);
    observer.observe(canvas);
    const data = { region, legend, canvas };
    panes.set(name, data);
    return data;
  }
  function draw() {
    if (!bars.length) {
      summary.textContent = 'No candles available';
      for (const { canvas, legend } of panes.values()) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        legend.textContent = '';
      }
      return;
    }
    const extent = Math.max(bars.length, ...lines.map((s) => s.values.length)),
      end = extent - offset,
      start = Math.max(0, end - count);
    const show = Array.from(
      { length: end - start },
      (_, i) => bars[start + i] ?? { time: bucket(bars.at(-1).time, frame, start + i - bars.length + 1) }
    );
    const selected = cursor ? show[clamp(Math.floor(cursor.fraction * show.length), 0, show.length - 1)] : bars.at(-1);
    if (!selected) return;
    const index = new Map(show.map((bar, i) => [bar.time, i]));
    const visible = signals.map((signal) => ({ signal, i: index.get(bucket(signal.time, frame)) }))
      .filter(({ i }) => i !== undefined);
    const markerText = (s) => s.label && s.label !== s.action ? s.action.toUpperCase() + ' · ' + s.label : s.action.toUpperCase();
    summary.textContent =
      selected.open === undefined
        ? timeFmt.format(selected.time) + ' UTC · projected indicator'
        : timeFmt.format(selected.time) +
          ' UTC · O ' +
          fmt(selected.open) +
          '   H ' +
          fmt(selected.high) +
          '   L ' +
          fmt(selected.low) +
          '   C ' +
          fmt(selected.close) +
          '   ' +
          fmt(100 * (selected.close / selected.open - 1)) +
          '%';
    if (cursor) {
      const details = visible.filter(({ i }) => show[i] === selected).map(({ signal }) =>
        markerText(signal) + ' ' + fmt(signal.price));
      if (details.length) summary.textContent += ' · ' + details.slice(0, 6).join(' / ') +
        (details.length > 6 ? ' (+' + (details.length - 6) + ')' : '');
    }
    for (const [name, { canvas, legend }] of panes) {
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      if (w < 20 || h < 20) continue;
      const ratio = Math.min(devicePixelRatio || 1, 2),
        ctx = canvas.getContext('2d');
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(canvas),
        up = style.getPropertyValue('--candle-up').trim(),
        down = style.getPropertyValue('--candle-down').trim();
      const fg = style.color,
        palette = [up, down, fg, '#8d73b2', '#6598bc', '#ad8d4a'];
      const series = lines.filter((line) => line.pane === name),
        values = series.flatMap((s) => s.values.slice(start, end).filter(Number.isFinite));
      if (name === 'price') {
        for (const b of show) if (b.open !== undefined) values.push(b.high, b.low);
        for (const { signal } of visible) values.push(signal.price);
      }
      if (series.some((s) => s.style === 'bars')) values.push(0);
      const bottom = h - (name === 'price' ? 24 : 9),
        width = Math.max(1, w - 56),
        slot = width / show.length;
      const lo = values.length ? Math.min(...values) : 0,
        hi = values.length ? Math.max(...values) : 1,
        span = hi - lo || 1;
      const y = (n) => bottom - 6 - ((n - lo) / span) * (bottom - 18),
        x = (i) => (i + 0.5) * slot;
      ctx.font = '10px ' + style.fontFamily;
      ctx.fillStyle = fg;
      for (let i = 0; i < 4; i++) {
        const n = lo + (span * i) / 3,
          yi = y(n);
        ctx.strokeStyle = fg;
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(0, yi);
        ctx.lineTo(width, yi);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(fmt(n), width + 5, yi + 3);
      }
      if (name === 'price') {
        for (const [a, b] of [
          ['Span A', 'Span B'],
          ['Hull', 'Hull lag']
        ]) {
          const upper = series.find((s) => s.name === a)?.values,
            lower = series.find((s) => s.name === b)?.values;
          if (!upper || !lower) continue;
          ctx.globalAlpha = 0.18;
          for (let i = 1; i < show.length; i++) {
            const k = start + i;
            if (![upper[k - 1], lower[k - 1], upper[k], lower[k]].every(Number.isFinite)) continue;
            ctx.fillStyle = upper[k] >= lower[k] ? up : down;
            ctx.beginPath();
            ctx.moveTo(x(i - 1), y(upper[k - 1]));
            ctx.lineTo(x(i), y(upper[k]));
            ctx.lineTo(x(i), y(lower[k]));
            ctx.lineTo(x(i - 1), y(lower[k - 1]));
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        for (let i = 0; i < show.length; i++) {
          const b = show[i],
            xi = x(i);
          if (b.open === undefined) continue;
          ctx.fillStyle = ctx.strokeStyle = b.close >= b.open ? up : down;
          ctx.beginPath();
          ctx.moveTo(xi, y(b.low));
          ctx.lineTo(xi, y(b.high));
          ctx.stroke();
          ctx.fillRect(
            xi - slot * 0.32,
            Math.min(y(b.open), y(b.close)),
            Math.max(1, slot * 0.64),
            Math.max(1, Math.abs(y(b.open) - y(b.close)))
          );
        }
        ctx.fillStyle = fg;
        for (const f of [0, 0.46, 0.82]) {
          const i = Math.floor(f * (show.length - 1));
          ctx.fillText(timeFmt.format(show[i].time), Math.max(1, Math.min(width - 85, x(i))), h - 5);
        }
      }
      series.forEach((s, k) => {
        ctx.strokeStyle = ctx.fillStyle = palette[k % palette.length];
        ctx.beginPath();
        let connected = false;
        s.values.slice(start, end).forEach((v, i) => {
          if (!Number.isFinite(v)) {
            connected = false;
            return;
          }
          if (s.style === 'bars') {
            ctx.fillStyle = show[i].close >= show[i].open ? up : down;
            ctx.fillRect(
              x(i) - slot * 0.32,
              Math.min(y(v), y(0)),
              Math.max(1, slot * 0.64),
              Math.max(1, Math.abs(y(v) - y(0)))
            );
          } else {
            if (connected) ctx.lineTo(x(i), y(v));
            else ctx.moveTo(x(i), y(v));
            connected = true;
          }
        });
        ctx.stroke();
      });
      if (name === 'price') {
        const labels = [];
        for (const { signal, i } of visible) {
          const px = x(i), py = y(signal.price), label = markerText(signal);
          ctx.fillStyle = ['buy', 'cover'].includes(signal.action) ? up :
            ['sell', 'short'].includes(signal.action) ? down : fg;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
          const size = ctx.measureText(label).width, left = clamp(px - 8, 1, Math.max(1, width - size));
          const baseline = clamp(py - 6, 12, bottom - 2);
          if (labels.some((p) => Math.abs(p.baseline - baseline) < 11 && p.left < left + size + 3 && left < p.right + 3)) continue;
          labels.push({ left, right: left + size, baseline });
          ctx.fillStyle = fg;
          ctx.fillText(label, left, baseline);
        }
      }
      if (cursor) {
        ctx.strokeStyle = fg;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(cursor.fraction * width, 1);
        ctx.lineTo(cursor.fraction * width, bottom);
        if (canvas === cursor.target) {
          ctx.moveTo(0, cursor.y);
          ctx.lineTo(width, cursor.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      legend.textContent = [name === 'price' ? 'Price · ' + currency : '', ...series.map((s) => s.name)]
        .filter(Boolean)
        .join(' / ');
    }
  }
  function pos(e) {
    const rect = e.target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  root.addEventListener(
    'wheel',
    (e) => {
      if (e.target.tagName === 'CANVAS') {
        e.preventDefault();
        zoom(count * (e.deltaY > 0 ? 1.18 : 0.85));
      }
    },
    { passive: false }
  );
  root.onpointerdown = (e) => {
    if (e.target.tagName !== 'CANVAS') return;
    e.target.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e.clientX);
    pan = { x: e.clientX, offset };
    if (pointers.size === 2) {
      const [a, b] = pointers.values();
      gesture = { distance: Math.max(1, Math.abs(a - b)), count };
    }
  };
  root.onpointermove = (e) => {
    if (e.target.tagName !== 'CANVAS') return;
    const { x, y } = pos(e),
      w = Math.max(10, e.target.clientWidth - 56);
    cursor = { fraction: clamp(x / w, 0, 0.9999), y, target: e.target };
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, e.clientX);
      if (gesture && pointers.size === 2) {
        const [a, b] = pointers.values();
        zoom((gesture.count * gesture.distance) / Math.max(1, Math.abs(a - b)));
      } else if (pan)
        offset = clamp(pan.offset + Math.round(((e.clientX - pan.x) / w) * count), 0, Math.max(0, bars.length - count));
    }
    draw();
  };
  root.onpointerup = root.onpointercancel = (e) => {
    pointers.delete(e.pointerId);
    pan = null;
    gesture = null;
  };
  root.onpointerleave = () => {
    cursor = null;
    draw();
  };
  root.onkeydown = (e) => {
    if (['ArrowLeft', 'ArrowRight', '+', '-'].includes(e.key)) {
      e.preventDefault();
      if (e.key === '+' || e.key === '-') zoom(count * (e.key === '+' ? 0.8 : 1.2));
      else offset = clamp(offset + (e.key === 'ArrowLeft' ? 5 : -5), 0, Math.max(0, bars.length - count));
      draw();
    }
  };
  return {
    update(next, selection, markers, timeframe, quoteCurrency = 'USD') {
      currency = quoteCurrency;
      frame = timeframe ?? frame;
      bars = next;
      lines = calculateStudies(bars, selection);
      signals = markers;
      const names = new Set(['price', ...lines.map((s) => s.pane)]);
      for (const [name, p] of panes)
        if (!names.has(name)) {
          observer.unobserve(p.canvas);
          p.region.remove();
          panes.delete(name);
        }
      for (const name of names) if (!panes.has(name)) pane(name);
      offset = clamp(offset, 0, Math.max(0, bars.length - count));
      draw();
    },
    reset() {
      offset = 0;
      count = 70;
      cursor = null;
    }
  };
}
