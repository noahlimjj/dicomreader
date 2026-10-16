// Measurements: data, quantification, drawing and hit testing.
// Points are continuous image coordinates (pixel i covers [i, i + 1]).

export const MEASURE_TOOLS = {
  length: {label: 'Distance', points: 2},
  angle: {label: 'Angle', points: 3},
  ellipse: {label: 'Ellipse', points: 2},
  rect: {label: 'Rectangle', points: 2},
  arrow: {label: 'Arrow', points: 2},
};

const COLOUR = '#ffd84d';
const SELECTED = '#5ad1ff';

let nextId = 1;
export function newMeasurement(type, ref, points) {
  return {id: `m${nextId++}`, type, ...ref, points};
}

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}

/** physical length of a segment; spacing [row, col] in mm or null (pixels) */
export function segmentLength(a, b, spacing) {
  const cs = spacing ? spacing[1] : 1;
  const rs = spacing ? spacing[0] : 1;
  return Math.hypot((b[0] - a[0]) * cs, (b[1] - a[1]) * rs);
}

function angleAt(a, v, c, spacing) {
  const cs = spacing ? spacing[1] : 1;
  const rs = spacing ? spacing[0] : 1;
  const u = [(a[0] - v[0]) * cs, (a[1] - v[1]) * rs];
  const w = [(c[0] - v[0]) * cs, (c[1] - v[1]) * rs];
  const d = Math.hypot(...u) * Math.hypot(...w);
  if (!d) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / d))) * 180) / Math.PI;
}

function roiStats(m, image, it) {
  if (!image || image.kind !== 'mono') return null;
  const [p, q] = m.points;
  const x0 = Math.min(p[0], q[0]);
  const x1 = Math.max(p[0], q[0]);
  const y0 = Math.min(p[1], q[1]);
  const y1 = Math.max(p[1], q[1]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  let min = Infinity;
  let max = -Infinity;
  const W = image.width;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(image.height, Math.ceil(y1)); ++y) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); ++x) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      if (m.type === 'ellipse' && rx > 0 && ry > 0 &&
        ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 > 1) continue;
      const v = image.data[y * W + x] * it.slope + it.intercept;
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return {n, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), min, max};
}

/**
 * Text describing a measurement.
 * @returns {{kind: string, rows: Array<[string, boolean]>, length?: number, unit?: string}}
 */
export function quantify(m, it, image, spacing) {
  const unit = spacing ? 'mm' : 'px';
  const [a, b, c] = m.points;
  switch (m.type) {
  case 'length': {
    const len = segmentLength(a, b, spacing);
    return {kind: 'Distance', rows: [[`${fmt(len, spacing ? 2 : 1)} ${unit}`, true]], length: len, unit};
  }
  case 'arrow':
    return {kind: 'Arrow', rows: []};
  case 'angle': {
    if (!c) return {kind: 'Angle', rows: [['tap the third point', false]]};
    return {kind: 'Angle', rows: [[`${fmt(angleAt(a, b, c, spacing), 1)}°`, true]]};
  }
  case 'ellipse':
  case 'rect': {
    const w = Math.abs(b[0] - a[0]) * (spacing ? spacing[1] : 1);
    const h = Math.abs(b[1] - a[1]) * (spacing ? spacing[0] : 1);
    let area = m.type === 'ellipse' ? (Math.PI * w * h) / 4 : w * h;
    let areaUnit = spacing ? 'mm²' : 'px²';
    if (spacing && area >= 100) {
      area /= 100;
      areaUnit = 'cm²';
    }
    const rows = [[`Area ${fmt(area, 2)} ${areaUnit}`, true]];
    rows.push([`${fmt(w, 1)} × ${fmt(h, 1)} ${unit}`, false]);
    const st = roiStats(m, image, it);
    const pu = it.modality === 'CT' && /HU|^$/.test(it.rescaleType || '') ? ' HU' : '';
    if (st) {
      rows.push([`Mean ${fmt(st.mean, 1)}${pu} · SD ${fmt(st.sd, 1)}`, false]);
      rows.push([`Min ${fmt(st.min, 0)} · Max ${fmt(st.max, 0)}${pu}`, false]);
    }
    return {kind: m.type === 'ellipse' ? 'Ellipse' : 'Rectangle', rows, stats: st};
  }
  default:
    return {kind: m.type, rows: []};
  }
}

// ---------------------------------------------------------------------------
// drawing (ctx in CSS pixels; toScreen maps image -> CSS pixel coordinates)

function label(ctx, text, x, y, colour) {
  const lines = text.split('\n').filter(Boolean);
  if (!lines.length) return;
  ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
  const h = lines.length * 16 + 6;
  const W = ctx.canvas.width / (ctx.getTransform().a || 1);
  const H = ctx.canvas.height / (ctx.getTransform().d || 1);
  const lx = Math.max(2, Math.min(W - w - 2, x));
  const ly = Math.max(2, Math.min(H - h - 2, y));
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(lx, ly, w, h, 4) : ctx.rect(lx, ly, w, h);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, lx + 5, ly + 4 + i * 16));
}

function handle(ctx, p, colour, big) {
  ctx.beginPath();
  ctx.arc(p[0], p[1], big ? 7 : 4, 0, Math.PI * 2);
  ctx.fillStyle = big ? 'rgba(0,0,0,0.35)' : colour;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

export function drawMeasurement(ctx, m, toScreen, text, {selected, touch, number}) {
  const colour = selected ? SELECTED : COLOUR;
  const pts = m.points.map((p) => toScreen(p[0], p[1]));
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = colour;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 2;
  ctx.beginPath();
  let anchor = pts[pts.length - 1];
  if (m.type === 'length' || m.type === 'arrow') {
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.stroke();
    if (m.type === 'arrow') {
      const [a, b] = pts;
      const ang = Math.atan2(a[1] - b[1], a[0] - b[0]);
      ctx.beginPath();
      for (const s of [-1, 1]) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(a[0] - 14 * Math.cos(ang + s * 0.45), a[1] - 14 * Math.sin(ang + s * 0.45));
      }
      ctx.stroke();
    } else {
      // end ticks
      const [a, b] = pts;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
      ctx.beginPath();
      for (const p of [a, b]) {
        ctx.moveTo(p[0] - 5 * Math.cos(ang), p[1] - 5 * Math.sin(ang));
        ctx.lineTo(p[0] + 5 * Math.cos(ang), p[1] + 5 * Math.sin(ang));
      }
      ctx.stroke();
    }
    anchor = pts[0][0] > pts[1][0] ? pts[0] : pts[1];
  } else if (m.type === 'angle') {
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    if (pts[2]) ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.stroke();
    anchor = pts[1];
  } else if (m.type === 'ellipse' || m.type === 'rect') {
    // the shape is axis aligned in image space: draw it through the transform
    const corners = [
      m.points[0], [m.points[1][0], m.points[0][1]], m.points[1], [m.points[0][0], m.points[1][1]],
    ].map((p) => toScreen(p[0], p[1]));
    if (m.type === 'rect') {
      ctx.moveTo(corners[0][0], corners[0][1]);
      for (const c of corners.slice(1)) ctx.lineTo(c[0], c[1]);
      ctx.closePath();
    } else {
      const cx = (m.points[0][0] + m.points[1][0]) / 2;
      const cy = (m.points[0][1] + m.points[1][1]) / 2;
      const rx = Math.abs(m.points[1][0] - m.points[0][0]) / 2;
      const ry = Math.abs(m.points[1][1] - m.points[0][1]) / 2;
      for (let k = 0; k <= 64; ++k) {
        const t = (k / 64) * Math.PI * 2;
        const p = toScreen(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
        if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      if (selected) {
        ctx.stroke();
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.moveTo(corners[0][0], corners[0][1]);
        for (const c of corners.slice(1)) ctx.lineTo(c[0], c[1]);
        ctx.closePath();
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    anchor = corners.reduce((best, c) => (c[0] + c[1] > best[0] + best[1] ? c : best), corners[0]);
  }
  ctx.shadowBlur = 0;
  if (selected) for (const p of pts) handle(ctx, p, colour, touch);
  const title = number ? `#${number} ` : '';
  if (text) label(ctx, title + text, anchor[0] + 10, anchor[1] + 6, colour);
  ctx.restore();
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Measurement under a screen point: {m, handle} (handle = point index or -1
 * for the shape itself), or null.
 */
export function hitTest(list, screenPoint, toScreen, radius) {
  let best = null;
  let bestD = Infinity;
  for (const m of list) {
    const pts = m.points.map((p) => toScreen(p[0], p[1]));
    pts.forEach((p, i) => {
      const d = Math.hypot(p[0] - screenPoint[0], p[1] - screenPoint[1]);
      if (d < radius && d < bestD) {
        bestD = d;
        best = {m, handle: i};
      }
    });
  }
  if (best) return best;
  for (const m of list) {
    let d = Infinity;
    if (m.type === 'ellipse' || m.type === 'rect') {
      const xs = [m.points[0][0], m.points[1][0]];
      const ys = [m.points[0][1], m.points[1][1]];
      const corners = [[xs[0], ys[0]], [xs[1], ys[0]], [xs[1], ys[1]], [xs[0], ys[1]]].map((p) => toScreen(p[0], p[1]));
      for (let i = 0; i < 4; ++i) d = Math.min(d, distToSegment(screenPoint, corners[i], corners[(i + 1) % 4]));
      // inside counts too for small shapes
      const inside = insidePolygon(screenPoint, corners);
      if (inside) d = Math.min(d, radius / 2);
    } else {
      const pts = m.points.map((p) => toScreen(p[0], p[1]));
      for (let i = 0; i + 1 < pts.length; ++i) d = Math.min(d, distToSegment(screenPoint, pts[i], pts[i + 1]));
    }
    if (d < radius * 0.7 && d < bestD) {
      bestD = d;
      best = {m, handle: -1};
    }
  }
  return best;
}

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
