import {test, expect} from '@playwright/test';
import {openSample, waitForImage, vpState, gesture, line, tap, menuItem} from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name !== 'desktop-chromium';
const pointerFor = (testInfo) => (isTouch(testInfo) ? 'touch' : 'mouse');

// screen point (relative to the viewport) of an image pixel position
const screenOf = (page, x, y, view = 0) => page.evaluate(({x, y, view}) => window.dicomReader.vps[view].toScreen(x, y), {x, y, view});

test.beforeEach(async ({page}) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('sample study opens with series list, overlays and orientation', async ({page}) => {
  await openSample(page);
  const st = await vpState(page);
  expect(st.series).toBe('Axial 2.5 mm');
  expect(st.count).toBe(76);
  expect(st.voi).toEqual({center: 40, width: 80});
  await expect(page.locator('#titleMain')).toHaveText('PHANTOM DEMO');
  await expect(page.locator('.vp[data-index="0"] .orient.left')).toHaveText('R');
  await expect(page.locator('.vp[data-index="0"] .orient.top')).toHaveText('A');
  await expect(page.locator('.series')).toHaveCount(4);
  // thumbnails are rendered in the background
  await expect(page.locator('img.thumb')).toHaveCount(4, {timeout: 30000});
});

test('drag scrolls through slices, slider jumps', async ({page}, testInfo) => {
  await openSample(page);
  const before = await vpState(page);
  await gesture(page, 0, [line([180, 300], [180, 420], 20)], {pointerType: pointerFor(testInfo)});
  await waitForImage(page);
  const after = await vpState(page);
  expect(after.pos).toBeGreaterThan(before.pos + 3);
  // the right edge slider
  const track = page.locator('.vp[data-index="0"] .scrubber .track');
  const box = await track.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 1);
  await waitForImage(page);
  expect((await vpState(page)).pos).toBe(75);
  await expect(page.locator('.vp[data-index="0"] .corners .tr')).toContainText('Image 76 / 76');
});

test('mouse wheel and keyboard scroll (desktop)', async ({page}, testInfo) => {
  test.skip(isTouch(testInfo), 'desktop only');
  await openSample(page);
  const p0 = (await vpState(page)).pos;
  const r = (await vpState(page)).rect;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  for (let i = 0; i < 3; ++i) await page.mouse.wheel(0, 40);
  await expect.poll(async () => (await vpState(page)).pos).toBe(p0 + 3);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await vpState(page)).pos).toBe(0);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await vpState(page)).pos).toBe(10);
});

test('pinch zooms, double tap resets', async ({page}, testInfo) => {
  test.skip(!isTouch(testInfo), 'touch only');
  await openSample(page);
  await gesture(page, 0, [line([150, 300], [80, 300], 10), line([230, 300], [300, 300], 10)]);
  const z = (await vpState(page)).zoom;
  expect(z).toBeGreaterThan(1.5);
  await tap(page, 0, [200, 300]);
  await tap(page, 0, [200, 300]);
  await expect.poll(async () => (await vpState(page)).zoom).toBe(1);
});

test('contrast tool and presets change the window', async ({page}, testInfo) => {
  await openSample(page);
  await page.click('.tool[data-tool="window"]');
  await gesture(page, 0, [line([150, 300], [250, 360], 15)], {pointerType: pointerFor(testInfo)});
  const voi = (await vpState(page)).voi;
  expect(voi.width).toBeGreaterThan(80);
  expect(voi.center).toBeGreaterThan(40);
  await menuItem(page, '#presetBtn', /^Bone\s+\(W 1800/);
  expect((await vpState(page)).voi).toEqual({center: 400, width: 1800});
  await expect(page.locator('.vp[data-index="0"] .corners .bl')).toContainText('W 1800  L 400');
});

test('distance, angle and ellipse measurements are correct', async ({page}, testInfo) => {
  await openSample(page);
  const pt = pointerFor(testInfo);
  await menuItem(page, '#measureMenuBtn', 'Distance');
  // 100 pixels at 0.9 mm = 90 mm
  const a = await screenOf(page, 78, 128);
  const b = await screenOf(page, 178, 128);
  await gesture(page, 0, [line(a, b, 10)], {pointerType: pt});
  const m1 = await page.evaluate(() => window.dicomReader.state.measurements.at(-1));
  expect(m1.type).toBe('length');
  const len = Math.hypot(m1.points[1][0] - m1.points[0][0], m1.points[1][1] - m1.points[0][1]) * 0.9;
  expect(len).toBeGreaterThan(89);
  expect(len).toBeLessThan(91);
  // selection bar on phones, measurement panel on desktop
  await expect(page.locator('#app')).toContainText(/9\d\.\d\d mm/);

  // angle: first arm by dragging, third point by tapping -> 90 degrees
  await menuItem(page, '#measureMenuBtn', 'Angle');
  const p = [await screenOf(page, 90, 90), await screenOf(page, 130, 130), await screenOf(page, 170, 90)];
  await gesture(page, 0, [line(p[0], p[1], 10)], {pointerType: pt});
  await tap(page, 0, p[2], pt);
  await expect(page.locator('#app')).toContainText('90.0°');

  // ellipse in the right hemisphere's white matter: mean about 27 HU
  await menuItem(page, '#measureMenuBtn', 'Ellipse');
  const e0 = await screenOf(page, 92, 124);
  const e1 = await screenOf(page, 104, 140);
  await gesture(page, 0, [line(e0, e1, 10)], {pointerType: pt});
  await page.click('#moreBtn');
  await page.locator('#menu button', {hasText: 'Measurements & calibration'}).click();
  const panel = page.locator('#sheetBody');
  await expect(panel).toContainText('Ellipse');
  const text = await panel.locator('.measure').last().innerText();
  const mean = parseFloat(/Mean (-?[\d.]+) HU/.exec(text)[1]);
  expect(mean).toBeGreaterThan(22);
  expect(mean).toBeLessThan(33);
  // undo removes the ellipse
  await page.locator('#mUndo').click();
  await expect(page.locator('#sheetBody .measure')).toHaveCount(2);
});

test('two views: reference lines, sync and locate', async ({page}, testInfo) => {
  await openSample(page);
  await menuItem(page, '#moreBtn', 'Two views');
  await waitForImage(page, 1);
  const s1 = await vpState(page, 1);
  expect(s1.series).toMatch(/Sagittal|Coronal|Scout/);
  // the other view's plane cuts this one: a reference segment exists
  const hasLine = await page.evaluate(() => {
    const [a, b] = window.dicomReader.vps;
    return !!(a.item.frameOfRef && a.item.frameOfRef === b.item.frameOfRef);
  });
  expect(hasLine).toBe(true);
  // double tap in view 2 moves view 1 to that level
  const before = (await vpState(page, 0)).pos;
  const r1 = (await vpState(page, 1)).rect;
  const target = [r1.width / 2, r1.height * 0.25];
  await tap(page, 1, target, pointerFor(testInfo));
  await tap(page, 1, target, pointerFor(testInfo));
  await expect.poll(async () => (await vpState(page, 0)).pos).not.toBe(before);
  const loc = await page.evaluate(() => window.dicomReader.state.locator);
  expect(loc).not.toBeNull();
});

test('DICOM tags panel', async ({page}) => {
  await openSample(page);
  await menuItem(page, '#moreBtn', 'DICOM tags');
  await expect(page.locator('#tagsTable')).toContainText('PHANTOM^DEMO');
  await expect(page.locator('#tagsTable')).toContainText("Patient's Name");
  await page.fill('#tagFilter', 'pixel spacing');
  await expect(page.locator('#tagsTable tr')).toHaveCount(1);
});

test('cine play advances images', async ({page}) => {
  await openSample(page);
  const p0 = (await vpState(page)).pos;
  await page.click('#playBtn');
  await expect.poll(async () => (await vpState(page)).pos, {timeout: 10000}).not.toBe(p0);
  await page.click('#playBtn');
  await expect(page.locator('#playBtn span')).toHaveText('Play');
});

test('export saves a PNG (desktop)', async ({page}, testInfo) => {
  test.skip(isTouch(testInfo), 'download flow is desktop only');
  await openSample(page);
  const download = page.waitForEvent('download');
  await menuItem(page, '#moreBtn', 'Save / share this view');
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^CT_Axial.*\.png$/);
});

test('Google Drive option is available in empty screen, Open menu and More menu', async ({page}) => {
  await page.goto('./');
  await expect(page.locator('#openDriveBig')).toBeVisible();
  await page.click('#openDriveBig');
  await expect(page.locator('#sheetTitle')).toHaveText('Google Drive');
  await expect(page.locator('#driveBrowseBtn')).toBeVisible();
  await expect(page.locator('#driveUrlInput')).toBeVisible();
  await page.click('#sheetClose');
  await expect(page.locator('#sheet')).toBeHidden();

  await page.click('#openBtn');
  await page.locator('#menu button', {hasText: 'Choose from Google Drive'}).click();
  await expect(page.locator('#sheetTitle')).toHaveText('Google Drive');
});

test('scout localizer: single tap navigates volume', async ({page}, testInfo) => {
  await openSample(page);
  await menuItem(page, '#moreBtn', 'Two views');
  await waitForImage(page, 1);
  // Switch view 1 to Scout
  await page.evaluate(() => {
    const scoutIdx = window.dicomReader.state.series.findIndex(s => s.title.includes('Scout'));
    window.dicomReader.showSeries(scoutIdx, window.dicomReader.vps[1]);
  });
  await waitForImage(page, 1);
  const r1 = (await vpState(page, 1)).rect;
  // Single tap near top of scout moves axial volume towards cranial slices (slice 0)
  await tap(page, 1, [r1.width / 2, r1.height * 0.1], pointerFor(testInfo));
  await expect.poll(async () => (await vpState(page, 0)).pos).toBeLessThan(20);

  // Single tap near bottom of scout moves axial volume towards caudal slices (slice 75)
  await tap(page, 1, [r1.width / 2, r1.height * 0.9], pointerFor(testInfo));
  await expect.poll(async () => (await vpState(page, 0)).pos).toBeGreaterThan(50);
});

