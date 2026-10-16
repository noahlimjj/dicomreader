// Turning picked / dropped files, folders and ZIP archives into "entries"
// that the loader can read lazily: {key, name, size, getSource()}.
import {ZipReader, BlobReader, Uint8ArrayWriter, configure} from '@zip.js/zip.js';

configure({useWebWorkers: false});

const SKIP = /(^|\/)(\.|__MACOSX\/|DICOMDIR$|DIRFILE$|LOCKFILE$|VERSION$|autorun\.inf$|Thumbs\.db$)/i;
const NOT_DICOM_EXT = /\.(txt|htm|html|xml|pdf|exe|dll|ini|inf|ico|bmp|gif|png|jpe?g|js|css|json|zip|ds_store|plist|sh|bat|cmd|cab|msi|app|chm|log|sys)$/i;

function fileKey(path, size, modified) {
  return `${path}|${size}|${modified || 0}`;
}

async function isZip(file) {
  if (/\.zip$/i.test(file.name)) return true;
  if (file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

async function zipEntries(file, path) {
  const reader = new ZipReader(new BlobReader(file));
  const list = await reader.getEntries();
  const out = [];
  for (const e of list) {
    if (e.directory || SKIP.test(e.filename) || NOT_DICOM_EXT.test(e.filename) || e.uncompressedSize < 128) continue;
    out.push({
      key: fileKey(`${path}/${e.filename}`, e.uncompressedSize, e.lastModDate?.getTime?.()),
      name: `${path.replace(/\.zip$/i, '')}/${e.filename}`,
      size: e.uncompressedSize,
      // extracted again whenever needed: keeps memory low on phones
      getSource: async () => {
        const data = await e.getData(new Uint8ArrayWriter());
        return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
      },
    });
  }
  return out;
}

/**
 * @param {Array<File & {relativePath?: string}>} files
 * @param {(msg: string) => void} onStatus
 */
export async function entriesFromFiles(files, onStatus = () => {}) {
  const entries = [];
  for (const f of files) {
    const path = f.relativePath || f.webkitRelativePath || f.name;
    if (SKIP.test(path)) continue;
    if (await isZip(f)) {
      onStatus(`Opening ${f.name}…`);
      try {
        entries.push(...await zipEntries(f, path));
      } catch (e) {
        console.warn('Could not read zip', f.name, e);
        throw new Error(`Could not open ${f.name}: ${e.message || e}`);
      }
      continue;
    }
    if (NOT_DICOM_EXT.test(path) || f.size < 128) continue;
    entries.push({
      key: fileKey(path, f.size, f.lastModified),
      name: path,
      size: f.size,
      cheap: true, // a File: the worker reads it itself
      getSource: () => Promise.resolve(f),
    });
  }
  return entries;
}

/** Entries for files served over HTTP (bundled sample, desktop launcher). */
export function entriesFromUrls(urls) {
  return urls.map((url) => ({
    key: fileKey(url, 0, 0),
    name: url.split('/').slice(-2).join('/'),
    size: 0,
    getSource: async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.arrayBuffer();
    },
  }));
}

// ---- drag and drop of folders (desktop browsers) ---------------------------

function readAll(dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => dirReader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else {
        all.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

async function walkEntry(entry, path, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    file.relativePath = path + file.name;
    out.push(file);
  } else if (entry.isDirectory) {
    const children = await readAll(entry.createReader());
    for (const c of children) await walkEntry(c, `${path}${entry.name}/`, out);
  }
}

export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const roots = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return [...dataTransfer.files];
  const out = [];
  for (const r of roots) await walkEntry(r, '', out);
  return out;
}
