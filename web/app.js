// DICOM viewer built on dwv (https://github.com/ivmartel/dwv, GPL-3.0).
import * as dwv from './vendor/dwv/dwv.min.js';
import {walk, withValues, rawValue, decodeIso2022} from './dicom.js';

dwv.logger.level = dwv.logger.levels.ERROR;

const $ = (id) => document.getElementById(id);
const PIXEL_DATA = new dwv.Tag('7FE0', '0010');
const PROJECTION = ['DX', 'CR', 'MG', 'XA', 'RF', 'IO', 'PX', 'DF', 'RG'];

const TOOLS = {
  WindowLevel: {dwv: 'WindowLevel'},
  ZoomAndPan: {dwv: 'ZoomAndPan'},
  Scroll: {dwv: 'Scroll'},
  Ruler: {dwv: 'Draw', shape: 'Ruler'},
  Protractor: {dwv: 'Draw', shape: 'Protractor'},
  Ellipse: {dwv: 'Draw', shape: 'Ellipse'},
  Rectangle: {dwv: 'Draw', shape: 'Rectangle'},
  Arrow: {dwv: 'Draw', shape: 'Arrow'},
  Ratio: {dwv: 'Draw', shape: 'Ruler'},
};

// One dwv app per viewport; the second one is used by the 2-view layout.
const VIEWPORTS = [0, 1].map((index) => ({
  index,
  divId: `layerGroup${index}`,
  app: null,
  series: -1, // index into state.series
  loaded: false,
  flip: false, // dwv index order is the reverse of the instance order
}));

const state = {
  series: [],
  layout: 1, // number of viewports shown
  active: 0, // active viewport
  sync: true, // scroll parallel series together
  allLevels: loadPref('allLevels', true), // show every slice of the other view as a faint line
  locator: null, // 3D point picked with a double-click
  ratio: {a: null, b: null}, // distance annotation uids
  tool: 'WindowLevel',
  sopIndex: new Map(),
  probe: null,
  selected: null, // uid of the selected measurement
  panel: null, // 'measure' | 'tags' | null
  calibrations: loadCalibrations(),
  smooth: loadPref('smooth', true), // interpolated display (looks only, measurements unaffected)
};

// ---------------------------------------------------------------------------
// formatting helpers

function tagValue(elements, key) {
  const el = elements[key];
  if (!el || el.value === undefined || el.value === null) return '';
  const vals = Array.isArray(el.value) ? el.value : [el.value];
  return vals
    .map((v) => (typeof v === 'object' && v !== null ? '' : String(v)))
    .join('\\')
    .trim();
}

function formatName(pn) {
  if (!pn) return '';
  const groups = pn.split('=').map((g) => g.replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(groups)].join(' / ');
}

function formatDate(da) {
  if (!/^\d{8}$/.test(da)) return da || '';
  return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
}

function formatAge(as) {
  const m = /^(\d{3})([DWMY])$/.exec(as || '');
  if (!m) return as || '';
  return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
}

function capitalize(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// e.g. ",,Axial,5.000,Axial,head/Axial.12" -> "Head · Axial · 5 mm"
function cleanDescription(desc) {
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}

// ---------------------------------------------------------------------------
// reading files

function parseHeader(buffer) {
  const parser = new dwv.DicomParser();
  parser.parse(buffer, PIXEL_DATA);
  return parser.getDicomElements();
}

function numbers(text) {
  return text.split('\\').map(parseFloat);
}

function makeItem(name, buffer) {
  const el = parseHeader(buffer);
  if (tagValue(el, '00020002') === '1.2.840.10008.1.3.10') return null; // DICOMDIR
  if (!el['00280010']) return null; // no image (report, SR, ...)
  const info = walk(buffer);
  const charset = tagValue(el, '00080005');
  const t = (key) => tagValue(el, key);
  // text that may need Japanese decoding
  const text = (key) => {
    if (/ISO 2022/.test(charset) && info) {
      const raw = rawValue(buffer, info, key);
      if (raw) return decodeIso2022(raw);
    }
    return t(key);
  };
  const ps = numbers(t('00280030'));
  const ips = numbers(t('00181164'));
  return {
    name,
    buffer,
    elements: el,
    info,
    charset,
    text,
    sop: t('00080018'),
    studyUid: t('0020000D') || 'unknown-study',
    seriesUid: t('0020000E') || name,
    modality: t('00080060') || 'OT',
    sopClass: t('00080016'),
    seriesDesc: text('0008103E'),
    studyDesc: text('00081030'),
    bodyPart: t('00180015'),
    protocol: text('00181030'),
    seriesNumber: parseInt(t('00200011'), 10),
    instanceNumber: parseInt(t('00200013'), 10),
    studyDate: t('00080020'),
    studyTime: t('00080030'),
    seriesDate: t('00080021'),
    rows: parseInt(t('00280010'), 10),
    cols: parseInt(t('00280011'), 10),
    iop: numbers(t('00200037')),
    ipp: numbers(t('00200032')),
    orientation: t('00200037').split('\\').map((v) => Math.round(parseFloat(v) * 100) / 100).join(','),
    patientOrientation: t('00200020'),
    frames: parseInt(t('00280008'), 10) || 1,
    imageType: t('00080008').toUpperCase(),
    kernel: t('00181210'),
    windowWidth: parseFloat(t('00281051').split('\\')[0]),
    thickness: parseFloat(t('00180050')),
    spacing: parseFloat(t('00180088')),
    hasGeometry: numbers(t('00200032')).length === 3 && numbers(t('00200037')).length === 6,
    frameOfRef: t('00200052'),
    pixelSpacing: ps.length === 2 && ps.every((v) => v > 0) ? ps : null,
    aspectRatio: t('00280034'),
    imagerSpacing: ips.length === 2 && ips.every((v) => v > 0) ? ips : null,
    magnification: parseFloat(t('00181114')),
    sid: parseFloat(t('00181110')),
    sod: parseFloat(t('00181111')),
    calibrationType: t('00280A02'),
    patientName: formatName(text('00100010')),
    patientId: t('00100020'),
    birthDate: t('00100030'),
    sex: t('00100040'),
    age: t('00101010'),
    institution: text('00080080'),
  };
}

async function pool(tasks, limit, onDone) {
  let next = 0;
  let done = 0;
  const results = new Array(tasks.length);
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        console.warn('Skipping file', e);
        results[i] = null;
      }
      onDone(++done, tasks.length);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, tasks.length)}, worker));
  return results;
}

async function indexFromServer() {
  const res = await fetch('api/files');
  if (!res.ok) throw new Error('Could not list files');
  const {files} = await res.json();
  if (!files.length) return null;
  setEmpty(`Reading ${files.length} files…`, 0);
  const tasks = files.map((f) => async () => {
    const r = await fetch('data/' + f.path.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.path}`);
    return makeItem(f.path, await r.arrayBuffer());
  });
  const items = await pool(tasks, 8, (d, n) => setEmpty(`Reading files… ${d} / ${n}`, d / n));
  return items.filter(Boolean);
}

async function indexFromFiles(fileList) {
  const files = Array.from(fileList).filter((f) =>
    !f.name.startsWith('.') && f.name.toUpperCase() !== 'DICOMDIR' && f.size > 132);
  setEmpty(`Reading ${files.length} files…`, 0);
  const tasks = files.map((f) => async () => {
    const head = new Uint8Array(await f.slice(128, 132).arrayBuffer());
    if (String.fromCharCode(...head) !== 'DICM') return null;
    return makeItem(f.webkitRelativePath || f.name, await f.arrayBuffer());
  });
  const items = await pool(tasks, 8, (d, n) => setEmpty(`Reading files… ${d} / ${n}`, d / n));
  return items.filter(Boolean);
}

// ---------------------------------------------------------------------------
// series grouping

function makeSeries(list, extra = {}) {
  list.sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0));
  const f = list[0];
  let title = cleanDescription(f.seriesDesc);
  if (f.imageType.includes('LOCALIZER')) title = 'Scout / localizer';
  if (!title) title = f.protocol || '';
  if (!title && PROJECTION.includes(f.modality) && f.bodyPart) title = `${capitalize(f.bodyPart.toLowerCase())} X-ray`;
  if (!title) title = f.bodyPart ? capitalize(f.bodyPart.toLowerCase()) : `Series ${f.seriesNumber || ''}`.trim();
  return {
    title,
    items: list,
    first: f,
    images: list.reduce((n, it) => n + it.frames, 0),
    stacked: false,
    ...extra,
  };
}

function groupSeries(items) {
  // dwv needs every slice of one volume to share size and orientation
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
      if (f.modality === 'CT' && f.windowWidth <= 200) s.title += ' (brain window)';
      else if (f.modality === 'CT' && f.windowWidth >= 1500) s.title += ' (bone window)';
      else if (f.kernel) s.title += ` (${f.kernel})`;
    }
    const titles = new Set(dupes.map((s) => s.title));
    if (titles.size < dupes.length) dupes.forEach((s, i) => { s.title += ` #${i + 1}`; });
  }
  for (const s of series) {
    if (s.isReference) s.title += s.images === 1 ? ' · reference image' : ' · reference images';
    s.key = `${s.first.seriesUid}|${s.first.rows}x${s.first.cols}|${s.first.orientation}|${s.stacked}`;
  }

  series.sort((a, b) =>
    (b.first.studyDate + b.first.studyTime).localeCompare(a.first.studyDate + a.first.studyTime) ||
    a.first.studyUid.localeCompare(b.first.studyUid) ||
    (a.first.seriesNumber || 0) - (b.first.seriesNumber || 0) ||
    (a.isReference ? 1 : 0) - (b.isReference ? 1 : 0) ||
    (a.first.instanceNumber || 0) - (b.first.instanceNumber || 0));
  return series;
}

// ---------------------------------------------------------------------------
// pixel spacing / calibration

/**
 * The pixel spacing dwv will use for this image, [row, column] in mm, and
 * what it means. Mirrors dwv's own lookup order.
 */
function spacingInfo(s) {
  const f = s.first;
  const cal = state.calibrations[s.key];
  if (cal) {
    return {spacing: cal.spacing, kind: 'user', label: `calibrated by you (${cal.note})`};
  }
  const projection = PROJECTION.includes(f.modality);
  const isSecondary = f.sopClass.startsWith('1.2.840.10008.5.1.4.1.1.7');
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

function loadPref(name, fallback) {
  try {
    const v = localStorage.getItem(`dicomViewer.${name}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function savePref(name, value) {
  try {
    localStorage.setItem(`dicomViewer.${name}`, JSON.stringify(value));
  } catch {
    // not available: preference lasts for this session
  }
}

function loadCalibrations() {
  try {
    return JSON.parse(localStorage.getItem('dicomViewer.calibrations') || '{}');
  } catch {
    return {};
  }
}

function saveCalibrations() {
  try {
    localStorage.setItem('dicomViewer.calibrations', JSON.stringify(state.calibrations));
  } catch {
    // private mode etc.: calibration then lasts for this session only
  }
}

// Buffer handed to dwv for one item of a series: a copy (dwv may transfer it
// to its decoder workers) with geometry / spacing adjusted when needed.
function bufferFor(s, item, index) {
  const values = {};
  const identity = '1\\0\\0\\0\\1\\0';
  if (s.stacked) {
    // re-position the angled slices onto a simple stack in instance order.
    // In-plane pixels and pixel spacing are untouched.
    const step = s.first.spacing || s.first.thickness || 1;
    values['00200037'] = identity;
    values['00200032'] = `0\\0\\${(index * step).toFixed(3)}`;
  } else if (item.hasGeometry && s.first.hasGeometry) {
    // Express the slices in their own frame (a pure rotation, so
    // all in-plane and between-slice distances are unchanged). dwv then shows
    // the pixels as stored by the scanner instead of re-orienting them, which
    // it gets wrong (off-screen) for some orientations.
    const row = s.first.iop.slice(0, 3);
    const col = s.first.iop.slice(3, 6);
    const normal = cross(row, col);
    const d = item.ipp.map((v, k) => v - s.first.ipp[k]);
    values['00200037'] = identity;
    values['00200032'] = [dot(d, row), dot(d, col), dot(d, normal)].map((v) => v.toFixed(4)).join('\\');
  }
  const cal = state.calibrations[s.key];
  if (cal) {
    values['00280030'] = cal.spacing.map((v) => v.toPrecision(10)).join('\\');
  } else if (!item.pixelSpacing && !item.imagerSpacing && item.aspectRatio) {
    // without a pixel spacing dwv uses the aspect ratio as spacing, so a
    // ratio written as 1024\1024 would multiply pixel lengths by 1024
    const [a, b] = numbers(item.aspectRatio);
    if (a > 0 && a === b) values['00280034'] = '1\\1';
  }
  if (!Object.keys(values).length) return item.buffer.slice(0);
  const out = withValues(item.buffer, values);
  if (!out) throw new Error('Could not prepare image');
  return out;
}

// ---------------------------------------------------------------------------
// viewports (one dwv app each)

function toolOptions() {
  return {
    Scroll: new dwv.ToolConfig(),
    WindowLevel: new dwv.ToolConfig(),
    ZoomAndPan: new dwv.ToolConfig(),
    Draw: new dwv.ToolConfig(['Ruler', 'Protractor', 'Ellipse', 'Rectangle', 'Arrow']),
  };
}

function disposeApp(a) {
  if (!a) return;
  a.abortAllLoads();
  a.reset();
  // dwv registers a window keydown listener per app: remove it
  a.getToolboxController()?.enableShortcuts(false);
}

const vp = () => VIEWPORTS[state.active];
const shown = () => VIEWPORTS.slice(0, state.layout);
const seriesOf = (v) => state.series[v.series];

function groupOf(v) {
  return v && v.app ? v.app.getLayerGroupByDivId(v.divId) : undefined;
}

// image layer of a group (while a draw tool is active the draw layer is the
// "active" one and getActiveViewLayer() returns nothing)
function viewLayer(group) {
  if (!group) return undefined;
  return group.getActiveViewLayer() || group.getBaseViewLayer?.() || group.getViewLayers?.()[0];
}

function viewController(group) {
  const vl = viewLayer(group);
  return vl ? vl.getViewController() : undefined;
}

const vcOf = (v) => viewController(groupOf(v));

// A new dwv app for every series: App.reset() does not release loaded data.
function createApp(v) {
  disposeApp(v.app);
  // fresh layer group element, without any state left by the previous app
  const old = $(v.divId);
  const fresh = old.cloneNode(false);
  fresh.removeAttribute('style');
  old.replaceWith(fresh);

  const a = new dwv.App();
  const options = new dwv.AppOptions({'*': [new dwv.ViewConfig(v.divId)]});
  options.tools = toolOptions();
  a.init(options);
  const mine = () => v.app === a;

  a.addEventListener('loadstart', () => mine() && showProgress(0));
  a.addEventListener('loadprogress', (e) => {
    if (mine() && e.lengthComputable) showProgress(e.loaded / e.total);
  });
  a.addEventListener('load', () => {
    if (!mine()) return;
    v.loaded = true;
    onSeriesLoaded(v);
  });
  a.addEventListener('loadend', () => mine() && showProgress(null));
  a.addEventListener('error', (e) => {
    if (!mine()) return;
    console.error('dwv error', e.error || e);
    const msg = (e.error && e.error.message) || 'Could not display this series';
    if (!msg.startsWith('Render error')) a.abortAllLoads();
    toast(msg);
  });
  a.addEventListener('positionchange', () => {
    if (!mine()) return;
    onPositionChange(v);
    scheduleUiUpdate();
  });
  for (const type of ['wlchange', 'colourmapchange', 'zoomchange', 'offsetchange']) {
    a.addEventListener(type, () => mine() && scheduleUiUpdate());
  }
  for (const type of ['annotationadd', 'annotationupdate', 'annotationremove']) {
    a.addEventListener(type, () => mine() && scheduleMeasureUpdate());
  }
  a.addEventListener('annotationselect', (e) => {
    state.selected = e.annotationid;
    scheduleMeasureUpdate();
  });
  if (v.index === 0) window.dwvApp = a; // handy for debugging from the browser console
  window.viewer = {viewports: VIEWPORTS, state, currentItem, viewLayer, groupOf};
  return a;
}

function loadSeries(index, v = vp()) {
  const s = state.series[index];
  if (!s) return;
  stopPlay(v);
  v.series = index;
  v.loaded = false;
  v.flip = false;
  state.probe = null;
  v.app = createApp(v);
  markSeriesList();
  updateButtons();
  updateUi();
  renderMeasurements();
  $('empty').hidden = true;
  let data;
  try {
    data = s.items.map((it, i) => ({name: it.name, filename: it.name, data: bufferFor(s, it, i)}));
  } catch (e) {
    toast(e.message);
    return;
  }
  v.app.loadImageObject(data);
}

function onSeriesLoaded(v) {
  const s = seriesOf(v);
  const g = groupOf(v);
  const vc = viewController(g);
  const ph = g && g.getPositionHelper();
  // number images in acquisition (instance) order and start at the first one
  if (vc && ph && ph.getMaximumScrollValue() > 0 && s.items.length > 1) {
    const first = vc.getOriginForImageUid(s.items[0].sop);
    const last = vc.getOriginForImageUid(s.items[s.items.length - 1].sop);
    const p0 = ph.getCurrentPositionAtScrollValue(0).getValues();
    const dist = (o) => (o ? Math.hypot(o.getX() - p0[0], o.getY() - p0[1], o.getZ() - p0[2]) : Infinity);
    v.flip = dist(first) > dist(last);
    setSliceIndex(v.flip ? ph.getMaximumScrollValue() : 0, v);
  }
  v.app.setImageSmoothing(state.smooth);
  applyTool(v);
  // a second view starts at the level of the first one when they are parallel
  const other = otherViewport(v);
  if (other && other.loaded) syncFrom(other, true);
  if (v === vp()) fillPresets();
  updateButtons();
  updateUi();
  renderMeasurements();
  queueThumbnails();
}

// refit the images once the browser has laid out the new view sizes
function fitViews() {
  requestAnimationFrame(() => {
    for (const v of shown()) {
      if (v.loaded) v.app.onResize();
    }
    updateOverlays();
  });
}

function otherViewport(v) {
  return state.layout === 2 ? VIEWPORTS[1 - v.index] : null;
}

function setActive(index) {
  if (index === state.active || index >= state.layout) return;
  state.active = index;
  for (const v of VIEWPORTS) $(v.divId).classList.toggle('active', state.layout === 2 && v.index === index);
  markSeriesList();
  fillPresets();
  updateButtons();
  updateUi();
  renderMeasurements();
}

function setLayout(n) {
  if (n === state.layout) return;
  state.layout = n;
  $('viewers').classList.toggle('two', n === 2);
  if (n === 1) {
    disposeApp(VIEWPORTS[1].app);
    Object.assign(VIEWPORTS[1], {app: null, series: -1, loaded: false});
    state.active = 0;
    state.locator = null;
  } else if (VIEWPORTS[0].series >= 0) {
    loadSeries(companionSeries(VIEWPORTS[0].series), VIEWPORTS[1]);
  }
  for (const v of VIEWPORTS) $(v.divId).classList.toggle('active', n === 2 && v.index === state.active);
  fitViews();
  markSeriesList();
  updateButtons();
  updateUi();
  renderMeasurements();
}

// The best series to show next to another one: same patient space (frame of
// reference) in a different plane, e.g. sagittal next to axial.
function companionSeries(index) {
  const s = state.series[index];
  const n = imageNormal(s.first);
  let best = -1;
  let bestScore = -Infinity;
  state.series.forEach((c, i) => {
    if (i === index) return;
    let score = 0;
    if (c.first.studyUid === s.first.studyUid) score += 1;
    if (s.first.frameOfRef && c.first.frameOfRef === s.first.frameOfRef) score += 2;
    const m = imageNormal(c.first);
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

// ---------------------------------------------------------------------------
// geometry of the image shown in a viewport (original file values)

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function imageNormal(it) {
  return it && it.hasGeometry ? cross(it.iop.slice(0, 3), it.iop.slice(3, 6)) : null;
}

function currentItem(v = vp()) {
  const vc = vcOf(v);
  if (!vc) return undefined;
  try {
    return state.sopIndex.get(vc.getCurrentImageUid());
  } catch {
    return undefined;
  }
}

// plane of an item in patient space, or null
function planeOf(it) {
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

const sameSpace = (p, q) => p && q && p.frame && p.frame === q.frame;

// pixel (x = column, y = row; pixel centres at integers) -> patient point
function pixelToPatient(p, x, y) {
  return [0, 1, 2].map((k) => p.origin[k] + x * p.colSpacing * p.row[k] + y * p.rowSpacing * p.col[k]);
}

// patient point -> pixel coordinates in plane p, and distance to the plane
function patientToPixel(p, point) {
  const d = [0, 1, 2].map((k) => point[k] - p.origin[k]);
  return {x: dot(d, p.row) / p.colSpacing, y: dot(d, p.col) / p.rowSpacing, dist: dot(d, p.normal)};
}

// Segment (in pixel coordinates of plane p) where plane q cuts the image of p.
function intersection(p, q) {
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
  // farthest pair (corners can produce duplicates)
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

// pixel coordinates of the shown image -> position inside the viewport div.
// dwv's planePosToDisplay() gives up outside the canvas, so use the (linear)
// inverse of displayToPlanePos(), which works everywhere.
function pixelToScreen(v, x, y) {
  const vl = viewLayer(groupOf(v));
  if (!vl) return null;
  const p0 = vl.displayToPlanePos(new dwv.Point2D(0, 0));
  const p1 = vl.displayToPlanePos(new dwv.Point2D(100, 100));
  const sx = (p1.getX() - p0.getX()) / 100;
  const sy = (p1.getY() - p0.getY()) / 100;
  if (!sx || !sy) return null;
  // dwv plane positions have the pixel centres at +0.5
  return {x: (x + 0.5 - p0.getX()) / sx, y: (y + 0.5 - p0.getY()) / sy};
}

function screenToPixel(v, clientX, clientY) {
  const vl = viewLayer(groupOf(v));
  if (!vl) return null;
  const rect = $(v.divId).getBoundingClientRect();
  const pp = vl.displayToPlanePos(new dwv.Point2D(clientX - rect.left, clientY - rect.top));
  return {x: pp.getX() - 0.5, y: pp.getY() - 0.5};
}

// index (acquisition order) of the slice of v's series closest to a point
function nearestSlice(v, point) {
  const s = seriesOf(v);
  if (!s) return -1;
  let best = -1;
  let bestD = Infinity;
  s.items.forEach((it, i) => {
    const p = planeOf(it);
    if (!p) return;
    const d = Math.abs(patientToPixel(p, point).dist);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const thick = s.first.thickness || s.first.spacing || 5;
  return bestD <= Math.max(thick, 5) ? best : -1;
}

let syncing = false;
function onPositionChange(v) {
  if (syncing || !state.sync) return;
  const w = otherViewport(v);
  if (w && w.loaded) syncFrom(v);
}

// move the other viewport to the same level when both show parallel planes
function syncFrom(v, force = false) {
  const w = otherViewport(v);
  if (!w || !w.loaded || !v.loaded || (!state.sync && !force)) return;
  const p = planeOf(currentItem(v));
  const q = planeOf(currentItem(w));
  if (!sameSpace(p, q) || Math.abs(dot(p.normal, q.normal)) < 0.98) return;
  const centre = pixelToPatient(p, (p.it.cols - 1) / 2, (p.it.rows - 1) / 2);
  const idx = nearestSlice(w, centre);
  if (idx < 0) return;
  syncing = true;
  try {
    goToImage(idx, w);
  } finally {
    syncing = false;
  }
}

// double-click: show this point in the other view
function locate(v, clientX, clientY) {
  const p = planeOf(currentItem(v));
  const px = screenToPixel(v, clientX, clientY);
  if (!p || !px) return;
  const point = pixelToPatient(p, px.x, px.y);
  state.locator = {point, frame: p.frame};
  const w = otherViewport(v);
  if (w && w.loaded) {
    const q = planeOf(currentItem(w));
    if (sameSpace(p, q)) {
      const idx = nearestSlice(w, point);
      if (idx >= 0) {
        syncing = true;
        try {
          goToImage(idx, w);
        } finally {
          syncing = false;
        }
      } else {
        toast('That point is outside the other series.');
      }
    } else if (q) {
      toast('The two series are not in the same patient coordinates.');
    }
  }
  scheduleUiUpdate();
}

// ---------------------------------------------------------------------------
// tools & actions

function applyTool(v) {
  if (!v.loaded) return;
  const t = TOOLS[state.tool];
  v.app.setTool(t.dwv);
  if (t.shape) v.app.setToolFeatures({shapeName: t.shape});
}

function setTool(name) {
  if (!TOOLS[name]) return;
  state.tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === name);
  }
  for (const v of shown()) applyTool(v);
  $('viewers').dataset.tool = name;
}

function fillPresets() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  const vc = vcOf(vp());
  if (!vc || !vc.canWindowLevel()) {
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const names = vc.getWindowLevelPresetsNames();
  names.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${i < 9 ? i + 1 + '  ' : ''}${presetLabel(name)}`;
    sel.appendChild(opt);
  });
  syncPresetSelect();
}

function presetLabel(name) {
  const labels = {
    minmax: 'Full range',
    mediastinum: 'Soft tissue',
    lung: 'Lung',
    bone: 'Bone',
    brain: 'Brain',
    head: 'Head',
    manual: 'Manual',
  };
  const m = /^Default(\d+)$/.exec(name);
  if (m) return m[1] === '0' ? 'Scanner default' : `Scanner default ${parseInt(m[1], 10) + 1}`;
  return labels[name] || capitalize(name);
}

function syncPresetSelect() {
  const vc = vcOf(vp());
  const sel = $('presetSelect');
  if (!vc || sel.disabled) return;
  const name = vc.getCurrentWindowPresetName();
  if (name && ![...sel.options].some((o) => o.value === name)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = presetLabel(name);
    sel.appendChild(opt);
  }
  sel.value = name || '';
}

function applyPreset(name) {
  const vc = vcOf(vp());
  if (vc && vc.getWindowLevelPresetsNames().includes(name)) vc.setWindowLevelPreset(name);
}

function toggleInvert() {
  const vc = vcOf(vp());
  if (!vc || !vc.isMonochrome()) return;
  vc.setColourMap(vc.getColourMap() === 'invPlain' ? 'plain' : 'invPlain');
  updateButtons();
}

function resetView() {
  const v = vp();
  stopPlay(v);
  if (!v.loaded) return;
  v.app.resetZoomPan();
  vcOf(v)?.resetWindowLevel();
  updateUi();
}

function togglePlay() {
  const v = vp();
  const vc = vcOf(v);
  if (!vc || !groupOf(v).canScroll()) return;
  if (vc.isPlaying()) vc.stop(); else vc.play();
  updateButtons();
}

function stopPlay(v = vp()) {
  const vc = vcOf(v);
  if (vc && vc.isPlaying()) vc.stop();
  updateButtons();
}

// delta in acquisition order (+1 = next image)
function scrollBy(delta, v = vp()) {
  const g = groupOf(v);
  const ph = v.loaded && g && g.getPositionHelper();
  if (!ph) return;
  if (v.flip) delta = -delta;
  setSliceIndex(ph.getCurrentPositionScrollValue() + delta, v);
}

function setSliceIndex(value, v = vp()) {
  const g = groupOf(v);
  const ph = g && g.getPositionHelper();
  if (!ph) return;
  const max = ph.getMaximumScrollValue();
  const k = Math.max(0, Math.min(max, Math.round(value)));
  if (k === ph.getCurrentPositionScrollValue()) return;
  ph.setCurrentPosition(ph.getCurrentPositionAtScrollValue(k));
}

// 0-based image number in acquisition order
function displayIndex(v) {
  const ph = groupOf(v).getPositionHelper();
  const max = ph.getMaximumScrollValue();
  const cur = ph.getCurrentPositionScrollValue();
  return {cur: v.flip ? max - cur : cur, max};
}

function goToImage(n, v = vp()) {
  const g = groupOf(v);
  const ph = g && g.getPositionHelper();
  if (!ph) return;
  const max = ph.getMaximumScrollValue();
  setSliceIndex(v.flip ? max - n : n, v);
}

// ---------------------------------------------------------------------------
// brightness / contrast (window level / width)

function wlRange(vc) {
  const r = vc.getImageRescaledDataRange();
  const span = Math.max(1, r.max - r.min);
  return {min: r.min, max: r.max, span};
}

function updateWlPanel() {
  if ($('wlPanel').hidden) return;
  const vc = vcOf(vp());
  const ok = !!vc && vc.canWindowLevel();
  for (const id of ['wlBrightness', 'wlContrast', 'wlLevel', 'wlWidth']) $(id).disabled = !ok;
  if (!ok) return;
  const {min, max, span} = wlRange(vc);
  const wl = vc.getWindowLevel();
  // brightness: right = brighter = lower window level
  const b = $('wlBrightness');
  b.min = String(-max);
  b.max = String(-min);
  b.step = String(span / 1000);
  if (document.activeElement !== b) b.value = String(-wl.center);
  // contrast: right = more contrast = narrower window, on a log scale
  const c = $('wlContrast');
  const maxW = span * 2;
  if (document.activeElement !== c) c.value = String(1 - Math.log(Math.max(1, wl.width)) / Math.log(maxW));
  if (document.activeElement !== $('wlLevel')) $('wlLevel').value = String(Math.round(wl.center));
  if (document.activeElement !== $('wlWidth')) $('wlWidth').value = String(Math.round(wl.width));
}

function setWindow(center, width) {
  const vc = vcOf(vp());
  if (!vc || !vc.canWindowLevel() || !Number.isFinite(center) || !(width >= 1)) return;
  vc.setWindowLevel(new dwv.WindowLevel(center, width));
}

function onWlInput(e) {
  const vc = vcOf(vp());
  if (!vc) return;
  const wl = vc.getWindowLevel();
  const {span} = wlRange(vc);
  if (e.target.id === 'wlBrightness') setWindow(-parseFloat(e.target.value), wl.width);
  if (e.target.id === 'wlContrast') setWindow(wl.center, Math.exp((1 - parseFloat(e.target.value)) * Math.log(span * 2)));
  if (e.target.id === 'wlLevel') setWindow(parseFloat(e.target.value), wl.width);
  if (e.target.id === 'wlWidth') setWindow(wl.center, parseFloat(e.target.value));
}

function toggleWlPanel() {
  $('wlPanel').hidden = !$('wlPanel').hidden;
  $('wlBtn').classList.toggle('on', !$('wlPanel').hidden);
  updateWlPanel();
}

// ---------------------------------------------------------------------------
// measurements

function drawLayers(v) {
  if (!v || !v.loaded) return [];
  try {
    return v.app.getDrawLayers();
  } catch {
    return [];
  }
}

function annotations(v = vp()) {
  const list = [];
  const seen = new Set();
  for (const layer of drawLayers(v)) {
    const group = layer.getDrawController().getAnnotationGroup();
    for (const a of group.getList()) {
      if (seen.has(a.trackingUid)) continue;
      seen.add(a.trackingUid);
      list.push({annotation: a, layer, v});
    }
  }
  return list;
}

function unitLabel(u) {
  return u === 'unit.mm' ? 'mm' : u === 'unit.cm2' ? 'cm²' : u === 'unit.degree' ? '°' : 'px';
}

function describe(a, v) {
  const q = a.quantification || {};
  const rows = [];
  let kind = 'Arrow';
  if (q.length) {
    kind = 'Distance';
    const u = unitLabel(q.length.unit);
    rows.push([`${fmt(q.length.value, u === 'mm' ? 2 : 1)} ${u}`, true]);
  }
  if (q.angle) {
    kind = 'Angle';
    rows.push([`${fmt(q.angle.value, 1)}°`, true]);
  }
  if (q.surface) {
    kind = q.a ? 'Ellipse' : q.radius ? 'Circle' : 'Rectangle';
    const u = unitLabel(q.surface.unit);
    rows.push([`Area ${fmt(q.surface.value, 2)} ${u}`, true]);
    if (q.a && q.b) rows.push([`Axes ${fmt(q.a.value * 2, 1)} × ${fmt(q.b.value * 2, 1)} ${unitLabel(q.a.unit)}`]);
    if (q.width && q.height) rows.push([`${fmt(q.width.value, 1)} × ${fmt(q.height.value, 1)} ${unitLabel(q.width.unit)}`]);
  }
  const pu = seriesOf(v)?.first.modality === 'CT' ? ' HU' : '';
  if (q.mean) rows.push([`Mean ${fmt(q.mean.value, 1)}${pu} · SD ${fmt(q.stdDev?.value, 1)}`]);
  if (q.min && q.max) rows.push([`Min ${fmt(q.min.value, 0)} · Max ${fmt(q.max.value, 0)}${pu}`]);
  return {kind, rows};
}

let measurePending = false;
function scheduleMeasureUpdate() {
  if (measurePending) return;
  measurePending = true;
  setTimeout(() => {
    measurePending = false;
    renderMeasurements();
  }, 60);
}

// numbered measurements of all shown viewports
function allMeasurements() {
  const out = [];
  for (const v of shown()) {
    annotations(v).forEach((m, i) => out.push({...m, number: i + 1}));
  }
  return out;
}

function measureLabel(m) {
  return state.layout === 2 ? `View ${m.v.index + 1} · #${m.number}` : `#${m.number}`;
}

function renderMeasurements() {
  const v = vp();
  const s = seriesOf(v);
  const box = $('measureList');
  const calBox = $('calibration');
  if (!s) {
    box.innerHTML = '';
    calBox.innerHTML = '';
    $('ratioBox').hidden = true;
    $('measureCount').textContent = '';
    return;
  }
  const info = spacingInfo(s);
  const sp = info.spacing;
  calBox.className = `calibration cal-${info.kind}`;
  calBox.innerHTML = `
    ${state.layout === 2 ? `<div class="muted">View ${v.index + 1}: ${escapeHtml(s.title)}</div>` : ''}
    <div><b>Scale:</b> ${sp ? `${fmt(sp[1], 4)} × ${fmt(sp[0], 4)} mm per pixel` : 'unknown'}</div>
    <div class="muted">${escapeHtml(info.label)}</div>`;

  const all = allMeasurements();
  $('measureCount').textContent = all.length ? `(${all.length})` : '';
  box.innerHTML = '';
  if (!all.length) {
    box.innerHTML = `<div class="muted hint">Pick <b>Distance</b>, <b>Angle</b>, <b>Ellipse</b> or
      <b>Rectangle</b> above and drag on the image. Click a measurement to move its end points,
      press Delete to remove it.</div>`;
  }
  let lastView = -1;
  for (const m of all) {
    if (state.layout === 2 && m.v.index !== lastView) {
      lastView = m.v.index;
      const head = document.createElement('div');
      head.className = 'measure-group muted';
      head.textContent = `View ${m.v.index + 1} · ${seriesOf(m.v)?.title || ''}`;
      box.appendChild(head);
    }
    const a = m.annotation;
    const {kind, rows} = describe(a, m.v);
    const item = document.createElement('div');
    item.className = 'measure' + (a.trackingUid === state.selected ? ' selected' : '');
    const where = imageNumberFor(a, m.v);
    item.innerHTML = `
      <div class="measure-head"><span>${m.number}. ${kind}${where ? ` <span class="muted">· image ${where}</span>` : ''}</span>
        <button class="icon" title="Delete">✕</button></div>
      ${rows.map(([t, big]) => `<div class="${big ? 'measure-value' : 'muted'}">${escapeHtml(t)}</div>`).join('')}`;
    item.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnnotation(a.trackingUid, m.v);
    });
    item.addEventListener('click', () => showAnnotation(a, m.v));
    box.appendChild(item);
  }
  renderRatio(all);

  // calibration controls (active view)
  const list = annotations(v);
  const lastDistance = [...list].reverse().find(({annotation: a}) => a.quantification?.length);
  const canCal = info.kind !== 'patient' || state.calibrations[s.key];
  $('calForm').hidden = !canCal;
  $('calApply').disabled = !lastDistance;
  $('calHint').textContent = lastDistance ?
    `Enter the real length of distance #${list.indexOf(lastDistance) + 1} (e.g. a ruler or coin in the image):` :
    'To calibrate, first draw a distance over something of known size.';
  $('calReset').hidden = !state.calibrations[s.key];
}

// ratio of two distances (e.g. canal / vertebral body). Magnification and
// calibration cancel out, so this is exact on X-rays too.
function renderRatio(all) {
  const distances = all.filter((m) => m.annotation.quantification?.length);
  const box = $('ratioBox');
  box.hidden = distances.length < 2;
  if (box.hidden) return;
  const uids = distances.map((m) => m.annotation.trackingUid);
  let {a, b} = state.ratio;
  if (!uids.includes(a) || !uids.includes(b) || a === b) {
    a = uids[uids.length - 2];
    b = uids[uids.length - 1];
    state.ratio = {a, b};
  }
  for (const [id, value] of [['ratioA', a], ['ratioB', b]]) {
    const sel = $(id);
    sel.innerHTML = distances.map((m) => {
      const q = m.annotation.quantification.length;
      return `<option value="${m.annotation.trackingUid}">${escapeHtml(measureLabel(m))} · ${fmt(q.value, 2)} ${unitLabel(q.unit)}</option>`;
    }).join('');
    sel.value = value;
  }
  const qa = distances.find((m) => m.annotation.trackingUid === a).annotation.quantification.length;
  const qb = distances.find((m) => m.annotation.trackingUid === b).annotation.quantification.length;
  const out = $('ratioValue');
  if (qa.unit !== qb.unit) {
    out.textContent = 'Different units (mm and px): calibrate first';
  } else if (!(qb.value > 0) || !(qa.value > 0)) {
    out.textContent = '–';
  } else {
    out.innerHTML = `<span class="measure-value">${fmt(qa.value / qb.value, 3)}</span>
      <span class="muted"> (B ÷ A = ${fmt(qb.value / qa.value, 3)})</span>`;
  }
}

function imageNumberFor(a, v) {
  const s = seriesOf(v);
  if (!s || !a.referencedSopInstanceUID) return '';
  const idx = s.items.findIndex((it) => it.sop === a.referencedSopInstanceUID);
  return idx >= 0 && s.items.length > 1 ? String(idx + 1) : '';
}

function showAnnotation(a, v) {
  const s = seriesOf(v);
  if (!s) return;
  setActive(v.index);
  const idx = s.items.findIndex((it) => it.sop === a.referencedSopInstanceUID);
  if (idx >= 0) goToImage(idx, v);
}

function deleteAnnotation(uid, v = vp()) {
  for (const layer of drawLayers(v)) {
    const dc = layer.getDrawController();
    if (dc.getAnnotation(uid)) {
      dc.removeAnnotationWithCommand(uid, v.app.addToUndoStack); // undo with ⌘Z
      layer.draw?.();
    }
  }
  scheduleMeasureUpdate();
}

function clearMeasures() {
  for (const v of shown()) {
    for (const layer of drawLayers(v)) {
      const dc = layer.getDrawController();
      for (const a of [...dc.getAnnotationGroup().getList()]) dc.removeAnnotationWithCommand(a.trackingUid, v.app.addToUndoStack);
      layer.draw?.();
    }
  }
  scheduleMeasureUpdate();
}

function reloadSeriesEverywhere(index) {
  for (const v of shown()) {
    if (v.series === index) loadSeries(index, v);
  }
}

function applyCalibration() {
  const v = vp();
  const s = seriesOf(v);
  const real = parseFloat($('calInput').value.replace(',', '.'));
  const list = annotations(v);
  const last = [...list].reverse().find(({annotation: a}) => a.quantification?.length);
  if (!s || !last) return;
  if (!(real > 0)) {
    toast('Enter the real length in millimetres');
    return;
  }
  const q = last.annotation.quantification.length;
  const current = spacingInfo(s).spacing || [1, 1];
  // measured value is in mm (or px when there was no calibration)
  const factor = real / q.value;
  state.calibrations[s.key] = {
    spacing: [current[0] * factor, current[1] * factor],
    note: `${fmt(q.value, 2)} ${q.unit === 'unit.mm' ? 'mm' : 'px'} = ${fmt(real, 2)} mm`,
  };
  saveCalibrations();
  $('calInput').value = '';
  toast(`Calibrated: ${state.calibrations[s.key].note}. Measurements were reset.`);
  reloadSeriesEverywhere(v.series);
}

function resetCalibration() {
  const v = vp();
  const s = seriesOf(v);
  if (!s) return;
  delete state.calibrations[s.key];
  saveCalibrations();
  reloadSeriesEverywhere(v.series);
}

// ---------------------------------------------------------------------------
// overlays

let uiPending = false;
function scheduleUiUpdate() {
  if (uiPending) return;
  uiPending = true;
  requestAnimationFrame(() => {
    uiPending = false;
    updateUi();
  });
}

function updateUi() {
  updateOverlays();
  updateSlider();
  syncPresetSelect();
  updateWlPanel();
  if (state.panel === 'tags') renderTags();
}

function updateSlider() {
  const v = vp();
  const g = groupOf(v);
  const ph = v.loaded && g && g.getPositionHelper();
  const slider = $('sliceSlider');
  if (!ph) {
    slider.disabled = true;
    $('sliceLabel').textContent = '';
    return;
  }
  const {cur, max} = displayIndex(v);
  slider.max = String(max);
  slider.value = String(cur);
  slider.disabled = max < 1;
  $('sliceLabel').textContent = `${state.layout === 2 ? `View ${v.index + 1}: ` : ''}${cur + 1} / ${max + 1}`;
}

// orientation letters for a patient space direction (LPS)
function directionLetters(dir) {
  const parts = [
    [dir[0], 'L', 'R'],
    [dir[1], 'P', 'A'],
    [dir[2], 'S', 'I'],
  ].filter(([c]) => Math.abs(c) > 0.3).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return parts.map(([c, pos, neg]) => (c > 0 ? pos : neg)).join('');
}

const PO_OPPOSITE = {L: 'R', R: 'L', A: 'P', P: 'A', H: 'F', F: 'H', S: 'I', I: 'S'};

// The image is shown as stored (see bufferFor), so the markers follow
// directly from the row / column directions of the file.
function orientationMarkers(it) {
  if (it.iop.length === 6 && it.iop.every(Number.isFinite)) {
    const row = it.iop.slice(0, 3);
    const col = it.iop.slice(3, 6);
    return {
      right: directionLetters(row),
      left: directionLetters(row.map((c) => -c)),
      bottom: directionLetters(col),
      top: directionLetters(col.map((c) => -c)),
    };
  }
  const po = it.patientOrientation.split('\\');
  if (po.length === 2 && po[0] && po[1]) {
    const opp = (t) => [...t].map((c) => PO_OPPOSITE[c] || c).join('');
    return {right: po[0], bottom: po[1], left: opp(po[0]), top: opp(po[1])};
  }
  return null;
}

// Liang-Barsky clipping of segment a-b to the rectangle [0, w] x [0, h]
function clipSegment(a, b, w, h) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [pk, qk] of [[-dx, a.x], [dx, w - a.x], [-dy, a.y], [dy, h - a.y]]) {
    if (pk === 0) {
      if (qk < 0) return null;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [{x: a.x + t0 * dx, y: a.y + t0 * dy}, {x: a.x + t1 * dx, y: a.y + t1 * dy}];
}

const VIEW_COLOURS = ['#4ea1ff', '#ff9f43'];
const SVG_NS = 'http://www.w3.org/2000/svg';

// reference lines (where the other view's slices cut this image) and the
// double-click locator, as an SVG on top of the viewport
function drawGeometryOverlay(v, box) {
  const it = currentItem(v);
  const p = planeOf(it);
  if (!p) return [];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'refsvg');
  const drawn = [];
  const w = otherViewport(v);
  if (w && w.loaded) {
    const current = currentItem(w);
    const q = planeOf(current);
    const colour = VIEW_COLOURS[w.index];
    const line = (a, b, cls) => {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', a.x);
      l.setAttribute('y1', a.y);
      l.setAttribute('x2', b.x);
      l.setAttribute('y2', b.y);
      l.setAttribute('stroke', colour);
      l.setAttribute('class', cls);
      svg.appendChild(l);
    };
    const text = (pt, str, cls, anchor) => {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', pt.x);
      t.setAttribute('y', pt.y);
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('fill', colour);
      t.setAttribute('class', cls);
      t.textContent = str;
      svg.appendChild(t);
      return t;
    };
    // screen segment of another slice on this image, clipped to the view
    // and ordered left -> right
    const segmentFor = (plane) => {
      const seg = intersection(p, plane);
      if (!seg) return null;
      const a = pixelToScreen(v, seg[0][0], seg[0][1]);
      const b = pixelToScreen(v, seg[1][0], seg[1][1]);
      if (!a || !b) return null;
      const clipped = clipSegment(a, b, box.clientWidth, box.clientHeight);
      if (!clipped) return null;
      return clipped[0].x <= clipped[1].x ? clipped : [clipped[1], clipped[0]];
    };
    if (sameSpace(p, q)) {
      // every level of the other series, numbered (click a number to go there)
      const items = seriesOf(w).items;
      if (state.allLevels && items.length > 1) {
        const step = Math.max(1, Math.ceil(items.length / 40));
        const placed = []; // label positions, to avoid overlapping numbers
        items.forEach((item, idx) => {
          if (item === current || (idx % step && idx !== items.length - 1)) return;
          const plane = planeOf(item);
          if (!sameSpace(p, plane)) return;
          const seg = segmentFor(plane);
          if (!seg) return;
          line(seg[0], seg[1], 'refline faint');
          const nearRight = seg[1].x > box.clientWidth - 18;
          if (placed.some((q2) => Math.abs(q2.x - seg[1].x) < 14 && Math.abs(q2.y - seg[1].y) < 10)) return;
          placed.push(seg[1]);
          const t = text({x: nearRight ? seg[1].x - 3 : seg[1].x + 3, y: seg[1].y + 3}, String(idx + 1), 'reflevel', nearRight ? 'end' : 'start');
          t.addEventListener('click', () => {
            setActive(w.index);
            goToImage(idx, w);
          });
        });
      }
      const seg = segmentFor(q);
      if (seg) {
        line(seg[0], seg[1], 'refline');
        const {cur} = displayIndex(w);
        const label = `View ${w.index + 1} · image ${cur + 1}`;
        const pos = {x: Math.min(seg[1].x, box.clientWidth - 8) - 4, y: seg[1].y - 6};
        text(pos, label, 'reflabel', 'end');
        drawn.push({a: seg[0], b: seg[1], colour, text: label});
      }
    }
  }
  if (state.locator && state.locator.frame && state.locator.frame === p.frame) {
    const loc = patientToPixel(p, state.locator.point);
    const thick = seriesOf(v)?.first.thickness || 3;
    if (Math.abs(loc.dist) <= Math.max(thick, 3)) {
      const c = pixelToScreen(v, loc.x, loc.y);
      if (c) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const l = document.createElementNS(SVG_NS, 'line');
          l.setAttribute('x1', c.x - 10 * dx);
          l.setAttribute('y1', c.y - 10 * dy);
          l.setAttribute('x2', c.x + 10 * dx);
          l.setAttribute('y2', c.y + 10 * dy);
          l.setAttribute('class', 'locator');
          svg.appendChild(l);
        }
      }
    }
  }
  box.appendChild(svg);
  return drawn;
}

function updateOverlays() {
  const container = $('overlays');
  container.innerHTML = '';
  const host = $('viewers').getBoundingClientRect();
  for (const v of shown()) {
    const s = seriesOf(v);
    const box = document.createElement('div');
    box.className = 'ovbox';
    box.dataset.view = String(v.index);
    const r = $(v.divId).getBoundingClientRect();
    box.style.cssText = `left:${r.left - host.left}px;top:${r.top - host.top}px;width:${r.width}px;height:${r.height}px;`;
    container.appendChild(box);
    if (state.layout === 2) {
      const tag = document.createElement('div');
      tag.className = 'viewtag';
      tag.style.background = VIEW_COLOURS[v.index];
      tag.textContent = String(v.index + 1);
      box.appendChild(tag);
    }
    if (!s || !v.loaded) continue;
    const g = groupOf(v);
    const vc = viewController(g);
    const it = currentItem(v) || s.first;
    const f = s.first;
    const spInfo = spacingInfo(s);

    const tl = [];
    if (v.index === 0) {
      if (state.layout === 1) tl.push(f.patientName);
      tl.push([f.patientId && `ID ${f.patientId}`, f.sex, formatAge(f.age)].filter(Boolean).join('  '));
      tl.push(formatDate(f.studyDate || f.seriesDate));
    }
    const tr = [`${f.modality}  ${s.title}`];
    if (Number.isFinite(f.seriesNumber)) tr.push(`Series ${f.seriesNumber}`);
    if (s.stacked) tr.push('Angled slices shown as a stack');
    const ph = g.getPositionHelper();
    if (ph && ph.getMaximumScrollValue() > 0) {
      const {cur, max} = displayIndex(v);
      tr.push(`Image ${cur + 1} / ${max + 1}`);
    }

    const bl = [];
    if (state.probe && state.probe.view === v.index) bl.push(state.probe.text);
    if (vc && vc.canWindowLevel()) {
      const wl = vc.getWindowLevel();
      bl.push(`W ${Math.round(wl.width)}  L ${Math.round(wl.center)}`);
    }
    const br = [];
    const thick = parseFloat(tagValue(it.elements, '00180050'));
    const loc = parseFloat(tagValue(it.elements, '00201041'));
    if (Number.isFinite(thick) && !PROJECTION.includes(f.modality)) br.push(`Thickness ${thick.toFixed(1)} mm`);
    if (Number.isFinite(loc) && !s.stacked) br.push(`Location ${loc.toFixed(1)} mm`);
    const scale = g.getScale?.();
    const base = g.getBaseScale?.();
    if (scale && base && base.x) br.push(`Zoom ${Math.round((scale.x / base.x) * 100)}%`);
    br.push(spInfo.spacing ? `${fmt(spInfo.spacing[1], 3)} mm/px${spInfo.kind === 'patient' ? '' : spInfo.kind === 'user' ? ' (calibrated)' : spInfo.kind === 'detector' ? ' (detector)' : ' (unreliable)'}` : 'Not calibrated (px)');

    for (const [pos, lines] of [['tl', tl], ['tr', tr], ['bl', bl], ['br', br]]) {
      const text = lines.filter(Boolean).join('\n');
      if (!text) continue;
      const o = document.createElement('div');
      o.className = `ov ${pos}`;
      o.textContent = text;
      box.appendChild(o);
    }
    const marks = orientationMarkers(it);
    if (marks) {
      for (const side of ['top', 'bottom', 'left', 'right']) {
        if (!marks[side]) continue;
        const m = document.createElement('div');
        m.className = `orient ${side}`;
        m.textContent = marks[side];
        box.appendChild(m);
      }
    }
    box.refLines = drawGeometryOverlay(v, box);
  }
}

function updateButtons() {
  const v = vp();
  const loaded = v.loaded;
  const vc = loaded ? vcOf(v) : undefined;
  const playing = !!vc && vc.isPlaying();
  $('playBtn').disabled = !loaded || !groupOf(v)?.canScroll();
  $('playBtn').classList.toggle('on', playing);
  $('playBtn').textContent = playing ? 'Stop' : 'Play';
  $('invertBtn').disabled = !loaded || !vc || !vc.isMonochrome();
  $('invertBtn').classList.toggle('on', !!vc && vc.getColourMap() === 'invPlain');
  for (const id of ['resetBtn', 'exportBtn', 'wlBtn']) $(id).disabled = !loaded;
  for (const b of document.querySelectorAll('[data-tool]')) b.disabled = !loaded;
  $('layoutBtn').classList.toggle('on', state.layout === 2);
  $('layoutBtn').disabled = !VIEWPORTS[0].loaded && state.layout === 1;
  $('syncBtn').hidden = state.layout !== 2;
  $('levelsBtn').hidden = state.layout !== 2;
  $('levelsBtn').classList.toggle('on', state.allLevels);
  $('syncBtn').classList.toggle('on', state.sync);
  $('tagsBtn').classList.toggle('on', state.panel === 'tags');
  $('measureBtn').classList.toggle('on', state.panel === 'measure');
}

function renderPatient(items) {
  const f = items[0];
  if (!f) {
    $('patient').innerHTML = '';
    return;
  }
  const bits = [];
  if (f.patientName) bits.push(`<b>${escapeHtml(f.patientName)}</b>`);
  if (f.patientId) bits.push(`ID ${escapeHtml(f.patientId)}`);
  if (f.birthDate) bits.push(`Born ${formatDate(f.birthDate)}`);
  if (f.sex) bits.push(escapeHtml(f.sex));
  if (f.institution) bits.push(escapeHtml(f.institution));
  $('patient').innerHTML = bits.join(' &nbsp;·&nbsp; ');
}

function renderSeriesList() {
  const list = $('seriesList');
  list.innerHTML = '';
  let lastStudy = null;
  state.series.forEach((s, i) => {
    const f = s.first;
    if (f.studyUid !== lastStudy) {
      lastStudy = f.studyUid;
      const mods = [...new Set(state.series
        .filter((x) => x.first.studyUid === f.studyUid)
        .map((x) => x.first.modality))].join(' / ');
      const head = document.createElement('div');
      head.className = 'study-head';
      head.textContent = [formatDate(f.studyDate), f.studyDesc, mods].filter(Boolean).join(' · ');
      list.appendChild(head);
    }
    const b = document.createElement('button');
    b.className = 'series' + (s.isReference ? ' reference' : '');
    b.dataset.index = String(i);
    b.title = `${s.title}\nClick: show in the active view. Drag onto a view to show it there.`;
    b.draggable = true;
    const thumb = s.thumb ?
      `<img class="thumb" src="${s.thumb}" alt="">` :
      `<div class="thumb">${escapeHtml(f.modality)}</div>`;
    b.innerHTML = `${thumb}<div class="series-meta">
      <div class="series-title"><span class="badge ${escapeHtml(f.modality)}">${escapeHtml(f.modality)}</span>${escapeHtml(s.title)}</div>
      <div class="series-sub">${s.images} image${s.images === 1 ? '' : 's'} · ${f.cols}×${f.rows}</div>
    </div><div class="inview"></div>`;
    b.addEventListener('click', () => loadSeries(i));
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-series', String(i));
      e.dataTransfer.effectAllowed = 'copy';
    });
    list.appendChild(b);
  });
  markSeriesList();
}

// highlight the series shown in each view
function markSeriesList() {
  for (const b of document.querySelectorAll('.series')) {
    const i = parseInt(b.dataset.index, 10);
    const views = shown().filter((v) => v.series === i);
    b.classList.toggle('active', views.some((v) => v.index === state.active));
    b.classList.toggle('inother', views.length > 0 && !views.some((v) => v.index === state.active));
    const chips = b.querySelector('.inview');
    if (chips) {
      chips.innerHTML = state.layout === 2 ?
        views.map((v) => `<span style="background:${VIEW_COLOURS[v.index]}">${v.index + 1}</span>`).join('') : '';
    }
  }
  document.querySelector('.series.active')?.scrollIntoView({block: 'nearest'});
}

// swap the placeholder for the rendered thumbnail without rebuilding the list
function showThumb(s) {
  const i = state.series.indexOf(s);
  const holder = document.querySelector(`.series[data-index="${i}"] .thumb`);
  if (!holder || !s.thumb) return;
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.src = s.thumb;
  holder.replaceWith(img);
}

function renderTags() {
  const it = currentItem() || seriesOf(vp())?.first;
  const table = $('tagsTable');
  if (!it) {
    table.innerHTML = '';
    return;
  }
  const filter = $('tagFilter').value.trim().toLowerCase();
  const rows = [];
  for (const key of Object.keys(it.elements).sort()) {
    const el = it.elements[key];
    const tag = el.tag || dwv.getTagFromKey(key);
    const name = (tag.getNameFromDictionary?.() || (tag.isPrivate?.() ? 'Private tag' : ''))
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    let value;
    if (el.vr === 'SQ') value = `(sequence, ${Array.isArray(el.value) ? el.value.length : 0} item(s))`;
    else if (['OB', 'OW', 'OF', 'OD', 'UN'].includes(el.vr) || key === '7FE00010') value = `(binary, ${el.vl} bytes)`;
    else if (['PN', 'LO', 'SH', 'ST', 'LT', 'UT'].includes(el.vr)) value = it.text(key);
    else value = tagValue(it.elements, key);
    if (value.length > 400) value = value.slice(0, 400) + '…';
    const label = `${key.slice(0, 4)},${key.slice(4)}`;
    if (filter && !`${label} ${name} ${el.vr} ${value}`.toLowerCase().includes(filter)) continue;
    rows.push(`<tr><td>${label}</td><td>${escapeHtml(el.vr || '')}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`);
  }
  table.innerHTML = `<thead><tr><th>Tag</th><th>VR</th><th>Name</th><th>Value</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  $('tagsFile').textContent = it.name;
}

function setEmpty(msg, progress, offerOpen = false) {
  $('empty').hidden = false;
  $('emptyOpen').hidden = !offerOpen;
  $('emptyMsg').textContent = msg;
  $('progressBar').parentElement.style.visibility = progress === undefined ? 'hidden' : 'visible';
  if (progress !== undefined) $('progressBar').style.width = `${Math.round(progress * 100)}%`;
}

function showProgress(p) {
  let bar = $('loadBar');
  if (p === null) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'loadBar';
    document.querySelector('.stage').appendChild(bar);
  }
  bar.style.width = `${Math.round(p * 100)}%`;
}

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.querySelector('.stage').appendChild(t);
  }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 5000);
}

function setPanel(name) {
  state.panel = state.panel === name ? null : name;
  $('sidepanel').hidden = !state.panel;
  $('tagsView').hidden = state.panel !== 'tags';
  $('measureView').hidden = state.panel !== 'measure';
  if (state.panel === 'tags') renderTags();
  if (state.panel === 'measure') renderMeasurements();
  updateButtons();
}

// ---------------------------------------------------------------------------
// export the active view as PNG (image + measurements + overlay)

function exportPng() {
  const v = vp();
  const s = seriesOf(v);
  if (!s || !v.loaded) return;
  const div = $(v.divId);
  const rect = div.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  out.width = Math.round(rect.width * dpr);
  out.height = Math.round(rect.height * dpr);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  for (const c of div.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(c).display === 'none') continue;
    ctx.drawImage(c, (r.left - rect.left) * dpr, (r.top - rect.top) * dpr, r.width * dpr, r.height * dpr);
  }
  const box = $('overlays').querySelector(`.ovbox[data-view="${v.index}"]`);
  if (box) {
    for (const l of box.refLines || []) {
      ctx.strokeStyle = l.colour;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(l.a.x * dpr, l.a.y * dpr);
      ctx.lineTo(l.b.x * dpr, l.b.y * dpr);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = `${12 * dpr}px Menlo, monospace`;
    ctx.fillStyle = '#f2d56b';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3 * dpr;
    for (const o of box.querySelectorAll('.ov, .orient')) {
      const r = o.getBoundingClientRect();
      const lines = o.textContent.split('\n');
      const right = o.classList.contains('tr') || o.classList.contains('br');
      ctx.textAlign = right ? 'right' : 'left';
      const x = right ? (r.right - rect.left - 8) * dpr : (r.left - rect.left + (o.classList.contains('orient') ? 0 : 8)) * dpr;
      lines.forEach((line, k) => {
        ctx.fillText(line, x, (r.top - rect.top + 6 + 12 + k * 16) * dpr);
      });
    }
  }
  const {cur} = displayIndex(v);
  const name = `${s.first.modality}_${s.title}_image${cur + 1}`.replace(/[^\w.-]+/g, '_');
  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------------------------------------------------------------------------
// thumbnails, rendered in the background with a separate small dwv app

let thumbQueueRunning = false;
async function queueThumbnails() {
  if (thumbQueueRunning) return;
  thumbQueueRunning = true;
  const series = state.series;
  for (const s of series) {
    if (s.thumb) continue;
    if (series !== state.series) break; // another folder was opened
    try {
      s.thumb = await renderThumb(s);
      showThumb(s);
    } catch (e) {
      console.warn('thumbnail failed', s.title, e);
      s.thumb = null;
    }
  }
  thumbQueueRunning = false;
}

function renderThumb(s) {
  return new Promise((resolve, reject) => {
    const stage = $('thumbStage');
    const a = new dwv.App();
    const options = new dwv.AppOptions({'*': [new dwv.ViewConfig('thumbGroup')]});
    options.tools = {};
    a.init(options);
    a.getToolboxController()?.enableShortcuts(false);
    const index = Math.floor(s.items.length / 2);
    const item = s.items[index];
    const timer = setTimeout(() => finish(new Error('timeout')), 15000);
    function finish(err, url) {
      clearTimeout(timer);
      try {
        disposeApp(a);
      } catch {
        // ignore
      }
      if (err) reject(err); else resolve(url);
    }
    a.addEventListener('error', (e) => finish(e.error || new Error('load error')));
    a.addEventListener('load', () => {
      requestAnimationFrame(() => {
        const canvas = stage.querySelector('canvas');
        if (!canvas || !canvas.width) {
          finish(new Error('no canvas'));
          return;
        }
        const size = 112;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);
        const k = Math.min(size / canvas.width, size / canvas.height);
        ctx.drawImage(canvas, (size - canvas.width * k) / 2, (size - canvas.height * k) / 2,
          canvas.width * k, canvas.height * k);
        finish(null, c.toDataURL('image/jpeg', 0.8));
      });
    });
    a.loadImageObject([{name: item.name, filename: item.name, data: bufferFor(s, item, index)}]);
  });
}

// ---------------------------------------------------------------------------
// input: trackpad / mouse wheel, pinch, pixel probe, keyboard

function viewportFromEvent(e) {
  const div = e.target.closest && e.target.closest('.layerGroup');
  if (!div) return null;
  const v = VIEWPORTS.find((x) => x.divId === div.id);
  return v && v.index < state.layout ? v : null;
}

function zoomAt(v, step, clientX, clientY) {
  const g = groupOf(v);
  const vl = viewLayer(g);
  if (!vl) return;
  const rect = $(v.divId).getBoundingClientRect();
  const p = vl.displayToMainPlanePos(new dwv.Point2D(clientX - rect.left, clientY - rect.top));
  const center = vl.getViewController().getPlanePositionFromPlanePoint(p);
  g.addScale(step, center);
  g.draw();
  scheduleUiUpdate();
}

let wheelAcc = 0;
let wheelResetTimer;
function onWheel(e) {
  const v = viewportFromEvent(e);
  if (!v || !v.loaded) return;
  // take over from dwv so trackpads scroll smoothly and pinch zooms
  e.preventDefault();
  e.stopPropagation();
  setActive(v.index);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey || e.metaKey) {
    // trackpad pinch arrives as ctrl+wheel (Chrome, Firefox); cmd+wheel for mice
    const step = Math.max(-0.5, Math.min(0.5, -dy * (e.ctrlKey ? 0.01 : 0.002)));
    zoomAt(v, step, e.clientX, e.clientY);
    return;
  }
  wheelAcc += dy;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelAcc = 0; }, 150);
  if (Math.abs(wheelAcc) >= 16) {
    scrollBy(wheelAcc > 0 ? 1 : -1, v);
    wheelAcc = 0;
  }
}

// Safari reports trackpad pinch as gesture events instead of ctrl+wheel
let gestureScale = 1;
function onGestureStart(e) {
  e.preventDefault();
  gestureScale = 1;
}
function onGestureChange(e) {
  e.preventDefault();
  const v = viewportFromEvent(e);
  if (!v || !v.loaded) return;
  const step = (e.scale - gestureScale) * 1.5;
  gestureScale = e.scale;
  zoomAt(v, step, e.clientX, e.clientY);
}

function probeAt(v, clientX, clientY) {
  const vl = viewLayer(groupOf(v));
  if (!vl) return null;
  const vc = vl.getViewController();
  const rect = $(v.divId).getBoundingClientRect();
  const planePos = vl.displayToPlanePos(new dwv.Point2D(clientX - rect.left, clientY - rect.top));
  const pos = vc.getPositionFromPlanePoint(planePos);
  if (!vc.isPositionInBounds(pos)) return null;
  const index = vc.getIndexFromPosition(pos);
  const value = vc.getRescaledImageValue(pos);
  return {x: index.get(0), y: index.get(1), value, unit: vc.getPixelUnit?.() || ''};
}

function onPointerMove(e) {
  const v = viewportFromEvent(e);
  if (!v || !v.loaded) return;
  let text = '';
  try {
    const p = probeAt(v, e.clientX, e.clientY);
    if (p) {
      const val = typeof p.value === 'number' ? ` = ${Math.round(p.value * 10) / 10}${p.unit ? ' ' + p.unit : ''}` : '';
      text = `x ${p.x}  y ${p.y}${val}`;
    }
  } catch {
    text = '';
  }
  const next = text ? {view: v.index, text} : null;
  if (JSON.stringify(next) !== JSON.stringify(state.probe)) {
    state.probe = next;
    scheduleUiUpdate();
  }
}

function onKey(e) {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    if (e.key === 'Enter' && e.target.id === 'calInput') applyCalibration();
    return;
  }
  if (!$('help').hidden) {
    if (e.key === 'Escape' || e.key === '?') $('help').hidden = true;
    return;
  }
  const v = vp();
  if (!v.app) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) v.app.redo(); else v.app.undo();
    scheduleMeasureUpdate();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key;
  const handled = () => e.preventDefault();
  switch (key) {
  case 'ArrowUp': case 'ArrowLeft': scrollBy(-1); handled(); return;
  case 'ArrowDown': case 'ArrowRight': scrollBy(1); handled(); return;
  case 'PageUp': scrollBy(-10); handled(); return;
  case 'PageDown': scrollBy(10); handled(); return;
  case 'Home': goToImage(0); handled(); return;
  case 'End': goToImage(1e9); handled(); return;
  case '[': if (v.series > 0) loadSeries(v.series - 1); return;
  case ']': if (v.series < state.series.length - 1) loadSeries(v.series + 1); return;
  case ' ': togglePlay(); handled(); return;
  case '?': $('help').hidden = false; return;
  case 'Tab':
    if (state.layout === 2) {
      setActive(1 - state.active);
      handled();
    }
    return;
  case 'Escape':
    if (!$('wlPanel').hidden) toggleWlPanel();
    else if (state.locator) {
      state.locator = null;
      scheduleUiUpdate();
    } else if (state.panel) setPanel(state.panel);
    return;
  case 'Delete': case 'Backspace': {
    // dwv's draw tool deletes the selected shape itself; make sure it is gone
    const uid = state.selected;
    setTimeout(() => {
      for (const w of shown()) {
        if (uid && annotations(w).some(({annotation: a}) => a.trackingUid === uid)) deleteAnnotation(uid, w);
      }
      state.selected = null;
      scheduleMeasureUpdate();
    }, 0);
    handled();
    return;
  }
  }
  if (!v.loaded) return;
  const tools = {w: 'WindowLevel', p: 'ZoomAndPan', s: 'Scroll', m: 'Ruler', d: 'Ruler', a: 'Protractor', e: 'Ellipse', b: 'Rectangle', o: 'Ratio'};
  const k = key.toLowerCase();
  if (tools[k]) {
    chooseTool(tools[k]);
    return;
  }
  switch (k) {
  case 'i': toggleInvert(); return;
  case 'r': resetView(); return;
  case 't': setPanel('tags'); return;
  case 'l': setPanel('measure'); return;
  case 'f': toggleSidebar(); return;
  case 'g': toggleSmoothing(); return;
  case 'x': exportPng(); return;
  case 'v': setLayout(state.layout === 2 ? 1 : 2); return;
  case 'c': toggleWlPanel(); return;
  case 'y': toggleSync(); return;
  case 'k': toggleLevels(); return;
  }
  if (/^[1-9]$/.test(key)) {
    const sel = $('presetSelect');
    const opt = sel.options[parseInt(key, 10) - 1];
    if (opt && !sel.disabled) {
      sel.value = opt.value;
      applyPreset(opt.value);
    }
  }
}

function chooseTool(name) {
  setTool(name);
  if (TOOLS[name].shape && !state.panel) setPanel('measure');
  if (name === 'Ratio') {
    toast('Ratio: draw two distances. The panel shows the first ÷ the second; you can change which ones.');
  }
}

function toggleLevels() {
  state.allLevels = !state.allLevels;
  savePref('allLevels', state.allLevels);
  updateButtons();
  scheduleUiUpdate();
}

function toggleSync() {
  state.sync = !state.sync;
  if (state.sync) syncFrom(vp());
  updateButtons();
}

function toggleSmoothing() {
  state.smooth = !state.smooth;
  savePref('smooth', state.smooth);
  for (const v of shown()) {
    if (v.loaded) v.app.setImageSmoothing(state.smooth);
  }
  toast(state.smooth ? 'Smooth display on' : 'Smooth display off: individual pixels visible');
}

function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
}

function bindUi() {
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => chooseTool(b.dataset.tool));
  }
  $('presetSelect').addEventListener('change', (e) => {
    applyPreset(e.target.value);
    e.target.blur();
  });
  $('invertBtn').addEventListener('click', toggleInvert);
  $('playBtn').addEventListener('click', togglePlay);
  $('resetBtn').addEventListener('click', resetView);
  $('layoutBtn').addEventListener('click', () => setLayout(state.layout === 2 ? 1 : 2));
  $('syncBtn').addEventListener('click', toggleSync);
  $('levelsBtn').addEventListener('click', toggleLevels);
  $('wlBtn').addEventListener('click', toggleWlPanel);
  for (const id of ['wlBrightness', 'wlContrast', 'wlLevel', 'wlWidth']) $(id).addEventListener('input', onWlInput);
  $('wlReset').addEventListener('click', () => vcOf(vp())?.resetWindowLevel());
  $('wlClose').addEventListener('click', toggleWlPanel);
  $('tagsBtn').addEventListener('click', () => setPanel('tags'));
  $('measureBtn').addEventListener('click', () => setPanel('measure'));
  $('exportBtn').addEventListener('click', exportPng);
  $('sidebarBtn').addEventListener('click', toggleSidebar);
  $('panelClose').addEventListener('click', () => setPanel(state.panel));
  $('clearBtn').addEventListener('click', clearMeasures);
  $('calApply').addEventListener('click', applyCalibration);
  $('calReset').addEventListener('click', resetCalibration);
  $('ratioA').addEventListener('change', (e) => { state.ratio.a = e.target.value; renderMeasurements(); });
  $('ratioB').addEventListener('change', (e) => { state.ratio.b = e.target.value; renderMeasurements(); });
  $('ratioSwap').addEventListener('click', () => {
    state.ratio = {a: state.ratio.b, b: state.ratio.a};
    renderMeasurements();
  });
  $('tagFilter').addEventListener('input', renderTags);
  $('helpBtn').addEventListener('click', () => { $('help').hidden = false; });
  $('helpClose').addEventListener('click', () => { $('help').hidden = true; });
  $('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').hidden = true; });
  $('sliceSlider').addEventListener('input', (e) => goToImage(parseFloat(e.target.value)));

  const viewers = $('viewers');
  viewers.addEventListener('wheel', onWheel, {capture: true, passive: false});
  viewers.addEventListener('gesturestart', onGestureStart, {capture: true});
  viewers.addEventListener('gesturechange', onGestureChange, {capture: true});
  viewers.addEventListener('pointerdown', (e) => {
    const v = viewportFromEvent(e);
    if (v) setActive(v.index);
  }, {capture: true});
  viewers.addEventListener('dblclick', (e) => {
    const v = viewportFromEvent(e);
    if (!v || !v.loaded) return;
    e.stopPropagation(); // dwv would start cine playback
    locate(v, e.clientX, e.clientY);
  }, {capture: true});
  viewers.addEventListener('pointermove', onPointerMove);
  viewers.addEventListener('pointerleave', () => {
    if (state.probe) {
      state.probe = null;
      scheduleUiUpdate();
    }
  });
  viewers.addEventListener('pointerup', scheduleMeasureUpdate);
  // series dragged from the list onto a view
  viewers.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/x-series') && viewportFromEvent(e)) e.preventDefault();
  });
  viewers.addEventListener('drop', (e) => {
    const v = viewportFromEvent(e);
    const i = parseInt(e.dataTransfer.getData('text/x-series'), 10);
    if (!v || !Number.isFinite(i)) return;
    e.preventDefault();
    setActive(v.index);
    loadSeries(i, v);
  });
  // stop the page itself from zooming on pinch outside the viewer
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') scheduleMeasureUpdate();
  });

  let resizeRaf;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      for (const v of shown()) {
        if (v.loaded) v.app.onResize();
      }
      updateOverlays();
    });
  }).observe(viewers);

  for (const id of ['folderInput', 'filesInput']) {
    $(id).addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      await openFiles(files);
    });
  }
  bindFileDrop();
}

async function openFiles(files) {
  if (!files.length) return;
  try {
    const hadScans = state.series.length > 0;
    const items = await indexFromFiles(files);
    const none = `No DICOM images found in the ${files.length} file${files.length === 1 ? '' : 's'} you picked.`;
    if (!items.length && hadScans) {
      // keep what is open
      $('empty').hidden = true;
      toast(none);
      return;
    }
    showSeries(items, none);
  } catch (e) {
    console.error(e);
    setEmpty('Could not read those files: ' + e.message, undefined, true);
  }
}

// files or folders dragged from Finder onto the window
function bindFileDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) $('dropHint').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('dropHint').hidden = true;
    const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    const files = entries.length ? await filesFromEntries(entries) : [...e.dataTransfer.files];
    await openFiles(files);
  });
}

// read dropped folders recursively
async function filesFromEntries(entries) {
  const out = [];
  async function visit(entry, path) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', {value: path + file.name});
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, `${path}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await visit(entry, '');
  return out;
}

function showSeries(items, emptyMsg) {
  for (const v of VIEWPORTS) {
    disposeApp(v.app);
    Object.assign(v, {app: null, series: -1, loaded: false, flip: false});
  }
  state.locator = null;
  state.active = 0;
  state.sopIndex = new Map(items.map((it) => [it.sop, it]));
  state.series = groupSeries(items);
  renderPatient(items);
  renderSeriesList();
  updateButtons();
  updateUi();
  renderMeasurements();
  if (!state.series.length) {
    setEmpty(emptyMsg, undefined, true);
    return;
  }
  // start with the largest CT/MR series, else the first one
  let start = 0;
  let best = -1;
  state.series.forEach((s, i) => {
    if (['CT', 'MR'].includes(s.first.modality) && !s.isReference && s.images > best) {
      best = s.images;
      start = i;
    }
  });
  loadSeries(start, VIEWPORTS[0]);
  if (state.layout === 2) loadSeries(companionSeries(start), VIEWPORTS[1]);
}

// ---------------------------------------------------------------------------

// let the local server know a viewer tab is still open (it can quit when idle)
function startHeartbeat() {
  const ping = () => fetch('api/ping', {cache: 'no-store'}).catch(() => {});
  setInterval(ping, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();
  });
}

async function main() {
  startHeartbeat();
  bindUi();
  updateButtons();
  try {
    const items = await indexFromServer();
    if (!items) {
      setEmpty('Choose a folder with DICOM images, for example a copied CD.', undefined, true);
      return;
    }
    showSeries(items, 'No DICOM images found. Use “Open folder…” to pick a folder.');
  } catch (e) {
    console.error(e);
    setEmpty('Could not read the scans: ' + e.message);
  }
}

main();
