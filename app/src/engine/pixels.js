// Pixel data of one frame -> typed array (monochrome stored values) or RGBA.
import * as dicomParser from 'dicom-parser';
import {TS} from './meta.js';
import {
  decodeJ2K, decodeHTJ2K, decodeJpegLs, decodeJpegBaseline8, decodeJpeg12, decodeJpegLossless,
} from './codecs.js';

export const SUPPORTED_TS = new Set(Object.values(TS));

function frameFragments(ds, el, frameIndex, frames) {
  if (el.basicOffsetTable && el.basicOffsetTable.length) {
    return dicomParser.readEncapsulatedImageFrame(ds, el, frameIndex);
  }
  if (frames === 1) {
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, el.fragments.length);
  }
  if (el.fragments.length === frames) {
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, frameIndex, 1);
  }
  // several fragments per frame and no offset table: find frame ends (JPEG EOI)
  const table = dicomParser.createJPEGBasicOffsetTable(ds, el);
  return dicomParser.readEncapsulatedImageFrame(ds, el, frameIndex, table);
}

function nativeFrame(ds, el, f, frameIndex) {
  const bytes = ds.byteArray;
  if (f.bitsAllocated === 1) {
    // bits are packed continuously across frames (LSB first)
    const n = f.rows * f.cols;
    const out = new Uint8Array(n);
    const startBit = frameIndex * n;
    for (let i = 0; i < n; ++i) {
      const bit = startBit + i;
      out[i] = (bytes[el.dataOffset + (bit >> 3)] >> (bit & 7)) & 1;
    }
    return out;
  }
  // YBR_FULL_422 stores 2 samples per pixel (Y Y Cb Cr per pair)
  const samples = f.photometric === 'YBR_FULL_422' ? 2 : f.samplesPerPixel;
  const frameBytes = f.rows * f.cols * samples * (f.bitsAllocated >> 3);
  const start = el.dataOffset + frameIndex * frameBytes;
  const available = Math.max(0, Math.min(frameBytes, el.dataOffset + el.length - start, bytes.length - start));
  if (available < frameBytes * 0.5) throw new Error('Pixel data is truncated');
  const out = new Uint8Array(frameBytes);
  out.set(bytes.subarray(start, start + available));
  return out;
}

function swapBytes(bytes, size) {
  if (size === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const t = bytes[i];
      bytes[i] = bytes[i + 1];
      bytes[i + 1] = t;
    }
  } else if (size === 4) {
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      let t = bytes[i];
      bytes[i] = bytes[i + 3];
      bytes[i + 3] = t;
      t = bytes[i + 1];
      bytes[i + 1] = bytes[i + 2];
      bytes[i + 2] = t;
    }
  }
}

/**
 * DICOM RLE: one segment per byte of each sample, most significant first.
 * Returns pixel interleaved little endian samples.
 */
export function decodeRle(data, rows, cols, spp, bitsAllocated) {
  const bytesPerSample = bitsAllocated >> 3;
  const n = rows * cols;
  const out = new Uint8Array(n * spp * bytesPerSample);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const segments = dv.getUint32(0, true);
  const offsets = [];
  for (let s = 0; s < segments; ++s) offsets.push(dv.getUint32(4 + s * 4, true));
  offsets.push(data.length);
  for (let s = 0; s < segments; ++s) {
    const sample = Math.floor(s / bytesPerSample);
    const byte = bytesPerSample - 1 - (s % bytesPerSample); // MSB segment first
    const stride = spp * bytesPerSample;
    let o = sample * bytesPerSample + byte;
    const outEnd = out.length;
    let i = offsets[s];
    const end = offsets[s + 1] || data.length;
    let written = 0;
    while (i < end && written < n) {
      const c = data[i++];
      if (c < 128) {
        for (let k = 0; k <= c && written < n && i < end; ++k) {
          if (o < outEnd) out[o] = data[i];
          i++;
          o += stride;
          written++;
        }
      } else if (c > 128) {
        const v = data[i++];
        for (let k = 0; k < 257 - c && written < n; ++k) {
          if (o < outEnd) out[o] = v;
          o += stride;
          written++;
        }
      }
    }
  }
  return out;
}

// raw sample bytes (little endian) -> monochrome typed array with sign / mask
function toMono(bytes, f) {
  const n = f.rows * f.cols;
  const ba = f.bitsAllocated;
  const signed = f.pixelRepresentation === 1;
  const bs = Math.min(f.bitsStored || ba, ba);
  if (ba === 1) return {data: bytes};
  if (ba === 8) {
    const src = bytes.subarray(0, n);
    if (!signed) {
      if (bs < 8) {
        const mask = (1 << bs) - 1;
        const out = new Uint8Array(n);
        for (let i = 0; i < n; ++i) out[i] = src[i] & mask;
        return {data: out};
      }
      return {data: src.byteOffset === 0 && src.length === src.buffer.byteLength ? src : src.slice()};
    }
    const out = new Int8Array(n);
    const shift = 32 - bs;
    for (let i = 0; i < n; ++i) out[i] = (src[i] << shift) >> shift;
    return {data: out};
  }
  if (ba === 16) {
    const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice();
    const u16 = new Uint16Array(aligned.buffer, aligned.byteOffset, Math.min(n, aligned.length >> 1));
    if (signed) {
      const out = new Int16Array(n);
      const shift = 32 - bs;
      for (let i = 0; i < u16.length; ++i) out[i] = (u16[i] << shift) >> shift;
      return {data: out};
    }
    const out = new Uint16Array(n);
    if (bs < 16) {
      const mask = (1 << bs) - 1;
      for (let i = 0; i < u16.length; ++i) out[i] = u16[i] & mask;
    } else {
      out.set(u16);
    }
    return {data: out};
  }
  if (ba === 32) {
    const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    const len = Math.min(n, aligned.length >> 2);
    const out = signed ? new Int32Array(n) : new Uint32Array(n);
    out.set(signed ? new Int32Array(aligned.buffer, aligned.byteOffset, len) : new Uint32Array(aligned.buffer, aligned.byteOffset, len));
    return {data: out};
  }
  throw new Error(`Unsupported bits allocated: ${ba}`);
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// raw colour samples -> RGBA
function toRgba(bytes, f, {planar, ybr, ybr422, bits = f.bitsAllocated} = {}) {
  const n = f.rows * f.cols;
  const out = new Uint8ClampedArray(n * 4);
  let sample;
  if (bits === 8) {
    sample = (i) => bytes[i];
  } else if (bits === 16) {
    const shift = Math.max(0, (f.bitsStored || 16) - 8);
    sample = (i) => (bytes[2 * i] | (bytes[2 * i + 1] << 8)) >> shift;
  } else {
    const max = 2 ** (f.bitsStored || 32) - 1;
    sample = (i) => Math.round(((bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16)) + bytes[4 * i + 3] * 16777216) * 255 / max);
  }
  for (let p = 0; p < n; ++p) {
    let a;
    let b;
    let c;
    if (ybr422) {
      // Y1 Y2 Cb Cr per pair of pixels
      const pair = p >> 1;
      a = sample(pair * 4 + (p & 1));
      b = sample(pair * 4 + 2);
      c = sample(pair * 4 + 3);
    } else if (planar) {
      a = sample(p);
      b = sample(p + n);
      c = sample(p + 2 * n);
    } else {
      a = sample(p * 3);
      b = sample(p * 3 + 1);
      c = sample(p * 3 + 2);
    }
    const o = p * 4;
    if (ybr) {
      out[o] = clamp8(Math.round(a + 1.402 * (c - 128)));
      out[o + 1] = clamp8(Math.round(a - 0.344136 * (b - 128) - 0.714136 * (c - 128)));
      out[o + 2] = clamp8(Math.round(a + 1.772 * (b - 128)));
    } else {
      out[o] = a;
      out[o + 1] = b;
      out[o + 2] = c;
    }
    out[o + 3] = 255;
  }
  return out;
}

function lutData(ds, descTag, dataTag) {
  const desc = ds.elements[descTag];
  const data = ds.elements[dataTag];
  if (!desc || !data) return null;
  let entries = ds.uint16(descTag, 0);
  if (entries === 0) entries = 65536;
  const first = desc.length >= 6 ? (ds.uint16(descTag, 1)) : 0;
  const bits = desc.length >= 6 ? ds.uint16(descTag, 2) : 16;
  const bytes = ds.byteArray;
  const values = new Uint8Array(entries);
  const eightBitPacked = bits === 8 && data.length === entries;
  for (let i = 0; i < entries; ++i) {
    let v;
    if (eightBitPacked) {
      v = bytes[data.dataOffset + i];
    } else {
      const o = data.dataOffset + i * 2;
      v = bytes[o] | (bytes[o + 1] << 8);
      v = bits === 8 ? v & 0xff : v >> 8;
    }
    values[i] = v;
  }
  return {values, first, entries};
}

function applyPalette(ds, mono, f) {
  const r = lutData(ds, 'x00281101', 'x00281201');
  const g = lutData(ds, 'x00281102', 'x00281202');
  const b = lutData(ds, 'x00281103', 'x00281203');
  if (!r || !g || !b) throw new Error('Palette colour lookup table missing');
  const n = f.rows * f.cols;
  const out = new Uint8ClampedArray(n * 4);
  const pick = (lut, v) => lut.values[Math.max(0, Math.min(lut.entries - 1, v - lut.first))];
  for (let p = 0; p < n; ++p) {
    const v = mono[p];
    const o = p * 4;
    out[o] = pick(r, v);
    out[o + 1] = pick(g, v);
    out[o + 2] = pick(b, v);
    out[o + 3] = 255;
  }
  return out;
}

// JFIF, or an Adobe marker with transform 1/2, means YCbCr inside the JPEG
function jpegHasColourTransform(bytes) {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xda || m === 0xd9) break; // start of scan / end
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (m === 0xe0 && bytes[i + 4] === 0x4a && bytes[i + 5] === 0x46) return true; // "JF"
    if (m === 0xee && bytes[i + 4] === 0x41 && bytes[i + 5] === 0x64) return bytes[i + 4 + 11] !== 0; // "Ad"obe
    i += 2 + len;
  }
  return false;
}

function minMax(data) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; ++i) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return {min: 0, max: 0};
  return {min, max};
}

/**
 * Decode one frame.
 * @param ds dicom-parser dataset parsed with the pixel data
 * @param f file metadata from extractMeta
 * @returns {Promise<{kind: 'mono'|'rgb', width, height, data?, rgba?, min?, max?}>}
 */
export async function decodeFrame(ds, f, frameIndex = 0) {
  const el = ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009;
  if (!el) throw new Error('No pixel data');
  if (ds.elements.x7fe00010 === undefined) throw new Error('Float pixel data is not supported');
  const ts = f.transferSyntax;
  if (!SUPPORTED_TS.has(ts) && el.encapsulatedPixelData) {
    throw new Error(`Compression not supported (${ts})`);
  }
  const photometric = f.photometric;
  const isColour = f.samplesPerPixel === 3;
  const width = f.cols;
  const height = f.rows;
  let raw; // little endian raw samples, pixel interleaved unless planar
  let planar = f.planarConfiguration === 1;
  let alreadyRgb = false; // decoder did the colour transform
  let signedByCodec;

  if (!el.encapsulatedPixelData) {
    raw = nativeFrame(ds, el, f, frameIndex);
    if (ts === TS.EXPLICIT_BE && f.bitsAllocated > 8) swapBytes(raw, f.bitsAllocated >> 3);
  } else {
    const comp = frameFragments(ds, el, frameIndex, f.frames);
    switch (ts) {
    case TS.RLE:
      raw = decodeRle(comp, height, width, f.samplesPerPixel, f.bitsAllocated);
      planar = false;
      break;
    case TS.JPEG_BASELINE:
    case TS.JPEG_EXTENDED: {
      if (isColour && photometric === 'RGB' && !jpegHasColourTransform(comp)) {
        // RGB components stored as is: libjpeg would convert them from YCbCr
        raw = decodeJpeg12(comp, 8, width, height).data;
      } else if (f.bitsAllocated <= 8 && ts === TS.JPEG_BASELINE) {
        try {
          const d = await decodeJpegBaseline8(comp);
          raw = d.bytes;
        } catch {
          raw = decodeJpeg12(comp, 8, width, height).data;
        }
      } else {
        const d = decodeJpeg12(comp, f.bitsAllocated, width, height);
        raw = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
      }
      planar = false;
      alreadyRgb = true;
      break;
    }
    case TS.JPEG_LOSSLESS_14:
    case TS.JPEG_LOSSLESS_SV1: {
      const d = decodeJpegLossless(comp, f.bitsAllocated);
      raw = d.bytes;
      planar = false;
      alreadyRgb = true;
      break;
    }
    case TS.JPEG_LS_LOSSLESS:
    case TS.JPEG_LS_NEAR: {
      const d = await decodeJpegLs(comp);
      raw = d.bytes;
      planar = false;
      alreadyRgb = photometric !== 'YBR_FULL';
      break;
    }
    case TS.J2K_LOSSLESS:
    case TS.J2K: {
      const d = await decodeJ2K(comp);
      raw = d.bytes;
      signedByCodec = d.signed;
      planar = false;
      alreadyRgb = true;
      break;
    }
    case TS.HTJ2K_LOSSLESS:
    case TS.HTJ2K_LOSSLESS_RPCL:
    case TS.HTJ2K: {
      const d = await decodeHTJ2K(comp);
      raw = d.bytes;
      signedByCodec = d.signed;
      planar = false;
      alreadyRgb = true;
      break;
    }
    default:
      // encapsulated uncompressed and unknown: try as raw bytes
      raw = comp;
    }
  }

  if (photometric === 'PALETTE COLOR') {
    const {data} = toMono(raw, {...f, samplesPerPixel: 1});
    return {kind: 'rgb', width, height, rgba: applyPalette(ds, data, f)};
  }
  if (isColour) {
    const ybr = !alreadyRgb && (photometric === 'YBR_FULL' || photometric === 'YBR_FULL_422');
    const ybr422 = !alreadyRgb && photometric === 'YBR_FULL_422' && !el.encapsulatedPixelData;
    const bits = el.encapsulatedPixelData && f.bitsAllocated > 8 ? 16 : f.bitsAllocated;
    return {kind: 'rgb', width, height, rgba: toRgba(raw, f, {planar, ybr, ybr422, bits})};
  }
  const mono = toMono(raw, {...f, pixelRepresentation: f.pixelRepresentation, signedByCodec});
  const {min, max} = minMax(mono.data);
  return {kind: 'mono', width, height, data: mono.data, min, max};
}
