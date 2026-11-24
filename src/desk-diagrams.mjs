// Moomoo-inspired market diagrams drawn as inline SVG from the captured $0 desk rows.
// Colors consume semantic tokens (--desk-up / --desk-down, defined scoped in web/journal.css) and
// currentColor for axes/labels, so typography and palette stay owned by the Design System.
// Geometry helpers are pure and pinned by test/desk-diagrams.test.mjs; no provider call is made.
const NS = 'http://www.w3.org/2000/svg';
const UP = 'var(--desk-up)', DOWN = 'var(--desk-down)';

export function candleGeometry(candles, { width = 640, height = 220, left = 46, right = 10, top = 10, bottom = 22 } = {}) {
  const lows = candles.map(c => Number(c.low)), highs = candles.map(c => Number(c.high));
  const lo = Math.min(...lows), hi = Math.max(...highs), span = hi - lo || 1;
  const plotH = height - top - bottom, slot = (width - left - right) / candles.length;
  const y = value => top + ((hi - value) / span) * plotH;
  return {
    lo, hi, slot,
    yTicks: [0, 1, 2, 3].map(i => { const value = lo + (span * i) / 3; return { y: y(value), label: String(Math.round(value * 100) / 100) }; }),
    candles: candles.map((c, i) => {
      const open = Number(c.open), close = Number(c.close), x = left + (i + 0.5) * slot;
      return {
        x, bodyWidth: slot * 0.6, up: close >= open,
        wickTop: y(Number(c.high)), wickBottom: y(Number(c.low)),
        bodyTop: y(Math.max(open, close)), bodyHeight: Math.max(1, Math.abs(y(open) - y(close))),
        label: c.date
      };
    })
  };
}

export function depthGeometry(depth, { width = 640, height = 240, left = 10, right = 10, top = 8, bottom = 8 } = {}) {
  const rows = Math.max(depth.ask.length, depth.bid.length);
  const rowH = (height - top - bottom) / rows, center = width / 2;
  const maxVolume = Math.max(...depth.ask.map(l => l.volume), ...depth.bid.map(l => l.volume));
  const half = center - left - 40;
  const bar = (level, i, side) => {
    const w = (level.volume / maxVolume) * half;
    return { y: top + i * rowH, height: rowH * 0.72, width: w, x: side === 'bid' ? center - 40 - w : center + 40, price: level.price, volume: level.volume };
  };
  return { center, maxVolume, rowH, bids: depth.bid.map((l, i) => bar(l, i, 'bid')), asks: depth.ask.map((l, i) => bar(l, i, 'ask')) };
}

export function tapeGeometry(tape, { width = 640, height = 120, left = 10, right = 10, top = 8, bottom = 18 } = {}) {
  const maxVolume = Math.max(...tape.map(t => t.volume));
  const slot = (width - left - right) / tape.length, plotH = height - top - bottom;
  return {
    maxVolume, slot,
    bars: tape.map((t, i) => {
      const h = (t.volume / maxVolume) * plotH;
      return { x: left + i * slot + slot * 0.15, width: slot * 0.7, y: height - bottom - h, height: Math.max(1, h), up: t.direction === 'BUY', volume: t.volume };
    })
  };
}

export function mountDeskDiagrams(document) {
  const el = (name, attributes, text) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const frame = (width, height, label) => {
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, class: 'desk-diagram' });
    svg.append(el('title', {}, label));
    return svg;
  };
  const axis = (svg, geometry, width, height, bottom) => {
    for (const tick of geometry.yTicks ?? []) {
      svg.append(el('line', { x1: 46, x2: width - 10, y1: tick.y, y2: tick.y, stroke: 'currentColor', 'stroke-opacity': 0.15 }));
      svg.append(el('text', { x: width - 6, y: tick.y + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, tick.label));
    }
    svg.append(el('line', { x1: 10, x2: width - 10, y1: height - bottom, y2: height - bottom, stroke: 'currentColor', 'stroke-opacity': 0.3 }));
  };
  return {
    candles(candles) {
      const width = 640, height = 220, g = candleGeometry(candles, { width, height });
      const svg = frame(width, height, `Daily candlestick chart · ${candles.length} sessions · open/high/low/close`);
      axis(svg, g, width, height, 22);
      for (const c of g.candles) {
        const color = c.up ? UP : DOWN;
        svg.append(el('line', { x1: c.x, x2: c.x, y1: c.wickTop, y2: c.wickBottom, stroke: color, 'stroke-width': 1.5 }));
        svg.append(el('rect', { x: c.x - c.bodyWidth / 2, y: c.bodyTop, width: c.bodyWidth, height: c.bodyHeight, fill: color }));
      }
      for (const i of [0, Math.floor((g.candles.length - 1) / 2), g.candles.length - 1]) {
        svg.append(el('text', { x: g.candles[i].x, y: height - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor' }, g.candles[i].label));
      }
      return svg;
    },
    depth(depth) {
      const width = 640, height = 240, g = depthGeometry(depth, { width, height });
      const svg = frame(width, height, `Order book depth diagram · ${depth.bid.length} bid / ${depth.ask.length} ask levels · bar length is volume`);
      svg.append(el('line', { x1: g.center, x2: g.center, y1: 4, y2: height - 4, stroke: 'currentColor', 'stroke-opacity': 0.3 }));
      g.bids.forEach((b, i) => {
        svg.append(el('rect', { x: b.x, y: b.y, width: b.width, height: b.height, fill: UP, 'fill-opacity': 0.8 }));
        svg.append(el('text', { x: g.center - 44, y: b.y + b.height / 2 + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, b.price));
        const a = g.asks[i];
        svg.append(el('rect', { x: a.x, y: a.y, width: a.width, height: a.height, fill: DOWN, 'fill-opacity': 0.8 }));
        svg.append(el('text', { x: g.center + 44, y: a.y + a.height / 2 + 3, 'text-anchor': 'start', 'font-size': 10, fill: 'currentColor' }, a.price));
      });
      return svg;
    },
    tape(tape) {
      const width = 640, height = 120, g = tapeGeometry(tape, { width, height });
      const svg = frame(width, height, `Time and sales volume diagram · ${tape.length} ticks · color is trade direction`);
      svg.append(el('line', { x1: 10, x2: width - 10, y1: height - 18, y2: height - 18, stroke: 'currentColor', 'stroke-opacity': 0.3 }));
      for (const b of g.bars) svg.append(el('rect', { x: b.x, y: b.y, width: b.width, height: b.height, fill: b.up ? UP : DOWN, 'fill-opacity': 0.85 }));
      svg.append(el('text', { x: 10, y: height - 5, 'font-size': 10, fill: 'currentColor' }, `max tick volume ${g.maxVolume}`));
      return svg;
    }
  };
}