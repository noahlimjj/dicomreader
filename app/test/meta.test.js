// Header parsing vs pydicom: names in many character sets, geometry, rescale.
import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {parse, extractMeta, makeReader, listTags} from '../src/engine/meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, 'data');
const GOLDEN = join(here, 'golden');

const load = (name) => {
  const buf = readFileSync(join(DATA, name));
  return parse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
};

const cases = existsSync(GOLDEN) ?
  readdirSync(GOLDEN).filter((f) => f.endsWith('.dcm.json')).map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8'))) :
  [];

function close(a, b) {
  if (b === null || b === undefined) return;
  expect(a).toBeTruthy();
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 4));
}

describe.skipIf(!cases.length)('metadata matches pydicom', () => {
  for (const c of cases) {
    it(c.name, () => {
      const {file, perFrame} = extractMeta(load(c.name));
      expect(file.patientName).toBe(c.patientName);
      expect(file.modality).toBe((c.modality || 'OT').toUpperCase());
      if (c.ipp && c.iop) {
        close(file.ipp, c.ipp);
        close(file.iop, c.iop);
      }
      if (c.pixelSpacing?.every((v) => v > 0)) close(file.pixelSpacing, c.pixelSpacing);
      else if (c.pixelSpacing) expect(file.pixelSpacing).toBeNull(); // invalid (0\0): measure in pixels
      if (file.modality !== 'RTDOSE') {
        expect(file.slope).toBeCloseTo(c.slope, 6);
        expect(file.intercept).toBeCloseTo(c.intercept, 6);
      }
      expect(perFrame.length).toBe(c.frames);
    });
  }
});

const charsetFile = join(GOLDEN, 'charsets.json');
const charsets = existsSync(charsetFile) ? JSON.parse(readFileSync(charsetFile, 'utf8')) : {};

describe.skipIf(!Object.keys(charsets).length)('patient names in other character sets', () => {
  for (const [name, want] of Object.entries(charsets)) {
    it(`${name} (${want.charset.join(' \\ ')})`, () => {
      const ds = load(name);
      const r = makeReader(ds);
      const pn = r.text('x00100010');
      const groups = [];
      for (const g of pn.split('=').map((x) => x.replace(/\^+/g, ' ').replace(/\s+/g, ' ').trim())) {
        if (g && !groups.includes(g)) groups.push(g);
      }
      // Japanese half-width katakana are normalised to full width (NFKC)
      expect(groups.join(' / ').normalize('NFKC')).toBe(want.patientName.normalize('NFKC'));
    });
  }
});

describe.skipIf(!existsSync(join(DATA, 'CT_small.dcm')))('tag listing', () => {
  it('lists elements with values and nested sequences', () => {
    const rows = listTags(load('CT_small.dcm'), () => undefined);
    const byKey = Object.fromEntries(rows.filter((r) => r.depth === 0).map((r) => [r.key, r]));
    expect(byKey['00100010'].value).toBe('CompressedSamples^CT1');
    expect(byKey['00280010'].value).toBe('128');
    expect(byKey['7FE00010'].value).toMatch(/pixel data/);
  });
});
