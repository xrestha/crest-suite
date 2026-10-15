// S809 CHECKOUT-11: a reprint takes the HSC codes of its own lines and the name of the login that
// closed (or comped) it, and a failed read of either is said, never printed around.
import { readHscMap, staffNameFor } from './billReprintData'

const builder = answer => {
  const calls = []
  const b = {
    calls,
    in: (col, ids) => { calls.push(['in', col, ids]); return b },
    then: (ok, ko) => Promise.resolve(answer).then(ok, ko),
  }
  return b
}

describe('readHscMap', () => {
  test('reads the codes of exactly these recipes, once each', async () => {
    const b = builder({ data: [{ id: 'momo', hsc_code: '2106' }, { id: 'tea', hsc_code: null }], error: null })
    const from = jest.fn(() => b)
    const res = await readHscMap(from, ['momo', 'tea', 'momo', null, undefined])
    expect(from).toHaveBeenCalledWith('recipes', 'id, hsc_code')
    expect(b.calls).toEqual([['in', 'id', ['momo', 'tea']]])
    expect(res).toEqual({ map: { momo: '2106', tea: null }, error: null })
  })

  test('a bill with no recipe lines asks nothing', async () => {
    const from = jest.fn()
    expect(await readHscMap(from, [null])).toEqual({ map: {}, error: null })
    expect(from).not.toHaveBeenCalled()
  })

  test('a failed read is an error with no codes, never an empty map that looks like "no codes"', async () => {
    const err = { message: 'boom' }
    const res = await readHscMap(() => builder({ data: null, error: err }), ['momo'])
    expect(res).toEqual({ map: {}, error: err })
  })
})

describe('staffNameFor', () => {
  const sb = answer => ({ rpc: jest.fn(() => Promise.resolve(answer)) })

  test('names the login that closed the bill, not whoever is reprinting it', async () => {
    const supabase = sb({ data: [{ id: 'u1', full_name: 'Sita' }, { id: 'u2', full_name: 'Ram' }], error: null })
    expect(await staffNameFor(supabase, 'c1', 'u2')).toEqual({ name: 'Ram', error: null })
    // Asked for by id (S840), so a bill Crest support closed is named on its reprint.
    expect(supabase.rpc).toHaveBeenCalledWith('get_client_profile_names', { p_client_id: 'c1', p_ids: ['u2'] })
  })

  test('no staff id on the bill is an empty name and no request', async () => {
    const supabase = sb({ data: [], error: null })
    expect(await staffNameFor(supabase, 'c1', null)).toEqual({ name: '', error: null })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  test('a login no longer in the list is an empty name, not an error', async () => {
    expect(await staffNameFor(sb({ data: [{ id: 'u1', full_name: 'Sita' }], error: null }), 'c1', 'gone'))
      .toEqual({ name: '', error: null })
  })

  test('a failed read comes back as the error (the caller prints nothing)', async () => {
    const err = { message: 'permission denied' }
    expect(await staffNameFor(sb({ data: null, error: err }), 'c1', 'u1')).toEqual({ name: '', error: err })
  })

  test('a read that never answers comes back as a timeout, not a hang', async () => {
    jest.useFakeTimers()
    try {
      const p = staffNameFor({ rpc: () => new Promise(() => {}) }, 'c1', 'u1')
      jest.advanceTimersByTime(20000)
      const res = await p
      expect(res.name).toBe('')
      expect(res.error?.name).toBe('TimeoutError')
    } finally {
      jest.useRealTimers()
    }
  })
})
