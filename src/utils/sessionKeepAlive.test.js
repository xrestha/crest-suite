import { isAuthExpiredError, startSessionKeepAlive } from './sessionKeepAlive'

describe('isAuthExpiredError', () => {
  test('recognises the server rejecting our token', () => {
    expect(isAuthExpiredError({ status: 401 })).toBe(true)
    expect(isAuthExpiredError({ code: 'PGRST301' })).toBe(true)
    expect(isAuthExpiredError({ message: 'JWT expired' })).toBe(true)
    expect(isAuthExpiredError({ message: 'invalid JWT: token is expired' })).toBe(true)
  })

  test('does not mistake an application error for an auth error', () => {
    // Retrying these would be pointless at best and a double-write at worst.
    expect(isAuthExpiredError({ code: '23503', message: 'foreign key violation' })).toBe(false)
    expect(isAuthExpiredError({ code: '42501', message: 'permission denied for table sales_entries' })).toBe(false)
    expect(isAuthExpiredError({ message: 'Save timed out after 20s' })).toBe(false)
    expect(isAuthExpiredError(null)).toBe(false)
  })
})

describe('startSessionKeepAlive', () => {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
  const setVisibility = v => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })

  afterEach(() => {
    if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
  })

  test('refreshes when the tab wakes up — the case auth-js own ticker misses', async () => {
    setVisibility('visible')
    let calls = 0
    const stop = startSessionKeepAlive(null, { ensure: async () => { calls++ } })

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(calls).toBe(1)

    stop()
  })

  test('does nothing while the tab is still hidden', async () => {
    setVisibility('hidden')
    let calls = 0
    const stop = startSessionKeepAlive(null, { ensure: async () => { calls++ } })

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(calls).toBe(0)

    stop()
  })

  test('coalesces overlapping wake events into one refresh', async () => {
    setVisibility('visible')
    let calls = 0
    let release
    const stop = startSessionKeepAlive(null, { ensure: () => { calls++; return new Promise(r => { release = r }) } })

    // visibilitychange + focus + online routinely fire together when a laptop is reopened.
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    expect(calls).toBe(1)
    release()
    stop()
  })

  test('a failed refresh never throws — it is a background top-up, not a user action', async () => {
    setVisibility('visible')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = startSessionKeepAlive(null, { ensure: async () => { throw new Error('offline') } })

    expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow()
    await Promise.resolve(); await Promise.resolve();

    stop()
    warn.mockRestore()
  })

  test('stop() unsubscribes every listener', async () => {
    setVisibility('visible')
    let calls = 0
    const stop = startSessionKeepAlive(null, { ensure: async () => { calls++ } })
    stop()

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    expect(calls).toBe(0)
  })
})
