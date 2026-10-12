// Low-level DICOM helpers that work on the raw file bytes: an element walker,
// value replacement (used for stacking / calibration copies) and a decoder
// for Japanese ISO 2022 text, which dwv does not decode fully.

const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEFINED = 0xffffffff;

function tagKey(group, element) {
  return group.toString(16).padStart(4, '0').toUpperCase() +
    element.toString(16).padStart(4, '0').toUpperCase();
}

/**
 * Walk the top level elements of a little endian DICOM part 10 buffer.
 * Stops at the pixel data. Returns null for unsupported (big endian) files.
 *
 * @returns {{explicit: boolean, elements: Map<string, object>}|null}
 */
export function walk(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const n = bytes.length;
  if (n < 140 || String.fromCharCode(...bytes.subarray(128, 132)) !== 'DICM') return null;
  const elements = new Map();
  let explicit = true;
  let ts = null;

  function readElement(pos, isExplicit) {
    if (pos + 8 > n) return null;
    const group = dv.getUint16(pos, true);
    const element = dv.getUint16(pos + 2, true);
    let vr = '';
    let lenPos;
    let lenSize;
    let valuePos;
    let length;
    if (group === 0xfffe) {
      // item / delimiters never have a VR
      lenPos = pos + 4;
      lenSize = 4;
      length = dv.getUint32(pos + 4, true);
      valuePos = pos + 8;
    } else if (isExplicit) {
      vr = String.fromCharCode(bytes[pos + 4], bytes[pos + 5]);
      if (LONG_VRS.has(vr)) {
        lenPos = pos + 8;
        lenSize = 4;
        length = dv.getUint32(pos + 8, true);
        valuePos = pos + 12;
      } else {
        lenPos = pos + 6;
        lenSize = 2;
        length = dv.getUint16(pos + 6, true);
        valuePos = pos + 8;
      }
    } else {
      lenPos = pos + 4;
      lenSize = 4;
      length = dv.getUint32(pos + 4, true);
      valuePos = pos + 8;
      if (length === UNDEFINED) vr = 'SQ';
    }
    return {group, element, vr, start: pos, lenPos, lenSize, valuePos, length};
  }

  // skip the content of an undefined length sequence, return position after it
  function skipSequence(pos, isExplicit) {
    while (pos + 8 <= n) {
      const el = readElement(pos, isExplicit);
      if (el.group === 0xfffe && el.element === 0xe0dd) return el.valuePos;
      if (el.group === 0xfffe && el.element === 0xe000) {
        pos = el.length === UNDEFINED ? skipItem(el.valuePos, isExplicit) : el.valuePos + el.length;
        continue;
      }
      throw new Error('Malformed sequence');
    }
    throw new Error('Unterminated sequence');
  }

  function skipItem(pos, isExplicit) {
    while (pos + 8 <= n) {
      const el = readElement(pos, isExplicit);
      if (el.group === 0xfffe && el.element === 0xe00d) return el.valuePos;
      if (el.length === UNDEFINED) {
        // UN with undefined length is encoded as implicit VR
        pos = skipSequence(el.valuePos, el.vr === 'UN' ? false : isExplicit);
      } else {
        pos = el.valuePos + el.length;
      }
    }
    throw new Error('Unterminated item');
  }

  let pos = 132;
  try {
    while (pos + 8 <= n) {
      const group = dv.getUint16(pos, true);
      if (group !== 0x0002 && ts === null) {
        ts = textOf(elements.get('00020010'), bytes).replace(/\0/g, '').trim();
        if (ts === '1.2.840.10008.1.2.2') return null; // big endian
        explicit = ts !== '1.2.840.10008.1.2';
      }
      const el = readElement(pos, group === 0x0002 ? true : explicit);
      const key = tagKey(el.group, el.element);
      elements.set(key, el);
      if (key === '7FE00010') break;
      if (el.length === UNDEFINED) {
        pos = skipSequence(el.valuePos, el.vr === 'UN' ? false : explicit);
      } else {
        pos = el.valuePos + el.length;
      }
    }
  } catch (e) {
    console.warn('DICOM walk stopped early:', e.message);
  }
  return {explicit, elements};
}

function textOf(el, bytes) {
  if (!el || el.length === UNDEFINED) return '';
  let s = '';
  for (let i = el.valuePos; i < el.valuePos + el.length && i < bytes.length; ++i) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/** Raw bytes of a top level element value, or undefined. */
export function rawValue(buffer, info, key) {
  const el = info && info.elements.get(key);
  if (!el || el.length === UNDEFINED) return undefined;
  return new Uint8Array(buffer, el.valuePos, Math.min(el.length, buffer.byteLength - el.valuePos));
}

// VR used when an element has to be inserted
const VR_OF = {'00180088': 'DS', '00280030': 'DS', '00200032': 'DS', '00200037': 'DS', '00280034': 'IS'};

/**
 * Return a copy of the buffer where the given top level string elements are
 * replaced (or inserted, in tag order) with new values. One pass, one copy.
 *
 * @param {ArrayBuffer} buffer
 * @param {Object<string,string>} values tag key -> new string value
 * @returns {ArrayBuffer|null} null if the file layout is not supported.
 */
export function withValues(buffer, values) {
  const info = walk(buffer);
  if (!info) return null;
  const src = new Uint8Array(buffer);
  const top = [...info.elements.entries()].filter(([k]) => !k.startsWith('0002'));
  const edits = [];
  for (const [key, text] of Object.entries(values)) {
    let value = text;
    if (value.length % 2) value += ' ';
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; ++i) bytes[i] = value.charCodeAt(i) & 0xff;
    const el = info.elements.get(key);
    if (el) {
      if (el.length === UNDEFINED || (el.lenSize === 2 && bytes.length > 0xffff)) return null;
      // keep everything up to the length field, rewrite length + value
      const len = new Uint8Array(el.lenSize);
      const dv = new DataView(len.buffer);
      if (el.lenSize === 2) dv.setUint16(0, bytes.length, true);
      else dv.setUint32(0, bytes.length, true);
      edits.push({from: el.lenPos, to: el.valuePos + el.length, parts: [len, bytes]});
    } else {
      const vr = VR_OF[key];
      const next = top.find(([k]) => k > key);
      if (!vr || !next) return null;
      const group = parseInt(key.slice(0, 4), 16);
      const element = parseInt(key.slice(4), 16);
      const header = new Uint8Array(8);
      const hdv = new DataView(header.buffer);
      hdv.setUint16(0, group, true);
      hdv.setUint16(2, element, true);
      if (info.explicit) {
        header[4] = vr.charCodeAt(0);
        header[5] = vr.charCodeAt(1);
        hdv.setUint16(6, bytes.length, true);
      } else {
        hdv.setUint32(4, bytes.length, true);
      }
      edits.push({from: next[1].start, to: next[1].start, parts: [header, bytes], insert: true});
    }
  }
  // inserts at the same position must keep tag order: stable sort by position
  edits.sort((a, b) => a.from - b.from || (a.insert ? -1 : 1));
  let size = src.length;
  for (const e of edits) size += e.parts.reduce((n, p) => n + p.length, 0) - (e.to - e.from);
  const out = new Uint8Array(size);
  let read = 0;
  let write = 0;
  for (const e of edits) {
    out.set(src.subarray(read, e.from), write);
    write += e.from - read;
    for (const p of e.parts) {
      out.set(p, write);
      write += p.length;
    }
    read = e.to;
  }
  out.set(src.subarray(read), write);
  return out.buffer;
}

// ---------------------------------------------------------------------------
// ISO 2022 (Japanese) text decoding: ISO 2022 IR 13 / IR 87 / IR 159

// Converted to EUC-JP and decoded in one go: browsers' iso-2022-jp decoders
// reject the 8-bit katakana that DICOM's ISO 2022 IR 13 uses.
export function decodeIso2022(bytes) {
  const euc = [];
  let mode = 'ascii';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b === 0x1b) {
      const s = String.fromCharCode(bytes[i + 1] || 0, bytes[i + 2] || 0);
      if (s === '$B' || s === '$@') mode = 'jis0208';
      else if (s === '(B' || s === '(J') mode = 'ascii';
      else if (s === '(I') mode = 'kana7';
      else if (s === '$(' && bytes[i + 3] === 0x44) {
        mode = 'jis0212';
        i += 4;
        continue;
      }
      // ESC ) I designates katakana to G1: handled by the high bytes below
      i += 3;
      continue;
    }
    if (b >= 0xa1 && b <= 0xdf) {
      euc.push(0x8e, b); // half-width katakana
      i += 1;
      continue;
    }
    if (mode === 'jis0208' && b >= 0x21 && b <= 0x7e && i + 1 < bytes.length) {
      euc.push(b | 0x80, bytes[i + 1] | 0x80);
      i += 2;
      continue;
    }
    if (mode === 'jis0212' && b >= 0x21 && b <= 0x7e && i + 1 < bytes.length) {
      euc.push(0x8f, b | 0x80, bytes[i + 1] | 0x80);
      i += 2;
      continue;
    }
    if (mode === 'kana7' && b >= 0x21 && b <= 0x5f) {
      euc.push(0x8e, b | 0x80);
      i += 1;
      continue;
    }
    // component delimiters reset to the default character set
    if (b === 0x5e || b === 0x3d || b === 0x5c || b === 0x0d || b === 0x0a) mode = 'ascii';
    euc.push(b);
    i += 1;
  }
  const text = new TextDecoder('euc-jp').decode(new Uint8Array(euc));
  // half-width katakana / full-width latin -> normal forms
  return text.normalize('NFKC').replace(/\0/g, '').trim();
}
