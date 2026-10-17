// Patient space geometry: image planes, reference line intersections.
// Pixel coordinates here are pixel *indices* (pixel centres at integers).

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function imageNormal(it) {
  return it && it.hasGeometry ? cross(it.iop.slice(0, 3), it.iop.slice(3, 6)) : null;
}

/** plane of an item in patient space, or null */
export function planeOf(it) {
  if (!it || !it.hasGeometry || !it.pixelSpacing) return null;
  const row = it.iop.slice(0, 3);
  const col = it.iop.slice(3, 6);
  return {
    it,
    origin: it.ipp,
    row,
    col,
    normal: cross(row, col),
    rowSpacing: it.pixelSpacing[0], // between rows (along col)
    colSpacing: it.pixelSpacing[1], // between columns (along row)
    frame: it.frameOfRef,
  };
}

export const sameSpace = (p, q) =>
  !!(p && q && ((p.frame && p.frame === q.frame) || (!p.frame && !q.frame && p.it?.studyUid && p.it.studyUid === q.it?.studyUid)));

/** pixel (x = column, y = row) -> patient point */
export function pixelToPatient(p, x, y) {
  return [0, 1, 2].map((k) => p.origin[k] + x * p.colSpacing * p.row[k] + y * p.rowSpacing * p.col[k]);
}

/** patient point -> pixel coordinates in plane p, and distance to the plane */
export function patientToPixel(p, point) {
  const d = [0, 1, 2].map((k) => point[k] - p.origin[k]);
  return {x: dot(d, p.row) / p.colSpacing, y: dot(d, p.col) / p.rowSpacing, dist: dot(d, p.normal)};
}

/** Segment (pixel coordinates of plane p) where plane q cuts the image of p. */
export function intersection(p, q) {
  const it = p.it;
  const a = dot(q.normal, p.row) * p.colSpacing;
  const b = dot(q.normal, p.col) * p.rowSpacing;
  const c = dot(q.normal, [0, 1, 2].map((k) => p.origin[k] - q.origin[k]));
  if (Math.hypot(a / p.colSpacing, b / p.rowSpacing) < 0.2) return null; // (nearly) parallel planes
  // a*x + b*y + c = 0, clipped to the image rectangle
  const x0 = -0.5;
  const x1 = it.cols - 0.5;
  const y0 = -0.5;
  const y1 = it.rows - 0.5;
  const pts = [];
  if (Math.abs(b) > 1e-9) {
    for (const x of [x0, x1]) {
      const y = -(a * x + c) / b;
      if (y >= y0 - 1e-6 && y <= y1 + 1e-6) pts.push([x, y]);
    }
  }
  if (Math.abs(a) > 1e-9) {
    for (const y of [y0, y1]) {
      const x = -(b * y + c) / a;
      if (x >= x0 - 1e-6 && x <= x1 + 1e-6) pts.push([x, y]);
    }
  }
  if (pts.length < 2) return null;
  let best = [pts[0], pts[1]];
  let bestD = -1;
  for (let i = 0; i < pts.length; ++i) {
    for (let j = i + 1; j < pts.length; ++j) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d > bestD) {
        bestD = d;
        best = [pts[i], pts[j]];
      }
    }
  }
  return bestD > 0.5 ? best : null;
}

/** index of the slice of a series closest to a point, or -1 */
export function nearestSlice(series, point, {clamp = false} = {}) {
  let best = -1;
  let bestD = Infinity;
  series.items.forEach((it, i) => {
    const p = planeOf(it);
    if (!p) return;
    const d = Math.abs(patientToPixel(p, point).dist);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (clamp && best >= 0) return best;
  const thick = series.first.thickness || series.first.spacing || 5;
  return bestD <= Math.max(thick, 5) ? best : -1;
}


/** orientation letters for a patient space direction (LPS) */
export function directionLetters(dir) {
  const parts = [
    [dir[0], 'L', 'R'],
    [dir[1], 'P', 'A'],
    [dir[2], 'S', 'I'],
  ].filter(([c]) => Math.abs(c) > 0.3).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return parts.map(([c, pos, neg]) => (c > 0 ? pos : neg)).join('');
}

const PO_OPPOSITE = {L: 'R', R: 'L', A: 'P', P: 'A', H: 'F', F: 'H', S: 'I', I: 'S'};

/**
 * Patient direction letters for a direction on screen, given as a pixel
 * direction (dx along columns, dy along rows) in the image.
 */
export function lettersForPixelDirection(it, dx, dy) {
  if (it.iop) {
    const row = it.iop.slice(0, 3);
    const col = it.iop.slice(3, 6);
    const cs = it.pixelSpacing ? it.pixelSpacing[1] : 1;
    const rs = it.pixelSpacing ? it.pixelSpacing[0] : 1;
    const d = [0, 1, 2].map((k) => dx * cs * row[k] + dy * rs * col[k]);
    const len = Math.hypot(...d) || 1;
    return directionLetters(d.map((c) => c / len));
  }
  const po = (it.patientOrientation || '').split('\\');
  if (po.length === 2 && po[0] && po[1]) {
    const opp = (t) => [...t].map((c) => PO_OPPOSITE[c] || c).join('');
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? po[0] : opp(po[0]);
    return dy > 0 ? po[1] : opp(po[1]);
  }
  return '';
}
