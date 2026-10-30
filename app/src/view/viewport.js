// One image view: canvas rendering, zoom / pan / rotate, slice changes,
// prefetching and cine playback.
import {renderPixels, defaultWindow} from './render.js';
import {pixelAspect} from '../model/study.js';

// 2D affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (x, y) => [x, 0, 0, y, 0, 0];
const ROT = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]];
const rotate = (q) => [...ROT[((q % 4) + 4) % 4], 0, 0];

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export class Viewport {
  /**
   * @param {HTMLElement} el container (.vp)
   * @param {{loader, index: number, onChange: Function, drawOverlay: Function, smooth: () => boolean}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.index = opts.index;
    this.loader = opts.loader;
    this.series = null;
    this.pos = 0; // image index within the series
    this.view = {zoom: 1, panX: 0, panY: 0, rot: 0, flip: false};
    this.voi = null;
    this.voiUser = false;
    this.invert = false;
    this.shown = null; // {item, image} currently on screen
    this.playing = null;
    this.dir = 1;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'img';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'ovl';
    this.buffer = document.createElement('canvas');
    this.bufferKey = '';
    el.prepend(this.canvas, this.overlay);
    this.size = {w: 1, h: 1, dpr: 1};
    this.frame = 0;
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  get item() {
    return this.series ? this.series.items[this.pos] : null;
  }

  get count() {
    return this.series ? this.series.items.length : 0;
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === this.size.w && h === this.size.h && dpr === this.size.dpr) return;
    this.size = {w, h, dpr};
    // small views (two views + an open panel on a phone): less overlay text
    this.el.classList.toggle('compact', w < 300 || h < 260);
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.draw();
    if (this.series) this.opts.onChange(this, 'view');
  }

  // ---- series / slices ------------------------------------------------------

  setSeries(series, pos = 0) {
    this.stop();
    if (this.series && this.series !== series) {
      const old = this.series;
      this.loader.cancel((it) => old.items.includes(it));
    }
    this.series = series;
    this.pos = Math.max(0, Math.min(series.items.length - 1, pos));
    this.view = {zoom: 1, panX: 0, panY: 0, rot: 0, flip: false};
    this.voi = null;
    this.voiUser = false;
    this.invert = false;
    this.shown = null;
    this.bufferKey = '';
    this.prefetchAll = estimateBytes(series) < this.loader.budget * 0.6;
    this.load();
    this.opts.onChange(this, 'series');
  }

  clear() {
    this.stop();
    this.series = null;
    this.shown = null;
    this.draw();
  }

  setPos(pos) {
    if (!this.series) return;
    const n = this.series.items.length;
    const p = Math.max(0, Math.min(n - 1, Math.round(pos)));
    if (p === this.pos) return;
    this.dir = p > this.pos ? 1 : -1;
    this.pos = p;
    this.load();
    this.opts.onChange(this, 'pos');
  }

  scrollBy(delta) {
    this.setPos(this.pos + delta);
  }

  load() {
    const item = this.item;
    if (!item) return;
    const cached = this.loader.peek(item);
    if (cached) {
      this.show(item, cached);
    } else {
      this.loading(true);
      const token = ++this.frame;
      this.loader.image(item, 10).then((image) => {
        if (this.item === item && token === this.frame) this.show(item, image);
      }, (e) => {
        if (e.cancelled || this.item !== item) return;
        this.loading(false);
        this.shown = {item, image: null, error: e.message};
        this.draw();
        this.opts.onChange(this, 'error', e);
      });
    }
    this.prefetch();
  }

  prefetch() {
    const s = this.series;
    if (!s) return;
    const n = s.items.length;
    const ahead = [];
    const reach = this.prefetchAll ? n : 12;
    for (let k = 1; k <= reach; ++k) {
      const a = this.pos + this.dir * k;
      const b = this.pos - this.dir * k;
      if (a >= 0 && a < n) ahead.push(s.items[a]);
      if (k <= reach / 3 && b >= 0 && b < n) ahead.push(s.items[b]);
    }
    // nearest first: higher priority for the closest images
    ahead.slice(0, 6).forEach((it) => this.loader.prefetch([it], 5));
    this.loader.prefetch(ahead.slice(6), 2);
  }

  show(item, image) {
    this.loading(false);
    this.shown = {item, image};
    if (!this.voi && image.kind === 'mono') {
      this.voi = defaultWindow(image, item);
      this.defaultVoi = {...this.voi};
      this.opts.onChange(this, 'voi');
    }
    this.draw();
    this.opts.onChange(this, 'image');
  }

  loading(on) {
    clearTimeout(this.spinTimer);
    if (on) this.spinTimer = setTimeout(() => this.el.classList.add('loading'), 180);
    else this.el.classList.remove('loading');
  }

  // ---- window / view --------------------------------------------------------

  setVoi(voi, user = true) {
    if (!voi || !Number.isFinite(voi.center) || !(voi.width >= 1)) return;
    this.voi = {center: voi.center, width: voi.width};
    this.voiUser = user;
    this.draw();
    this.opts.onChange(this, 'voi');
  }

  resetVoi() {
    if (this.defaultVoi) this.setVoi(this.defaultVoi, false);
  }

  resetView() {
    this.view = {zoom: 1, panX: 0, panY: 0, rot: 0, flip: false};
    this.draw();
    this.opts.onChange(this, 'view');
  }

  rotate(q = 1) {
    this.view.rot = (this.view.rot + q + 4) % 4;
    this.draw();
    this.opts.onChange(this, 'view');
  }

  flip() {
    this.view.flip = !this.view.flip;
    this.draw();
    this.opts.onChange(this, 'view');
  }

  /** zoom by a factor about a point (CSS px in the viewport) */
  zoomAt(factor, sx, sy) {
    const v = this.view;
    const z = Math.max(0.2, Math.min(40, v.zoom * factor));
    const f = z / v.zoom;
    const cx = this.size.w / 2 + v.panX;
    const cy = this.size.h / 2 + v.panY;
    v.panX += (sx - cx) * (1 - f);
    v.panY += (sy - cy) * (1 - f);
    v.zoom = z;
    this.draw();
    this.opts.onChange(this, 'view');
  }

  panBy(dx, dy) {
    this.view.panX += dx;
    this.view.panY += dy;
    this.draw();
    this.opts.onChange(this, 'view');
  }

  /** fit scale (screen px per image pixel column) */
  fitScale(it) {
    const aspect = pixelAspect(it);
    const w = it.cols;
    const h = it.rows * aspect;
    const rotated = this.view.rot % 2 === 1;
    const bw = rotated ? h : w;
    const bh = rotated ? w : h;
    return Math.min(this.size.w / bw, this.size.h / bh);
  }

  /** image (continuous pixel coords) -> CSS px matrix */
  matrix(it = this.shown?.item || this.item) {
    if (!it) return [1, 0, 0, 1, 0, 0];
    const v = this.view;
    const s = this.fitScale(it) * v.zoom;
    const aspect = pixelAspect(it);
    let m = translate(this.size.w / 2 + v.panX, this.size.h / 2 + v.panY);
    if (v.flip) m = mul(m, scale(-1, 1));
    m = mul(m, rotate(v.rot));
    m = mul(m, scale(s, s * aspect));
    m = mul(m, translate(-it.cols / 2, -it.rows / 2));
    return m;
  }

  toScreen(x, y) {
    return apply(this.matrix(), x, y);
  }

  toImage(sx, sy) {
    // the ResizeObserver can lag a layout change (e.g. just after Two views), so measure now
    this.resize();
    return apply(invert(this.matrix()), sx, sy);
  }

  /** screen px per image pixel (for the zoom label) */
  displayScale() {
    const m = this.matrix();
    return Math.hypot(m[0], m[1]);
  }

  // ---- drawing --------------------------------------------------------------

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  paint() {
    const {w, h, dpr} = this.size;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const shown = this.shown;
    if (shown && shown.image) {
      const {item, image} = shown;
      this.updateBuffer(item, image);
      const m = this.matrix(item);
      ctx.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
      ctx.imageSmoothingEnabled = this.opts.smooth();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.buffer, 0, 0);
    }
    const o = this.overlay.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (shown && shown.error) {
      o.fillStyle = '#ff8080';
      o.font = '14px system-ui, sans-serif';
      o.textAlign = 'center';
      o.fillText(`Cannot show this image: ${shown.error}`.slice(0, 90), w / 2, h / 2);
      o.textAlign = 'start';
    }
    if (shown) this.opts.drawOverlay(this, o);
  }

  updateBuffer(item, image) {
    const voi = this.voi || {center: 0, width: 1};
    const key = `${item.id}|${voi.center}|${voi.width}|${this.invert}`;
    if (key === this.bufferKey) return;
    const b = this.buffer;
    if (b.width !== image.width || b.height !== image.height) {
      b.width = image.width;
      b.height = image.height;
      this.imageData = null;
    }
    const bctx = b.getContext('2d');
    if (!this.imageData) this.imageData = bctx.createImageData(image.width, image.height);
    renderPixels(image, item, voi, this.invert, this.imageData.data);
    bctx.putImageData(this.imageData, 0, 0);
    this.bufferKey = key;
  }

  // ---- cine -------------------------------------------------------------------

  play() {
    if (!this.series || this.count < 2 || this.playing) return;
    const it = this.item;
    let fps = 15;
    if (it.frameTime > 0) fps = 1000 / it.frameTime;
    else if (it.cineRate > 0) fps = it.cineRate;
    fps = Math.max(2, Math.min(60, fps));
    this.prefetchAll = true;
    this.prefetch();
    let last = performance.now();
    const step = (t) => {
      if (!this.playing) return;
      if (t - last >= 1000 / fps) {
        const next = (this.pos + 1) % this.count;
        // wait for the next frame rather than flashing the spinner
        if (this.loader.peek(this.series.items[next]) || t - last > 1500) {
          last = t;
          this.dir = 1;
          this.pos = next;
          this.load();
          this.opts.onChange(this, 'pos');
        }
      }
      this.playing = requestAnimationFrame(step);
    };
    this.playing = requestAnimationFrame(step);
    this.opts.onChange(this, 'play');
  }

  stop() {
    if (!this.playing) return;
    cancelAnimationFrame(this.playing);
    this.playing = null;
    this.opts.onChange(this, 'play');
  }

  togglePlay() {
    if (this.playing) this.stop(); else this.play();
  }
}

function estimateBytes(series) {
  const f = series.first;
  const bpp = f.samplesPerPixel === 3 || f.photometric === 'PALETTE COLOR' ? 4 : Math.max(1, f.bitsAllocated >> 3);
  return series.items.length * f.rows * f.cols * bpp;
}
