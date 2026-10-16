// Decoder worker: parses headers, decodes frames and lists tags off the main
// thread. Messages: {id, op: 'index'|'decode'|'tags', key, source?, frame?}
import openjpegWasm from '@cornerstonejs/codec-openjpeg/decodewasm?url';
import charlsWasm from '@cornerstonejs/codec-charls/decodewasm?url';
import libjpegWasm from '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm?url';
import openjphWasm from '@cornerstonejs/codec-openjph/wasm?url';
import {parse, extractMeta, listTags} from './meta.js';
import {decodeFrame} from './pixels.js';
import {setWasmUrls} from './codecs.js';

setWasmUrls({openjpeg: openjpegWasm, charls: charlsWasm, libjpeg: libjpegWasm, openjph: openjphWasm});

const HEAD_BYTES = 48 * 1024;

// recently parsed full datasets (multi-frame files are decoded frame by frame)
const parsed = new Map();
let parsedBytes = 0;
const PARSED_BUDGET = 96 * 1024 * 1024;

function remember(key, ds, meta) {
  if (parsed.has(key)) return;
  parsed.set(key, {ds, meta});
  parsedBytes += ds.byteArray.length;
  while (parsedBytes > PARSED_BUDGET && parsed.size > 1) {
    const [k, v] = parsed.entries().next().value;
    parsed.delete(k);
    parsedBytes -= v.ds.byteArray.length;
  }
}

async function bytesOf(source, limit) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  // File / Blob
  const blob = limit && source.size > limit ? source.slice(0, limit) : source;
  return new Uint8Array(await blob.arrayBuffer());
}

async function full(key, source) {
  const hit = parsed.get(key);
  if (hit) {
    // refresh LRU position
    parsed.delete(key);
    parsed.set(key, hit);
    return hit;
  }
  if (!source) return null;
  const bytes = await bytesOf(source);
  const ds = parse(bytes);
  const meta = extractMeta(ds);
  if (!meta) throw new Error('Not an image');
  remember(key, ds, meta);
  return {ds, meta};
}

async function index(source) {
  const size = source.size ?? source.byteLength ?? 0;
  let bytes = await bytesOf(source, HEAD_BYTES);
  if (bytes.length < 132) return null;
  let ds;
  try {
    ds = parse(bytes, {untilPixelData: true});
    if (!ds.elements.x7fe00010 && size > bytes.length) throw new Error('header longer than the first chunk');
  } catch (e) {
    if (size <= bytes.length) throw e;
    bytes = await bytesOf(source);
    ds = parse(bytes, {untilPixelData: true});
  }
  // whole file read and still no pixel data: not an image (SR, KO, PR, ...)
  if (!ds.elements.x7fe00010 && !ds.elements.x7fe00008 && !ds.elements.x7fe00009 && bytes.length >= size) return null;
  return extractMeta(ds);
}

let dictionary = null;
async function vrLookup(url) {
  if (!dictionary && url) {
    try {
      dictionary = await (await fetch(url)).json();
    } catch {
      dictionary = {};
    }
  }
  return (key) => dictionary?.[key]?.[0];
}

self.onmessage = async (e) => {
  const {id, op, key, source, frame} = e.data;
  try {
    if (op === 'indexMany') {
      const results = await Promise.all(e.data.items.map((it) => index(it.source).then(
        (meta) => ({ok: true, meta}),
        (err) => ({ok: false, error: String(err?.message || err)}))));
      self.postMessage({id, ok: true, results});
      return;
    }
    if (op === 'index') {
      const meta = await index(source);
      self.postMessage({id, ok: true, meta});
      return;
    }
    if (op === 'decode') {
      const hit = await full(key, source);
      if (!hit) {
        self.postMessage({id, ok: false, missing: true});
        return;
      }
      const img = await decodeFrame(hit.ds, hit.meta.file, frame || 0);
      const transfer = [(img.data || img.rgba).buffer];
      self.postMessage({id, ok: true, image: img}, transfer);
      return;
    }
    if (op === 'tags') {
      const hit = await full(key, source);
      if (!hit) {
        self.postMessage({id, ok: false, missing: true});
        return;
      }
      const vrOf = await vrLookup(e.data.dictionaryUrl);
      self.postMessage({id, ok: true, rows: listTags(hit.ds, vrOf)});
      return;
    }
    throw new Error(`Unknown op ${op}`);
  } catch (err) {
    self.postMessage({id, ok: false, error: String(err?.message || err)});
  }
};
