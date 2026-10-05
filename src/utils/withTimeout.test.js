import { withTimeout, isTimeout, settleWithin } from './withTimeout'

describe('withTimeout', () => {
  test('settles a promise that never resolves and never rejects', async () => {
    // This is the exact case `.abortSignal()` cannot rescue: supabase-js hangs inside
    // `await getAccessToken()` before it ever calls fetch, so the abort signal is attached
    // to nothing. Only a wall clock can break out of it.
    await expect(withTimeout(new Promise(() => {}), 50, 'Save')).rejects.toThrow(/Save timed out/)
  })

  test('marks its own give-up so a caller can tell it from a real failure', async () => {
    const timedOut = await withTimeout(new Promise(() => {}), 20, 'Save').catch(e => e)
    expect(isTimeout(timedOut)).toBe(true)
    const real = await withTimeout(Promise.reject(new Error('boom')), 50, 'Save').catch(e => e)
    expect(isTimeout(real)).toBe(false)
    expect(isTimeout(null)).toBe(false)
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

describe('settleWithin', () => {
  test('a hung call answers as its own error, marked as a timeout', async () => {
    const res = await settleWithin(new Promise(() => {}), 20, 'Finalize')
    expect(res.data).toBeNull()
    expect(isTimeout(res.error)).toBe(true)
  })

  test('an answer passes through untouched, error and all', async () => {
    const refused = { data: null, error: { code: '42501', message: 'refused' } }
    await expect(settleWithin(Promise.resolve(refused), 50)).resolves.toBe(refused)
    await expect(settleWithin(Promise.resolve({ data: [1], error: null }), 50)).resolves.toEqual({ data: [1], error: null })
  })

  test('a rejection is an error, not a timeout', async () => {
    const res = await settleWithin(Promise.reject(new Error('boom')), 50)
    expect(res.error.message).toBe('boom')
    expect(isTimeout(res.error)).toBe(false)
  })
})
