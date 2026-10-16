// Decoders vs pydicom reference output (see test/tools/make_golden.py).
import {describe, it, expect, beforeAll} from 'vitest';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {parse, extractMeta} from '../src/engine/meta.js';
import {decodeFrame} from '../src/engine/pixels.js';
import {setWasmUrls} from '../src/engine/codecs.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, 'data');
const GOLDEN = join(here, 'golden');
const require = createRequire(import.meta.url);

beforeAll(() => {
  setWasmUrls({
    openjpeg: require.resolve('@cornerstonejs/codec-openjpeg/decodewasm'),
    charls: require.resolve('@cornerstonejs/codec-charls/decodewasm'),
    libjpeg: require.resolve('@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm'),
    openjph: require.resolve('@cornerstonejs/codec-openjph/wasm'),
  });
});

const cases = existsSync(GOLDEN) ?
  readdirSync(GOLDEN).filter((f) => f.endsWith('.dcm.json')).map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8'))) :
  [];

function load(name) {
  const buf = readFileSync(join(DATA, name));
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const ds = parse(bytes);
  return {ds, meta: extractMeta(ds)};
}

describe.skipIf(!cases.length)('pixel decoding matches pydicom', () => {
  for (const c of cases) {
    it(`${c.name} (${c.transferSyntax}, ${c.photometric})`, async () => {
      const {ds, meta} = load(c.name);
      expect(meta).toBeTruthy();
      expect(meta.file.rows).toBe(c.rows);
      expect(meta.file.cols).toBe(c.columns);
      expect(meta.file.frames).toBe(c.frames);
      for (const fr of c.checked) {
        const img = await decodeFrame(ds, meta.file, fr.index);
        const ref = readFileSync(join(GOLDEN, `${c.name}.${fr.index}.bin`));
        if (fr.kind === 'mono') {
          expect(img.kind).toBe('mono');
          const want = new Float64Array(ref.buffer, ref.byteOffset, ref.byteLength / 8);
          expect(img.data.length).toBe(want.length);
          let maxDiff = 0;
          let sumDiff = 0;
          for (let i = 0; i < want.length; ++i) {
            const d = Math.abs(img.data[i] - want[i]);
            sumDiff += d;
            if (d > maxDiff) maxDiff = d;
          }
          const range = Math.max(1, img.max - img.min);
          if (c.lossy) {
            expect(sumDiff / want.length / range).toBeLessThan(0.01);
          } else {
            expect(maxDiff).toBe(0);
          }
        } else {
          expect(img.kind).toBe('rgb');
          const want = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
          const n = c.rows * c.columns;
          expect(want.length).toBe(n * 3);
          let maxDiff = 0;
          let sumDiff = 0;
          for (let p = 0; p < n; ++p) {
            for (let k = 0; k < 3; ++k) {
              const d = Math.abs(img.rgba[p * 4 + k] - want[p * 3 + k]);
              sumDiff += d;
              if (d > maxDiff) maxDiff = d;
            }
          }
          // colour conversions round differently between libraries
          const tolerance = c.lossy || /YBR/.test(c.photometric) ? 3 : 0;
          expect(sumDiff / (n * 3)).toBeLessThanOrEqual(Math.max(tolerance / 2, 0));
          if (!c.lossy && !/YBR/.test(c.photometric)) expect(maxDiff).toBe(0);
        }
      }
    });
  }
});

describe.skipIf(!existsSync(join(DATA, 'JPEG-lossy.dcm')))('files pydicom cannot decode', () => {
  it('JPEG-lossy.dcm (12 bit JPEG extended) decodes to a plausible image', async () => {
    const {ds, meta} = load('JPEG-lossy.dcm');
    const img = await decodeFrame(ds, meta.file, 0);
    expect(img.kind).toBe('mono');
    expect(img.data.length).toBe(meta.file.rows * meta.file.cols);
    expect(img.max).toBeGreaterThan(img.min);
    expect(img.max).toBeLessThan(4096);
  });
});
