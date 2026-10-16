import {expect} from '@playwright/test';

export async function openSample(page) {
  await page.goto('./');
  await page.click('#sampleBtn');
  await waitForImage(page, 0);
}

export async function waitForImage(page, view = 0) {
  await page.waitForFunction((v) => {
    const vp = window.dicomReader?.vps[v];
    return vp && vp.shown && (vp.shown.image || vp.shown.error) && vp.shown.item === vp.item;
  }, view, {timeout: 60000});
  const err = await page.evaluate((v) => window.dicomReader.vps[v].shown.error || null, view);
  expect(err).toBeNull();
}

export const vpState = (page, view = 0) => page.evaluate((v) => {
  const vp = window.dicomReader.vps[v];
  return {
    pos: vp.pos,
    count: vp.count,
    zoom: vp.view.zoom,
    voi: vp.voi,
    series: vp.series?.title,
    rect: vp.el.getBoundingClientRect().toJSON(),
  };
}, view);

/**
 * Synthetic pointer gesture on a viewport (works the same in all engines).
 * paths: one array of [x, y] points per finger, relative to the viewport.
 */
export async function gesture(page, view, paths, {pointerType = 'touch', button = 0, delay = 8, holdMs = 0} = {}) {
  await page.evaluate(async ({view, paths, pointerType, button, delay, holdMs}) => {
    const el = window.dicomReader.vps[view].el;
    const r = el.getBoundingClientRect();
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const fire = (type, i, [x, y]) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 100 + i, pointerType, isPrimary: i === 0, bubbles: true, cancelable: true,
      clientX: r.left + x, clientY: r.top + y, button: type === 'pointermove' ? -1 : button,
      buttons: type === 'pointerup' ? 0 : 1,
    }));
    paths.forEach((p, i) => fire('pointerdown', i, p[0]));
    if (holdMs) await sleep(holdMs);
    const steps = Math.max(...paths.map((p) => p.length));
    for (let k = 1; k < steps; ++k) {
      paths.forEach((p, i) => fire('pointermove', i, p[Math.min(k, p.length - 1)]));
      await sleep(delay);
    }
    paths.forEach((p, i) => fire('pointerup', i, p[p.length - 1]));
  }, {view, paths, pointerType, button, delay, holdMs});
}

/** straight line from a to b in n steps */
export function line(a, b, n = 12) {
  return Array.from({length: n + 1}, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
}

export async function tap(page, view, p, pointerType = 'touch') {
  await gesture(page, view, [[p]], {pointerType});
}

export async function menuItem(page, buttonSelector, label) {
  await page.click(buttonSelector);
  await page.locator('#menu button', {hasText: label}).first().click();
}
