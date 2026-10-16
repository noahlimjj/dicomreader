// Native (Capacitor) integration: sharing exported images, files opened with
// the app ("Open in…"), Android back button. All optional on the web.
import {Capacitor} from '@capacitor/core';

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
