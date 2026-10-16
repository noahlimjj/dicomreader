// Items (one per image frame), series grouping, pixel spacing and window presets.
import {cross, dot} from './geometry.js';

export const PROJECTION = ['DX', 'CR', 'MG', 'XA', 'RF', 'IO', 'PX', 'DF', 'RG'];

export function capitalize(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function formatDate(da) {
  if (!/^\d{8}$/.test(da || '')) return da || '';
  return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
}

export function formatAge(as) {
  const m = /^(\d{3})([DWMY])$/.exec(as || '');
  if (!m) return as || '';
  return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
}

// e.g. ",,Axial,5.000,Axial,head/Axial.12" -> "Head · Axial · 5 mm"
export function cleanDescription(desc) {
  const words = [];
  let thickness = '';
  for (let tok of (desc || '').split(',')) {
    tok = tok.trim().split('/')[0].trim();
    if (!tok) continue;
    if (/^\d+(\.\d+)?$/.test(tok)) {
      if (!thickness) thickness = `${parseFloat(tok)} mm`;
      continue;
    }
    if (!words.some((w) => w.toLowerCase() === tok.toLowerCase())) words.push(tok);
  }
  // body part (lower-case word) first, then plane etc.
  words.sort((a, b) => (b === b.toLowerCase()) - (a === a.toLowerCase()));
  return [...words.map(capitalize), thickness].filter(Boolean).join(' · ');
}

/** one item per frame, with per-frame geometry folded in */
export function makeItems(entry, meta) {
  const {file, perFrame} = meta;
  const items = [];
  for (let f = 0; f < file.frames; ++f) {
    const it = {...file, ...perFrame[f]};
    it.entry = entry;
    it.frame = f;
    it.id = `${entry.key}#${f}`;
    it.name = entry.name;
    it.seriesUid = file.seriesUid || entry.name;
    it.hasGeometry = !!(it.ipp && it.iop);
    it.orientation = it.iop ? it.iop.map((v) => Math.round(v * 100) / 100).join(',') : '';
    it.sopFrame = file.frames > 1 ? `${file.sop}#${f}` : file.sop;
    items.push(it);
  }
  return items;
}

function sortItems(list) {
  // acquisition order: instance number, then frame; position along the normal
  // when instance numbers are missing or equal
  const n = list[0].hasGeometry ? cross(list[0].iop.slice(0, 3), list[0].iop.slice(3, 6)) : null;
  const pos = (it) => (n && it.hasGeometry ? dot(it.ipp, n) : 0);
  list.sort((a, b) =>
    (a.instanceNumber || 0) - (b.instanceNumber || 0) ||
    (a.frame - b.frame) ||
    (pos(a) - pos(b)) ||
    a.name.localeCompare(b.name));
}

function makeSeries(list, extra = {}) {
  sortItems(list);
  const f = list[0];
  let title = cleanDescription(f.seriesDesc);
  if (f.imageType.includes('LOCALIZER')) title = 'Scout / localizer';
  if (!title) title = f.protocol || '';
  if (!title && PROJECTION.includes(f.modality) && f.bodyPart) title = `${capitalize(f.bodyPart.toLowerCase())} X-ray`;
  if (!title) title = f.bodyPart ? capitalize(f.bodyPart.toLowerCase()) : `Series ${Number.isFinite(f.seriesNumber) ? f.seriesNumber : ''}`.trim();
  return {
    title,
    items: list,
    first: f,
    images: list.length,
    stacked: false,
    ...extra,
  };
}

export function groupSeries(items) {
  const bySeries = new Map();
  for (const it of items) {
    if (!bySeries.has(it.seriesUid)) bySeries.set(it.seriesUid, []);
    bySeries.get(it.seriesUid).push(it);
  }
  const series = [];
  for (const all of bySeries.values()) {
    const parts = [];
    const bySize = new Map();
    for (const it of all) {
      const key = `${it.rows}x${it.cols}`;
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push(it);
    }
    for (const list of bySize.values()) {
      const byOrient = new Map();
      for (const it of list) {
        if (!byOrient.has(it.orientation)) byOrient.set(it.orientation, []);
        byOrient.get(it.orientation).push(it);
      }
      const subs = [...byOrient.values()].sort((a, b) => b.length - a.length);
      if (subs.length > 1 && (subs.length >= 3 || subs[0].length / list.length < 0.5) &&
          list.every((it) => it.hasGeometry)) {
        // several small, differently angled groups (e.g. spine MR axials per
        // disc level): one scrollable stack
        parts.push(makeSeries(list, {stacked: true}));
      } else {
        for (const sub of subs) parts.push(makeSeries(sub));
      }
    }
    parts.sort((a, b) => b.images - a.images);
    // odd ones out next to a main volume are reference / scout images
    if (parts.length > 1) {
      for (const p of parts.slice(1)) {
        if (p.images <= 2 && parts[0].images > 2) p.isReference = true;
      }
    }
    series.push(...parts);
  }

  // make identical titles within a study distinguishable
  const byTitle = new Map();
  for (const s of series) {
    const key = `${s.first.studyUid}|${s.title}|${!!s.isReference}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }
  for (const dupes of byTitle.values()) {
    if (dupes.length < 2) continue;
    for (const s of dupes) {
      const f = s.first;
      const w = f.windowWidth?.[0];
      if (f.modality === 'CT' && w <= 200) s.title += ' (brain window)';
      else if (f.modality === 'CT' && w >= 1500) s.title += ' (bone window)';
      else if (f.kernel) s.title += ` (${f.kernel})`;
    }
    const titles = new Set(dupes.map((s) => s.title));
    if (titles.size < dupes.length) dupes.forEach((s, i) => { s.title += ` #${i + 1}`; });
  }
  for (const s of series) {
    if (s.isReference) s.title += s.images === 1 ? ' · reference image' : ' · reference images';
    s.key = `${s.first.seriesUid}|${s.first.rows}x${s.first.cols}|${s.stacked ? 'stack' : s.first.orientation}`;
  }

  series.sort((a, b) =>
    (b.first.studyDate + b.first.studyTime).localeCompare(a.first.studyDate + a.first.studyTime) ||
    a.first.studyUid.localeCompare(b.first.studyUid) ||
    (a.first.seriesNumber || 0) - (b.first.seriesNumber || 0) ||
    (a.isReference ? 1 : 0) - (b.isReference ? 1 : 0) ||
    (a.first.instanceNumber || 0) - (b.first.instanceNumber || 0));
  return series;
}

/**
 * The best series to show next to another one: same patient space (frame of
 * reference) in a different plane, e.g. sagittal next to axial.
 */
export function companionSeries(all, index) {
  const s = all[index];
  const n = normalOf(s.first);
  let best = -1;
  let bestScore = -Infinity;
  all.forEach((c, i) => {
    if (i === index) return;
    let score = 0;
    if (c.first.studyUid === s.first.studyUid) score += 1;
    if (s.first.frameOfRef && c.first.frameOfRef === s.first.frameOfRef) score += 2;
    const m = normalOf(c.first);
    if (n && m && Math.abs(dot(n, m)) < 0.5) score += 4; // different plane
    if (c.first.modality === s.first.modality) score += 1;
    if (c.isReference) score -= 5;
    score += Math.min(c.images, 100) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best >= 0 ? best : index;
}

function normalOf(it) {
  return it && it.hasGeometry ? cross(it.iop.slice(0, 3), it.iop.slice(3, 6)) : null;
}

/**
 * The pixel spacing used for measurements, [row, column] in mm, and what it
 * means (patient plane, detector, user calibration...).
 */
export function spacingInfo(s, calibrations = {}) {
  const f = s.first;
  const cal = calibrations[s.key];
  if (cal) {
    return {spacing: cal.spacing, kind: 'user', label: `calibrated by you (${cal.note})`};
  }
  const projection = PROJECTION.includes(f.modality);
  const isSecondary = (f.sopClass || '').startsWith('1.2.840.10008.5.1.4.1.1.7');
  if (f.pixelSpacing) {
    if (isSecondary) {
      return {spacing: f.pixelSpacing, kind: 'secondary', label: 'this is a secondary capture (a picture of a report or screen); its pixel size may be copied from another image, so do not rely on these mm values'};
    }
    if (projection) {
      const sameAsDetector = f.imagerSpacing &&
        Math.abs(f.imagerSpacing[0] - f.pixelSpacing[0]) < 1e-6 &&
        Math.abs(f.imagerSpacing[1] - f.pixelSpacing[1]) < 1e-6;
      if (f.calibrationType || (f.imagerSpacing && !sameAsDetector)) {
        return {spacing: f.pixelSpacing, kind: 'patient', label: 'calibrated by the scanner'};
      }
      return {spacing: f.pixelSpacing, kind: 'detector',
        label: 'at the detector: X-ray magnification not corrected (anatomy is usually 5–15 % smaller)'};
    }
    return {spacing: f.pixelSpacing, kind: 'patient', label: 'patient plane'};
  }
  if (f.imagerSpacing) {
    let m = f.magnification;
    if (!(m > 0) && f.sid > 0 && f.sod > 0) m = f.sid / f.sod;
    if (m > 0) {
      return {spacing: f.imagerSpacing.map((v) => v / m), kind: 'patient',
        label: `corrected for ${((m - 1) * 100).toFixed(1)} % magnification`};
    }
    return {spacing: f.imagerSpacing, kind: 'detector',
      label: 'at the detector: X-ray magnification not corrected (anatomy is usually 5–15 % smaller)'};
  }
  return {spacing: null, kind: 'none', label: 'no calibration in the file: measuring in pixels'};
}

/** display aspect of a pixel (height / width) */
export function pixelAspect(it) {
  if (it.pixelSpacing) return it.pixelSpacing[0] / it.pixelSpacing[1];
  if (it.imagerSpacing) return it.imagerSpacing[0] / it.imagerSpacing[1];
  const ar = (it.aspectRatio || '').split('\\').map(parseFloat);
  if (ar.length === 2 && ar[0] > 0 && ar[1] > 0) return ar[0] / ar[1];
  return 1;
}

const CT_PRESETS = [
  {name: 'Soft tissue', center: 40, width: 400},
  {name: 'Lung', center: -600, width: 1500},
  {name: 'Bone', center: 400, width: 1800},
  {name: 'Brain', center: 40, width: 80},
  {name: 'Subdural', center: 75, width: 215},
  {name: 'Stroke', center: 32, width: 40},
  {name: 'Liver', center: 60, width: 150},
  {name: 'Mediastinum', center: 50, width: 350},
  {name: 'Angio', center: 300, width: 600},
];

/** window presets for an item: scanner defaults first, CT presets, full range */
export function windowPresets(it) {
  const out = [];
  const wc = it.windowCenter || [];
  const ww = it.windowWidth || [];
  for (let i = 0; i < Math.min(wc.length, ww.length); ++i) {
    if (!(ww[i] >= 1)) continue;
    const explanation = it.windowExplanation?.[i];
    out.push({
      name: explanation && !/^\s*$/.test(explanation) ? `${capitalize(explanation.toLowerCase())} (scanner)` : (i === 0 ? 'Scanner default' : `Scanner default ${i + 1}`),
      center: wc[i],
      width: ww[i],
      fromFile: true,
    });
  }
  if (it.modality === 'CT') out.push(...CT_PRESETS);
  out.push({name: 'Full range', auto: 'minmax'});
  out.push({name: 'Auto (contrast stretch)', auto: 'percentile'});
  return out;
}
