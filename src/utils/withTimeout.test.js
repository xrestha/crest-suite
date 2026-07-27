import { withTimeout } from './withTimeout'

describe('withTimeout', () => {
  test('settles a promise that never resolves and never rejects', async () => {
    // This is the exact case `.abortSignal()` cannot rescue: supabase-js hangs inside
    // `await getAccessToken()` before it ever calls fetch, so the abort signal is attached
    // to nothing. Only a wall clock can break out of it.
    await expect(withTimeout(new Promise(() => {}), 50, 'Save')).rejects.toThrow(/Save timed out/)
  })

  test('passes a normal success straight through', async () => {
    await expect(withTimeout(Promise.resolve({ error: null }), 50, 'Save')).resolves.toEqual({ error: null })
  })

  test('propagates a real rejection unchanged rather than masking it as a timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'Save')).rejects.toThrow('boom')
  })

  test('works on a thenable — PostgrestBuilder is not a real Promise', async () => {
    const thenable = { then(res) { setTimeout(() => res('done'), 5) } }
    await expect(withTimeout(thenable, 500, 'Save')).resolves.toBe('done')
  })
})
