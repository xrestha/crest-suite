import { clearStoredAuthSession, signOutThisDevice } from './deviceSignOut'
import { supabase } from '../supabaseClient'

jest.mock('../supabaseClient', () => ({ supabase: { auth: { signOut: jest.fn() } } }))

function fakeStorage(entries) {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    key: i => [...map.keys()][i] ?? null,
    removeItem: k => { map.delete(k) },
    keys: () => [...map.keys()],
  }
}

describe('clearStoredAuthSession', () => {
  test('removes the session and its siblings, and nothing else', () => {
    const s = fakeStorage({
      'sb-abcd-auth-token': '{}',
      'sb-abcd-auth-token-code-verifier': 'x',
      'sb-abcd-auth-token-user': '{}',
      'crest_staff_client': 'c1',
      'pos_device_client_id': 'c1',
      'theme': 'dark',
    })
    expect(clearStoredAuthSession(s)).toBe(3)
    expect(s.keys()).toEqual(['crest_staff_client', 'pos_device_client_id', 'theme'])
  })
})

describe('signOutThisDevice', () => {
  afterEach(() => { window.localStorage.clear(); jest.restoreAllMocks() })

  test('a normal sign-out leaves the clearing to the library', async () => {
    supabase.auth.signOut.mockResolvedValue({ error: null })
    window.localStorage.setItem('sb-abcd-auth-token', '{}')
    expect(await signOutThisDevice()).toBe(true)
    expect(window.localStorage.getItem('sb-abcd-auth-token')).toBe('{}')
  })

  test('a failed sign-out clears the stored session itself', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    supabase.auth.signOut.mockResolvedValue({ error: { message: 'Failed to fetch' } })
    window.localStorage.setItem('sb-abcd-auth-token', '{}')
    window.localStorage.setItem('crest_staff_client', 'c1')
    expect(await signOutThisDevice()).toBe(false)
    expect(window.localStorage.getItem('sb-abcd-auth-token')).toBeNull()
    expect(window.localStorage.getItem('crest_staff_client')).toBe('c1')
  })

  test('with no scope the library default is used, unchanged (S809)', async () => {
    supabase.auth.signOut.mockResolvedValue({ error: null })
    expect(await signOutThisDevice()).toBe(true)
    expect(supabase.auth.signOut).toHaveBeenLastCalledWith()
  })

  test('scope local signs out this device only (S809 ACCESS-1)', async () => {
    supabase.auth.signOut.mockResolvedValue({ error: null })
    expect(await signOutThisDevice({ scope: 'local' })).toBe(true)
    expect(supabase.auth.signOut).toHaveBeenLastCalledWith({ scope: 'local' })
  })

  test('any other scope value falls back to the default rather than being passed through', async () => {
    supabase.auth.signOut.mockResolvedValue({ error: null })
    expect(await signOutThisDevice({ scope: 'others' })).toBe(true)
    expect(supabase.auth.signOut).toHaveBeenLastCalledWith()
  })

  test('a sign-out that throws is treated the same way', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    supabase.auth.signOut.mockRejectedValue(new Error('network down'))
    window.localStorage.setItem('sb-abcd-auth-token', '{}')
    expect(await signOutThisDevice()).toBe(false)
    expect(window.localStorage.getItem('sb-abcd-auth-token')).toBeNull()
  })
})
