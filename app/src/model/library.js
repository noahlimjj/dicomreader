// Persistent on-device Study Library ("Patient Folders") backed by IndexedDB.
// Stores parsed DICOM header metadata (`meta`) + thumbnails + measurements +
// either native persistent file paths (iOS/Android) or file blobs (Web/ZIP),
// so reopening a saved study takes < 5 ms with zero re-indexing.
import {Capacitor} from '@capacitor/core';
import {makeItems, groupSeries} from './study.js';
import {isNative, deleteNativePaths, getNativeStudiesDir} from '../ui/native.js';

const DB_NAME = 'dicomReaderLibrary';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('studies')) {
        db.createObjectStore('studies', {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', {keyPath: 'id'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Resolves a stored native file or directory path against the current native studies directory.
 * On iOS, app updates change the sandbox UUID
 * (/var/mobile/Containers/Data/Application/<UUID>/Library/Application Support/studies/...).
 * Re-anchoring the relative subpath against the living Application Support directory ensures
 * saved studies open reliably and permanently across app updates and device restores.
 */
export async function resolveNativeFilePath(nativePath, relPath) {
  if (!nativePath && !relPath) return null;
  if (!isNative) return nativePath || relPath;
  const currentBase = await getNativeStudiesDir();
  if (!currentBase) return nativePath || relPath;

  if (relPath) {
    const cleanRel = relPath.startsWith('studies/') ? relPath.slice('studies/'.length) : relPath;
    return `${currentBase}/${cleanRel}`;
  }

  const idx = nativePath.indexOf('/studies/');
  if (idx !== -1) {
    const sub = nativePath.slice(idx + '/studies/'.length);
    return `${currentBase}/${sub}`;
  }

  return nativePath;
}

/** Compute a stable ID for a loaded study. */
export function studyIdOf(series) {
  const f0 = series[0]?.first;
  if (!f0) return `study-${Date.now()}`;
  const hasUid = f0.studyUid && f0.studyUid !== 'unknown-study';
  if (hasUid) return `study:${f0.studyUid}`;

  const sigParts = [
    f0.patientName || '',
    f0.patientId || '',
    f0.studyDate || f0.seriesDate || '',
    f0.studyDesc || '',
    series.map((s) => `${s.title}:${s.images}`).join(';'),
  ].filter(Boolean);

  const raw = sigParts.length ? sigParts.join('|') : (f0.sop || f0.seriesUid || `study-${Date.now()}`);
  return `study:${raw}`;
}

/**
 * List all saved studies (lightweight summary without the per-file `records` array),
 * sorted most recently opened first.
 */
export async function listSavedStudies() {
  try {
    const db = await openDb();
    const tx = db.transaction('studies', 'readonly');
    const all = await reqResult(tx.objectStore('studies').getAll());
    return all
      .map(({records, ...summary}) => ({
        ...summary,
        fileCount: records ? records.length : 0,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

/**
 * Save or update a loaded study in the in-app Library.
 * @param {Array} series grouped series from `groupSeries`
 * @param {Array} indexedEntries `{entry, meta}[]`
 * @param {Array} measurements current measurements
 */
export async function saveStudyToLibrary(series, indexedEntries, measurements = []) {
  if (!series?.length || !indexedEntries?.length) return null;
  const db = await openDb();
  const id = studyIdOf(series);
  const f0 = series[0].first;
  const modalities = [...new Set(series.map((s) => s.first.modality).filter(Boolean))];
  const imageCount = series.reduce((sum, s) => sum + s.images, 0);
  const mainSeries = series.find((s) => !s.isReference && s.thumb) || series.find((s) => s.thumb) || series[0];
  const batchDirs = [...new Set(indexedEntries.map((x) => x.entry.batchDir).filter(Boolean))];

  const records = [];
  const blobsToSave = [];

  for (const {entry, meta} of indexedEntries) {
    if (!meta) continue;
    let relPath = null;
    if (entry.nativePath && entry.nativePath.includes('/studies/')) {
      relPath = entry.nativePath.slice(entry.nativePath.indexOf('/studies/') + '/studies/'.length);
    }
    const rec = {
      key: entry.key,
      name: entry.name,
      size: entry.size || 0,
      meta,
      nativePath: entry.nativePath || null,
      relPath,
    };
    records.push(rec);
    // If not backed by a persistent native file on iOS/Android, persist the binary blob in IndexedDB
    if (!entry.nativePath) {
      try {
        const src = await entry.getSource();
        let buf = null;
        if (src instanceof ArrayBuffer) {
          buf = src.slice(0);
        } else if (ArrayBuffer.isView(src)) {
          buf = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
        } else if (src instanceof Blob) {
          buf = await src.arrayBuffer();
        }
        if (buf) {
          blobsToSave.push({id: `${id}|${entry.key}`, studyId: id, data: buf});
        }
      } catch (e) {
        console.warn('Could not persist blob for', entry.name, e);
      }
    }
  }

  const studyDoc = {
    id,
    patientName: f0.patientName || 'Unnamed patient',
    patientId: f0.patientId || '',
    birthDate: f0.birthDate || '',
    sex: f0.sex || '',
    studyDate: f0.studyDate || f0.seriesDate || '',
    studyDesc: f0.studyDesc || series[0].title || '',
    institution: f0.institution || '',
    modalities,
    seriesCount: series.length,
    imageCount,
    thumb: mainSeries?.thumb || null,
    measurements: measurements || [],
    batchDirs,
    records,
    updatedAt: Date.now(),
  };

  // 1. Save study metadata doc
  const tx = db.transaction('studies', 'readwrite');
  tx.objectStore('studies').put(studyDoc);
  await txDone(tx);

  // 2. Save binary blobs in safe batches of 20
  if (blobsToSave.length) {
    for (let i = 0; i < blobsToSave.length; i += 20) {
      const chunk = blobsToSave.slice(i, i + 20);
      try {
        const btx = db.transaction('blobs', 'readwrite');
        const bStore = btx.objectStore('blobs');
        for (const b of chunk) {
          bStore.put(b);
        }
        await txDone(btx);
      } catch (err) {
        console.warn('Batch blob save warning', err);
      }
    }
  }
  return id;
}

/** Update the thumbnail or measurements of an already-saved study. */
export async function updateSavedStudyMeta(studyId, patch) {
  if (!studyId) return;
  try {
    const db = await openDb();
    const tx = db.transaction('studies', 'readwrite');
    const store = tx.objectStore('studies');
    const existing = await reqResult(store.get(studyId));
    if (!existing) return;
    Object.assign(existing, patch, {updatedAt: Date.now()});
    store.put(existing);
    await txDone(tx);
  } catch {
    // ignore
  }
}

/**
 * Load a saved study from the in-app Library in < 5 ms (no header re-indexing needed!).
 */
export async function loadSavedStudy(studyId) {
  const db = await openDb();
  const tx = db.transaction('studies', 'readonly');
  const doc = await reqResult(tx.objectStore('studies').get(studyId));
  if (!doc || !doc.records?.length) throw new Error('Saved study not found');

  const items = [];
  for (const r of doc.records) {
    const entry = {
      key: r.key,
      name: r.name,
      size: r.size,
      frames: r.meta.file.frames,
      nativePath: r.nativePath || null,
      cheap: true,
      getSource: async () => {
        if (r.nativePath && isNative) {
          const resolvedPath = await resolveNativeFilePath(r.nativePath, r.relPath);
          return {url: Capacitor.convertFileSrc(`file://${resolvedPath}`), size: r.size};
        }
        const btx = db.transaction('blobs', 'readonly');
        const bdoc = await reqResult(btx.objectStore('blobs').get(`${studyId}|${r.key}`));
        if (!bdoc?.data) throw new Error(`Saved data missing for ${r.name}`);
        return bdoc.data instanceof ArrayBuffer ? bdoc.data.slice(0) : bdoc.data;
      },
    };
    items.push(...makeItems(entry, r.meta));
  }
  return {
    id: doc.id,
    series: groupSeries(items),
    measurements: doc.measurements || [],
    sourceCount: doc.records.length,
  };
}

/** Delete a saved study and its associated blobs / native files. */
export async function deleteSavedStudy(studyId) {
  const db = await openDb();
  const tx = db.transaction(['studies', 'blobs'], 'readwrite');
  const studyStore = tx.objectStore('studies');
  const blobStore = tx.objectStore('blobs');
  const doc = await reqResult(studyStore.get(studyId));
  studyStore.delete(studyId);
  if (doc?.records) {
    for (const r of doc.records) {
      blobStore.delete(`${studyId}|${r.key}`);
    }
  }
  await txDone(tx);
  if (doc?.batchDirs?.length) {
    const resolvedBatchDirs = [];
    for (const b of doc.batchDirs) {
      const resolved = await resolveNativeFilePath(b);
      if (resolved) resolvedBatchDirs.push(resolved);
    }
    await deleteNativePaths(resolvedBatchDirs);
  }
}
