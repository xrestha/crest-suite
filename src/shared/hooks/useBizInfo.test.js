/**
 * `ready` is what an export gates on (S845): false until the client-name read answers, false after
 * a failure, and a read that never answers ends as a failure rather than holding exports off unsaid.
 */
import { renderHook, waitFor, act } from '@testing-library/react'

let mockRead = () => new Promise(() => {}) // the clients read's answer
jest.mock('../../supabaseClient', () => ({
  supabase: {
    from: () => {
      const b = {}
      for (const op of ['select', 'eq']) b[op] = () => b
      b.maybeSingle = () => mockRead()
      return b
    },
  },
}))
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ clientId: 'c1', profile: null }) }))
jest.mock('../../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { vat_number: '301234567', property_address: 'Thamel', is_vat_registered: true } }),
}))

// eslint-disable-next-line import/first
import { useBizInfo, BIZ_NAME_READ_MS } from './useBizInfo'

afterEach(() => jest.useRealTimers())

test('not ready before the read answers, ready with the name once it has', async () => {
  let answer
  mockRead = () => new Promise(resolve => { answer = resolve })
  const { result } = renderHook(() => useBizInfo())
  expect(result.current).toMatchObject({ name: '', error: null, ready: false })
  await act(async () => { answer({ data: { name: 'Test Cafe' }, error: null }) })
  expect(result.current).toMatchObject({ name: 'Test Cafe', error: null, ready: true, vat: '301234567' })
})

test('a failed read is an error and never ready', async () => {
  mockRead = () => Promise.resolve({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })
  const { result } = renderHook(() => useBizInfo())
  await waitFor(() => expect(result.current.error).toBeTruthy())
  expect(result.current).toMatchObject({ name: '', ready: false })
})

test('a read that never answers becomes an error after its time limit', async () => {
  jest.useFakeTimers()
  mockRead = () => new Promise(() => {})
  const { result } = renderHook(() => useBizInfo())
  expect(result.current.ready).toBe(false)
  await act(async () => { jest.advanceTimersByTime(BIZ_NAME_READ_MS) })
  expect(result.current.error?.name).toBe('TimeoutError')
  expect(result.current.ready).toBe(false)
})
