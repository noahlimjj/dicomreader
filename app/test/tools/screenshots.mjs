// App Store screenshots from the sample study: node test/tools/screenshots.mjs (needs `npx vite preview` on 4173)
import {chromium} from '@playwright/test';
const SIZES = {
  'iphone-6.9': {width: 440, height: 956, scale: 3},  // 1320 x 2868
  'iphone-6.5': {width: 414, height: 896, scale: 3},  // 1242 x 2688
  'ipad-13': {width: 1032, height: 1376, scale: 2},   // 2064 x 2752
};
const b = await chromium.launch();
for (const [name, s] of Object.entries(SIZES)) {
  const ctx = await b.newContext({viewport: {width: s.width, height: s.height}, deviceScaleFactor: s.scale, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({path: `store/screenshots/${name}-${n}.png`});
  await p.goto('http://localhost:4173/');
  await shot('1-start');
  await p.click('#sampleBtn');
  await p.waitForFunction(() => window.dicomReader?.vps[0].shown?.image);
  await p.evaluate(() => { document.getElementById('toast').hidden = true; });
  await p.waitForTimeout(800);
  // measurements
  await p.evaluate(() => {
    const {state, vps} = window.dicomReader;
    const v = vps[0];
    state.measurements.push({id: 'a', type: 'length', seriesKey: v.series.key, pos: v.pos, points: [[66, 130], [190, 130]]});
    state.measurements.push({id: 'b', type: 'ellipse', seriesKey: v.series.key, pos: v.pos, points: [[150, 112], [176, 150]]});
    state.selected = 'b';
    v.draw();
  });
  await p.waitForTimeout(300);
  await shot('2-measure');
  await p.evaluate(() => { window.dicomReader.state.selected = null; window.dicomReader.setLayout(2); });
  await p.waitForFunction(() => window.dicomReader.vps[1].shown?.image);
  await p.evaluate(() => { document.getElementById('toast').hidden = true; });
  await p.waitForTimeout(600);
  await shot('3-two-views');
  await p.evaluate(() => { window.dicomReader.setLayout(1); window.dicomReader.showSeries(3, window.dicomReader.vps[0]); });
  await p.waitForFunction(() => window.dicomReader.vps[0].shown?.image && window.dicomReader.vps[0].series.title.startsWith('Coronal'));
  await p.evaluate(() => { const v = window.dicomReader.vps[0]; document.getElementById('toast').hidden = true; });
  await p.waitForTimeout(400);
  await shot('4-coronal');
  await p.click('#seriesBtn');
  await p.waitForTimeout(500);
  await shot('5-series');
  await ctx.close();
}
await b.close();
console.log('done');
