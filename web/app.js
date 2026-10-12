// DICOM viewer built on dwv (https://github.com/ivmartel/dwv, GPL-3.0).
import * as dwv from './vendor/dwv/dwv.min.js';
import {walk, withValues, rawValue, decodeIso2022} from './dicom.js';

dwv.logger.level = dwv.logger.levels.ERROR;

const $ = (id) => document.getElementById(id);
const GROUP_IDS = ['layerGroup0'];
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
};

const state = {
  series: [],
  current: -1,
  tool: 'WindowLevel',
  loaded: false,
  activeGroup: 0,
  flip: false, // dwv index order is the reverse of the instance order
  sopIndex: new Map(),
  probe: null,
  selected: null, // uid of the selected measurement
  panel: null, // 'measure' | 'tags' | null
  calibrations: loadCalibrations(),
  smooth: loadPref('smooth', true), // interpolated display (looks only, measurements unaffected)
};

let app = null;

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
// dwv app

function viewConfigs() {
  return {'*': [new dwv.ViewConfig(GROUP_IDS[0])]};
}

function toolOptions() {
  return {
    Scroll: new dwv.ToolConfig(),
    WindowLevel: new dwv.ToolConfig(),
    ZoomAndPan: new dwv.ToolConfig(),
    Draw: new dwv.ToolConfig(['Ruler', 'Protractor', 'Ellipse', 'Rectangle', 'Arrow']),
  };
}

// A new dwv App for every series: App.reset() does not release loaded data.
function disposeApp(a) {
  if (!a) return;
  a.abortAllLoads();
  a.reset();
  // dwv registers a window keydown listener per app: remove it
  a.getToolboxController()?.enableShortcuts(false);
}

function createApp() {
  disposeApp(app);
  state.selected = null;
  // fresh layer group elements, without any state left by the previous app
  for (const id of GROUP_IDS) {
    const old = $(id);
    const fresh = old.cloneNode(false);
    fresh.removeAttribute('style');
    old.replaceWith(fresh);
  }
  const a = new dwv.App();
  const options = new dwv.AppOptions(viewConfigs());
  options.tools = toolOptions();
  a.init(options);

  a.addEventListener('loadstart', () => showProgress(0));
  a.addEventListener('loadprogress', (e) => {
    if (e.lengthComputable) showProgress(e.loaded / e.total);
  });
  a.addEventListener('load', () => {
    if (a !== app) return;
    state.loaded = true;
    onSeriesLoaded();
  });
  a.addEventListener('loadend', () => showProgress(null));
  a.addEventListener('error', (e) => {
    if (a !== app) return;
    console.error('dwv error', e.error || e);
    const msg = (e.error && e.error.message) || 'Could not display this series';
    if (!msg.startsWith('Render error')) a.abortAllLoads();
    toast(msg);
  });
  for (const type of ['positionchange', 'wlchange', 'colourmapchange', 'zoomchange', 'offsetchange']) {
    a.addEventListener(type, scheduleUiUpdate);
  }
  for (const type of ['annotationadd', 'annotationupdate', 'annotationremove', 'drawcreate', 'drawchange', 'drawdelete']) {
    a.addEventListener(type, scheduleMeasureUpdate);
  }
  a.addEventListener('annotationselect', (e) => {
    state.selected = e.annotationid;
    scheduleMeasureUpdate();
  });
  window.dwvApp = a; // handy for debugging from the browser console
  return a;
}

function groups() {
  if (!app) return [];
  const list = [];
  for (let i = 0; i < GROUP_IDS.length; ++i) {
    const g = app.getLayerGroupByDivId(GROUP_IDS[i]);
    if (g) list.push(g);
  }
  return list;
}

function activeGroup() {
  if (!app) return undefined;
  return app.getLayerGroupByDivId(GROUP_IDS[state.activeGroup]) ||
    app.getLayerGroupByDivId(GROUP_IDS[0]);
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

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function loadSeries(index) {
  const s = state.series[index];
  if (!s) return;
  state.current = index;
  state.loaded = false;
  state.flip = false;
  state.activeGroup = 0;
  state.probe = null;
  app = createApp();
  for (const b of document.querySelectorAll('.series')) {
    b.classList.toggle('active', b.dataset.index === String(index));
  }
  document.querySelector('.series.active')?.scrollIntoView({block: 'nearest'});
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
  app.loadImageObject(data);
}

function onSeriesLoaded() {
  const s = state.series[state.current];
  app.setActiveLayerGroup(state.activeGroup);
  // number images in acquisition (instance) order and start at the first one
  const g = activeGroup();
  const vc = viewController(g);
  const ph = g && g.getPositionHelper();
  if (vc && ph && ph.getMaximumScrollValue() > 0 && s.items.length > 1) {
    const first = vc.getOriginForImageUid(s.items[0].sop);
    const last = vc.getOriginForImageUid(s.items[s.items.length - 1].sop);
    const p0 = ph.getCurrentPositionAtScrollValue(0).getValues();
    const dist = (o) => (o ? Math.hypot(o.getX() - p0[0], o.getY() - p0[1], o.getZ() - p0[2]) : Infinity);
    state.flip = dist(first) > dist(last);
    setSliceIndex(state.flip ? ph.getMaximumScrollValue() : 0, g);
  }
  app.setImageSmoothing(state.smooth);
  setTool(state.tool);
  fillPresets();
  updateButtons();
  updateUi();
  renderMeasurements();
  queueThumbnails();
}

// ---------------------------------------------------------------------------
// tools & actions

function setTool(name) {
  if (!TOOLS[name]) return;
  state.tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === name);
  }
  if (!state.loaded) return;
  const t = TOOLS[name];
  app.setTool(t.dwv);
  if (t.shape) app.setToolFeatures({shapeName: t.shape});
  $('viewers').dataset.tool = name;
}

function fillPresets() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  const vc = viewController(activeGroup());
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
  const vc = viewController(activeGroup());
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
  for (const g of groups()) {
    const vc = viewController(g);
    if (vc && vc.getWindowLevelPresetsNames().includes(name)) vc.setWindowLevelPreset(name);
  }
}

function toggleInvert() {
  for (const g of groups()) {
    const vc = viewController(g);
    if (!vc || !vc.isMonochrome()) continue;
    vc.setColourMap(vc.getColourMap() === 'invPlain' ? 'plain' : 'invPlain');
  }
  updateButtons();
}

function resetView() {
  stopPlay();
  if (!app) return;
  app.resetZoomPan();
  for (const g of groups()) {
    const vc = viewController(g);
    if (vc) vc.resetWindowLevel();
  }
  updateUi();
}

function togglePlay() {
  const vc = viewController(activeGroup());
  if (!vc || !activeGroup().canScroll()) return;
  if (vc.isPlaying()) vc.stop(); else vc.play();
  updateButtons();
}

function stopPlay() {
  for (const g of groups()) {
    const vc = viewController(g);
    if (vc && vc.isPlaying()) vc.stop();
  }
  updateButtons();
}

function flipFor(group) {
  return state.flip && group === activeGroup();
}

// delta in acquisition order (+1 = next image)
function scrollBy(delta, group = activeGroup()) {
  if (!group || !state.loaded) return;
  const ph = group.getPositionHelper();
  if (!ph) return;
  if (flipFor(group)) delta = -delta;
  setSliceIndex(ph.getCurrentPositionScrollValue() + delta, group);
}

function setSliceIndex(value, group = activeGroup()) {
  const ph = group && group.getPositionHelper();
  if (!ph) return;
  const max = ph.getMaximumScrollValue();
  const v = Math.max(0, Math.min(max, Math.round(value)));
  if (v === ph.getCurrentPositionScrollValue()) return;
  ph.setCurrentPosition(ph.getCurrentPositionAtScrollValue(v));
}

// 0-based image number in acquisition order
function displayIndex(group) {
  const ph = group.getPositionHelper();
  const max = ph.getMaximumScrollValue();
  const cur = ph.getCurrentPositionScrollValue();
  return {cur: flipFor(group) ? max - cur : cur, max};
}

function goToImage(n) {
  const g = activeGroup();
  const ph = g && g.getPositionHelper();
  if (!ph) return;
  const max = ph.getMaximumScrollValue();
  setSliceIndex(flipFor(g) ? max - n : n, g);
}

// ---------------------------------------------------------------------------
// measurements

function drawLayers() {
  if (!app || !state.loaded) return [];
  try {
    return app.getDrawLayers();
  } catch {
    return [];
  }
}

function annotations() {
  const list = [];
  const seen = new Set();
  for (const layer of drawLayers()) {
    const group = layer.getDrawController().getAnnotationGroup();
    for (const a of group.getList()) {
      if (seen.has(a.trackingUid)) continue;
      seen.add(a.trackingUid);
      list.push({annotation: a, layer});
    }
  }
  return list;
}

function describe(a) {
  const q = a.quantification || {};
  const unit = (u) => (u === 'unit.mm' ? 'mm' : u === 'unit.cm2' ? 'cm²' : u === 'unit.degree' ? '°' : 'px');
  const rows = [];
  let kind = 'Arrow';
  if (q.length) {
    kind = 'Distance';
    const u = unit(q.length.unit);
    rows.push([`${fmt(q.length.value, u === 'mm' ? 2 : 1)} ${u}`, true]);
  }
  if (q.angle) {
    kind = 'Angle';
    rows.push([`${fmt(q.angle.value, 1)}°`, true]);
  }
  if (q.surface) {
    kind = q.a ? 'Ellipse' : q.radius ? 'Circle' : 'Rectangle';
    const u = unit(q.surface.unit);
    rows.push([`Area ${fmt(q.surface.value, 2)} ${u}`, true]);
    if (q.a && q.b) rows.push([`Axes ${fmt(q.a.value * 2, 1)} × ${fmt(q.b.value * 2, 1)} ${unit(q.a.unit)}`]);
    if (q.width && q.height) rows.push([`${fmt(q.width.value, 1)} × ${fmt(q.height.value, 1)} ${unit(q.width.unit)}`]);
  }
  const pu = state.series[state.current]?.first.modality === 'CT' ? ' HU' : '';
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

function renderMeasurements() {
  const s = state.series[state.current];
  const box = $('measureList');
  const calBox = $('calibration');
  if (!s) {
    box.innerHTML = '';
    calBox.innerHTML = '';
    return;
  }
  const info = spacingInfo(s);
  const sp = info.spacing;
  calBox.className = `calibration cal-${info.kind}`;
  calBox.innerHTML = `
    <div><b>Scale:</b> ${sp ? `${fmt(sp[1], 4)} × ${fmt(sp[0], 4)} mm per pixel` : 'unknown'}</div>
    <div class="muted">${escapeHtml(info.label)}</div>`;

  const list = annotations();
  $('measureCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    box.innerHTML = `<div class="muted hint">Pick <b>Distance</b>, <b>Angle</b>, <b>Ellipse</b> or
      <b>Rectangle</b> above and drag on the image. Click a measurement to move its end points,
      press Delete to remove it.</div>`;
  } else {
    box.innerHTML = '';
    list.forEach(({annotation: a}, i) => {
      const {kind, rows} = describe(a);
      const item = document.createElement('div');
      item.className = 'measure' + (a.trackingUid === state.selected ? ' selected' : '');
      const where = imageNumberFor(a);
      item.innerHTML = `
        <div class="measure-head"><span>${i + 1}. ${kind}${where ? ` <span class="muted">· image ${where}</span>` : ''}</span>
          <button class="icon" title="Delete">✕</button></div>
        ${rows.map(([t, big]) => `<div class="${big ? 'measure-value' : 'muted'}">${escapeHtml(t)}</div>`).join('')}`;
      item.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAnnotation(a.trackingUid);
      });
      item.addEventListener('click', () => showAnnotation(a));
      box.appendChild(item);
    });
  }

  // calibration controls
  const lastDistance = [...list].reverse().find(({annotation: a}) => a.quantification?.length);
  const canCal = info.kind !== 'patient' || state.calibrations[s.key];
  $('calForm').hidden = !canCal;
  $('calApply').disabled = !lastDistance;
  $('calHint').textContent = lastDistance ?
    `Enter the real length of distance #${list.indexOf(lastDistance) + 1} (e.g. a ruler or coin in the image):` :
    'To calibrate, first draw a distance over something of known size.';
  $('calReset').hidden = !state.calibrations[s.key];
}

function imageNumberFor(a) {
  const s = state.series[state.current];
  if (!s || !a.referencedSopInstanceUID) return '';
  const idx = s.items.findIndex((it) => it.sop === a.referencedSopInstanceUID);
  return idx >= 0 && s.items.length > 1 ? String(idx + 1) : '';
}

function showAnnotation(a) {
  const s = state.series[state.current];
  if (!s) return;
  const idx = s.items.findIndex((it) => it.sop === a.referencedSopInstanceUID);
  if (idx >= 0) goToImage(idx);
}

function deleteAnnotation(uid) {
  for (const layer of drawLayers()) {
    const dc = layer.getDrawController();
    if (dc.getAnnotation(uid)) {
      dc.removeAnnotationWithCommand(uid, app.addToUndoStack); // undo with ⌘Z
      layer.draw?.();
    }
  }
  scheduleMeasureUpdate();
}

function clearMeasures() {
  for (const layer of drawLayers()) {
    const dc = layer.getDrawController();
    for (const a of [...dc.getAnnotationGroup().getList()]) dc.removeAnnotationWithCommand(a.trackingUid, app.addToUndoStack);
    layer.draw?.();
  }
  scheduleMeasureUpdate();
}

function applyCalibration() {
  const s = state.series[state.current];
  const real = parseFloat($('calInput').value.replace(',', '.'));
  const list = annotations();
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
  loadSeries(state.current);
}

function resetCalibration() {
  const s = state.series[state.current];
  if (!s) return;
  delete state.calibrations[s.key];
  saveCalibrations();
  loadSeries(state.current);
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
  if (state.panel === 'tags') renderTags();
}

function updateSlider() {
  const g = activeGroup();
  const ph = g && state.loaded && g.getPositionHelper();
  const slider = $('sliceSlider');
  if (!ph) {
    slider.disabled = true;
    $('sliceLabel').textContent = '';
    return;
  }
  const {cur, max} = displayIndex(g);
  slider.max = String(max);
  slider.value = String(cur);
  slider.disabled = max < 1;
  $('sliceLabel').textContent = `${cur + 1} / ${max + 1}`;
}

function currentItem(group = activeGroup()) {
  const vc = viewController(group);
  if (!vc) return undefined;
  try {
    return state.sopIndex.get(vc.getCurrentImageUid());
  } catch {
    return undefined;
  }
}

// orientation letters for a patient space direction (LPS)
function directionLetters(v) {
  const parts = [
    [v[0], 'L', 'R'],
    [v[1], 'P', 'A'],
    [v[2], 'S', 'I'],
  ].filter(([c]) => Math.abs(c) > 0.3).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return parts.map(([c, pos, neg]) => (c > 0 ? pos : neg)).join('');
}

const PO_OPPOSITE = {L: 'R', R: 'L', A: 'P', P: 'A', H: 'F', F: 'H', S: 'I', I: 'S'};

// The image is shown as stored (see bufferFor), so the markers follow
// directly from the row / column directions of the file.
function orientationMarkers(s) {
  if (s.stacked) return null;
  const f = s.first;
  if (f.iop.length === 6 && f.iop.every(Number.isFinite)) {
    const row = f.iop.slice(0, 3);
    const col = f.iop.slice(3, 6);
    return {
      right: directionLetters(row),
      left: directionLetters(row.map((v) => -v)),
      bottom: directionLetters(col),
      top: directionLetters(col.map((v) => -v)),
    };
  }
  const po = f.patientOrientation.split('\\');
  if (po.length === 2 && po[0] && po[1]) {
    const opp = (t) => [...t].map((c) => PO_OPPOSITE[c] || c).join('');
    return {right: po[0], bottom: po[1], left: opp(po[0]), top: opp(po[1])};
  }
  return null;
}

function updateOverlays() {
  const s = state.series[state.current];
  const container = $('overlays');
  container.innerHTML = '';
  if (!s || !state.loaded) return;
  const host = $('viewers').getBoundingClientRect();
  const spInfo = spacingInfo(s);
  groups().forEach((g, i) => {
    const div = $(GROUP_IDS[i]);
    const r = div.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'ovbox';
    box.style.cssText = `left:${r.left - host.left}px;top:${r.top - host.top}px;width:${r.width}px;height:${r.height}px;`;
    const vc = viewController(g);
    const it = currentItem(g) || s.first;
    const f = s.first;

    const tl = [];
    if (i === 0) {
      tl.push(f.patientName);
      tl.push([f.patientId && `ID ${f.patientId}`, f.sex, formatAge(f.age)].filter(Boolean).join('  '));
      tl.push(formatDate(f.studyDate || f.seriesDate));
    }
    const tr = [`${f.modality}  ${s.title}`];
    if (Number.isFinite(f.seriesNumber)) tr.push(`Series ${f.seriesNumber}`);
    if (s.stacked) tr.push('Angled slices shown as a stack');
    const ph = g.getPositionHelper();
    if (ph && ph.getMaximumScrollValue() > 0) {
      const {cur, max} = displayIndex(g);
      tr.push(`Image ${cur + 1} / ${max + 1}`);
    }

    const bl = [];
    if (state.probe && state.probe.group === i) bl.push(state.probe.text);
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
    if (i === 0) {
      br.push(spInfo.spacing ? `${fmt(spInfo.spacing[1], 3)} mm/px${spInfo.kind === 'patient' ? '' : spInfo.kind === 'user' ? ' (calibrated)' : spInfo.kind === 'detector' ? ' (detector)' : ' (unreliable)'}` : 'Not calibrated (px)');
    }

    for (const [pos, lines] of [['tl', tl], ['tr', tr], ['bl', bl], ['br', br]]) {
      const text = lines.filter(Boolean).join('\n');
      if (!text) continue;
      const o = document.createElement('div');
      o.className = `ov ${pos}`;
      o.textContent = text;
      box.appendChild(o);
    }
    const marks = orientationMarkers(s);
    if (marks) {
      for (const side of ['top', 'bottom', 'left', 'right']) {
        if (!marks[side]) continue;
        const m = document.createElement('div');
        m.className = `orient ${side}`;
        m.textContent = marks[side];
        box.appendChild(m);
      }
    }
    container.appendChild(box);
  });
}

function updateButtons() {
  const loaded = state.loaded;
  const vc = loaded ? viewController(activeGroup()) : undefined;
  const playing = !!vc && vc.isPlaying();
  $('playBtn').disabled = !loaded || !activeGroup()?.canScroll();
  $('playBtn').classList.toggle('on', playing);
  $('playBtn').textContent = playing ? 'Stop' : 'Play';
  $('invertBtn').disabled = !loaded || !vc || !vc.isMonochrome();
  $('invertBtn').classList.toggle('on', !!vc && vc.getColourMap() === 'invPlain');
  for (const id of ['resetBtn', 'exportBtn']) $(id).disabled = !loaded;
  for (const b of document.querySelectorAll('[data-tool]')) b.disabled = !loaded;
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
    b.className = 'series' + (i === state.current ? ' active' : '') + (s.isReference ? ' reference' : '');
    b.dataset.index = String(i);
    b.title = s.title;
    const thumb = s.thumb ?
      `<img class="thumb" src="${s.thumb}" alt="">` :
      `<div class="thumb">${escapeHtml(f.modality)}</div>`;
    b.innerHTML = `${thumb}<div class="series-meta">
      <div class="series-title"><span class="badge ${escapeHtml(f.modality)}">${escapeHtml(f.modality)}</span>${escapeHtml(s.title)}</div>
      <div class="series-sub">${s.images} image${s.images === 1 ? '' : 's'} · ${f.cols}×${f.rows}</div>
    </div>`;
    b.addEventListener('click', () => loadSeries(i));
    list.appendChild(b);
  });
  const active = list.querySelector('.series.active');
  if (active) active.scrollIntoView({block: 'nearest'});
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
  const it = currentItem() || state.series[state.current]?.first;
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
// export the current view as PNG (image + measurements + overlay text)

function exportPng() {
  const i = state.activeGroup;
  const div = $(GROUP_IDS[i]);
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
  const box = $('overlays').children[i];
  if (box) {
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
  const s = state.series[state.current];
  const {cur} = displayIndex(activeGroup());
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
    a.loadImageObject([{name: item.name, filename: item.name, data: bufferFor(s, item, index, 1)}]);
  });
}

// ---------------------------------------------------------------------------
// input: trackpad / mouse wheel, pinch, pixel probe, keyboard

function groupFromEvent(e) {
  const div = e.target.closest && e.target.closest('.layerGroup');
  if (!div || !app) return null;
  const i = GROUP_IDS.indexOf(div.id);
  return i < 0 ? null : {index: i, div, group: app.getLayerGroupByDivId(div.id)};
}

function focusGroup(index) {
  if (index === state.activeGroup) return;
  state.activeGroup = index;
  app.setActiveLayerGroup(index);
  fillPresets();
  updateButtons();
  updateUi();
}

function zoomAt(group, div, step, clientX, clientY) {
  const vl = viewLayer(group);
  if (!vl) return;
  const rect = div.getBoundingClientRect();
  const p = vl.displayToMainPlanePos(new dwv.Point2D(clientX - rect.left, clientY - rect.top));
  const center = vl.getViewController().getPlanePositionFromPlanePoint(p);
  group.addScale(step, center);
  group.draw();
  scheduleUiUpdate();
}

let wheelAcc = 0;
let wheelResetTimer;
function onWheel(e) {
  const hit = groupFromEvent(e);
  if (!hit || !hit.group || !state.loaded) return;
  // take over from dwv so trackpads scroll smoothly and pinch zooms
  e.preventDefault();
  e.stopPropagation();
  focusGroup(hit.index);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey || e.metaKey) {
    // trackpad pinch arrives as ctrl+wheel (Chrome, Firefox); cmd+wheel for mice
    const step = Math.max(-0.5, Math.min(0.5, -dy * (e.ctrlKey ? 0.01 : 0.002)));
    zoomAt(hit.group, hit.div, step, e.clientX, e.clientY);
    return;
  }
  wheelAcc += dy;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelAcc = 0; }, 150);
  if (Math.abs(wheelAcc) >= 16) {
    scrollBy(wheelAcc > 0 ? 1 : -1, hit.group);
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
  const hit = groupFromEvent(e);
  if (!hit || !hit.group || !state.loaded) return;
  const step = (e.scale - gestureScale) * 1.5;
  gestureScale = e.scale;
  zoomAt(hit.group, hit.div, step, e.clientX, e.clientY);
}

function probeAt(clientX, clientY, hit) {
  const vl = viewLayer(hit.group);
  if (!vl) return null;
  const vc = vl.getViewController();
  const rect = hit.div.getBoundingClientRect();
  const planePos = vl.displayToPlanePos(new dwv.Point2D(clientX - rect.left, clientY - rect.top));
  const pos = vc.getPositionFromPlanePoint(planePos);
  if (!vc.isPositionInBounds(pos)) return null;
  const index = vc.getIndexFromPosition(pos);
  const value = vc.getRescaledImageValue(pos);
  return {x: index.get(0), y: index.get(1), value, unit: vc.getPixelUnit?.() || ''};
}

function onPointerMove(e) {
  const hit = groupFromEvent(e);
  if (!hit || !hit.group || !state.loaded) return;
  let text = '';
  try {
    const p = probeAt(e.clientX, e.clientY, hit);
    if (p) {
      const v = typeof p.value === 'number' ? ` = ${Math.round(p.value * 10) / 10}${p.unit ? ' ' + p.unit : ''}` : '';
      text = `x ${p.x}  y ${p.y}${v}`;
    }
  } catch {
    text = '';
  }
  const next = text ? {group: hit.index, text} : null;
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
  if (!app) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) app.redo(); else app.undo();
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
  case '[': if (state.current > 0) loadSeries(state.current - 1); return;
  case ']': if (state.current < state.series.length - 1) loadSeries(state.current + 1); return;
  case ' ': togglePlay(); handled(); return;
  case '?': $('help').hidden = false; return;
  case 'Escape': if (state.panel) setPanel(state.panel); return;
  case 'Delete': case 'Backspace': {
    // dwv's draw tool deletes the selected shape itself; make sure it is gone
    const uid = state.selected;
    setTimeout(() => {
      if (uid && annotations().some(({annotation: a}) => a.trackingUid === uid)) deleteAnnotation(uid);
      state.selected = null;
      scheduleMeasureUpdate();
    }, 0);
    handled();
    return;
  }
  }
  if (!state.loaded) return;
  const tools = {w: 'WindowLevel', p: 'ZoomAndPan', s: 'Scroll', m: 'Ruler', d: 'Ruler', a: 'Protractor', e: 'Ellipse', b: 'Rectangle'};
  const k = key.toLowerCase();
  if (tools[k]) {
    setTool(tools[k]);
    if (TOOLS[tools[k]].shape && !state.panel) setPanel('measure');
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

function toggleSmoothing() {
  state.smooth = !state.smooth;
  savePref('smooth', state.smooth);
  if (app && state.loaded) app.setImageSmoothing(state.smooth);
  toast(state.smooth ? 'Smooth display on' : 'Smooth display off: individual pixels visible');
}

function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
}

function bindUi() {
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => {
      setTool(b.dataset.tool);
      if (TOOLS[b.dataset.tool].shape && !state.panel) setPanel('measure');
    });
  }
  $('presetSelect').addEventListener('change', (e) => {
    applyPreset(e.target.value);
    e.target.blur();
  });
  $('invertBtn').addEventListener('click', toggleInvert);
  $('playBtn').addEventListener('click', togglePlay);
  $('resetBtn').addEventListener('click', resetView);
  $('tagsBtn').addEventListener('click', () => setPanel('tags'));
  $('measureBtn').addEventListener('click', () => setPanel('measure'));
  $('exportBtn').addEventListener('click', exportPng);
  $('sidebarBtn').addEventListener('click', toggleSidebar);
  $('panelClose').addEventListener('click', () => setPanel(state.panel));
  $('clearBtn').addEventListener('click', clearMeasures);
  $('calApply').addEventListener('click', applyCalibration);
  $('calReset').addEventListener('click', resetCalibration);
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
    const hit = groupFromEvent(e);
    if (hit) focusGroup(hit.index);
  }, {capture: true});
  viewers.addEventListener('pointermove', onPointerMove);
  viewers.addEventListener('pointerleave', () => {
    if (state.probe) {
      state.probe = null;
      scheduleUiUpdate();
    }
  });
  viewers.addEventListener('pointerup', scheduleMeasureUpdate);
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
      if (!state.loaded || !app) return;
      app.onResize();
      updateOverlays();
    });
  }).observe(viewers);

  $('folderInput').addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    const items = await indexFromFiles(e.target.files);
    e.target.value = '';
    showSeries(items, 'No DICOM images found in that folder.');
  });
}

function showSeries(items, emptyMsg) {
  disposeApp(app);
  app = null;
  state.loaded = false;
  state.current = -1;
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
  loadSeries(start);
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
