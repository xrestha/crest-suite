// Writes backup files to a real folder on disk (e.g. C:\CrestBackups\<Client>\), via the File
// System Access API.
//
// Why this rather than an ordinary download: a download goes wherever the browser is configured
// to put it, under a name the page only partly controls, and cannot organise per-client folders.
// showDirectoryPicker gives one durable handle to a folder the admin chose once.
//
// The permission model is the part worth knowing. A stored handle does NOT come back with write
// access automatically — requestPermission() must be called, and it needs a user gesture. The
// exception is what makes the unattended path viable: Chrome 122+ automatically persists File
// System Access permissions for INSTALLED PWAs, skipping the prompt entirely. Crest ships a
// valid manifest with display:standalone, so installing it to the desktop is what turns this
// from "prompts every session" into silent writes. In a plain tab, expect a prompt per visit.
//
// Firefox and Safari implement none of this, hence downloadFallback().

const DB_NAME = 'crest-backup'
const DB_VERSION = 1
const STORE = 'handles'
const KEY = 'backupDir'

// Deliberately a separate IndexedDB database from `crest-offline`. Adding a store there would
// mean bumping that DB's version, whose upgrade path runs on the live POS offline-order route —
// not worth disturbing to store one directory handle.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet(key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  }))
}

function idbPut(key, value) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  }))
}

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

// Must be called from a user gesture (click) — the picker is gated on user activation.
export async function pickBackupDirectory() {
  if (!isFileSystemAccessSupported()) {
    throw new Error('This browser cannot write to a folder. Use Chrome or Edge, or export via download.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'crest-backups' })
  await idbPut(KEY, handle)
  return handle
}

export async function getSavedDirectory() {
  try { return await idbGet(KEY) } catch { return null }
}

export async function forgetBackupDirectory() {
  try { await idbPut(KEY, null) } catch { /* nothing usable to report */ }
}

/**
 * Resolves the stored handle to one that is actually writable right now.
 * @param request  when false, only checks (safe to call outside a user gesture); when true, may prompt.
 * @returns { handle, state } where state is 'granted' | 'prompt' | 'denied' | 'none'
 */
export async function ensureBackupDirectory({ request = false } = {}) {
  const handle = await getSavedDirectory()
  if (!handle) return { handle: null, state: 'none' }
  let state = await handle.queryPermission({ mode: 'readwrite' })
  if (state !== 'granted' && request) {
    state = await handle.requestPermission({ mode: 'readwrite' })
  }
  return { handle, state }
}

// Windows forbids \ / : * ? " < > | in a path segment, and a trailing dot or space produces a
// folder that is awkward to delete. Restaurant names contain apostrophes and ampersands freely.
export function sanitizeFolderName(name) {
  const cleaned = String(name || 'Unnamed Client')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned || 'Unnamed Client'
}

// Local time, not ISO/UTC — this filename is read by a person looking for "the backup I took
// yesterday afternoon", and a UTC stamp in Nepal (+05:45) shows the wrong day for a good part
// of the evening.
export function backupStamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`
}

/**
 * Writes the artifact set into <chosen folder>/<Client Name>/.
 * @param reason 'manual' | 'prepurge' | 'predelete' | 'archive' — carried in the filename so a
 *               file found on disk a year later explains itself.
 */
export async function writeBackup(handle, clientName, reason, { xlsxBlob, jsonBlob, manifest }) {
  const dir = await handle.getDirectoryHandle(sanitizeFolderName(clientName), { create: true })
  const base = `${backupStamp()}_${reason}`

  async function put(filename, blob) {
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
  }

  await put(`${base}.xlsx`, xlsxBlob)
  await put(`${base}.json`, jsonBlob)
  await put(`${base}_manifest.txt`, new Blob([
    `Crest Suite backup\n` +
    `Client:     ${manifest.clientName}\n` +
    `Client ID:  ${manifest.clientId}\n` +
    `Taken:      ${manifest.generatedAt}\n` +
    `Reason:     ${reason}\n` +
    `Total rows: ${manifest.totalRows}\n\n` +
    Object.entries(manifest.counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `  ${t.padEnd(34)} ${n}`)
      .join('\n') +
    `\n\nNotes:\n` + manifest.notes.map(n => `  - ${n}`).join('\n') + '\n',
  ], { type: 'text/plain' }))

  return `${sanitizeFolderName(clientName)}/${base}`
}

// Used where the File System Access API is unavailable. The admin gets the same two artifacts
// in their Downloads folder and files them by hand.
export function downloadFallback(clientName, reason, { xlsxBlob, jsonBlob }) {
  const base = `${sanitizeFolderName(clientName)}_${backupStamp()}_${reason}`
  for (const [suffix, blob] of [['.xlsx', xlsxBlob], ['.json', jsonBlob]]) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${base}${suffix}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return base
}
