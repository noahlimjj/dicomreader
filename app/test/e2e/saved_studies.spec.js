import {test, expect} from '@playwright/test';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdirSync} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const US_FILE = join(here, '..', 'library', 'us_misc', '0006.dcm');
const CT_DIR = join(here, '..', 'library', 'ct_chest');
const CT_FILES = readdirSync(CT_DIR).filter((f) => f.endsWith('.dcm')).map((f) => join(CT_DIR, f));

test('study saves to library and can be reopened from home screen', async ({page}) => {
  await page.goto('./');
  await page.setInputFiles('#filesInput', [US_FILE]);
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
  expect(await page.evaluate(() => window.dicomReader.state.series[0].first.modality)).toBe('US');
});

test('multi-file study saves to library and can be reopened', async ({page}) => {
  test.setTimeout(120000);
  await page.goto('./');
  await page.setInputFiles('#filesInput', CT_FILES.slice(0, 20));
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
  expect(await page.evaluate(() => window.dicomReader.state.series[0].items.length)).toBe(20);
});

test('zip study saves to library and can be reopened', async ({page}) => {
  test.setTimeout(120000);
  const ZIP_FILE = join(here, '..', 'library', 'us_pelvis.zip');
  await page.goto('./');
  await page.setInputFiles('#filesInput', [ZIP_FILE]);
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
  await page.setInputFiles('#filesInput', [US_FILE]);
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


