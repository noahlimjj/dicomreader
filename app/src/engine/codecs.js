// Lazily initialised WebAssembly / JS image codecs (all MIT / BSD / Apache
// licensed, see THIRD_PARTY_NOTICES.md).
import openjpegFactory from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import charlsFactory from '@cornerstonejs/codec-charls/decodewasmjs';
import libjpegTurboFactory from '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs';
import openjphFactory from '@cornerstonejs/codec-openjph/wasmjs';
import {Decoder as LosslessDecoder} from 'jpeg-lossless-decoder-js';
import JpegImage from '../vendor/jpeg12.js';

// where the .wasm files are: set by the worker (bundled URLs) or the tests
let wasmUrls = {};
export function setWasmUrls(urls) {
  wasmUrls = urls;
}

const modules = {};
function load(name, factory) {
  if (!modules[name]) {
    modules[name] = factory({
      locateFile: (f) => (f.endsWith('.wasm') && wasmUrls[name] ? wasmUrls[name] : f),
    });
  }
  return modules[name];
}

function copyOut(decoded) {
  const out = new Uint8Array(decoded.length);
  out.set(decoded);
  return out;
}

async function runWasm(name, factory, className, bytes, extra) {
  const codec = await load(name, factory);
  const decoder = new codec[className]();
  try {
    const input = decoder.getEncodedBuffer(bytes.length);
    input.set(bytes);
    if (extra) extra(decoder); else decoder.decode();
    const info = decoder.getFrameInfo();
    return {
      bytes: copyOut(decoder.getDecodedBuffer()),
      width: info.width,
      height: info.height,
      bitsPerSample: info.bitsPerSample,
      components: info.componentCount,
      signed: info.isSigned,
    };
  } catch (e) {
    throw new Error(typeof e === 'number' && codec.getExceptionMessage ? codec.getExceptionMessage(e) : String(e?.message || e));
  } finally {
    decoder.delete();
  }
}

export function decodeJ2K(bytes) {
  return runWasm('openjpeg', openjpegFactory, 'J2KDecoder', bytes);
}

export function decodeHTJ2K(bytes) {
  return runWasm('openjph', openjphFactory, 'HTJ2KDecoder', bytes, (d) => d.decodeSubResolution(0));
}

export function decodeJpegLs(bytes) {
  return runWasm('charls', charlsFactory, 'JpegLSDecoder', bytes);
}

export function decodeJpegBaseline8(bytes) {
  return runWasm('libjpeg', libjpegTurboFactory, 'JPEGDecoder', bytes);
}

/** 12 bit (and 8 bit fallback) JPEG extended, pure JS (pdf.js). */
export function decodeJpeg12(bytes, bitsAllocated, cols, rows) {
  const jpeg = new JpegImage();
  jpeg.parse(bytes);
  jpeg.colorTransform = false;
  const data = bitsAllocated > 8 ? jpeg.getData16(cols, rows) : jpeg.getData(cols, rows);
  return {data, components: jpeg.components?.length || 1};
}

/** JPEG lossless (processes 14 / 14 SV1), pure JS. */
export function decodeJpegLossless(bytes, bitsAllocated) {
  const decoder = new LosslessDecoder();
  const out = decoder.decode(bytes.buffer, bytes.byteOffset, bytes.length, bitsAllocated <= 8 ? 1 : 2);
  return {
    bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
    components: decoder.numComp || 1,
  };
}
