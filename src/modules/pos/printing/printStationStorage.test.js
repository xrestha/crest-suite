import { readStoredDevice, writeStoredDevice, clearStoredDevice, PRINT_DEVICE_KEY } from './printStationStorage'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) },
    raw: m,
  }
}

const refusing = {
  getItem() { throw new Error('SecurityError') },
  setItem() { throw new Error('QuotaExceededError') },
  removeItem() { throw new Error('SecurityError') },
}

const PAIRING = { deviceId: 'dev-1', secret: 's3cret', deviceName: 'Counter PC', clientName: 'Bhatti Choila' }

test('round trip under crest_print_device', () => {
  const s = memoryStorage()
  expect(PRINT_DEVICE_KEY).toBe('crest_print_device')
  expect(writeStoredDevice(PAIRING, s)).toBe(true)
  expect(JSON.parse(s.raw.get('crest_print_device'))).toEqual(PAIRING)
  expect(readStoredDevice(s)).toEqual(PAIRING)
  clearStoredDevice(s)
  expect(readStoredDevice(s)).toBeNull()
})

test('nothing stored, junk stored, or a pairing missing its secret reads as not paired', () => {
  const s = memoryStorage()
  expect(readStoredDevice(s)).toBeNull()
  s.setItem(PRINT_DEVICE_KEY, '{not json')
  expect(readStoredDevice(s)).toBeNull()
  s.setItem(PRINT_DEVICE_KEY, JSON.stringify({ deviceId: 'dev-1' }))
  expect(readStoredDevice(s)).toBeNull()
  s.setItem(PRINT_DEVICE_KEY, JSON.stringify({ deviceId: 'dev-1', secret: 'x', deviceName: 7 }))
  expect(readStoredDevice(s)).toEqual({ deviceId: 'dev-1', secret: 'x', deviceName: '', clientName: '' })
})

test('a browser that refuses storage never throws; the write says it failed', () => {
  expect(readStoredDevice(refusing)).toBeNull()
  expect(writeStoredDevice(PAIRING, refusing)).toBe(false)
  expect(() => clearStoredDevice(refusing)).not.toThrow()
  expect(writeStoredDevice(PAIRING, null)).toBe(false)
  expect(readStoredDevice(null)).toBeNull()
})
