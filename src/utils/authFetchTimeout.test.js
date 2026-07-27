import { makeAuthTimeoutFetch } from './authFetchTimeout'

const AUTH_URL = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token'
const REST_URL = 'https://x.supabase.co/rest/v1/sales_entries?select=*'

describe('makeAuthTimeoutFetch', () => {
  test('aborts an auth request that never responds — the S454 wedge', async () => {
    // Simulates the stalled /auth/v1/token refresh that leaves auth-js `lockAcquired` stuck
    // true forever, which in turn hangs every DB call in the app.
    const hangingFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('AbortError')))
      })

    const f = makeAuthTimeoutFetch(hangingFetch, 50)
    await expect(f(AUTH_URL, {})).rejects.toThrow('AbortError')
  })

  test('leaves non-auth (PostgREST/Storage) requests completely untouched', async () => {
    // A slow report query or large upload must never be cut off by the auth timeout.
    const seen = []
    const baseFetch = (input, init) => { seen.push({ input, init }); return Promise.resolve('ok') }

    const f = makeAuthTimeoutFetch(baseFetch, 50)
    await expect(f(REST_URL, { method: 'GET' })).resolves.toBe('ok')

    expect(seen).toHaveLength(1)
    expect(seen[0].init.signal).toBeUndefined() // no signal injected
  })

  test('passes a normal auth response straight through and clears its timer', async () => {
    const baseFetch = () => Promise.resolve('session')
    const f = makeAuthTimeoutFetch(baseFetch, 50)
    await expect(f(AUTH_URL, {})).resolves.toBe('session')
  })

  test('honours a caller-supplied abort signal instead of discarding it', async () => {
    const hangingFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('AbortError')))
      })

    const outer = new AbortController()
    const f = makeAuthTimeoutFetch(hangingFetch, 60000) // long timer; outer signal must win
    const p = f(AUTH_URL, { signal: outer.signal })
    outer.abort()

    await expect(p).rejects.toThrow('AbortError')
  })

  test('handles a Request-like object, not just a string url', async () => {
    const baseFetch = () => Promise.resolve('ok')
    const f = makeAuthTimeoutFetch(baseFetch, 50)
    await expect(f({ url: REST_URL }, {})).resolves.toBe('ok')
  })
})
