import { isChunkLoadError, recoverFromChunkError, chunkErrorMessage } from './chunkReload'

// jsdom's window.location.reload is not writable, so it is replaced wholesale per test.
function withLocation(fn) {
  const original = window.location
  const reload = jest.fn()
  delete window.location
  window.location = { ...original, reload }
  try { return fn(reload) } finally { window.location = original }
}

function setOnline(value) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true })
}

beforeEach(() => {
  sessionStorage.clear()
  setOnline(true)
})

describe('isChunkLoadError', () => {
  it('recognises webpack, Chrome, Firefox and Safari wordings', () => {
    const chunk = Object.assign(new Error('Loading chunk 4821 failed.'), { name: 'ChunkLoadError' })
    expect(isChunkLoadError(chunk)).toBe(true)
    expect(isChunkLoadError(new Error('Loading CSS chunk 137 failed'))).toBe(true)
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/a.js'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })

  it('does not swallow an ordinary application error', () => {
    // The whole guard hangs off this: a real crash misread as a stale deploy becomes a reload
    // loop that hides the bug instead of reporting it.
    expect(isChunkLoadError(new Error("Cannot read properties of null (reading 'revenue')"))).toBe(false)
    expect(isChunkLoadError(new Error('TypeError: Failed to fetch'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('recoverFromChunkError', () => {
  it('reloads once for a chunk failure', () => {
    withLocation(reload => {
      expect(recoverFromChunkError(new Error('Loading chunk 12 failed'))).toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
    })
  })

  it('does not reload twice inside the window', () => {
    withLocation(reload => {
      recoverFromChunkError(new Error('Loading chunk 12 failed'))
      expect(recoverFromChunkError(new Error('Loading chunk 12 failed'))).toBe(false)
      expect(reload).toHaveBeenCalledTimes(1)
    })
  })

  it('never reloads while offline — the reload is answered from the cached shell and fails the same way', () => {
    setOnline(false)
    withLocation(reload => {
      expect(recoverFromChunkError(new Error('Loading chunk 12 failed'))).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    })
    // and the one attempt this allows has not been spent
    setOnline(true)
    withLocation(reload => {
      expect(recoverFromChunkError(new Error('Loading chunk 12 failed'))).toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores an ordinary error', () => {
    withLocation(reload => {
      expect(recoverFromChunkError(new Error('boom'))).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    })
  })
})

describe('chunkErrorMessage', () => {
  it('tells the two states apart', () => {
    setOnline(false)
    expect(chunkErrorMessage()).toMatch(/not available offline/i)
    setOnline(true)
    expect(chunkErrorMessage()).toMatch(/updated while this screen was open/i)
  })

  it('never claims saved work was lost', () => {
    setOnline(true)
    expect(chunkErrorMessage()).toMatch(/already saved is unaffected/i)
    setOnline(false)
    expect(chunkErrorMessage()).toMatch(/already saved is unaffected/i)
  })
})
