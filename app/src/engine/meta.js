// DICOM header parsing (dicom-parser) and the metadata the viewer needs.
// Runs in the decoder worker and in unit tests (no DOM access).
import * as dicomParser from 'dicom-parser';
import {inflateRaw} from 'pako';
import {textDecoderFor} from './charset.js';

export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
  JPEG_LOSSLESS_14: '1.2.840.10008.1.2.4.57',
  JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEG_LS_LOSSLESS: '1.2.840.10008.1.2.4.80',
  JPEG_LS_NEAR: '1.2.840.10008.1.2.4.81',
  J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
  J2K: '1.2.840.10008.1.2.4.91',
  HTJ2K_LOSSLESS: '1.2.840.10008.1.2.4.201',
  HTJ2K_LOSSLESS_RPCL: '1.2.840.10008.1.2.4.202',
  HTJ2K: '1.2.840.10008.1.2.4.203',
  RLE: '1.2.840.10008.1.2.5',
};

export const DICOMDIR_CLASS = '1.2.840.10008.1.3.10';

function inflater(byteArray, position) {
  // deflated explicit VR little endian: everything after the meta header
  const inflated = inflateRaw(byteArray.subarray(position));
  const out = new Uint8Array(inflated.length + position);
  out.set(byteArray.subarray(0, position), 0);
  out.set(inflated, position);
  return out;
}

export function hasPreamble(bytes) {
  return bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 &&
    bytes[130] === 0x43 && bytes[131] === 0x4d;
}

/**
 * Parse a DICOM file. Files without the 128 byte preamble + "DICM" (old
 * ACR-NEMA style files found on some CDs) are read as implicit VR little
 * endian datasets.
 *
 * @param {Uint8Array} bytes
 * @param {{untilPixelData?: boolean}} options
 */
export function parse(bytes, {untilPixelData = false} = {}) {
  const options = {inflater};
  if (untilPixelData) options.untilTag = 'x7fe00010';
  if (!hasPreamble(bytes)) {
    options.TransferSyntaxUID = TS.IMPLICIT_LE;
    const ds = dicomParser.parseDicom(bytes, options);
    // accept only if it really looks like an image dataset
    if (!ds.elements.x00280010 || !ds.elements.x00280011) throw new Error('Not a DICOM file');
    ds.implicitNoMeta = true;
    return ds;
  }
  return dicomParser.parseDicom(bytes, options);
}

// ---------------------------------------------------------------------------
// value helpers

function trimText(s) {
  return s.replace(/[\0\s]+$/, '').replace(/^\s+/, '');
}

export function makeReader(ds) {
  const charset = ds.string('x00080005') || '';
  const decodeText = textDecoderFor(charset);
  const str = (tag, d = ds) => {
    try {
      return (d.string(tag) || '').trim();
    } catch {
      return '';
    }
  };
  const text = (tag, d = ds) => {
    const el = d.elements[tag];
    if (!el || !el.length) return '';
    try {
      return trimText(decodeText(d.byteArray.subarray(el.dataOffset, el.dataOffset + el.length)));
    } catch {
      return str(tag, d);
    }
  };
  const nums = (tag, d = ds) => {
    const s = str(tag, d);
    if (!s) return [];
    return s.split('\\').map(parseFloat).filter((v) => !Number.isNaN(v));
  };
  const num = (tag, d = ds) => {
    const v = nums(tag, d)[0];
    return v === undefined ? NaN : v;
  };
  const us = (tag, d = ds) => {
    const el = d.elements[tag];
    if (!el) return undefined;
    if (!el.length) return undefined;
    // implicit VR files: US values are still 2 byte little/big endian
    try {
      return d.uint16(tag);
    } catch {
      return undefined;
    }
  };
  const int = (tag, d = ds) => {
    const v = parseInt(str(tag, d), 10);
    return Number.isFinite(v) ? v : NaN;
  };
  const item = (seqTag, d = ds, index = 0) => {
    const el = d.elements[seqTag];
    return el && el.items && el.items[index] ? el.items[index].dataSet : undefined;
  };
  return {charset, str, text, nums, num, us, int, item, decodeText};
}

function formatName(pn) {
  if (!pn) return '';
  const groups = pn.split('=').map((g) => g.replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(groups)].join(' / ');
}

const valid = (arr, n) => (arr.length === n && arr.every(Number.isFinite) ? arr : null);
const positive = (arr) => (arr && arr.length === 2 && arr.every((v) => v > 0) ? arr : null);

/**
 * Per frame geometry / pixel value transformation of enhanced multi-frame
 * objects (functional groups), falling back to the shared groups.
 */
function functionalGroups(ds, r, frames) {
  const shared = r.item('x52009229');
  const perFrame = ds.elements.x52009230?.items;
  if (!shared && !perFrame) return null;
  const look = (frame, seq, attr, kind) => {
    const sources = [perFrame?.[frame]?.dataSet, shared];
    for (const src of sources) {
      if (!src) continue;
      const it = r.item(seq, src);
      if (!it || !it.elements[attr]) continue;
      if (kind === 'nums') return r.nums(attr, it);
      if (kind === 'str') return r.str(attr, it);
      return r.num(attr, it);
    }
    return undefined;
  };
  const out = [];
  for (let f = 0; f < frames; ++f) {
    out.push({
      ipp: look(f, 'x00209113', 'x00200032', 'nums'),
      iop: look(f, 'x00209116', 'x00200037', 'nums'),
      pixelSpacing: look(f, 'x00289110', 'x00280030', 'nums'),
      thickness: look(f, 'x00289110', 'x00180050'),
      slope: look(f, 'x00289145', 'x00281053'),
      intercept: look(f, 'x00289145', 'x00281052'),
      windowCenter: look(f, 'x00289132', 'x00281050', 'nums'),
      windowWidth: look(f, 'x00289132', 'x00281051', 'nums'),
      stackPosition: look(f, 'x00209111', 'x00209057'),
      temporal: look(f, 'x00209111', 'x00209128'),
    });
  }
  return out;
}

/**
 * Everything the viewer needs from a parsed file: one entry per frame.
 * Returns null for non-image objects (reports, DICOMDIR, ...).
 */
export function extractMeta(ds) {
  const r = makeReader(ds);
  const {str, text, nums, num, us, int} = r;
  const mediaClass = str('x00020002');
  const sopClass = str('x00080016') || mediaClass;
  if (sopClass === DICOMDIR_CLASS || mediaClass === DICOMDIR_CLASS) return null;
  const rows = us('x00280010');
  const cols = us('x00280011');
  if (!rows || !cols || !ds.elements.x7fe00010) {
    // pixel data may be missing because the header was parsed partially
    if (!rows || !cols) return null;
  }
  const frames = Math.max(1, int('x00280008') || 1);
  const ts = ds.implicitNoMeta ? TS.IMPLICIT_LE : (str('x00020010') || TS.IMPLICIT_LE);
  const ps = positive(nums('x00280030'));
  const ips = positive(nums('x00181164'));
  const wc = nums('x00281050');
  const ww = nums('x00281051');
  const photometric = (str('x00280004') || 'MONOCHROME2').toUpperCase().replace(/\s+/g, ' ');
  const file = {
    transferSyntax: ts,
    charset: r.charset,
    sop: str('x00080018'),
    sopClass,
    studyUid: str('x0020000d') || 'unknown-study',
    seriesUid: str('x0020000e') || '',
    modality: (str('x00080060') || 'OT').toUpperCase(),
    seriesDesc: text('x0008103e'),
    studyDesc: text('x00081030'),
    bodyPart: str('x00180015'),
    protocol: text('x00181030'),
    seriesNumber: int('x00200011'),
    instanceNumber: int('x00200013'),
    acquisitionNumber: int('x00200012'),
    studyDate: str('x00080020'),
    studyTime: str('x00080030'),
    seriesDate: str('x00080021'),
    seriesTime: str('x00080031'),
    contentTime: str('x00080033'),
    rows,
    cols,
    frames,
    photometric,
    samplesPerPixel: us('x00280002') || 1,
    bitsAllocated: us('x00280100') || 16,
    bitsStored: us('x00280101') || us('x00280100') || 16,
    highBit: us('x00280102'),
    pixelRepresentation: us('x00280103') || 0,
    planarConfiguration: us('x00280006') || 0,
    slope: Number.isFinite(num('x00281053')) && num('x00281053') !== 0 ? num('x00281053') : 1,
    intercept: Number.isFinite(num('x00281052')) ? num('x00281052') : 0,
    rescaleType: str('x00281054'),
    windowCenter: wc,
    windowWidth: ww,
    windowExplanation: text('x00281055').split('\\').map((s) => s.trim()),
    voiFunction: str('x00281056'),
    presentationShape: str('x20500020'),
    imageType: str('x00080008').toUpperCase(),
    kernel: str('x00181210'),
    thickness: num('x00180050'),
    spacing: num('x00180088'),
    sliceLocation: num('x00201041'),
    ipp: valid(nums('x00200032'), 3),
    iop: valid(nums('x00200037'), 6),
    frameOfRef: str('x00200052'),
    patientOrientation: str('x00200020'),
    pixelSpacing: ps,
    aspectRatio: str('x00280034'),
    imagerSpacing: ips,
    magnification: num('x00181114'),
    sid: num('x00181110'),
    sod: num('x00181111'),
    calibrationType: str('x00280a02'),
    lossy: str('x00282110') === '01',
    lossyRatio: num('x00282112'),
    frameTime: num('x00181063'),
    cineRate: num('x00180040') || num('x00082144'),
    laterality: str('x00200062') || str('x00200060'),
    viewPosition: str('x00185101'),
    patientName: formatName(text('x00100010')),
    patientId: text('x00100020'),
    birthDate: str('x00100030'),
    sex: str('x00100040'),
    age: str('x00101010'),
    institution: text('x00080080'),
    manufacturer: text('x00080070'),
    gridOffsets: nums('x3004000c'),
    doseScaling: num('x3004000e'),
  };
  if (file.modality === 'RTDOSE' && Number.isFinite(file.doseScaling)) {
    file.slope = file.doseScaling;
    file.intercept = 0;
  }
  const groups = functionalGroups(ds, r, frames);
  const perFrame = [];
  for (let f = 0; f < frames; ++f) {
    const g = groups?.[f];
    const fr = {};
    if (g) {
      if (g.ipp && g.ipp.length === 3) fr.ipp = g.ipp;
      if (g.iop && g.iop.length === 6) fr.iop = g.iop;
      if (positive(g.pixelSpacing)) fr.pixelSpacing = g.pixelSpacing;
      if (Number.isFinite(g.thickness)) fr.thickness = g.thickness;
      if (Number.isFinite(g.slope) && g.slope !== 0) fr.slope = g.slope;
      if (Number.isFinite(g.intercept)) fr.intercept = g.intercept;
      if (g.windowCenter?.length && g.windowWidth?.length) {
        fr.windowCenter = g.windowCenter;
        fr.windowWidth = g.windowWidth;
      }
      if (Number.isFinite(g.stackPosition)) fr.stackPosition = g.stackPosition;
      if (Number.isFinite(g.temporal)) fr.temporal = g.temporal;
    } else if (frames > 1 && file.ipp && file.iop && file.gridOffsets.length === frames) {
      // RT dose and similar: frames stacked along the normal
      const n = cross(file.iop.slice(0, 3), file.iop.slice(3, 6));
      fr.ipp = file.ipp.map((v, k) => v + file.gridOffsets[f] * n[k]);
    }
    perFrame.push(fr);
  }
  if (!file.iop && perFrame[0]?.iop) file.iop = perFrame[0].iop;
  if (!file.ipp && perFrame[0]?.ipp) file.ipp = perFrame[0].ipp;
  if (!file.pixelSpacing && perFrame[0]?.pixelSpacing) file.pixelSpacing = perFrame[0].pixelSpacing;
  if (!Number.isFinite(file.thickness) && Number.isFinite(perFrame[0]?.thickness)) file.thickness = perFrame[0].thickness;
  return {file, perFrame};
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// ---------------------------------------------------------------------------
// tag listing for the "Tags" panel

const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);

/**
 * Flat list of all elements (sequences expanded, depth-limited).
 * @param {Function} vrOf tag key ("00100010") -> VR from the dictionary
 */
export function listTags(ds, vrOf = () => undefined, maxDepth = 3) {
  const r = makeReader(ds);
  const rows = [];
  const walk = (d, depth) => {
    for (const tag of Object.keys(d.elements).sort()) {
      const el = d.elements[tag];
      const key = tag.slice(1).toUpperCase();
      if (key.slice(4) === '0000' && !key.startsWith('0002')) continue; // group lengths
      let vr = el.vr || vrOf(key) || (el.items ? 'SQ' : '');
      if (vr.includes('|') || vr.includes(' or ')) vr = vr.split(/[| ]/)[0];
      let value;
      if (el.items) {
        value = `(sequence, ${el.items.length} item${el.items.length === 1 ? '' : 's'})`;
        rows.push({key, vr: 'SQ', value, depth});
        if (depth < maxDepth) {
          el.items.forEach((it, i) => {
            rows.push({key: 'FFFEE000', vr: '', value: `Item ${i + 1}`, depth: depth + 1});
            if (it.dataSet) walk(it.dataSet, depth + 2);
          });
        }
        continue;
      }
      if (key === '7FE00010' || el.fragments) {
        value = `(pixel data, ${el.encapsulatedPixelData ? `${el.fragments?.length || 0} fragments` : `${el.length} bytes`})`;
      } else if (BINARY_VRS.has(vr) || (!vr && el.length > 256)) {
        value = `(binary, ${el.length} bytes)`;
      } else {
        value = formatValue(d, tag, el, vr, r);
      }
      if (value.length > 300) value = value.slice(0, 300) + '…';
      rows.push({key, vr, value, depth});
    }
  };
  walk(ds, 0);
  return rows;
}

function formatValue(d, tag, el, vr, r) {
  try {
    switch (vr) {
    case 'US': return seq(el.length / 2, (i) => d.uint16(tag, i));
    case 'SS': return seq(el.length / 2, (i) => d.int16(tag, i));
    case 'UL': return seq(el.length / 4, (i) => d.uint32(tag, i));
    case 'SL': return seq(el.length / 4, (i) => d.int32(tag, i));
    case 'FL': return seq(el.length / 4, (i) => round(d.float(tag, i)));
    case 'FD': return seq(el.length / 8, (i) => round(d.double(tag, i)));
    case 'AT': return seq(el.length / 4, (i) => {
      const g = d.uint16(tag, i * 2);
      const e = d.uint16(tag, i * 2 + 1);
      return `(${hex4(g)},${hex4(e)})`;
    });
    case 'PN': case 'LO': case 'SH': case 'ST': case 'LT': case 'UT': case 'UC':
      return r.text(tag, d);
    default: {
      const s = r.str(tag, d);
      // undecodable binary in unknown-VR elements
      return /[\0-\x08\x0e-\x1f]/.test(s) ? `(binary, ${el.length} bytes)` : s;
    }
    }
  } catch {
    return '';
  }
}

function seq(n, f) {
  const out = [];
  for (let i = 0; i < Math.min(n, 32); ++i) out.push(f(i));
  return out.join('\\') + (n > 32 ? '\\…' : '');
}

function round(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
}

function hex4(v) {
  return v.toString(16).padStart(4, '0').toUpperCase();
}
