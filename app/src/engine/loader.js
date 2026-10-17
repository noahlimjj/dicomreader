// Main thread side of the decoder workers: a priority queue, a byte-bounded
// cache of decoded frames and prefetching.

const isIos = typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const isMobile = isIos || (typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent));

export const MOBILE = isMobile;

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; ++i) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class Loader {
  constructor({dictionaryUrl} = {}) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(2, Math.min(isMobile ? 4 : 8, cores - 1));
    this.workers = Array.from({length: n}, (_, i) => this.makeWorker(i));
    this.queue = [];
    this.pending = new Map(); // request id -> task
    this.cache = new Map(); // image id -> {image, bytes}
    this.cacheBytes = 0;
    this.budget = (isMobile ? 160 : 512) * 1024 * 1024;
    this.nextId = 1;
    this.dictionaryUrl = dictionaryUrl;
  }

  makeWorker(index) {
    const w = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
    const slot = {w, index, busy: null, holds: new Set()};
    w.onmessage = (e) => this.onMessage(slot, e.data);
    w.onerror = (e) => {
      console.error('decoder worker error', e.message || e);
      const t = slot.busy;
      slot.busy = null;
      const err = new Error(e.message || 'Decoder crashed');
      if (t?.tasks) t.tasks.forEach((x) => x.reject(err)); else if (t) t.reject(err);
      this.pump();
    };
    return slot;
  }

  // ---- public API --------------------------------------------------------

  /** Header of a file. entry: {key, getSource(): Promise<File|ArrayBuffer>} */
  index(entry) {
    return this.enqueue({op: 'index', entry, priority: 1});
  }

  peek(item) {
    if (item.mprImage) return item.mprImage;
    const hit = this.cache.get(item.id);
    if (!hit) return undefined;
    this.cache.delete(item.id);
    this.cache.set(item.id, hit);
    return hit.image;
  }

  /** Decoded frame of item ({id, entry, frame}), from the cache if possible. */
  image(item, priority = 10) {
    if (item.mprImage) return Promise.resolve(item.mprImage);
    const cached = this.peek(item);
    if (cached) return Promise.resolve(cached);

    const existing = [...this.pending.values()].find((t) => t.op === 'decode' && t.item.id === item.id) ||
      this.queue.find((t) => t.op === 'decode' && t.item.id === item.id);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      return existing.promise;
    }
    return this.enqueue({op: 'decode', item, entry: item.entry, priority});
  }

  prefetch(items, priority = 2) {
    for (const it of items) {
      if (!this.cache.has(it.id)) this.image(it, priority).catch(() => {});
    }
  }

  /** Drop queued (not running) decodes, e.g. when another series is shown. */
  cancel(predicate = () => true) {
    this.queue = this.queue.filter((t) => {
      if (t.op === 'decode' && predicate(t.item)) {
        t.reject(Object.assign(new Error('cancelled'), {cancelled: true}));
        return false;
      }
      return true;
    });
  }

  tags(item) {
    return this.enqueue({op: 'tags', entry: item.entry, item, priority: 20});
  }

  clear() {
    this.cancel();
    this.queue = [];
    this.cache.clear();
    this.cacheBytes = 0;
    for (const s of this.workers) s.holds.clear();
  }

  // ---- internals -----------------------------------------------------------

  enqueue(task) {
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    task.seq = this.nextId++;
    this.queue.push(task);
    this.pump();
    return task.promise;
  }

  // multi-frame files stick to one worker, which keeps the parsed file
  slotFor(task) {
    if (task.op !== 'index' && task.entry?.frames > 1) {
      const preferred = this.workers[hash(task.entry.key) % this.workers.length];
      return preferred.busy ? null : preferred;
    }
    return this.workers.find((s) => !s.busy) || null;
  }

  pump() {
    // highest priority first. Among equals: decodes newest first (the latest
    // scroll position wins), headers in order (so read-ahead below matches)
    this.queue.sort((a, b) => a.priority - b.priority ||
      (a.op === 'index' && b.op === 'index' ? b.seq - a.seq : a.seq - b.seq));
    while (this.queue.length && this.workers.some((s) => !s.busy)) {
      let started = false;
      for (let i = this.queue.length - 1; i >= 0; --i) {
        const slot = this.slotFor(this.queue[i]);
        if (!slot) continue;
        const [task] = this.queue.splice(i, 1);
        if (task.op === 'index' && task.entry.cheap) this.runBatch(slot, task);
        else this.run(slot, task);
        started = true;
        break;
      }
      if (!started) break;
    }
    this.readAhead();
  }

  // Files inside a ZIP are extracted on the main thread: start extracting the
  // next few while the workers parse, but only a few (memory on phones).
  readAhead() {
    let inFlight = this.queue.filter((t) => t.sourcePromise).length;
    for (let i = this.queue.length - 1; i >= 0 && inFlight < 4; --i) {
      const t = this.queue[i];
      if (t.op !== 'index' || t.sourcePromise || t.entry.cheap) continue;
      t.sourcePromise = t.entry.getSource();
      t.sourcePromise.catch(() => {});
      inFlight++;
    }
  }

  // Headers of plain files go to a worker in batches: one message per file
  // costs a round trip each (noticeable in WebKit with hundreds of slices).
  runBatch(slot, first) {
    const per = Math.max(4, Math.min(32, Math.ceil(this.queue.length / this.workers.length)));
    const tasks = [first];
    for (let i = this.queue.length - 1; i >= 0 && tasks.length < per; --i) {
      const t = this.queue[i];
      if (t.op === 'index' && t.entry.cheap && t.priority === first.priority) {
        tasks.push(t);
        this.queue.splice(i, 1);
      }
    }
    const id = this.nextId++;
    const batch = {op: 'indexMany', tasks};
    slot.busy = batch;
    this.pending.set(id, batch);
    Promise.all(tasks.map((t) => t.entry.getSource())).then((sources) => {
      slot.w.postMessage({id, op: 'indexMany', items: tasks.map((t, k) => ({key: t.entry.key, source: sources[k]}))});
    }, (e) => {
      this.pending.delete(id);
      slot.busy = null;
      for (const t of tasks) t.reject(e);
      this.pump();
    });
  }

  async run(slot, task, forceSource = false) {
    slot.busy = task;
    const id = this.nextId++;
    task.requestId = id;
    this.pending.set(id, task);
    const entry = task.entry;
    const multi = entry.frames > 1;
    let source;
    try {
      if (task.sourcePromise && !forceSource) {
        source = await task.sourcePromise;
        task.sourcePromise = null;
      } else if (task.op === 'index' || forceSource || !multi || !slot.holds.has(entry.key)) {
        source = await entry.getSource();
      }
    } catch (e) {
      this.pending.delete(id);
      slot.busy = null;
      task.reject(e);
      this.pump();
      return;
    }
    const msg = {id, op: task.op, key: entry.key, frame: task.item?.frame || 0, source};
    if (task.op === 'tags') msg.dictionaryUrl = this.dictionaryUrl;
    const transfer = source instanceof ArrayBuffer && !entry.keepBuffer ? [source] : [];
    slot.w.postMessage(msg, transfer);
  }

  onMessage(slot, msg) {
    const task = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    slot.busy = null;
    if (!task) {
      this.pump();
      return;
    }
    if (task.op === 'indexMany') {
      task.tasks.forEach((t, k) => {
        const r = msg.results?.[k];
        if (r && r.ok) t.resolve(r.meta); else t.reject(new Error(r?.error || msg.error || 'Failed'));
      });
      this.pump();
      return;
    }
    if (!msg.ok && msg.missing) {
      slot.holds.delete(task.entry.key);
      this.run(slot, task, true);
      return;
    }
    if (task.entry && task.entry.frames > 1 && (task.op === 'decode' || task.op === 'tags')) {
      slot.holds.add(task.entry.key);
      if (slot.holds.size > 4) slot.holds.delete(slot.holds.values().next().value);
    }
    if (!msg.ok) {
      task.reject(new Error(msg.error || 'Failed'));
    } else if (task.op === 'index') {
      task.resolve(msg.meta);
    } else if (task.op === 'tags') {
      task.resolve(msg.rows);
    } else {
      const image = msg.image;
      this.store(task.item.id, image);
      task.resolve(image);
    }
    this.pump();
  }

  store(id, image) {
    const bytes = (image.data || image.rgba).byteLength;
    if (this.cache.has(id)) return;
    this.cache.set(id, {image, bytes});
    this.cacheBytes += bytes;
    while (this.cacheBytes > this.budget && this.cache.size > 4) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      this.cacheBytes -= v.bytes;
    }
  }
}
