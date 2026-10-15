// S840: get_client_profile_names names a Crest operator login only for the operator itself or when
// its id is asked for in `p_ids`. These pin the helper every screen resolves names through: the ids
// it asks for, the second request it skips when nothing is missing, and an error that is passed back
// rather than swallowed into an empty map that reads as "nobody".
import { renderHook, waitFor } from '@testing-library/react'
import {
  distinctIds, namesMapOf, profileNamesRpc, loadProfileNames, missingNameIds, fillMissingNames,
  useMissingProfileNames,
} from './profileNames'

const sb = (...answers) => {
  const rpc = jest.fn()
  for (const a of answers) rpc.mockImplementationOnce(() => Promise.resolve(a))
  rpc.mockImplementation(() => Promise.resolve(answers[answers.length - 1] || { data: [], error: null }))
  return { rpc }
}

describe('the ids asked for', () => {
  test('are deduplicated, with empty ids dropped', () => {
    expect(distinctIds(['u1', null, 'u2', undefined, 'u1', ''])).toEqual(['u1', 'u2'])
    expect(distinctIds(null)).toEqual([])
  })

  test('go to the RPC as p_ids; no ids sends the one-key call', () => {
    const supabase = sb({ data: [], error: null })
    profileNamesRpc(supabase, 'c1', ['u1', null, 'u1', 'op'])
    expect(supabase.rpc).toHaveBeenLastCalledWith('get_client_profile_names', { p_client_id: 'c1', p_ids: ['u1', 'op'] })
    profileNamesRpc(supabase, 'c1')
    expect(supabase.rpc).toHaveBeenLastCalledWith('get_client_profile_names', { p_client_id: 'c1' })
  })
})

describe('loadProfileNames', () => {
  test('answers the names as a map', async () => {
    const supabase = sb({ data: [{ id: 'u1', full_name: 'Sita' }, { id: 'op', full_name: 'Crest support' }], error: null })
    expect(await loadProfileNames(supabase, 'c1', ['op'])).toEqual({ map: { u1: 'Sita', op: 'Crest support' }, error: null })
  })

  test('passes a failed read back as the error, with no names', async () => {
    const err = { message: 'permission denied' }
    expect(await loadProfileNames(sb({ data: null, error: err }), 'c1', ['u1'])).toEqual({ map: {}, error: err })
  })

  test('a read that never answers comes back as a timeout', async () => {
    jest.useFakeTimers()
    try {
      const p = loadProfileNames({ rpc: () => new Promise(() => {}) }, 'c1', ['u1'], { ms: 5000 })
      jest.advanceTimersByTime(5000)
      const res = await p
      expect(res.map).toEqual({})
      expect(res.error?.name).toBe('TimeoutError')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('fillMissingNames', () => {
  const first = namesMapOf([{ id: 'u1', full_name: 'Sita' }, { id: 'u2', full_name: null }])

  test('a login with an empty name is named, not missing', () => {
    expect(missingNameIds(first, ['u1', 'u2', 'op', 'op', null])).toEqual(['op'])
  })

  test('nothing missing: no second request, and the same map back', async () => {
    const supabase = sb({ data: [], error: null })
    const res = await fillMissingNames(supabase, 'c1', first, ['u1', 'u2', null])
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(res.map).toBe(first)
    expect(res.error).toBeNull()
  })

  test('asks for the missing ids only, once each, and merges what comes back', async () => {
    const supabase = sb({ data: [{ id: 'u1', full_name: 'Sita' }, { id: 'op', full_name: 'Crest support' }], error: null })
    const res = await fillMissingNames(supabase, 'c1', first, ['u1', 'op', 'op', 'gone', null])
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('get_client_profile_names', { p_client_id: 'c1', p_ids: ['op', 'gone'] })
    expect(res).toEqual({ map: { u1: 'Sita', u2: null, op: 'Crest support' }, error: null })
  })

  test('a failed second read passes the error back and keeps the first names', async () => {
    const err = { message: 'boom' }
    const res = await fillMissingNames(sb({ data: null, error: err }), 'c1', first, ['op'])
    expect(res.map).toBe(first)
    expect(res.error).toBe(err)
  })
})

describe('useMissingProfileNames', () => {
  test('asks for the unnamed ids once the page names are in, and hands back only those', async () => {
    const supabase = sb({ data: [{ id: 'u1', full_name: 'Sita' }, { id: 'op', full_name: 'Crest support' }], error: null })
    const onFound = jest.fn()
    renderHook(() => useMissingProfileNames({
      supabase, clientId: 'c1', names: { u1: 'Sita' }, ids: ['u1', 'op', null], onFound,
    }))
    await waitFor(() => expect(onFound).toHaveBeenCalledWith({ op: 'Crest support' }))
    expect(supabase.rpc).toHaveBeenCalledWith('get_client_profile_names', { p_client_id: 'c1', p_ids: ['op'] })
  })

  test('asks nothing before the page names are in, or when every id is named', async () => {
    const supabase = sb({ data: [], error: null })
    const onFound = jest.fn()
    const { rerender } = renderHook(props => useMissingProfileNames({ supabase, clientId: 'c1', onFound, ...props }), {
      initialProps: { names: {}, ready: false, ids: ['u1'] },
    })
    rerender({ names: { u1: 'Sita' }, ready: true, ids: ['u1', null] })
    await new Promise(r => setTimeout(r, 0))
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(onFound).not.toHaveBeenCalled()
  })

  test('a failed request reaches onError, and nothing is merged', async () => {
    const err = { message: 'boom' }
    const onFound = jest.fn()
    const onError = jest.fn()
    renderHook(() => useMissingProfileNames({
      supabase: sb({ data: null, error: err }), clientId: 'c1', names: {}, ids: ['op'], onFound, onError,
    }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith(err))
    expect(onFound).not.toHaveBeenCalled()
  })
})
