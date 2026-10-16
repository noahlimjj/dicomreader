// Multiplanar Reconstruction (MPR): on-the-fly reconstruction of
// Coronal and Sagittal series from an Axial CT or MRI volume.
import {cross, dot} from './geometry.js';
import {cleanDescription} from './study.js';

/**
 * Check if a series has sufficient 3D geometric volume data for MPR reconstruction.
 */
export function canReconstructMpr(series) {
  if (!series || series.items.length < 8) return false;
  const f = series.first;
  if (!f.hasGeometry || !f.pixelSpacing || f.samplesPerPixel === 3) return false;
  if (series.stacked || series.isReference) return false;
  return f.modality === 'CT' || f.modality === 'MR' || f.modality === 'PT';
}

/**
 * Build Coronal and Sagittal MPR series from an Axial volume.
 * @param {Object} series The source axial series
 * @param {Object} loader The Loader instance to fetch decoded slices
 * @param {(msg: string, frac: number) => void} onProgress
 */
export async function buildMprSeries(series, loader, onProgress = () => {}) {
  const items = series.items;
  const N = items.length;
  const f0 = items[0];
  const rows = f0.rows;
  const cols = f0.cols;
  const [rowSpacing, colSpacing] = f0.pixelSpacing; // mm per row (dy), mm per col (dx)

  // Sort slices along the normal vector so they are in consecutive 3D order
  const normal = cross(f0.iop.slice(0, 3), f0.iop.slice(3, 6));
  const sorted = [...items].sort((a, b) => dot(a.ipp, normal) - dot(b.ipp, normal));

  // Compute slice thickness / spacing along normal
  const p0 = dot(sorted[0].ipp, normal);
  const p1 = dot(sorted[N - 1].ipp, normal);
  const sliceSpacing = Math.abs(p1 - p0) / Math.max(1, N - 1);

  onProgress('Loading volume slices…', 0);
  const images = [];
  for (let i = 0; i < N; i++) {
    const img = await loader.image(sorted[i], 10);
    images.push(img);
    if (i % 8 === 0 || i === N - 1) {
      onProgress(`Reading slices… ${i + 1} / ${N}`, (i + 1) / N);
    }
  }

  // Determine pixel array type from source
  const sampleData = images[0].data;
  const ArrayType = sampleData.constructor;

  // Build 3D array: volume[z][y * cols + x]
  // Dimensions: X = cols, Y = rows, Z = N
  onProgress('Reconstructing Coronal & Sagittal views…', 0.95);

  const corSlices = Math.min(rows, 128); // Sample up to 128 coronal slices
  const sagSlices = Math.min(cols, 128); // Sample up to 128 sagittal slices
  const yStep = rows / corSlices;
  const xStep = cols / sagSlices;

  // 1. Coronal MPR: slices along Y (Anterior -> Posterior)
  // Each slice: width = cols, height = N (inverted Z so Superior is up)
  const corItems = [];
  const corSeriesUid = `${f0.seriesUid}.MPR.CORONAL`;
  for (let s = 0; s < corSlices; s++) {
    const y = Math.floor(s * yStep);
    const corData = new ArrayType(cols * N);
    let min = Infinity;
    let max = -Infinity;
    for (let z = 0; z < N; z++) {
      // Invert Z so head (superior) is at top of image
      const srcZ = N - 1 - z;
      const srcSlice = images[srcZ].data;
      const srcRowOffset = y * cols;
      const destRowOffset = z * cols;
      for (let x = 0; x < cols; x++) {
        const val = srcSlice[srcRowOffset + x];
        corData[destRowOffset + x] = val;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    const corImage = {
      width: cols,
      height: N,
      kind: 'mono',
      data: corData,
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 1 : max,
    };
    const corItem = {
      ...f0,
      id: `${corSeriesUid}#${s}`,
      seriesUid: corSeriesUid,
      seriesDesc: `${cleanDescription(f0.seriesDesc)} · Coronal MPR`,
      instanceNumber: s + 1,
      rows: N,
      cols,
      pixelSpacing: [sliceSpacing, colSpacing],
      hasGeometry: true,
      // Coronal orientation: [1, 0, 0] (Left-Right) and [0, 0, -1] (Superior-Inferior)
      iop: [f0.iop[0], f0.iop[1], f0.iop[2], -normal[0], -normal[1], -normal[2]],
      ipp: [
        sorted[N - 1].ipp[0] + y * rowSpacing * f0.iop[3],
        sorted[N - 1].ipp[1] + y * rowSpacing * f0.iop[4],
        sorted[N - 1].ipp[2] + y * rowSpacing * f0.iop[5],
      ],
      mprImage: corImage,
    };
    corItems.push(corItem);
  }

  // 2. Sagittal MPR: slices along X (Right -> Left)
  // Each slice: width = rows, height = N
  const sagItems = [];
  const sagSeriesUid = `${f0.seriesUid}.MPR.SAGITTAL`;
  for (let s = 0; s < sagSlices; s++) {
    const x = Math.floor(s * xStep);
    const sagData = new ArrayType(rows * N);
    let min = Infinity;
    let max = -Infinity;
    for (let z = 0; z < N; z++) {
      const srcZ = N - 1 - z;
      const srcSlice = images[srcZ].data;
      const destRowOffset = z * rows;
      for (let y = 0; y < rows; y++) {
        const val = srcSlice[y * cols + x];
        sagData[destRowOffset + y] = val;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    const sagImage = {
      width: rows,
      height: N,
      kind: 'mono',
      data: sagData,
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 1 : max,
    };
    const sagItem = {
      ...f0,
      id: `${sagSeriesUid}#${s}`,
      seriesUid: sagSeriesUid,
      seriesDesc: `${cleanDescription(f0.seriesDesc)} · Sagittal MPR`,
      instanceNumber: s + 1,
      rows: N,
      cols: rows,
      pixelSpacing: [sliceSpacing, rowSpacing],
      hasGeometry: true,
      // Sagittal orientation: [0, 1, 0] (Anterior-Posterior) and [0, 0, -1] (Superior-Inferior)
      iop: [f0.iop[3], f0.iop[4], f0.iop[5], -normal[0], -normal[1], -normal[2]],
      ipp: [
        sorted[N - 1].ipp[0] + x * colSpacing * f0.iop[0],
        sorted[N - 1].ipp[1] + x * colSpacing * f0.iop[1],
        sorted[N - 1].ipp[2] + x * colSpacing * f0.iop[2],
      ],
      mprImage: sagImage,
    };
    sagItems.push(sagItem);
  }

  const makeSeriesFromItems = (list, title) => ({
    title,
    items: list,
    first: list[0],
    images: list.length,
    stacked: false,
    key: list[0].seriesUid,
    isMpr: true,
  });

  return [
    makeSeriesFromItems(corItems, `${cleanDescription(f0.seriesDesc)} · Coronal MPR`),
    makeSeriesFromItems(sagItems, `${cleanDescription(f0.seriesDesc)} · Sagittal MPR`),
  ];
}
