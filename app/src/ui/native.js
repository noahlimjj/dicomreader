// Native (Capacitor) integration: sharing exported images, files opened with
// the app ("Open in…"), Android back button. All optional on the web.
import {Capacitor} from '@capacitor/core';
import {entriesFromFiles, maybeDicom} from '../engine/import.js';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Save / share an image blob. Returns a short status text. */
export async function shareBlob(blob, filename) {
  if (isNative) {
    const [{Filesystem, Directory}, {Share}] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ]);
    const data = await blobToBase64(blob);
    const res = await Filesystem.writeFile({path: filename, data, directory: Directory.Cache});
    await Share.share({title: filename, files: [res.uri]});
    return '';
  }
  const file = new File([blob], filename, {type: blob.type});
  if (navigator.canShare && navigator.canShare({files: [file]}) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({files: [file], title: filename});
      return '';
    } catch (e) {
      if (e.name === 'AbortError') return '';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return `Saved ${filename}`;
}

/**
 * Files opened with the app from Files / Mail / AirDrop arrive as URLs.
 * @param {(files: File[]) => void} onFiles
 * @param {() => boolean} onBack return true when the back press was handled
 */
export async function initNative(onFiles, onBack) {
  if (!isNative) return;
  const {App} = await import('@capacitor/app');
  const openUrl = async (url) => {
    if (!url || !/^(file|content):/.test(url)) return;
    try {
      const r = await fetch(Capacitor.convertFileSrc(url));
      const blob = await r.blob();
      const name = decodeURIComponent(url.split('/').pop() || 'scan');
      onFiles([new File([blob], name, {type: blob.type})]);
    } catch (e) {
      console.warn('Could not open', url, e);
    }
  };
  App.addListener('appUrlOpen', (e) => openUrl(e.url));
  const launch = await App.getLaunchUrl().catch(() => null);
  if (launch?.url) openUrl(launch.url);
  App.addListener('backButton', () => {
    if (!onBack()) App.exitApp();
  });
}

/**
 * Convert native-copied file records `{name, path, size}` into loader entries,
 * automatically unpacking any `.zip` archives via `entriesFromFiles`.
 * Non-ZIP entries are marked `cheap: true` so the worker pool indexes 32 headers
 * at a time by streaming only the first 48 KB per file.
 */
export async function nativeFilesToEntries(files, onStatus = () => {}, batchDir = null) {
  const entries = [];
  const zipFiles = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const r = await fetch(Capacitor.convertFileSrc(`file://${f.path}`));
      if (!r.ok) throw new Error(`Cannot read ${f.name}`);
      const blob = await r.blob();
      const file = new File([blob], f.name, {type: 'application/zip'});
      file.relativePath = f.name;
      file.nativePath = f.path;
      zipFiles.push(file);
    } else if (maybeDicom(f.name, f.size || 512)) {
      const url = Capacitor.convertFileSrc(`file://${f.path}`);
      const size = f.size || 0;
      entries.push({
        key: `${f.path}|${size}`,
        name: f.name,
        size,
        nativePath: f.path,
        batchDir,
        cheap: true,
        getSource: () => Promise.resolve({url, size}),
      });
    }
  }
  if (zipFiles.length) {
    const unzipped = await entriesFromFiles(zipFiles, onStatus);
    for (const u of unzipped) {
      u.batchDir = batchDir;
    }
    entries.push(...unzipped);
  }
  return entries;
}

/**
 * Native folder picker (iOS Files / Android): the folder is copied into the
 * app's persistent studies folder. Returns import entries, or null when cancelled.
 */
export async function pickNativeFolder(onStatus) {
  const {registerPlugin} = await import('@capacitor/core');
  const FolderPicker = registerPlugin('FolderPicker');
  const res = await FolderPicker.pickFolder();
  if (!res || res.cancelled || !res.files) return null;
  return nativeFilesToEntries(res.files, onStatus, res.batchDir || null);
}

/**
 * Native file picker (iOS Files / Android Documents UI, including Google Drive).
 * When `drive: true` is passed on Android, opens directly in Google Drive.
 * Returns import entries, or null when cancelled.
 */
export async function pickNativeFiles({drive = false} = {}, onStatus) {
  const {registerPlugin} = await import('@capacitor/core');
  const FolderPicker = registerPlugin('FolderPicker');
  const res = await FolderPicker.pickFiles({drive});
  if (!res || res.cancelled || !res.files) return null;
  return nativeFilesToEntries(res.files, onStatus, res.batchDir || null);
}

/**
 * Download a remote URL (such as a shared Google Drive file link) natively
 * without browser CORS limits, and return import entries.
 */
export async function downloadNativeUrl(url, filename = 'google-drive-scan', onStatus) {
  const {registerPlugin} = await import('@capacitor/core');
  const FolderPicker = registerPlugin('FolderPicker');
  const res = await FolderPicker.downloadUrl({url, filename});
  if (!res || !res.files) return [];
  return nativeFilesToEntries(res.files, onStatus, res.batchDir || null);
}

/** Delete native study directories when a saved study is removed from the library. */
export async function deleteNativePaths(paths) {
  if (!isNative || !paths?.length) return;
  try {
    const {registerPlugin} = await import('@capacitor/core');
    const FolderPicker = registerPlugin('FolderPicker');
    await FolderPicker.deletePaths({paths});
  } catch (e) {
    console.warn('Could not delete native paths', e);
  }
}

/** Listen for live folder copy progress events from native iOS and Android plugins. */
export async function onNativeProgress(callback) {
  if (!isNative) return {remove: () => {}};
  try {
    const {registerPlugin} = await import('@capacitor/core');
    const FolderPicker = registerPlugin('FolderPicker');
    return await FolderPicker.addListener('folderProgress', callback);
  } catch {
    return {remove: () => {}};
  }
}

let cachedStudiesDir = null;

/** Get the persistent studies directory on the current native platform. */
export async function getNativeStudiesDir() {
  if (!isNative) return null;
  if (cachedStudiesDir) return cachedStudiesDir;
  try {
    const {registerPlugin} = await import('@capacitor/core');
    const FolderPicker = registerPlugin('FolderPicker');
    const res = await FolderPicker.getStudiesDir();
    if (res?.path) cachedStudiesDir = res.path;
    return cachedStudiesDir;
  } catch (e) {
    console.warn('Could not get native studies dir', e);
    return null;
  }
}

/**
 * Request OS background execution time (UIBackgroundTaskIdentifier on iOS, WakeLock on Android)
 * so long-running operations (like folder copying, slice indexing, and study library saving)
 * continue running even if the user switches apps or locks the screen.
 */
export async function beginNativeBackgroundTask(name = 'DICOM-Task') {
  if (!isNative) return null;
  try {
    const {registerPlugin} = await import('@capacitor/core');
    const FolderPicker = registerPlugin('FolderPicker');
    if (typeof FolderPicker.startBackgroundTask === 'function') {
      const res = await FolderPicker.startBackgroundTask({name});
      return res?.taskId || null;
    }
  } catch (e) {
    console.warn('Could not start native background task', e);
  }
  return null;
}

/** End a previously started native background task. */
export async function endNativeBackgroundTask(taskId) {
  if (!isNative || !taskId) return;
  try {
    const {registerPlugin} = await import('@capacitor/core');
    const FolderPicker = registerPlugin('FolderPicker');
    if (typeof FolderPicker.endBackgroundTask === 'function') {
      await FolderPicker.endBackgroundTask({taskId});
    }
  } catch (e) {
    console.warn('Could not end native background task', e);
  }
}



