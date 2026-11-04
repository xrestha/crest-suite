/**
 * A failed settings save on a device that never downloaded the error table (S876, PERF-8). The table
 * is fetched only when a save fails, so offline that fetch can fail too: the save must still reject
 * with a sentence that names the consequence, the raw detail kept, and never with the import's own
 * failure (which says nothing about the save) or an unhandled rejection (which reloads the page).
 */
import { render, act } from '@testing-library/react'
import { SettingsProvider, useSettings } from './SettingsContext'
import { useAuth } from './AuthContext'
import { UNAVAILABLE_TEXT } from '../shared/lazyErrorText'

// Every read answers as a dropped connection does.
function mockBuilder() {
  const b = {
    select: () => b, eq: () => b, is: () => b,
    maybeSingle: () => Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } }),
  }
  return b
}
jest.mock('../supabaseClient', () => ({ supabase: { from: () => mockBuilder() } }))
jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('./ThemeContext', () => ({ isPinnedGuestSurface: () => false }))
// The table's file cannot be fetched.
jest.mock('../shared/errorText', () => { throw new Error('Loading chunk 812 failed.') })

it('rejects with the plain fallback sentence and the detail', async () => {
  let ctx
  function Grab() { ctx = useSettings(); return null }
  useAuth.mockReturnValue({ isPremium: false, isAdmin: false, clientId: 'c-1' })
  render(<SettingsProvider><Grab /></SettingsProvider>)
  await act(() => Promise.resolve())

  await expect(ctx.saveSettings({ app_name: 'Bloom Cafe' })).rejects.toThrow(`${UNAVAILABLE_TEXT} (TypeError: Failed to fetch)`)
})
