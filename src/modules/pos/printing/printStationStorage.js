// Where the print station page keeps its pairing (S837): `crest_print_device` in localStorage, so a
// Chrome restart (an update, a power cut) keeps printing without a new code.
//
// Every access is wrapped: a browser with site data blocked, or a private window, can refuse the
// read or the write, and the page must still work for as long as it stays open. A write that fails
// is reported to the caller, which warns that a reload will need a new code.

export const PRINT_DEVICE_KEY = 'crest_print_device'

const defaultStorage = () => {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch (_) { return null }
}

/** The stored pairing, or null when there is none, it cannot be read, or it is not a pairing. */
export function readStoredDevice(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(PRINT_DEVICE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v.deviceId !== 'string' || !v.deviceId || typeof v.secret !== 'string' || !v.secret) return null
    return {
      deviceId: v.deviceId,
      secret: v.secret,
      deviceName: typeof v.deviceName === 'string' ? v.deviceName : '',
      clientName: typeof v.clientName === 'string' ? v.clientName : '',
    }
  } catch (_) {
    return null
  }
}

/** → true when the pairing was saved. */
export function writeStoredDevice(value, storage = defaultStorage()) {
  try {
    if (!storage) return false
    storage.setItem(PRINT_DEVICE_KEY, JSON.stringify({
      deviceId: value.deviceId, secret: value.secret,
      deviceName: value.deviceName || '', clientName: value.clientName || '',
    }))
    return true
  } catch (_) {
    return false
  }
}

export function clearStoredDevice(storage = defaultStorage()) {
  try { storage?.removeItem(PRINT_DEVICE_KEY) } catch (_) { /* nothing to clear, or not allowed to */ }
}
