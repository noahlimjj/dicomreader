// Opens whole libraries of real-world files and checks every series renders.
import {test, expect} from '@playwright/test';
import {readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, BlobWriter, Uint8ArrayReader} from '@zip.js/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data');
const LIBRARY = join(here, '..', 'library');
const SAMPLES = join(here, '..', '..', 'public', 'samples');

test.beforeEach(async ({page}, testInfo) => {
  test.skip(testInfo.project.name === 'android-chromium', 'covered by the other two engines');
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function openAndCheckAll(page, files, {expectSeries = 1, label = '', input = '#filesInput'} = {}) {
  await page.goto('./');
  const t0 = Date.now();
  await page.setInputFiles(input, files);
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 120000});
  const firstImageMs = Date.now() - t0;
  const n = await page.evaluate(() => window.dicomReader.state.series.length);
  expect(n).toBeGreaterThanOrEqual(expectSeries);
  // every series: first, middle and last image decode without error
  const report = await page.evaluate(async () => {
    const {state, vps, showSeries} = window.dicomReader;
    const v = vps[0];
    const out = [];
    const wait = () => new Promise((resolve) => {
      const t = setInterval(() => {
        if (v.shown && v.shown.item === v.item && (v.shown.image || v.shown.error)) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    for (let i = 0; i < state.series.length; ++i) {
      showSeries(i, v);
      const s = state.series[i];
      const errors = [];
      const started = performance.now();
      for (const pos of [...new Set([0, Math.floor(s.items.length / 2), s.items.length - 1])]) {
        v.setPos(pos);
        await wait();
        if (v.shown.error) errors.push(`${pos}: ${v.shown.error}`);
      }
      out.push({
        title: s.title, modality: s.first.modality, images: s.items.length,
        ts: s.first.transferSyntax, photometric: s.first.photometric,
        size: `${s.first.cols}x${s.first.rows}`, ms: Math.round(performance.now() - started), errors,
        voi: v.voi ? `${Math.round(v.voi.width)}/${Math.round(v.voi.center)}` : 'rgb',
      });
    }
    return out;
  });
  const inApp = await page.evaluate(() => window.dicomReader.state.timing?.firstImage);
  console.log(`\n${label}: ${n} series, first image ${inApp ?? '?'} ms after picking (${firstImageMs} ms incl. test upload)`);
  for (const r of report) {
    console.log(`  ${r.errors.length ? 'FAIL' : 'ok  '} ${r.modality.padEnd(6)} ${String(r.images).padStart(4)} img ${r.size.padEnd(10)} ${r.photometric.padEnd(14)} ${r.ts.padEnd(24)} W/L ${r.voi.padEnd(10)} ${r.ms} ms  ${r.title}${r.errors.length ? `  ${r.errors.join('; ')}` : ''}`);
  }
  expect(report.filter((r) => r.errors.length)).toEqual([]);
  return report;
}

test('pydicom test files: every series renders', async ({page}) => {
  test.skip(!existsSync(DATA), 'run `npm run golden` first');
  const files = readdirSync(DATA).filter((f) => f.endsWith('.dcm')).map((f) => join(DATA, f));
  await openAndCheckAll(page, files, {expectSeries: 20, label: 'pydicom test files'});
});

test('a ZIP of a study opens', async ({page}) => {
  const tmp = join(here, '..', '..', 'test-results');
  mkdirSync(tmp, {recursive: true});
  const zipPath = join(tmp, 'sample-study.zip');
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const f of readdirSync(SAMPLES).filter((x) => x.endsWith('.dcm'))) {
    await writer.add(`DICOM/ST000/${f.replace('.dcm', '').toUpperCase()}`, new Uint8ArrayReader(readFileSync(join(SAMPLES, f))));
  }
  await writer.add('README.TXT', new Uint8ArrayReader(new TextEncoder().encode('not dicom')));
  const blob = await writer.close();
  writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));
  const report = await openAndCheckAll(page, [zipPath], {expectSeries: 4, label: 'sample zip'});
  expect(report.map((r) => r.images).sort((a, b) => a - b)).toEqual([1, 44, 52, 76]);
});

test('a folder laid out like a hospital CD opens (nested folders, DICOMDIR, viewer files)', async ({page}, testInfo) => {
  const cd = join(here, '..', '..', 'test-results', `HOSPITAL_CD-${testInfo.project.name}`);
  rmSync(cd, {recursive: true, force: true});
  const series = {SE000: 'axial', SE001: 'sagittal', SE002: 'coronal', SE003: 'scout'};
  for (const [se, prefix] of Object.entries(series)) {
    const dir = join(cd, 'DICOM', 'ST000', se);
    mkdirSync(dir, {recursive: true});
    readdirSync(SAMPLES).filter((f) => f.startsWith(prefix)).forEach((f, i) => {
      copyFileSync(join(SAMPLES, f), join(dir, `IM${String(i).padStart(4, '0')}`));
    });
  }
  // a second study on the same CD (a real CT) when the library is present
  const realCt = join(LIBRARY, 'ct_chest');
  let expected = 4;
  if (existsSync(realCt)) {
    const dir = join(cd, 'DICOM', 'ST001', 'SE000');
    mkdirSync(dir, {recursive: true});
    readdirSync(realCt).slice(0, 60).forEach((f, i) => copyFileSync(join(realCt, f), join(dir, `I${i}`)));
    expected = 5;
  }
  writeFileSync(join(cd, 'DICOMDIR'), Buffer.alloc(4096, 1));
  writeFileSync(join(cd, 'AUTORUN.INF'), '[autorun]\r\nopen=viewer.exe');
  writeFileSync(join(cd, 'README.HTM'), '<html>viewer</html>');
  mkdirSync(join(cd, 'VIEWER'), {recursive: true});
  writeFileSync(join(cd, 'VIEWER', 'viewer.exe'), Buffer.alloc(200000, 7));
  writeFileSync(join(cd, 'VIEWER', 'data.bin'), Buffer.alloc(5000, 3)); // unknown junk: must be skipped quietly
  const report = await openAndCheckAll(page, cd, {expectSeries: expected, label: 'hospital CD folder', input: '#folderInput'});
  expect(report.length).toBe(expected);
  expect(report.map((r) => r.images).filter((n) => [76, 44, 52, 1].includes(n)).sort((a, b) => a - b)).toEqual([1, 44, 52, 76]);
  // scroll through the axial series to the last image
  await page.evaluate(() => {
    const {state, vps, showSeries} = window.dicomReader;
    showSeries(state.series.findIndex((s) => s.images === 76), vps[0]);
  });
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => window.dicomReader.vps[0].pos)).toBe(75);
});

// real studies (test/tools/fetch_library.py): folders through the folder
// picker, and the ZIP copies through the file picker
const library = existsSync(LIBRARY) ? readdirSync(LIBRARY, {withFileTypes: true}) : [];
for (const d of library) {
  if (d.isDirectory() && readdirSync(join(LIBRARY, d.name)).some((f) => f.endsWith('.dcm'))) {
    test(`library folder: ${d.name}`, async ({page}) => {
      await openAndCheckAll(page, join(LIBRARY, d.name), {label: d.name, input: '#folderInput'});
    });
  } else if (d.name.endsWith('.zip')) {
    test(`library zip: ${d.name}`, async ({page}) => {
      await openAndCheckAll(page, [join(LIBRARY, d.name)], {label: d.name});
    });
  }
}
