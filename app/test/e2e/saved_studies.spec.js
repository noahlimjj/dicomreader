import {test, expect} from '@playwright/test';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {ZipWriter, BlobWriter, Uint8ArrayReader} from '@zip.js/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', 'public', 'samples');
const AXIAL_FILES = readdirSync(SAMPLES).filter((f) => f.startsWith('axial_')).sort().map((f) => join(SAMPLES, f));
const SINGLE_FILE = AXIAL_FILES[0];
const MULTI_FILES = AXIAL_FILES.slice(0, 10);

async function makeTestZip(files, outPath) {
  const zipWriter = new ZipWriter(new BlobWriter('application/zip'));
  for (const f of files) {
    const data = readFileSync(f);
    await zipWriter.add(basename(f), new Uint8ArrayReader(data));
  }
  const blob = await zipWriter.close();
  const buf = Buffer.from(await blob.arrayBuffer());
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, buf);
}

test('study saves to library and can be reopened from home screen', async ({page}) => {
  await page.goto('./');
  await page.setInputFiles('#filesInput', [SINGLE_FILE]);
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});
  
  // Wait for saveStudyToLibrary to complete
  await page.waitForFunction(() => window.dicomReader.state.activeStudyId !== null, null, {timeout: 10000});

  // Reload page
  await page.reload();

  // Check if savedStudies is visible and list has 1 item
  await page.waitForSelector('#savedStudies:not([hidden])', {timeout: 10000});
  const cards = page.locator('#savedList .saved-card');
  await expect(cards).toHaveCount(1);

  // Click card to reopen
  await cards.first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});
  expect(await page.evaluate(() => window.dicomReader.state.series[0].first.modality)).toBe('CT');
});

test('multi-file study saves to library and can be reopened', async ({page}) => {
  test.setTimeout(120000);
  await page.goto('./');
  await page.setInputFiles('#filesInput', MULTI_FILES);
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 60000});
  
  // Wait for saveStudyToLibrary to complete
  await page.waitForFunction(() => window.dicomReader.state.activeStudyId !== null, null, {timeout: 30000});

  // Reload page
  await page.reload();

  // Check if savedStudies is visible
  await page.waitForSelector('#savedStudies:not([hidden])', {timeout: 10000});
  const cards = page.locator('#savedList .saved-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(1);

  // Reopen
  await cards.first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 60000});
  expect(await page.evaluate(() => window.dicomReader.state.series[0].items.length)).toBe(10);
});

test('zip study saves to library and can be reopened', async ({page}, testInfo) => {
  test.setTimeout(120000);
  const zipPath = join(here, '..', '..', 'test-results', `test-study-${testInfo.project.name}.zip`);
  await makeTestZip(AXIAL_FILES.slice(0, 5), zipPath);
  await page.goto('./');
  await page.setInputFiles('#filesInput', [zipPath]);
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 60000});
  
  // Wait for saveStudyToLibrary to complete
  await page.waitForFunction(() => window.dicomReader.state.activeStudyId !== null, null, {timeout: 30000});

  // Reload page
  await page.reload();

  // Check if savedStudies is visible
  await page.waitForSelector('#savedStudies:not([hidden])', {timeout: 10000});
  const cards = page.locator('#savedList .saved-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(1);

  // Reopen
  await cards.first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 60000});
  expect(await page.evaluate(() => window.dicomReader.state.series[0].items.length)).toBeGreaterThanOrEqual(1);
});

test('navigation back to home page via homeBtn, title, drawer, and escape', async ({page}) => {
  await page.goto('./');
  await page.setInputFiles('#filesInput', [SINGLE_FILE]);
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});
  expect(await page.locator('#empty').isHidden()).toBe(true);

  // 1. Click #homeBtn to return to Home
  await page.click('#homeBtn');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#savedStudies')).toBeVisible();

  // Re-open from saved list
  await page.locator('#savedList .saved-card').first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});
  expect(await page.locator('#empty').isHidden()).toBe(true);

  // 2. Click #title to return to Home
  await page.click('#title');
  await expect(page.locator('#empty')).toBeVisible();

  // Re-open from saved list
  await page.locator('#savedList .saved-card').first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});

  // 3. Series drawer #drawerHomeBtn
  const isDrawerClosed = await page.evaluate(() => {
    const p = document.getElementById('seriesPanel');
    const wide = window.matchMedia('(min-width: 900px)').matches;
    return wide ? p.classList.contains('closed') : !p.classList.contains('open');
  });
  if (isDrawerClosed) {
    await page.click('#seriesBtn');
  }
  await page.click('#drawerHomeBtn');
  await expect(page.locator('#empty')).toBeVisible();

  // Re-open from saved list
  await page.locator('#savedList .saved-card').first().click();
  await page.waitForFunction(() => window.dicomReader.state.series.length > 0 && window.dicomReader.vps[0].shown?.image, null, {timeout: 30000});

  // 4. Press Escape to return to Home
  await page.keyboard.press('Escape');
  await expect(page.locator('#empty')).toBeVisible();
});


