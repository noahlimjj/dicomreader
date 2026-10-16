// Decoded frame + window -> RGBA pixels.

/** modality value range of a decoded mono image */
export function modalityRange(image, it) {
  const a = image.min * it.slope + it.intercept;
  const b = image.max * it.slope + it.intercept;
  return {min: Math.min(a, b), max: Math.max(a, b)};
}

/** window covering the central part of the histogram (for images without a stored window) */
export function percentileWindow(image, it, lo = 0.01, hi = 0.995) {
  const {data, min, max} = image;
  if (max <= min) return {center: min * it.slope + it.intercept, width: 1};
  const bins = 4096;
  const hist = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min);
  const step = data.length > 2e6 ? 4 : 1;
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[((data[i] - min) * scale) | 0]++;
    n++;
  }
  // ignore a dominant background bin (air / padding) at the low end
  let start = 0;
  if (hist[0] > n * 0.2) {
    n -= hist[0];
    start = 1;
  }
  let acc = 0;
  let a = start;
  let b = bins - 1;
  for (let i = start; i < bins; ++i) {
    acc += hist[i];
    if (acc >= n * lo) {
      a = i;
      break;
    }
  }
  acc = 0;
  for (let i = start; i < bins; ++i) {
    acc += hist[i];
    if (acc >= n * hi) {
      b = i;
      break;
    }
  }
  const va = (min + a / scale) * it.slope + it.intercept;
  const vb = (min + (b + 1) / scale) * it.slope + it.intercept;
  const lowV = Math.min(va, vb);
  const highV = Math.max(va, vb);
  return {center: (lowV + highV) / 2, width: Math.max(1, highV - lowV)};
}

/** default window of an image: file value, else a contrast stretch */
export function defaultWindow(image, it) {
  const wc = it.windowCenter?.[0];
  const ww = it.windowWidth?.[0];
  if (Number.isFinite(wc) && ww >= 1) return {center: wc, width: ww};
  if (image.max - image.min < 256 && it.bitsStored <= 8) {
    const r = modalityRange(image, it);
    return {center: (r.min + r.max) / 2, width: Math.max(1, r.max - r.min)};
  }
  return percentileWindow(image, it);
}

export function minMaxWindow(image, it) {
  const r = modalityRange(image, it);
  return {center: (r.min + r.max) / 2, width: Math.max(1, r.max - r.min + 1)};
}

/**
 * Fill `out` (RGBA, length 4 * pixels) with the windowed image.
 * @param {{center:number,width:number}} voi
 * @param {boolean} invert show negative (MONOCHROME1 is handled here too)
 */
export function renderPixels(image, it, voi, invert, out) {
  const n = image.width * image.height;
  const u32 = new Uint32Array(out.buffer, out.byteOffset, n);
  if (image.kind === 'rgb') {
    if (!invert) {
      out.set(image.rgba);
    } else {
      const src = image.rgba;
      for (let i = 0; i < n * 4; i += 4) {
        out[i] = 255 - src[i];
        out[i + 1] = 255 - src[i + 1];
        out[i + 2] = 255 - src[i + 2];
        out[i + 3] = 255;
      }
    }
    return;
  }
  const neg = invert !== (it.photometric === 'MONOCHROME1' || it.presentationShape === 'INVERSE');
  const {data, min, max} = image;
  const c = voi.center - 0.5;
  const w = Math.max(1, voi.width - 1);
  const slope = it.slope;
  const intercept = it.intercept;
  const sigmoid = it.voiFunction === 'SIGMOID';
  const grey = (v) => {
    const m = v * slope + intercept;
    let y;
    if (sigmoid) y = 1 / (1 + Math.exp(-4 * (m - voi.center) / voi.width));
    else y = (m - c) / w + 0.5;
    let g = y <= 0 ? 0 : y >= 1 ? 255 : (y * 255 + 0.5) | 0;
    if (neg) g = 255 - g;
    return 0xff000000 | (g << 16) | (g << 8) | g;
  };
  const range = max - min + 1;
  if (range <= 1 << 20 && Number.isInteger(min)) {
    const lut = new Uint32Array(range);
    for (let i = 0; i < range; ++i) lut[i] = grey(i + min);
    for (let i = 0; i < n; ++i) u32[i] = lut[data[i] - min];
  } else {
    for (let i = 0; i < n; ++i) u32[i] = grey(data[i]);
  }
}

/** modality value of a pixel (x = column, y = row indices), or null */
export function pixelValue(image, it, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const i = y * image.width + x;
  if (image.kind === 'rgb') {
    const o = i * 4;
    return {rgb: [image.rgba[o], image.rgba[o + 1], image.rgba[o + 2]]};
  }
  return {value: image.data[i] * it.slope + it.intercept};
}
