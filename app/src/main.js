// DICOM Mobile: app shell, tools, measurements, two views with reference lines.
import {Loader, MOBILE} from './engine/loader.js';
import {entriesFromFiles, entriesFromUrls, filesFromDrop, parseGoogleDriveUrl} from './engine/import.js';
import {makeItems, groupSeries, companionSeries, spacingInfo, windowPresets, formatDate, formatAge, PROJECTION} from './model/study.js';
import {
  planeOf, sameSpace, pixelToPatient, patientToPixel, intersection, nearestSlice, dot, lettersForPixelDirection,
} from './model/geometry.js';
import {Viewport} from './view/viewport.js';
import {attachGestures} from './view/gestures.js';
import {minMaxWindow, percentileWindow, pixelValue, renderPixels, defaultWindow} from './view/render.js';
import {MEASURE_TOOLS, newMeasurement, quantify, drawMeasurement, hitTest} from './view/measure.js';
import {openMenu, closeMenu, isMenuOpen} from './ui/menu.js';
import {initNative, shareBlob, isNative, platform, pickNativeFolder, pickNativeFiles, downloadNativeUrl, onNativeProgress} from './ui/native.js';
import {listSavedStudies, saveStudyToLibrary, updateSavedStudyMeta, loadSavedStudy, deleteSavedStudy, studyIdOf} from './model/library.js';
import {canReconstructMpr, buildMprSeries} from './model/mpr.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const TOUCH = matchMedia('(pointer: coarse)').matches;
const VIEW_COLOURS = ['#4ea1ff', '#ff9f43'];

// ---------------------------------------------------------------------------
// preferences

function loadPref(name, fallback) {
  try {
    const v = localStorage.getItem(`dicomReader.${name}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function savePref(name, value) {
  try {
    localStorage.setItem(`dicomReader.${name}`, JSON.stringify(value));
  } catch {
    // private mode: lasts for this session
  }
}

// ---------------------------------------------------------------------------
// state

const state = {
  series: [],
  layout: 1,
  active: 0,
  tool: loadPref('tool', 'scroll'),
  measureTool: loadPref('measureTool', 'length'),
  sync: true,
  allLevels: loadPref('allLevels', false),
  smooth: loadPref('smooth', true),
  showInfo: loadPref('showInfo', true),
  anonymize: loadPref('anonymize', false),
  locator: null, // {point, frame}
  measurements: [],
  selected: null, // measurement id
  pendingAngle: null, // measurement waiting for its third point
  history: [],
  future: [],
  calibrations: loadPref('calibrations', {}),
  ratio: {a: null, b: null},
  probe: null, // {view, text}
  sheet: null, // name of the open panel
  sourceCount: 0,
  activeStudyId: null,
  lastIndexedEntries: [],
};


const loader = new Loader({dictionaryUrl: `${BASE}dicom-dict.json`});

const vpEls = [...document.querySelectorAll('.vp')];
const vps = vpEls.map((el, index) => new Viewport(el, {
  loader,
  index,
  smooth: () => state.smooth,
  onChange: onViewportChange,
  drawOverlay,
}));

const activeVp = () => vps[state.active];
const shownVps = () => vps.slice(0, state.layout);
const otherVp = (v) => (state.layout === 2 ? vps[1 - v.index] : null);

// ---------------------------------------------------------------------------
// opening files

function setProgress(msg, fraction) {
  $('progress').hidden = msg === null;
  $('emptyActions').hidden = msg !== null;
  if (msg !== null) {
    $('progressMsg').textContent = msg;
    $('progressBar').style.width = `${Math.round((fraction || 0) * 100)}%`;
  }
}

async function openEntries(entries, label = '') {
  if (!entries.length) {
    toast('No DICOM files found there.');
    return;
  }
  showEmpty(true);
  loader.clear();
  setProgress(`Reading ${entries.length} file${entries.length === 1 ? '' : 's'}…`, 0);
  let done = 0;
  const items = [];
  const indexed = [];
  let lastPaint = 0;
  let failed = 0;
  await Promise.all(entries.map((entry) => loader.index(entry).then((meta) => {
    if (meta) {
      entry.frames = meta.file.frames;
      indexed.push({entry, meta});
      items.push(...makeItems(entry, meta));
    }
  }, () => {
    failed++;
  }).finally(() => {
    done++;
    const now = performance.now();
    if (now - lastPaint > 80 || done === entries.length) {
      lastPaint = now;
      setProgress(`Reading files… ${done} / ${entries.length}`, done / entries.length);
    }
  })));
  setProgress(null);
  if (!items.length) {
    showEmpty(true);
    toast(`No images found in ${entries.length} file${entries.length === 1 ? '' : 's'}${failed ? ' (they may not be DICOM)' : ''}.`);
    return;
  }
  state.sourceCount = entries.length;
  state.lastIndexedEntries = indexed;
  const series = groupSeries(items);
  setStudy(series, label);
  if (label !== 'sample') {
    saveStudyToLibrary(series, indexed, state.measurements).then((id) => {
      state.activeStudyId = id;
      toast('Study saved to library');
    }).catch((e) => console.warn('Could not save to library', e));
  }
}

async function openSavedStudy(id) {
  try {
    showEmpty(true);
    setProgress('Opening saved study…', 0.5);
    const doc = await loadSavedStudy(id);
    setProgress(null);
    state.activeStudyId = doc.id;
    state.measurements = doc.measurements || [];
    state.sourceCount = doc.sourceCount || 0;
    setStudy(doc.series);
    toast(`Opened saved study: ${doc.series[0]?.first?.patientName || 'Patient'}`);
  } catch (e) {
    setProgress(null);
    toast(`Could not open saved study: ${e.message || e}`);
    renderSavedStudies();
  }
}

let cachedSavedStudies = [];
let savedStudiesSearchQuery = '';

function renderSavedListItems() {
  const list = $('savedList');
  if (!list) return;
  const q = (savedStudiesSearchQuery || '').trim().toLowerCase();
  const filtered = q
    ? cachedSavedStudies.filter((s) => {
        const text = [s.patientName, s.patientId, s.studyDesc, ...(s.modalities || []), s.studyDate].filter(Boolean).join(' ').toLowerCase();
        return text.includes(q);
      })
    : cachedSavedStudies;

  if (!filtered.length) {
    list.innerHTML = `<div class="saved-empty-search muted">No studies match "${escapeHtml(q)}"</div>`;
    return;
  }

  list.innerHTML = filtered.map((s) => {
    const name = state.anonymize ? 'ANONYMOUS' : escapeHtml(s.patientName || 'Unnamed patient');
    const mods = (s.modalities || []).map((m) => `<span class="badge mod-${escapeHtml(m)}">${escapeHtml(m)}</span>`).join('');
    const date = formatDate(s.studyDate);
    const desc = s.studyDesc ? `<div class="saved-desc">${escapeHtml(s.studyDesc)}</div>` : '';
    const subParts = [date, `${s.seriesCount} series`, `${s.imageCount} images`].filter(Boolean);
    const sub = subParts.join(' · ');
    const thumb = s.thumb ? `<img class="saved-thumb" src="${s.thumb}" alt="">` : `<div class="saved-thumb">${escapeHtml(s.modalities?.[0] || 'DCM')}</div>`;
    return `
      <div class="saved-card" data-id="${escapeHtml(s.id)}">
        ${thumb}
        <div class="saved-meta">
          <div class="saved-title"><span class="saved-mods">${mods}</span> <span class="saved-patient">${name}</span></div>
          ${desc}
          <div class="saved-sub">${escapeHtml(sub)}</div>
        </div>
        <button class="saved-del" title="Delete from saved studies" aria-label="Delete" data-del="${escapeHtml(s.id)}">
          <svg><use href="#i-trash"/></svg>
        </button>
      </div>`;
  }).join('');

  for (const card of list.querySelectorAll('.saved-card')) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.saved-del')) return;
      openSavedStudy(card.dataset.id);
    });
  }
  for (const btn of list.querySelectorAll('.saved-del')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      await deleteSavedStudy(id);
      if (state.activeStudyId === id) state.activeStudyId = null;
      renderSavedStudies();
      toast('Study deleted from library.');
    });
  }
}

async function renderSavedStudies() {
  const box = $('savedStudies');
  const list = $('savedList');
  if (!box || !list) return;
  cachedSavedStudies = await listSavedStudies();
  if (!cachedSavedStudies.length) {
    box.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.hidden = false;
  $('savedCount').textContent = String(cachedSavedStudies.length);
  renderSavedListItems();
}

async function openFiles(files) {
  state.timing = {start: performance.now()};
  try {
    const entries = await entriesFromFiles(files, (m) => setProgress(m, 0));
    await openEntries(entries);
  } catch (e) {
    setProgress(null);
    toast(e.message || String(e));
  }
}

async function openSample() {
  try {
    setProgress('Loading the sample scan…', 0);
    const res = await fetch(`${BASE}samples/manifest.json`);
    const manifest = await res.json();
    await openEntries(entriesFromUrls(manifest.files.map((f) => `${BASE}samples/${f}`)), 'sample');
  } catch (e) {
    setProgress(null);
    toast(`Could not load the sample: ${e.message}`);
  }
}

function setStudy(series, label) {
  for (const v of vps) v.clear();
  state.series = series;
  state.history = [];
  state.future = [];
  state.selected = null;
  state.pendingAngle = null;
  state.locator = null;
  setLayout(1);
  state.active = 0;
  showEmpty(false);
  renderSeriesList();
  // first proper series: skip scouts and single reference images
  let first = series.findIndex((s) => !s.isReference && s.images > 2 && !s.first.imageType.includes('LOCALIZER'));
  if (first < 0) first = 0;
  showSeries(first, vps[0]);
  queueThumbnails();
  if (label === 'sample') toast('Sample: a synthetic head phantom (not a real patient). Drag up / down to scroll.');
  else if (!TOUCH) toast(`${series.length} series. Scroll with the mouse wheel, drag to use the selected tool.`);
}

function closeStudy() {
  for (const v of vps) v.clear();
  loader.clear();
  state.series = [];
  state.measurements = [];
  state.activeStudyId = null;
  setLayout(1);
  renderSeriesList();
  showEmpty(true);
  updateAll();
}

function showEmpty(on) {
  $('empty').hidden = !on;
  document.body.classList.toggle('no-study', on);
  $('homeBtn')?.classList.toggle('on', on);
  if (on) {
    setProgress(null);
    renderSavedStudies();
  }
}


// ---------------------------------------------------------------------------
// series

function showSeries(index, v = activeVp()) {
  const s = state.series[index];
  if (!s) return;
  v.seriesIndex = index;
  state.pendingAngle = null;
  // start where the other view is, when they are parallel
  let pos = 0;
  const w = otherVp(v);
  if (w && w.series) {
    const p = planeOf(w.item);
    const q = planeOf(s.items[0]);
    if (sameSpace(p, q) && Math.abs(dot(p.normal, q.normal)) > 0.98) {
      const idx = nearestSlice(s, pixelToPatient(p, (p.it.cols - 1) / 2, (p.it.rows - 1) / 2));
      if (idx >= 0) pos = idx;
    }
  }
  if (pos === 0 && s.items.length > 2 && !PROJECTION.includes(s.first.modality) && s.first.hasGeometry) {
    pos = Math.floor(s.items.length / 2); // middle of a volume is more useful than the edge
  }
  v.setSeries(s, pos);
  markSeriesList();
  closeDrawerOnPhone();
}

function renderSeriesList() {
  const list = $('seriesList');
  list.innerHTML = '';
  const f0 = state.series[0]?.first;
  const pName = state.anonymize ? 'ANONYMOUS' : (f0?.patientName || 'Unnamed patient');
  const pId = state.anonymize ? 'ID [REDACTED]' : (f0?.patientId ? `ID ${f0.patientId}` : '');
  const pBirth = state.anonymize ? '' : (f0?.birthDate ? `born ${formatDate(f0.birthDate)}` : '');
  const pSex = state.anonymize ? '' : (f0?.sex || '');
  const pInst = state.anonymize ? '' : (f0?.institution || '');
  $('patientBox').innerHTML = f0 ? `<b>${escapeHtml(pName)}</b>${escapeHtml([
    pId, pBirth, pSex,
  ].filter(Boolean).join(' · '))}${pInst ? `<br>${escapeHtml(pInst)}` : ''}` : '';

  let lastStudy = null;
  state.series.forEach((s, i) => {
    const f = s.first;
    if (f.studyUid !== lastStudy) {
      lastStudy = f.studyUid;
      const mods = [...new Set(state.series.filter((x) => x.first.studyUid === f.studyUid).map((x) => x.first.modality))].join(' / ');
      const head = document.createElement('div');
      head.className = 'study-head';
      head.textContent = [formatDate(f.studyDate), f.studyDesc, mods].filter(Boolean).join(' · ');
      list.appendChild(head);
    }
    const b = document.createElement('button');
    b.className = `series${s.isReference ? ' reference' : ''}`;
    b.dataset.index = String(i);
    const thumb = s.thumb ? `<img class="thumb" src="${s.thumb}" alt="">` : `<div class="thumb">${escapeHtml(f.modality)}</div>`;
    b.innerHTML = `${thumb}<div class="series-meta">
      <div class="series-title"><span class="badge">${escapeHtml(f.modality)}</span>${escapeHtml(s.title)}</div>
      <div class="series-sub">${s.images} image${s.images === 1 ? '' : 's'} · ${f.cols}×${f.rows}${f.lossy ? ' · lossy' : ''}</div>
    </div><div class="inview"></div>`;
    b.addEventListener('click', () => showSeries(i));
    list.appendChild(b);
  });
  markSeriesList();
}

function markSeriesList() {
  for (const b of document.querySelectorAll('.series')) {
    const i = parseInt(b.dataset.index, 10);
    const views = shownVps().filter((v) => v.series && v.seriesIndex === i);
    b.classList.toggle('active', views.some((v) => v.index === state.active));
    b.classList.toggle('inother', views.length > 0 && !views.some((v) => v.index === state.active));
    b.querySelector('.inview').innerHTML = state.layout === 2 ?
      views.map((v) => `<span style="background:${VIEW_COLOURS[v.index]}">${v.index + 1}</span>`).join('') : '';
  }
}

let thumbsRunning = false;
async function queueThumbnails() {
  if (thumbsRunning) return;
  thumbsRunning = true;
  const series = state.series;
  for (const s of series.slice(0, 80)) {
    if (series !== state.series) break;
    if (s.thumb !== undefined) continue;
    try {
      const it = s.items[Math.floor(s.items.length / 2)];
      const image = await loader.image(it, 0);
      s.thumb = thumbnail(image, it);
      if (state.activeStudyId && s.thumb && (s === series[0] || !series[0].thumb)) {
        updateSavedStudyMeta(state.activeStudyId, {thumb: s.thumb}).catch(() => {});
      }
      const holder = document.querySelector(`.series[data-index="${state.series.indexOf(s)}"] .thumb`);
      if (holder) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.alt = '';
        img.src = s.thumb;
        holder.replaceWith(img);
      }
    } catch {
      s.thumb = null;
    }
  }
  thumbsRunning = false;
}

function thumbnail(image, it) {
  const full = document.createElement('canvas');
  full.width = image.width;
  full.height = image.height;
  const fctx = full.getContext('2d');
  const data = fctx.createImageData(image.width, image.height);
  renderPixels(image, it, image.kind === 'mono' ? defaultWindow(image, it) : null, false, data.data);
  fctx.putImageData(data, 0, 0);
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const aspect = it.pixelSpacing ? it.pixelSpacing[0] / it.pixelSpacing[1] : 1;
  const k = Math.min(size / image.width, size / (image.height * aspect));
  const w = image.width * k;
  const h = image.height * aspect * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, (size - w) / 2, (size - h) / 2, w, h);
  full.width = full.height = 0;
  return c.toDataURL('image/jpeg', 0.8);
}

// ---------------------------------------------------------------------------
// layout, active view

function setLayout(n) {
  if (n === state.layout && (n === 1 || vps[1].series)) return;
  state.layout = n;
  $('viewports').classList.toggle('two', n === 2);
  vpEls[1].hidden = n !== 2;
  if (n === 1) {
    vps[1].clear();
    state.active = 0;
    state.locator = null;
  } else if (vps[0].series) {
    showSeries(companionSeries(state.series, vps[0].seriesIndex), vps[1]);
    if (vps[1].seriesIndex === vps[0].seriesIndex) toast('Only one series: both views show it. Pick another series from the list.');
  }
  setActive(state.active, true);
  requestAnimationFrame(() => vps.forEach((v) => v.resize()));
  updateAll();
}

function setActive(index, force = false) {
  if ((index === state.active && !force) || index >= state.layout) return;
  state.active = index;
  vpEls.forEach((el, i) => el.classList.toggle('active-2', state.layout === 2 && i === index));
  markSeriesList();
  updateAll();
}

// ---------------------------------------------------------------------------
// viewport events

let syncing = false;
function onViewportChange(v, what, err) {
  if (what === 'error') {
    toast(`Cannot show this image: ${err.message}`);
  }
  if (what === 'pos' && !syncing && state.sync) syncFrom(v);
  if (what === 'pos' || what === 'series') {
    // reference lines in the other view follow
    const w = otherVp(v);
    if (w) w.draw();
  }
  if (what === 'image' && state.timing && !state.timing.firstImage) {
    state.timing.firstImage = Math.round(performance.now() - state.timing.start);
  }
  if (what === 'series') {
    v.el.classList.toggle('has-stack', v.count > 1);
    v.el.classList.toggle('active-2', state.layout === 2 && v.index === state.active);
  }
  updateCorners(v);
  updateScrubber(v);
  if (v === activeVp()) {
    updateTitle();
    updateToolbar();
    if (state.sheet === 'measure' && (what === 'pos' || what === 'series')) renderMeasurePanel();
    if (state.sheet === 'tags' && (what === 'pos' || what === 'series')) renderTagsPanel();
    if (state.sheet === 'window' && (what === 'voi' || what === 'series' || what === 'image')) updateWindowPanel();
  }
}

function syncFrom(v) {
  const w = otherVp(v);
  if (!w || !w.series || !v.series) return;
  const p = planeOf(v.item);
  const q = planeOf(w.item);
  if (!sameSpace(p, q) || Math.abs(dot(p.normal, q.normal)) < 0.98) return;
  const idx = nearestSlice(w.series, pixelToPatient(p, (p.it.cols - 1) / 2, (p.it.rows - 1) / 2));
  if (idx < 0) return;
  syncing = true;
  try {
    w.setPos(idx);
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// overlays: corners, orientation, title, scrubber

function updateTitle() {
  const v = activeVp();
  const s = v.series;
  if (!s) {
    $('titleMain').textContent = 'DICOM Mobile';
    $('titleSub').textContent = '';
    return;
  }
  const f = s.first;
  const patientDisplay = state.anonymize ? 'ANONYMOUS' : (f.patientName || s.title);
  $('titleMain').textContent = patientDisplay;
  $('titleSub').textContent = [f.patientName ? `${f.modality} · ${s.title}` : f.modality, formatDate(f.studyDate)].filter(Boolean).join(' · ');
}

function fmt(v, d) {
  return Number.isFinite(v) ? v.toFixed(d) : '–';
}

function updateCorners(v) {
  const el = v.el;
  const c = (cls) => el.querySelector(`.corners .${cls}`);
  const s = v.series;
  if (!s) {
    for (const k of ['tl', 'tr', 'bl', 'br']) c(k).textContent = '';
    for (const o of el.querySelectorAll('.orient')) o.textContent = '';
    return;
  }
  const it = v.item;
  const f = s.first;
  const tl = [];
  if (v.index === 0) {
    const patientName = state.anonymize ? 'ANONYMOUS' : f.patientName;
    const idInfo = state.anonymize ? 'ID [REDACTED]' : [f.patientId && `ID ${f.patientId}`, f.sex, formatAge(f.age)].filter(Boolean).join(' ');
    tl.push(state.layout === 1 && TOUCH ? '' : patientName);
    tl.push(idInfo);
    tl.push(formatDate(f.studyDate || f.seriesDate));
  }

  const tr = [`${f.modality} ${s.title}`.slice(0, 48)];
  if (Number.isFinite(f.seriesNumber)) tr.push(`Series ${f.seriesNumber}`);
  if (v.count > 1) tr.push(`Image ${v.pos + 1} / ${v.count}`);
  if (s.stacked) tr.push('Angled slices (stack)');
  if (it.lossy || f.lossy) tr.push('LOSSY');
  const bl = [];
  if (state.probe && state.probe.view === v.index) bl.push(state.probe.text);
  if (v.voi && v.shown?.image?.kind === 'mono') bl.push(`W ${Math.round(v.voi.width)}  L ${Math.round(v.voi.center)}`);
  const br = [];
  if (Number.isFinite(it.thickness) && !PROJECTION.includes(f.modality)) br.push(`Thick ${it.thickness.toFixed(1)} mm`);
  if (Number.isFinite(it.sliceLocation) && !s.stacked) br.push(`Loc ${it.sliceLocation.toFixed(1)} mm`);
  if (v.shown?.image) br.push(`Zoom ${Math.round(v.displayScale() * 100)}%`);
  const sp = spacingInfo(s, state.calibrations);
  br.push(sp.spacing ? `${fmt(sp.spacing[1], 3)} mm/px${sp.kind === 'patient' ? '' : sp.kind === 'user' ? ' (cal.)' : sp.kind === 'detector' ? ' (detector)' : ' (?)'}` : 'Not calibrated');
  c('tl').textContent = tl.filter(Boolean).join('\n');
  c('tr').textContent = tr.join('\n');
  c('bl').textContent = bl.join('\n');
  c('br').textContent = br.join('\n');
  // orientation letters for the screen directions (rotation / flip aware)
  const m = v.matrix(it);
  const det = m[0] * m[3] - m[1] * m[2];
  const inv = (dx, dy) => [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
  const set = (side, d) => {
    el.querySelector(`.orient.${side}`).textContent = lettersForPixelDirection(it, ...inv(...d));
  };
  set('right', [1, 0]);
  set('left', [-1, 0]);
  set('bottom', [0, 1]);
  set('top', [0, -1]);
}

function updateScrubber(v) {
  const sc = v.el.querySelector('.scrubber');
  const n = v.count;
  if (n < 2) return;
  const track = sc.querySelector('.track');
  const frac = v.pos / (n - 1);
  const knob = sc.querySelector('.knob');
  knob.style.top = `${frac * track.clientHeight}px`;
  sc.querySelector('.bubble').textContent = `${v.pos + 1} / ${n}`;
  sc.querySelector('.bubble').style.top = `${34 + frac * track.clientHeight}px`;
}

function attachScrubber(v) {
  const sc = v.el.querySelector('.scrubber');
  const track = sc.querySelector('.track');
  const go = (e) => {
    const r = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    v.setPos(frac * (v.count - 1));
  };
  sc.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    setActive(v.index);
    v.stop();
    sc.setPointerCapture(e.pointerId);
    sc.classList.add('dragging');
    go(e);
  });
  sc.addEventListener('pointermove', (e) => {
    if (sc.hasPointerCapture(e.pointerId)) go(e);
  });
  const end = (e) => {
    sc.classList.remove('dragging');
    try {
      sc.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  sc.addEventListener('pointerup', end);
  sc.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// drawing on top of the image: reference lines, locator, measurements

function drawOverlay(v, ctx) {
  if (!v.series || !v.shown?.image) return;
  drawReferenceLines(v, ctx);
  drawMeasurements(v, ctx);
}

/** pixel index (centre at integers) -> screen */
const idxToScreen = (v, x, y) => v.toScreen(x + 0.5, y + 0.5);

function clipSegment(a, b, w, h) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [pk, qk] of [[-dx, a[0]], [dx, w - a[0]], [-dy, a[1]], [dy, h - a[1]]]) {
    if (pk === 0) {
      if (qk < 0) return null;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function drawReferenceLines(v, ctx) {
  const it = v.shown.item;
  const p = planeOf(it);
  if (!p) return;
  const {w: W, h: H} = v.size;
  const w = otherVp(v);
  v.levelLabels = [];
  if (w && w.series) {
    const current = w.item;
    const q = planeOf(current);
    const colour = VIEW_COLOURS[w.index];
    const segmentFor = (plane) => {
      const seg = intersection(p, plane);
      if (!seg) return null;
      const a = idxToScreen(v, seg[0][0], seg[0][1]);
      const b = idxToScreen(v, seg[1][0], seg[1][1]);
      const c = clipSegment(a, b, W, H);
      if (!c) return null;
      return c[0][0] <= c[1][0] ? c : [c[1], c[0]];
    };
    if (sameSpace(p, q)) {
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.font = '600 11px system-ui, sans-serif';
      if (state.allLevels && w.count > 1) {
        const step = Math.max(1, Math.ceil(w.count / Math.max(6, Math.min(40, Math.min(W, H) / 14))));
        const placed = [];
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1;
        w.series.items.forEach((item, idx) => {
          if (item === current || (idx % step && idx !== w.count - 1)) return;
          const plane = planeOf(item);
          if (!sameSpace(p, plane)) return;
          const seg = segmentFor(plane);
          if (!seg) return;
          ctx.beginPath();
          ctx.moveTo(...seg[0]);
          ctx.lineTo(...seg[1]);
          ctx.stroke();
          if (placed.some((q2) => Math.abs(q2[0] - seg[1][0]) < 16 && Math.abs(q2[1] - seg[1][1]) < 12)) return;
          placed.push(seg[1]);
          const nearRight = seg[1][0] > W - 40;
          const lx = nearRight ? seg[1][0] - 30 : seg[1][0] + 3;
          ctx.globalAlpha = 0.9;
          ctx.fillText(String(idx + 1), lx, seg[1][1] + 4);
          ctx.globalAlpha = 0.45;
          v.levelLabels.push({x: lx + 8, y: seg[1][1], idx, target: w});
        });
        ctx.globalAlpha = 1;
      }
      const seg = segmentFor(q);
      if (seg) {
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(...seg[0]);
        ctx.lineTo(...seg[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = `View ${w.index + 1} · image ${w.pos + 1}`;
        ctx.font = '600 12px system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const lx = Math.max(4, Math.min(seg[1][0], W - 24) - tw - 4);
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 3;
        ctx.fillText(label, lx, Math.max(14, seg[1][1] - 7));
      }
      ctx.restore();
    }
  }
  const loc = state.locator;
  if (loc && loc.frame && loc.frame === p.frame) {
    const at = patientToPixel(p, loc.point);
    const thick = v.series.first.thickness || 3;
    if (Math.abs(at.dist) <= Math.max(thick, 3)) {
      const [cx, cy] = idxToScreen(v, at.x, at.y);
      ctx.save();
      ctx.strokeStyle = '#7CFC9A';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy);
      ctx.lineTo(cx - 4, cy);
      ctx.moveTo(cx + 4, cy);
      ctx.lineTo(cx + 12, cy);
      ctx.moveTo(cx, cy - 12);
      ctx.lineTo(cx, cy - 4);
      ctx.moveTo(cx, cy + 4);
      ctx.lineTo(cx, cy + 12);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function measurementsOf(v) {
  if (!v.series) return [];
  return state.measurements.filter((m) => m.seriesKey === v.series.key && m.pos === v.pos);
}

function numberOf(m) {
  return state.measurements.filter((x) => x.seriesKey === m.seriesKey).indexOf(m) + 1;
}

function spacingOf(v) {
  return v.series ? spacingInfo(v.series, state.calibrations).spacing : null;
}

function describe(m, v) {
  const s = state.series.find((x) => x.key === m.seriesKey);
  const it = s ? s.items[m.pos] : v?.item;
  const image = it ? loader.peek(it) : null;
  return quantify(m, it, image, s ? spacingInfo(s, state.calibrations).spacing : null);
}

function drawMeasurements(v, ctx) {
  const list = measurementsOf(v);
  const toScreen = (x, y) => v.toScreen(x, y);
  for (const m of list) {
    const q = describe(m, v);
    const lines = v.el.classList.contains('compact') ? 1 : m.id === state.selected ? 4 : 2;
    drawMeasurement(ctx, m, toScreen, q.rows.map((r) => r[0]).slice(0, lines).join('\n'), {
      selected: m.id === state.selected || m === state.pendingAngle,
      touch: TOUCH,
      number: numberOf(m),
    });
  }
}

function redrawAll() {
  for (const v of shownVps()) v.draw();
}

// ---------------------------------------------------------------------------
// measurements: history, selection

function snapshot() {
  return state.measurements.map((m) => ({...m, points: m.points.map((p) => [...p])}));
}

function remember() {
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  state.future = [];
  updateUndo();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  state.measurements = state.history.pop();
  state.pendingAngle = null;
  afterMeasureChange();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  state.measurements = state.future.pop();
  afterMeasureChange();
}

function updateUndo() {
  $('undoBtn').disabled = !state.history.length;
  $('redoBtn').disabled = !state.future.length;
}

function afterMeasureChange() {
  if (state.selected && !state.measurements.some((m) => m.id === state.selected)) state.selected = null;
  updateUndo();
  redrawAll();
  updateSelectionBar();
  if (state.sheet === 'measure') renderMeasurePanel();
  updateToolbar();
  if (state.activeStudyId) {
    updateSavedStudyMeta(state.activeStudyId, {measurements: state.measurements});
  }
}

function deleteMeasurement(id) {
  remember();
  state.measurements = state.measurements.filter((m) => m.id !== id);
  if (state.selected === id) state.selected = null;
  afterMeasureChange();
}

function select(id) {
  state.selected = id;
  updateSelectionBar();
  redrawAll();
  if (state.sheet === 'measure') renderMeasurePanel();
}

// floating bar for the selected measurement (delete without a keyboard)
function updateSelectionBar() {
  let bar = $('selBar');
  const m = state.measurements.find((x) => x.id === state.selected);
  if (!m || state.sheet === 'measure') {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selBar';
    bar.className = 'toast sel-bar';
    $('stage').appendChild(bar);
  }
  const q = describe(m);
  bar.innerHTML = `<span>#${numberOf(m)} ${escapeHtml(q.kind)}${q.rows[0] ? ` · <b>${escapeHtml(q.rows[0][0])}</b>` : ''}</span>
    <button class="btn small danger" id="selDelete"><svg><use href="#i-trash"/></svg>Delete</button>
    <button class="btn small" id="selDone">Done</button>`;
  bar.querySelector('#selDelete').onclick = () => deleteMeasurement(m.id);
  bar.querySelector('#selDone').onclick = () => select(null);
}

// ---------------------------------------------------------------------------
// tools

const NAV_TOOLS = {scroll: 'Scroll', window: 'Contrast', pan: 'Move'};

function setTool(name) {
  if (MEASURE_TOOLS[name]) {
    state.measureTool = name;
    savePref('measureTool', name);
  }
  state.tool = name;
  state.pendingAngle = null;
  savePref('tool', name);
  updateToolbar();
  redrawAll();
}

function updateToolbar() {
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === state.tool);
  const mb = $('measureMenuBtn');
  const isMeasure = !!MEASURE_TOOLS[state.tool];
  mb.classList.toggle('on', isMeasure);
  const icon = {length: 'ruler', angle: 'angle', ellipse: 'ellipse', rect: 'rect', arrow: 'arrow'}[state.measureTool];
  mb.querySelector('use').setAttribute('href', `#i-${isMeasure ? icon : 'measure'}`);
  $('measureLabel').textContent = isMeasure ? MEASURE_TOOLS[state.tool].label : 'Measure';
  const v = activeVp();
  const loaded = !!v.series;
  for (const b of document.querySelectorAll('.tool')) b.disabled = !loaded;
  const play = $('playBtn');
  play.disabled = !loaded || v.count < 2;
  play.classList.toggle('on', !!v.playing);
  play.querySelector('use').setAttribute('href', v.playing ? '#i-stop' : '#i-play');
  play.querySelector('span').textContent = v.playing ? 'Stop' : 'Play';
  $('presetBtn').disabled = !loaded || v.shown?.image?.kind === 'rgb';
}

/** which tool a pointer drag uses (mouse buttons / modifier keys) */
function toolForDrag(e, button) {
  if (e.pointerType === 'mouse') {
    if (button === 1 || (button === 0 && (e.shiftKey))) return 'pan';
    if (button === 2) return 'window';
    if (button === 0 && (e.ctrlKey || e.metaKey)) return 'zoom';
  }
  return state.tool;
}

function makeDragHandler(v, x, y, e, button) {
  const tool = toolForDrag(e, button);
  const radius = e.pointerType === 'mouse' ? 10 : 24;
  const toScreen = (px, py) => v.toScreen(px, py);
  // only the selected measurement can be edited (a tap selects): starting a
  // new shape next to an existing one must not grab that one
  const selected = measurementsOf(v).filter((m) => m.id === state.selected);
  const hit = hitTest(selected, [x, y], toScreen, radius);
  if (hit && button === 0) {
    return editMeasurement(v, hit, x, y, e);
  }
  if (MEASURE_TOOLS[tool] && button === 0) return createMeasurement(v, tool, x, y, e);
  switch (tool) {
  case 'scroll': {
    let acc = 0;
    const per = Math.max(3, Math.min(16, (v.size.h / Math.max(1, v.count)) * 1.5));
    v.stop();
    return {
      move(mx, my, dx, dy) {
        acc += dy;
        const steps = Math.trunc(acc / per);
        if (steps) {
          acc -= steps * per;
          v.scrollBy(steps);
        }
      },
    };
  }
  case 'window': {
    if (!v.voi || v.shown?.image?.kind !== 'mono') return null;
    return {
      move(mx, my, dx, dy) {
        const {center, width} = v.voi;
        // right = wider (less contrast), down = higher level (darker)
        const nw = Math.max(1, width * Math.exp(dx / 180));
        const nc = center + dy * Math.max(width, 20) / 260;
        v.setVoi({center: nc, width: nw});
      },
    };
  }
  case 'pan':
    return {move: (mx, my, dx, dy) => v.panBy(dx, dy)};
  case 'zoom':
    return {move: (mx, my, dx, dy) => v.zoomAt(Math.exp(-dy / 150), x, y)};
  default:
    return null;
  }
}

function clampToImage(v, p) {
  const it = v.shown.item;
  return [Math.max(0, Math.min(it.cols, p[0])), Math.max(0, Math.min(it.rows, p[1]))];
}

function createMeasurement(v, tool, x, y, e) {
  if (!v.shown?.image) return null;
  const p0 = clampToImage(v, v.toImage(x, y));
  // angle: third point of a pending angle
  if (tool === 'angle' && state.pendingAngle && measurementsOf(v).includes(state.pendingAngle)) {
    const m = state.pendingAngle;
    m.points[2] = p0;
    redrawAll();
    showLoupe(v, x, y, e);
    return {
      move(mx, my) {
        m.points[2] = clampToImage(v, v.toImage(mx, my));
        v.draw();
        showLoupe(v, mx, my, e);
      },
      end() {
        state.pendingAngle = null;
        hideLoupe();
        select(m.id);
        afterMeasureChange();
      },
      cancel() {
        hideLoupe();
      },
    };
  }
  remember();
  const m = newMeasurement(tool, {seriesKey: v.series.key, pos: v.pos, sop: v.item.sopFrame}, [p0, [...p0]]);
  state.measurements.push(m);
  state.selected = null;
  showLoupe(v, x, y, e);
  return {
    move(mx, my) {
      m.points[1] = clampToImage(v, v.toImage(mx, my));
      v.draw();
      showLoupe(v, mx, my, e);
    },
    end() {
      hideLoupe();
      const a = v.toScreen(...m.points[0]);
      const b = v.toScreen(...m.points[1]);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 6) {
        // too small: treat as a mistake
        state.measurements = state.measurements.filter((x2) => x2 !== m);
        state.history.pop();
        afterMeasureChange();
        return;
      }
      if (tool === 'angle') {
        state.pendingAngle = m;
        toast('Now tap or drag to place the third point of the angle.');
      } else {
        select(m.id);
      }
      afterMeasureChange();
      if (!state.sheet && !TOUCH) openSheet('measure');
    },
    cancel() {
      hideLoupe();
      state.measurements = state.measurements.filter((x2) => x2 !== m);
      state.history.pop();
      afterMeasureChange();
    },
  };
}

function editMeasurement(v, hit, x, y, e) {
  remember();
  const m = hit.m;
  select(m.id);
  const start = m.points.map((p) => [...p]);
  const s0 = v.toImage(x, y);
  return {
    move(mx, my) {
      const p = v.toImage(mx, my);
      if (hit.handle >= 0) {
        m.points[hit.handle] = clampToImage(v, p);
        showLoupe(v, mx, my, e);
      } else {
        const dx = p[0] - s0[0];
        const dy = p[1] - s0[1];
        m.points = start.map((q) => [q[0] + dx, q[1] + dy]);
      }
      v.draw();
      if (state.sheet === 'measure') scheduleMeasurePanel();
    },
    end() {
      hideLoupe();
      afterMeasureChange();
    },
    cancel() {
      hideLoupe();
      m.points = start;
      state.history.pop();
      afterMeasureChange();
    },
  };
}

let measurePanelTimer = 0;
function scheduleMeasurePanel() {
  if (measurePanelTimer) return;
  measurePanelTimer = setTimeout(() => {
    measurePanelTimer = 0;
    renderMeasurePanel();
  }, 120);
}

// magnifier above the finger while placing points / probing
function showLoupe(v, x, y, e, text = '') {
  if (!e || e.pointerType === 'mouse') return;
  const loupe = $('loupe');
  const canvas = loupe.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const {dpr} = v.size;
  const zoom = 2;
  const src = 60 / zoom; // CSS px around the finger
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const c of [v.canvas, v.overlay]) {
    ctx.drawImage(c, (x - src) * dpr, (y - src) * dpr, src * 2 * dpr, src * 2 * dpr, 0, 0, canvas.width, canvas.height);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 14, canvas.height / 2);
  ctx.lineTo(canvas.width / 2 + 14, canvas.height / 2);
  ctx.moveTo(canvas.width / 2, canvas.height / 2 - 14);
  ctx.lineTo(canvas.width / 2, canvas.height / 2 + 14);
  ctx.stroke();
  loupe.querySelector('.loupe-val').textContent = text;
  const stage = $('stage').getBoundingClientRect();
  const r = v.el.getBoundingClientRect();
  let lx = r.left - stage.left + x - 60;
  let ly = r.top - stage.top + y - 150;
  if (ly < 4) ly = r.top - stage.top + y + 40;
  lx = Math.max(4, Math.min(stage.width - 124, lx));
  loupe.style.left = `${lx}px`;
  loupe.style.top = `${ly}px`;
  loupe.hidden = false;
}

function hideLoupe() {
  $('loupe').hidden = true;
}

function probeText(v, x, y) {
  const shown = v.shown;
  if (!shown?.image) return '';
  const [ix, iy] = v.toImage(x, y);
  const px = Math.floor(ix);
  const py = Math.floor(iy);
  const val = pixelValue(shown.image, shown.item, px, py);
  if (!val) return '';
  if (val.rgb) return `x ${px} y ${py} = RGB ${val.rgb.join(' ')}`;
  const unit = shown.item.modality === 'CT' ? ' HU' : '';
  return `x ${px} y ${py} = ${Math.round(val.value * 10) / 10}${unit}`;
}

function setProbe(v, text) {
  const next = text ? {view: v.index, text} : null;
  if (JSON.stringify(next) === JSON.stringify(state.probe)) return;
  state.probe = next;
  updateCorners(v);
}

// double tap / double click: locate the point in the other view, or zoom
function onDoubleTap(v, x, y) {
  if (!v.series) return;
  if (state.layout === 2) {
    locate(v, x, y);
    return;
  }
  if (v.view.zoom !== 1 || v.view.panX || v.view.panY) v.resetView();
  else v.zoomAt(2.5, x, y);
}

function locate(v, x, y) {
  const p = planeOf(v.item);
  if (!p) {
    toast('This image has no position information.');
    return;
  }
  const [ix, iy] = v.toImage(x, y);
  const point = pixelToPatient(p, ix - 0.5, iy - 0.5);
  state.locator = {point, frame: p.frame};
  const w = otherVp(v);
  if (w && w.series) {
    const q = planeOf(w.item);
    if (sameSpace(p, q)) {
      const idx = nearestSlice(w.series, point);
      if (idx >= 0) {
        syncing = true;
        try {
          w.setPos(idx);
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
  redrawAll();
}

function onTap(v, x, y, e) {
  if (!v.series) return;
  // numbered level labels (all levels)
  const lbl = (v.levelLabels || []).find((l) => Math.hypot(l.x - x, l.y - y) < (TOUCH ? 16 : 9));
  if (lbl) {
    setActive(lbl.target.index);
    lbl.target.setPos(lbl.idx);
    return;
  }
  const radius = e.pointerType === 'mouse' ? 10 : 24;
  const hit = hitTest(measurementsOf(v), [x, y], (px, py) => v.toScreen(px, py), radius);
  if (state.tool === 'angle' && state.pendingAngle && !hit) {
    const m = state.pendingAngle;
    m.points[2] = clampToImage(v, v.toImage(x, y));
    state.pendingAngle = null;
    select(m.id);
    afterMeasureChange();
    return;
  }
  if (hit) {
    select(hit.m.id);
    return;
  }
  if (state.selected) select(null);
}

function bindViewport(v) {
  attachGestures(v.el, {
    down: () => setActive(v.index),
    tap: (x, y, e) => onTap(v, x, y, e),
    doubleTap: (x, y) => onDoubleTap(v, x, y),
    dragStart: (x, y, e, button) => {
      if (!v.series) return null;
      const h = makeDragHandler(v, x, y, e, button);
      return h ? {cancel() {}, end() {}, ...h} : null;
    },
    pinch: (scale, cx, cy, dx, dy) => {
      if (!v.series) return;
      v.panBy(dx, dy);
      v.zoomAt(scale, cx, cy);
    },
    longPress: (x, y, e) => {
      if (!v.shown?.image) return null;
      const show = (mx, my) => {
        const t = probeText(v, mx, my);
        setProbe(v, t);
        showLoupe(v, mx, my, e, t.replace(/^x \d+ y \d+ = /, ''));
      };
      show(x, y);
      return {
        move: show,
        end() {
          hideLoupe();
          setProbe(v, '');
        },
      };
    },
    wheel: (e, x, y) => onWheel(v, e, x, y),
    hover: (x, y) => setProbe(v, probeText(v, x, y)),
    leave: () => setProbe(v, ''),
  });
  attachScrubber(v);
}

let wheelAcc = 0;
let wheelTimer = 0;
function onWheel(v, e, x, y) {
  if (!v.series) return;
  setActive(v.index);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey || e.metaKey) {
    // trackpad pinch arrives as ctrl + wheel
    v.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), x, y);
    return;
  }
  wheelAcc += dy;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelAcc = 0; }, 150);
  if (Math.abs(wheelAcc) >= 16) {
    v.stop();
    v.scrollBy(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
  }
}

// ---------------------------------------------------------------------------
// menus

function measureMenu(anchor) {
  const tools = Object.entries(MEASURE_TOOLS).map(([k, t]) => ({
    label: t.label,
    icon: {length: 'ruler', angle: 'angle', ellipse: 'ellipse', rect: 'rect', arrow: 'arrow'}[k],
    on: state.tool === k,
    key: {length: 'M', angle: 'A', ellipse: 'E', rect: 'B', arrow: ''}[k],
    action: () => setTool(k),
  }));
  openMenu(anchor, [
    {title: 'Measure'},
    ...tools,
    '-',
    {label: `Measurements${state.measurements.length ? ` (${state.measurements.length})` : ''} & ratio`, icon: 'list', action: () => openSheet('measure')},
    {label: 'Undo', icon: 'undo', disabled: !state.history.length, action: undo},
    {label: 'Redo', icon: 'redo', disabled: !state.future.length, action: redo},
  ]);
}

function presetsMenu(anchor) {
  const v = activeVp();
  const it = v.item;
  if (!it || v.shown?.image?.kind !== 'mono') return;
  const presets = windowPresets(it);
  openMenu(anchor, [
    {title: 'Window presets'},
    ...presets.map((p, i) => ({
      label: p.auto ? p.name : `${p.name}  (W ${Math.round(p.width)} / L ${Math.round(p.center)})`,
      key: i < 9 ? String(i + 1) : '',
      on: !p.auto && v.voi && Math.round(v.voi.center) === Math.round(p.center) && Math.round(v.voi.width) === Math.round(p.width),
      action: () => applyPreset(p),
    })),
    '-',
    {label: 'Brightness / contrast sliders', icon: 'sliders', action: () => openSheet('window')},
    {label: 'Invert', icon: 'invert', on: v.invert, action: toggleInvert},
  ]);
}

function applyPreset(p, v = activeVp()) {
  const image = v.shown?.image;
  if (!image || image.kind !== 'mono') return;
  if (p.auto === 'minmax') v.setVoi(minMaxWindow(image, v.shown.item));
  else if (p.auto === 'percentile') v.setVoi(percentileWindow(image, v.shown.item));
  else v.setVoi(p);
}

async function moreMenu(anchor) {
  const v = activeVp();
  const loaded = !!v.series;
  const saved = await listSavedStudies();
  openMenu(anchor, [
    {label: 'Two views (reference lines)', icon: 'layout', on: state.layout === 2, disabled: !loaded, key: 'V', action: () => setLayout(state.layout === 2 ? 1 : 2)},
    ...(state.layout === 2 ? [
      {label: 'Sync scrolling (same plane)', icon: 'sync', on: state.sync, key: 'Y', action: toggleSync},
      {label: 'Show all levels of the other view', icon: 'levels', on: state.allLevels, key: 'K', action: toggleLevels},
    ] : []),
    '-',
    {label: 'Rotate 90°', icon: 'rotate', disabled: !loaded, action: () => v.rotate(1)},
    {label: 'Flip horizontally', icon: 'flip', on: v.view.flip, disabled: !loaded, action: () => v.flip()},
    {label: 'Invert', icon: 'invert', on: v.invert, disabled: !loaded, key: 'I', action: toggleInvert},
    {label: 'Reset view', icon: 'reset', disabled: !loaded, key: 'R', action: resetView},
    {label: 'Smooth display', icon: 'smooth', on: state.smooth, key: 'G', action: toggleSmooth},
    {label: 'Show image info', icon: 'info', on: state.showInfo, action: toggleInfo},
    '-',
    {label: 'Brightness / contrast sliders', icon: 'sliders', disabled: !loaded, key: 'C', action: () => openSheet('window')},
    {label: 'Measurements & calibration', icon: 'list', disabled: !loaded, key: 'L', action: () => openSheet('measure')},
    {label: 'DICOM tags', icon: 'tags', disabled: !loaded, key: 'T', action: () => openSheet('tags')},
    {label: 'Save / share this view', icon: 'share', disabled: !loaded, key: 'X', action: exportView},
    {label: 'Anonymize patient info', icon: 'shield', on: state.anonymize, key: 'H', action: toggleAnonymize},
    ...(canReconstructMpr(v.series) ? [{label: 'Reconstruct MPR (Coronal & Sagittal)', icon: 'layout', action: () => runMpr(v.series)}] : []),
    '-',
    {label: 'Open files or a ZIP', icon: 'open', action: pickFiles},
    {label: 'Choose from Google Drive', icon: 'drive', action: openGoogleDrive},
    ...(canPickFolder ? [{label: 'Open a folder', icon: 'open', action: pickFolder}] : []),
    ...(saved.length ? [{label: `Saved studies (${saved.length})`, icon: 'list', action: () => openSheet('saved')}] : []),
    {label: 'Close scans', icon: 'close', disabled: !state.series.length, action: closeStudy},
    {label: 'Help & about', icon: 'help', key: '?', action: () => openSheet('help')},
  ]);
}

async function openSourceMenu(anchor) {
  const saved = await listSavedStudies();
  openMenu(anchor, [
    {title: 'Open scans'},
    ...(saved.length ? [{label: `Saved studies (${saved.length})`, icon: 'list', action: () => openSheet('saved')}, '-'] : []),
    {label: 'Choose files or a ZIP', icon: 'open', action: pickFiles},
    {label: 'Choose from Google Drive', icon: 'drive', action: openGoogleDrive},
    ...(canPickFolder ? [{label: 'Open a folder', icon: 'open', action: pickFolder}] : []),
  ]);
}

function toggleAnonymize() {
  state.anonymize = !state.anonymize;
  savePref('anonymize', state.anonymize);
  updateTitle();
  renderSeriesList();
  for (const v of vps) updateCorners(v);
  renderSavedStudies();
  toast(state.anonymize ? 'Anonymize ON: patient info hidden' : 'Anonymize OFF');
}

async function runMpr(sourceSeries) {
  if (!sourceSeries || !canReconstructMpr(sourceSeries)) return;
  try {
    setProgress('Reconstructing Coronal & Sagittal views…', 0);
    const mprSeries = await buildMprSeries(sourceSeries, loader, (msg, frac) => setProgress(msg, frac));
    setProgress(null);
    state.series.push(...mprSeries);
    renderSeriesList();
    toast('Coronal and Sagittal MPR reconstructed! Select them in the Series drawer or Two Views.');
    setLayout(2);
    showSeries(state.series.indexOf(mprSeries[0]), vps[1]);
  } catch (e) {
    setProgress(null);
    toast(`Could not reconstruct MPR: ${e.message || e}`);
  }
}


function toggleInvert() {
  const v = activeVp();
  if (!v.series) return;
  v.invert = !v.invert;
  v.draw();
}

function resetView() {
  const v = activeVp();
  v.stop();
  v.resetView();
  v.resetVoi();
  v.invert = false;
  v.draw();
}

function toggleSync() {
  state.sync = !state.sync;
  if (state.sync) syncFrom(activeVp());
  toast(state.sync ? 'Sync scrolling on' : 'Sync scrolling off');
}

function toggleLevels() {
  state.allLevels = !state.allLevels;
  savePref('allLevels', state.allLevels);
  redrawAll();
}

function toggleSmooth() {
  state.smooth = !state.smooth;
  savePref('smooth', state.smooth);
  redrawAll();
  toast(state.smooth ? 'Smooth display on' : 'Smooth display off: individual pixels visible');
}

function toggleInfo() {
  state.showInfo = !state.showInfo;
  savePref('showInfo', state.showInfo);
  $('viewports').classList.toggle('hide-info', !state.showInfo);
}

// ---------------------------------------------------------------------------
// sheets (bottom sheet on phones, side panel on wide screens)

function openSheet(name, toggle = false) {
  if (state.sheet === name) {
    if (toggle) closeSheet();
    return;
  }
  state.sheet = name;
  $('sheet').hidden = false;
  $('sheet').classList.toggle('tall', name === 'tags' || name === 'help');
  const titles = {
    measure: 'Measurements',
    tags: 'DICOM tags',
    window: 'Brightness / contrast',
    drive: 'Google Drive',
    help: 'Help & about',
    saved: 'Saved studies',
  };
  $('sheetTitle').textContent = titles[name];
  if (name === 'measure') renderMeasurePanel();
  updateSelectionBar();
  if (name === 'tags') renderTagsPanel(true);
  if (name === 'window') renderWindowPanel();
  if (name === 'drive') renderDrivePanel();
  if (name === 'help') renderHelpPanel();
  if (name === 'saved') renderSavedSheet();
  requestAnimationFrame(() => vps.forEach((v) => v.resize()));
}

function closeSheet() {
  state.sheet = null;
  setTimeout(updateSelectionBar, 0);
  $('sheet').hidden = true;
  $('sheetBody').innerHTML = '';
  requestAnimationFrame(() => vps.forEach((v) => v.resize()));
}

function renderMeasurePanel() {
  if (state.sheet !== 'measure') return;
  const body = $('sheetBody');
  const v = activeVp();
  const s = v.series;
  if (!s) {
    body.innerHTML = '<p class="muted">Open a scan first.</p>';
    return;
  }
  const info = spacingInfo(s, state.calibrations);
  const sp = info.spacing;
  const all = state.measurements;
  const lengths = all.filter((m) => m.type === 'length');
  let html = `<div class="calibration cal-${info.kind}"><div><b>Scale:</b> ${sp ? `${fmt(sp[1], 4)} × ${fmt(sp[0], 4)} mm per pixel` : 'unknown'}</div>
    <div class="muted">${escapeHtml(info.label)}</div></div>`;
  if (!all.length) {
    html += `<p class="muted">Pick a tool under <b>Measure</b> and drag on the image. Tap a measurement to select it, then drag its end points.
      An angle takes three points: drag the first arm, then tap the third point.</p>`;
  }
  html += '<div id="mlist"></div>';
  if (lengths.length >= 2) {
    html += `<h3>Ratio of two distances</h3>
      <p class="note">e.g. spinal canal ÷ vertebral body. Magnification cancels out, so this is exact on X-rays too.</p>
      <div class="row"><span style="width:20px">A</span><select id="ratioA"></select></div>
      <div class="row"><span style="width:20px">B</span><select id="ratioB"></select></div>
      <div class="row"><b>A ÷ B</b><span id="ratioValue"></span><button class="btn small" id="ratioSwap">Swap</button></div>`;
  }
  const list = measurementsOf(v);
  const lastLen = [...list].reverse().find((m) => m.type === 'length');
  const canCal = info.kind !== 'patient' || state.calibrations[s.key];
  if (canCal) {
    html += `<h3>Calibrate</h3><p class="note">${lastLen ?
      `Enter the real length of distance #${numberOf(lastLen)} (e.g. a ruler or coin in the image):` :
      'To calibrate, draw a distance over something of known size on this image.'}</p>
      <div class="row"><input id="calInput" type="text" inputmode="decimal" placeholder="Real length" ${lastLen ? '' : 'disabled'}><span class="muted">mm</span>
      <button class="btn small" id="calApply" ${lastLen ? '' : 'disabled'}>Apply</button></div>
      ${state.calibrations[s.key] ? '<button class="btn small" id="calReset">Remove calibration</button>' : ''}`;
  }
  if (all.length) html += '<div class="row"><button class="btn small danger" id="clearAll"><svg><use href="#i-trash"/></svg>Delete all</button><button class="btn small" id="mUndo">Undo</button></div>';
  body.innerHTML = html;

  const box = body.querySelector('#mlist');
  let lastSeries = null;
  for (const m of all) {
    const ms = state.series.find((x) => x.key === m.seriesKey);
    if (m.seriesKey !== lastSeries) {
      lastSeries = m.seriesKey;
      const h = document.createElement('div');
      h.className = 'study-head';
      h.textContent = ms ? ms.title : 'Series';
      box.appendChild(h);
    }
    const q = describe(m);
    const div = document.createElement('div');
    div.className = `measure${m.id === state.selected ? ' selected' : ''}`;
    div.innerHTML = `<div class="measure-head"><span>${numberOf(m)}. ${escapeHtml(q.kind)} <span class="muted">· image ${m.pos + 1}</span></span>
      <button class="ib small" aria-label="Delete"><svg><use href="#i-trash"/></svg></button></div>
      ${q.rows.map(([t, big]) => `<div class="${big ? 'measure-value' : 'muted'}">${escapeHtml(t)}</div>`).join('')}`;
    div.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      deleteMeasurement(m.id);
    };
    div.onclick = () => goToMeasurement(m);
    box.appendChild(div);
  }
  if (lengths.length >= 2) {
    const ids = lengths.map((m) => m.id);
    let {a, b} = state.ratio;
    if (!ids.includes(a) || !ids.includes(b) || a === b) {
      a = ids[ids.length - 2];
      b = ids[ids.length - 1];
      state.ratio = {a, b};
    }
    for (const [id, val] of [['ratioA', a], ['ratioB', b]]) {
      const sel = body.querySelector(`#${id}`);
      sel.innerHTML = lengths.map((m) => {
        const q = describe(m);
        return `<option value="${m.id}">#${numberOf(m)} · ${escapeHtml(q.rows[0][0])}</option>`;
      }).join('');
      sel.value = val;
      sel.onchange = () => {
        state.ratio[id === 'ratioA' ? 'a' : 'b'] = sel.value;
        renderMeasurePanel();
      };
    }
    const qa = describe(lengths.find((m) => m.id === a));
    const qb = describe(lengths.find((m) => m.id === b));
    const out = body.querySelector('#ratioValue');
    if (qa.unit !== qb.unit) out.textContent = 'different units (mm and px): calibrate first';
    else if (!(qa.length > 0 && qb.length > 0)) out.textContent = '–';
    else out.innerHTML = `<span class="measure-value">${fmt(qa.length / qb.length, 3)}</span> <span class="muted">(B ÷ A = ${fmt(qb.length / qa.length, 3)})</span>`;
    body.querySelector('#ratioSwap').onclick = () => {
      state.ratio = {a: state.ratio.b, b: state.ratio.a};
      renderMeasurePanel();
    };
  }
  body.querySelector('#calApply')?.addEventListener('click', () => applyCalibration(lastLen));
  body.querySelector('#calInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCalibration(lastLen);
  });
  body.querySelector('#calReset')?.addEventListener('click', () => {
    delete state.calibrations[s.key];
    savePref('calibrations', state.calibrations);
    afterCalibration();
  });
  body.querySelector('#clearAll')?.addEventListener('click', () => {
    remember();
    state.measurements = [];
    afterMeasureChange();
  });
  body.querySelector('#mUndo')?.addEventListener('click', undo);
}

function goToMeasurement(m) {
  const si = state.series.findIndex((x) => x.key === m.seriesKey);
  if (si < 0) return;
  let v = shownVps().find((x) => x.seriesIndex === si && x.series);
  if (!v) {
    v = activeVp();
    showSeries(si, v);
  }
  setActive(v.index);
  v.setPos(m.pos);
  select(m.id);
}

function applyCalibration(lastLen) {
  const v = activeVp();
  const s = v.series;
  const input = $('calInput');
  const real = parseFloat((input?.value || '').replace(',', '.'));
  if (!s || !lastLen) return;
  if (!(real > 0)) {
    toast('Enter the real length in millimetres');
    return;
  }
  const q = describe(lastLen);
  const current = spacingInfo(s, state.calibrations).spacing || [1, 1];
  const factor = real / q.length;
  state.calibrations[s.key] = {
    spacing: [current[0] * factor, current[1] * factor],
    note: `${fmt(q.length, 2)} ${q.unit} = ${fmt(real, 2)} mm`,
  };
  savePref('calibrations', state.calibrations);
  toast(`Calibrated: ${state.calibrations[s.key].note}`);
  afterCalibration();
}

function afterCalibration() {
  for (const v of shownVps()) updateCorners(v);
  redrawAll();
  renderMeasurePanel();
}

let dictionary = null;
async function loadDictionary() {
  if (!dictionary) {
    try {
      dictionary = await (await fetch(`${BASE}dicom-dict.json`)).json();
    } catch {
      dictionary = {};
    }
  }
  return dictionary;
}

let tagsToken = 0;
async function renderTagsPanel(fresh = false) {
  if (state.sheet !== 'tags') return;
  const body = $('sheetBody');
  const v = activeVp();
  const it = v.item;
  if (!it) {
    body.innerHTML = '<p class="muted">Open a scan first.</p>';
    return;
  }
  const filterValue = fresh ? '' : (body.querySelector('#tagFilter')?.value || '');
  if (!body.querySelector('#tagFilter')) {
    body.innerHTML = `<div class="row" style="position:sticky;top:0;background:var(--panel);margin:0;padding:6px 0">
      <input id="tagFilter" type="search" placeholder="Filter tags…" style="flex:1"></div>
      <div id="tagsFile" class="muted" style="font-size:12px"></div><table class="tags-table" id="tagsTable"></table>`;
    body.querySelector('#tagFilter').addEventListener('input', () => drawTags());
  }
  body.querySelector('#tagFilter').value = filterValue;
  const token = ++tagsToken;
  body.querySelector('#tagsFile').textContent = `${it.name}${it.frames > 1 ? ` · frame ${it.frame + 1}` : ''}`;
  try {
    const [rows, dict] = await Promise.all([loader.tags(it), loadDictionary()]);
    if (token !== tagsToken) return;
    body.tagRows = rows;
    body.dict = dict;
    drawTags();
  } catch (e) {
    body.querySelector('#tagsTable').innerHTML = `<tr><td>${escapeHtml(e.message)}</td></tr>`;
  }
}

function drawTags() {
  const body = $('sheetBody');
  const rows = body.tagRows || [];
  const dict = body.dict || {};
  const filter = (body.querySelector('#tagFilter')?.value || '').trim().toLowerCase();
  const html = [];
  for (const r of rows) {
    const name = r.key === 'FFFEE000' ? '' : (dict[r.key]?.[1] || (parseInt(r.key.slice(0, 4), 16) % 2 ? 'Private tag' : ''));
    const label = `${r.key.slice(0, 4)},${r.key.slice(4)}`;
    if (filter && !`${label} ${name} ${r.vr} ${r.value}`.toLowerCase().includes(filter)) continue;
    const pad = r.depth ? `padding-left:${6 + r.depth * 10}px` : '';
    html.push(`<tr><td style="${pad}">${label}</td><td><div class="nm">${escapeHtml(name)} <span class="muted">${escapeHtml(r.vr || '')}</span></div>${escapeHtml(r.value)}</td></tr>`);
    if (html.length > 3000) break;
  }
  body.querySelector('#tagsTable').innerHTML = html.join('');
}

function renderWindowPanel() {
  $('sheetBody').innerHTML = `<div class="wl">
    <label>Brightness <span class="muted">(window level)</span><input id="wlBrightness" type="range"></label>
    <label>Contrast <span class="muted">(window width)</span><input id="wlContrast" type="range" min="0" max="1" step="0.001"></label>
    <div class="row"><label style="margin:0">L <input id="wlLevel" type="number" step="1" style="width:110px"></label>
    <label style="margin:0">W <input id="wlWidth" type="number" step="1" min="1" style="width:110px"></label>
    <button class="btn small" id="wlReset">Reset</button></div>
    <p class="note">Tip: with the <b>Contrast</b> tool, drag on the image: up / down = brightness, left / right = contrast.</p></div>`;
  const onInput = (e) => {
    const v = activeVp();
    if (!v.voi) return;
    const {span} = wlRange(v);
    const id = e.target.id;
    const val = parseFloat(e.target.value);
    if (id === 'wlBrightness') v.setVoi({center: -val, width: v.voi.width});
    if (id === 'wlContrast') v.setVoi({center: v.voi.center, width: Math.exp((1 - val) * Math.log(span * 2))});
    if (id === 'wlLevel') v.setVoi({center: val, width: v.voi.width});
    if (id === 'wlWidth') v.setVoi({center: v.voi.center, width: val});
  };
  for (const id of ['wlBrightness', 'wlContrast', 'wlLevel', 'wlWidth']) $(id).addEventListener('input', onInput);
  $('wlReset').onclick = () => activeVp().resetVoi();
  updateWindowPanel();
}

function wlRange(v) {
  const image = v.shown?.image;
  const it = v.shown?.item;
  if (!image || image.kind !== 'mono') return {min: 0, max: 1, span: 1};
  const a = image.min * it.slope + it.intercept;
  const b = image.max * it.slope + it.intercept;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return {min, max, span: Math.max(1, max - min)};
}

function updateWindowPanel() {
  if (state.sheet !== 'window') return;
  const v = activeVp();
  const ok = !!v.voi && v.shown?.image?.kind === 'mono';
  for (const id of ['wlBrightness', 'wlContrast', 'wlLevel', 'wlWidth']) $(id).disabled = !ok;
  if (!ok) return;
  const {min, max, span} = wlRange(v);
  const b = $('wlBrightness');
  b.min = String(-max);
  b.max = String(-min);
  b.step = String(span / 1000);
  if (document.activeElement !== b) b.value = String(-v.voi.center);
  const c = $('wlContrast');
  if (document.activeElement !== c) c.value = String(1 - Math.log(Math.max(1, v.voi.width)) / Math.log(span * 2));
  if (document.activeElement !== $('wlLevel')) $('wlLevel').value = String(Math.round(v.voi.center));
  if (document.activeElement !== $('wlWidth')) $('wlWidth').value = String(Math.round(v.voi.width));
}

function renderDrivePanel() {
  if (state.sheet !== 'drive') return;
  const body = $('sheetBody');
  const howTip = platform === 'ios' ?
    'Tap <b>Browse Google Drive files</b> below, then in the Files sheet tap <b>Browse → Locations → Google Drive</b> (enable Google Drive under ⋯ → Edit if needed) and pick your <b>.zip</b> or DICOM files.' :
    platform === 'android' ?
      'Tap <b>Browse Google Drive files</b> below to open Google Drive directly and select your <b>.zip</b> study or DICOM files.' :
      'Tap <b>Browse Google Drive files</b> below and choose your <b>Google Drive</b> folder or downloaded <b>.zip</b> / DICOM files.';
  body.innerHTML = `
    <div style="margin: 10px 0">
      <button id="driveBrowseBtn" class="btn primary big" style="width:100%">
        <svg><use href="#i-drive"/></svg> Browse Google Drive files
      </button>
    </div>
    <p class="note">${howTip}</p>
    <h3>Or paste a Google Drive link</h3>
    <p class="note">If someone shared a Google Drive <b>.zip</b> or DICOM file link (set to <i>Anyone with the link</i>), paste it here:</p>
    <div class="row">
      <input id="driveUrlInput" type="text" placeholder="https://drive.google.com/file/d/…" autocomplete="off" spellcheck="false">
      <button id="driveUrlBtn" class="btn primary small">Open link</button>
    </div>
    <p class="muted" style="font-size:12px">Tip: You can also open the Google Drive app, tap <b>⋯ → Open in</b> on any <b>.zip</b> or <b>.dcm</b> file, and choose <b>DICOM Mobile</b>.</p>`;
  body.querySelector('#driveBrowseBtn').addEventListener('click', () => {
    closeSheet();
    pickFromGoogleDrive();
  });
  const submitUrl = () => {
    const val = body.querySelector('#driveUrlInput')?.value || '';
    openGoogleDriveLink(val);
  };
  body.querySelector('#driveUrlBtn').addEventListener('click', submitUrl);
  body.querySelector('#driveUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitUrl();
  });
}

function openGoogleDrive() {
  openSheet('drive');
}

async function pickFromGoogleDrive() {
  if (!isNative) {
    $('filesInput').click();
    return;
  }
  try {
    showEmpty(true);
    setProgress('Opening from Google Drive…', 0);
    const entries = await pickNativeFiles({drive: true}, (m) => setProgress(m, 0));
    if (!entries) {
      setProgress(null);
      if (!state.series.length) showEmpty(true); else showEmpty(false);
      return;
    }
    await openEntries(entries);
  } catch (e) {
    setProgress(null);
    if (!state.series.length) showEmpty(true); else showEmpty(false);
    toast(e.message || String(e));
  }
}

async function openGoogleDriveLink(input) {
  const parsed = parseGoogleDriveUrl(input);
  if (!parsed) {
    toast('Paste a Google Drive file link (https://drive.google.com/file/d/…).');
    return;
  }
  if (parsed.kind === 'folder') {
    toast('Google Drive folder links cannot be downloaded as a single file. Use "Browse Google Drive files" above, or share a .zip link.');
    return;
  }
  closeSheet();
  state.timing = {start: performance.now()};
  try {
    showEmpty(true);
    setProgress('Downloading from Google Drive…', 0);
    if (isNative) {
      const entries = await downloadNativeUrl(parsed.downloadUrl, parsed.id ? `drive-${parsed.id}` : 'drive-scan', (m) => setProgress(m, 0));
      await openEntries(entries);
      return;
    }
    const r = await fetch(parsed.downloadUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
      throw new Error('Google Drive returned a web page. Make sure the file is shared as "Anyone with the link", or use "Browse Google Drive files".');
    }
    const blob = await r.blob();
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const isZipHeader = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    const ext = isZipHeader ? '.zip' : '.dcm';
    const file = new File([blob], `drive-${parsed.id || 'scan'}${ext}`, {type: blob.type});
    await openFiles([file]);
  } catch (e) {
    setProgress(null);
    if (!state.series.length) showEmpty(true); else showEmpty(false);
    toast(`Could not download from Google Drive: ${e.message || e}. Try "Browse Google Drive files" instead.`);
  }
}

function renderHelpPanel() {
  const touchRows = [
    ['Drag up / down (Scroll)', 'Next / previous image'],
    ['Right edge slider', 'Jump through the images quickly'],
    ['Drag (Contrast)', 'Up / down = brightness, left / right = contrast'],
    ['Pinch · two-finger drag', 'Zoom · move the image (any tool)'],
    ['Double tap', 'Zoom in / back to fit. With two views: show that point in the other view'],
    ['Touch and hold', 'Magnifier with the pixel value (HU on CT)'],
    ['Measure', 'Drag to draw. Tap a measurement to select, drag its points, delete'],
  ];
  const deskRows = [
    ['Mouse wheel / two-finger scroll', 'Next / previous image'],
    ['Pinch · Ctrl + wheel', 'Zoom'],
    ['Right drag · middle drag', 'Contrast · move'],
    ['↑ ↓ ← → · PgUp PgDn · Home End', 'Images · 10 images · first / last'],
    ['[  ]', 'Previous / next series'],
    ['S W P · M A E B', 'Scroll, contrast, move · distance, angle, ellipse, rectangle'],
    ['1 – 9 · I · R · Space', 'Presets · invert · reset · play'],
    ['V · Y · K · Tab', 'Two views · sync · all levels · switch view'],
    ['L · T · C · X · F', 'Measurements · tags · sliders · save image · series list'],
    ['H', 'Anonymize patient info'],
    ['Ctrl+Z · Ctrl+Shift+Z · Delete', 'Undo · redo · delete selected measurement'],
  ];
  const rows = (TOUCH ? touchRows : [...touchRows.slice(0, 1), ...deskRows]);
  $('sheetBody').innerHTML = `
    <table class="help-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
    <h3>Two views and reference lines</h3>
    <p class="note">With <b>Two views</b> (in ⋯), the dashed line in each view shows where the other view's current image
      cuts it, e.g. the level of an axial slice on the sagittal image. <b>Show all levels</b> draws every slice of the other
      series as a numbered line; tap a number to go there. Lines are drawn only between series in the same patient coordinates.</p>
    <h3>About measurements</h3>
    <p class="note">CT and MR distances use the pixel size stored by the scanner. Plain X-rays usually only store the pixel size at
      the detector, so anatomy measures about 5–15 % larger than it really is: the panel says so, and <b>Calibrate</b> fixes it with an
      object of known size. Ratios of two distances are exact either way.</p>
    <h3>Privacy</h3>
    <p class="note">Images are read on this device and never uploaded. The app has no account, no tracking and no analytics.
      Preferences (tool, calibrations) are stored only on this device.</p>
    <h3>Not a medical device</h3>
    <p class="note">This viewer is for looking at your own images, for education and reference. It is not intended for diagnosis;
      diagnosis should come from your doctor's report. Compressed (lossy) images are marked LOSSY.</p>
    <h3>Open source</h3>
    <p class="note">Built with dicom-parser, OpenJPEG, CharLS, libjpeg-turbo, OpenJPH, jpeg-lossless-decoder-js, pdf.js (JPEG),
      pako, zip.js and Capacitor. <a href="${BASE}licenses.txt" target="_blank" rel="noopener" style="color:var(--accent-2)">Licences</a></p>
    <p class="muted" style="font-size:12px">Version ${import.meta.env.VITE_APP_VERSION || 'dev'} · ${platform}</p>`;
}

async function renderSavedSheet() {
  if (state.sheet !== 'saved') return;
  const body = $('sheetBody');
  const studies = await listSavedStudies();
  if (!studies.length) {
    body.innerHTML = '<p class="muted">No saved studies in your library yet. Any scan you open is automatically saved for instant access.</p>';
    return;
  }
  body.innerHTML = `
    <p class="note">These studies are stored in your device's library. Tap a study to open it instantly without re-reading or copying files.</p>
    <div id="sheetSavedList" class="saved-list">
      ${studies.map((s) => {
        const name = state.anonymize ? 'ANONYMOUS' : escapeHtml(s.patientName || 'Unnamed patient');
        const mods = (s.modalities || []).map((m) => `<span class="badge">${escapeHtml(m)}</span>`).join('');
        const date = formatDate(s.studyDate);
        const sub = [date, `${s.seriesCount} series`, `${s.imageCount} images`].filter(Boolean).join(' · ');
        const thumb = s.thumb ? `<img class="saved-thumb" src="${s.thumb}" alt="">` : `<div class="saved-thumb">${escapeHtml(s.modalities?.[0] || 'DCM')}</div>`;
        return `
          <div class="saved-card" data-id="${escapeHtml(s.id)}">
            ${thumb}
            <div class="saved-meta">
              <div class="saved-title">${mods} ${name}</div>
              <div class="saved-sub">${escapeHtml(sub)}</div>
            </div>
            <button class="saved-del" title="Delete from saved studies" aria-label="Delete" data-del="${escapeHtml(s.id)}">
              <svg><use href="#i-trash"/></svg>
            </button>
          </div>`;
      }).join('')}
    </div>`;

  const list = body.querySelector('#sheetSavedList');
  for (const card of list.querySelectorAll('.saved-card')) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.saved-del')) return;
      closeSheet();
      openSavedStudy(card.dataset.id);
    });
  }
  for (const btn of list.querySelectorAll('.saved-del')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      await deleteSavedStudy(id);
      if (state.activeStudyId === id) state.activeStudyId = null;
      renderSavedSheet();
      renderSavedStudies();
      toast('Study deleted from library.');
    });
  }
}

// ---------------------------------------------------------------------------
// export the active view as PNG (image + measurements + overlay text)

async function exportView() {
  const v = activeVp();
  if (!v.series || !v.shown?.image) return;
  const {w, h, dpr} = v.size;
  const out = document.createElement('canvas');
  out.width = Math.round(w * dpr);
  out.height = Math.round(h * dpr);
  const ctx = out.getContext('2d');
  ctx.drawImage(v.canvas, 0, 0);
  ctx.drawImage(v.overlay, 0, 0);
  if (state.showInfo) {
    ctx.font = `${11.5 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillStyle = '#f2e7b3';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3 * dpr;
    const rect = v.el.getBoundingClientRect();
    for (const o of v.el.querySelectorAll('.corners .c, .orient')) {
      if (!o.textContent) continue;
      const r = o.getBoundingClientRect();
      const right = o.classList.contains('tr') || o.classList.contains('br');
      ctx.textAlign = right ? 'right' : 'left';
      const x = right ? r.right - rect.left - 8 : r.left - rect.left + (o.classList.contains('orient') ? 0 : 8);
      o.textContent.split('\n').forEach((line, k) => {
        ctx.fillText(line, x * dpr, (r.top - rect.top + 6 + 11 + k * 15.5) * dpr);
      });
    }
  }
  const name = `${v.series.first.modality}_${v.series.title}_image${v.pos + 1}`.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  try {
    const msg = await shareBlob(blob, `${name}.png`);
    if (msg) toast(msg);
  } catch (e) {
    toast(`Could not save the image: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// misc UI

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'}[c]));
}

function updateAll() {
  for (const v of vps) {
    updateCorners(v);
    updateScrubber(v);
  }
  updateTitle();
  updateToolbar();
  updateUndo();
  redrawAll();
}

function toggleDrawer(force) {
  const d = $('seriesPanel');
  const wide = matchMedia('(min-width: 900px)').matches;
  if (wide) {
    d.classList.toggle('closed', force === undefined ? !d.classList.contains('closed') : !force);
    requestAnimationFrame(() => vps.forEach((v) => v.resize()));
    return;
  }
  const open = force === undefined ? !d.classList.contains('open') : force;
  d.classList.toggle('open', open);
  $('scrim').hidden = !open;
}

function closeDrawerOnPhone() {
  if (!matchMedia('(min-width: 900px)').matches) toggleDrawer(false);
}

async function pickFiles() {
  if (!isNative) {
    $('filesInput').click();
    return;
  }
  try {
    showEmpty(true);
    setProgress('Copying files…', 0);
    const entries = await pickNativeFiles({drive: false}, (m) => setProgress(m, 0));
    if (!entries) {
      setProgress(null);
      if (!state.series.length) showEmpty(true); else showEmpty(false);
      return;
    }
    await openEntries(entries);
  } catch (e) {
    setProgress(null);
    if (!state.series.length) showEmpty(true); else showEmpty(false);
    toast(e.message || String(e));
  }
}

const canPickFolder = isNative || 'webkitdirectory' in document.createElement('input');

async function pickFolder() {
  if (!isNative) {
    $('folderInput').click();
    return;
  }
  try {
    showEmpty(true);
    setProgress('Copying the folder…', 0);
    const entries = await pickNativeFolder((m) => setProgress(m, 0));
    if (!entries) {
      setProgress(null);
      if (!state.series.length) showEmpty(true); else showEmpty(false);
      return;
    }
    await openEntries(entries);
  } catch (e) {
    setProgress(null);
    if (!state.series.length) showEmpty(true); else showEmpty(false);
    toast(e.message || String(e));
  }
}

function onBack() {
  if (isMenuOpen()) {
    closeMenu();
    return true;
  }
  if (state.sheet) {
    closeSheet();
    return true;
  }
  if ($('seriesPanel').classList.contains('open')) {
    toggleDrawer(false);
    return true;
  }
  if (state.selected) {
    select(null);
    return true;
  }
  if (state.layout === 2) {
    setLayout(1);
    return true;
  }
  if (state.series.length) {
    closeStudy();
    return true;
  }
  return false;
}

function onKey(e) {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const v = activeVp();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) redo(); else undo();
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
    pickFiles();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const handled = () => e.preventDefault();
  switch (e.key) {
  case 'Escape': onBack(); return;
  case '?': openSheet('help'); return;
  default: break;
  }
  if (!v.series) return;
  switch (e.key) {
  case 'ArrowUp': case 'ArrowLeft': v.scrollBy(-1); handled(); return;
  case 'ArrowDown': case 'ArrowRight': v.scrollBy(1); handled(); return;
  case 'PageUp': v.scrollBy(-10); handled(); return;
  case 'PageDown': v.scrollBy(10); handled(); return;
  case 'Home': v.setPos(0); handled(); return;
  case 'End': v.setPos(v.count - 1); handled(); return;
  case '[': if (v.seriesIndex > 0) showSeries(v.seriesIndex - 1); return;
  case ']': if (v.seriesIndex < state.series.length - 1) showSeries(v.seriesIndex + 1); return;
  case ' ': v.togglePlay(); handled(); return;
  case 'Tab': if (state.layout === 2) { setActive(1 - state.active); handled(); } return;
  case 'Delete': case 'Backspace': if (state.selected) deleteMeasurement(state.selected); handled(); return;
  default: break;
  }
  const k = e.key.toLowerCase();
  const tools = {s: 'scroll', w: 'window', p: 'pan', m: 'length', d: 'length', a: 'angle', e: 'ellipse', b: 'rect'};
  if (tools[k]) {
    setTool(tools[k]);
    return;
  }
  switch (k) {
  case 'i': toggleInvert(); return;
  case 'r': resetView(); return;
  case 't': openSheet('tags', true); return;
  case 'l': openSheet('measure', true); return;
  case 'c': openSheet('window', true); return;
  case 'f': toggleDrawer(); return;
  case 'g': toggleSmooth(); return;
  case 'x': exportView(); return;
  case 'v': setLayout(state.layout === 2 ? 1 : 2); return;
  case 'y': toggleSync(); return;
  case 'k': toggleLevels(); return;
  case 'h': toggleAnonymize(); return;
  default: break;
  }
  if (/^[1-9]$/.test(e.key) && v.item && v.shown?.image?.kind === 'mono') {
    const p = windowPresets(v.item)[parseInt(e.key, 10) - 1];
    if (p) applyPreset(p);
  }
}

function bindUi() {
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('homeBtn')?.addEventListener('click', () => {
    if (state.series.length) closeStudy();
    else renderSavedStudies();
  });
  $('title')?.addEventListener('click', () => {
    if (state.series.length) closeStudy();
  });
  $('drawerHomeBtn')?.addEventListener('click', () => {
    toggleDrawer(false);
    closeStudy();
  });
  $('emptyLogo')?.addEventListener('click', () => renderSavedStudies());
  $('savedSearch')?.addEventListener('input', (e) => {
    savedStudiesSearchQuery = e.target.value;
    renderSavedListItems();
  });
  $('measureMenuBtn').addEventListener('click', (e) => measureMenu(e.currentTarget));
  $('presetBtn').addEventListener('click', (e) => presetsMenu(e.currentTarget));
  $('playBtn').addEventListener('click', () => activeVp().togglePlay());
  $('moreBtn').addEventListener('click', (e) => moreMenu(e.currentTarget));
  $('openBtn').addEventListener('click', (e) => openSourceMenu(e.currentTarget));
  $('seriesBtn').addEventListener('click', () => toggleDrawer());
  $('scrim').addEventListener('click', () => toggleDrawer(false));
  for (const b of document.querySelectorAll('[data-close="seriesPanel"]')) b.addEventListener('click', () => toggleDrawer(false));
  $('sheetClose').addEventListener('click', closeSheet);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('openFilesBig').addEventListener('click', pickFiles);
  $('openDriveBig').addEventListener('click', openGoogleDrive);
  $('openFolderBig').addEventListener('click', pickFolder);
  $('sampleBtn').addEventListener('click', openSample);
  for (const id of ['filesInput', 'folderInput']) {
    $(id).addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) openFiles(files);
    });
  }
  // drag and drop (desktop)
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) openFiles(files);
  });
  window.addEventListener('keydown', onKey);
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  window.addEventListener('resize', () => vps.forEach((v) => updateScrubber(v)));
  if (matchMedia('(min-width: 900px)').matches && loadPref('drawerClosed', false)) toggleDrawer(false);
  $('viewports').classList.toggle('hide-info', !state.showInfo);
}

// ---------------------------------------------------------------------------

bindUi();
vps.forEach(bindViewport);
updateAll();
initNative((files) => openFiles(files), onBack);
onNativeProgress((p) => {
  if (p && p.total > 0) {
    const pct = Math.round((p.copied / p.total) * 100);
    setProgress(`Copying files… ${p.copied} / ${p.total} (${pct}%)`, p.copied / p.total);
  }
});
$('openFolderBig').hidden = !canPickFolder;
renderSavedStudies();

// handy for debugging and for the end-to-end tests
window.dicomReader = {state, vps, loader, openFiles, openSample, openGoogleDrive, openGoogleDriveLink, setTool, setLayout, showSeries, activeVp};
if (new URLSearchParams(location.search).has('sample') || import.meta.env.VITE_AUTOLOAD_SAMPLE === '1') openSample();

