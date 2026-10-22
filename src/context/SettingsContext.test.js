/**
 * SettingsProvider's settings load (S859): a client session's own row and the platform row go out
 * together, and everything S747 decided about them still holds. The own row is applied when it lands,
 * `loading` waits for both, a failed platform read keeps the last known values, and a load that was
 * superseded by a client switch applies nothing.
 */

import { render, screen, act } from '@testing-library/react'
import { SettingsProvider, useSettings } from './SettingsContext'
import { useAuth } from './AuthContext'

// Each maybeSingle() is a read the test answers by hand, in whatever order it likes. The provider's
// feature_flags read is recorded too and never answered; only `settings` reads are looked at here.
const mockReads = []
function mockBuilder(table) {
  const read = { table, filter: null, value: undefined }
  const b = {
    select: () => b,
    eq: (col, v) => { read.filter = 'eq'; read.value = v; return b },
    is: (col, v) => { read.filter = 'is'; read.value = v; return b },
    maybeSingle: () => new Promise(resolve => { read.answer = resolve; mockReads.push(read) }),
  }
  return b
}
jest.mock('../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table) } }))
jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('./ThemeContext', () => ({ isPinnedGuestSurface: () => false }))

const settingsReads = () => mockReads.filter(r => r.table === 'settings')
const own = cid => settingsReads().filter(r => r.filter === 'eq' && r.value === cid)
const platform = () => settingsReads().filter(r => r.filter === 'is')

function Probe() {
  const s = useSettings()
  return (
    <output data-testid="probe">
      {JSON.stringify({
        loading: s.loading,
        app: s.settings.app_name,
        email: s.platformSupport?.email || null,
        platformLoaded: s.platformLoaded,
        platformError: !!s.platformLoadError,
        settingsError: !!s.settingsLoadError,
        settingsFor: s.settingsClientId ?? null,
      })}
    </output>
  )
}
const probe = () => JSON.parse(screen.getByTestId('probe').textContent)
const flush = () => act(() => Promise.resolve())
async function answer(read, value) { await act(async () => { read.answer(value) }) }

function renderAs(auth) {
  useAuth.mockReturnValue({ isPremium: false, isAdmin: false, ...auth })
  return render(<SettingsProvider><Probe /></SettingsProvider>)
}

beforeEach(() => { mockReads.length = 0 })

describe('a client session', () => {
  it('sends the platform read with its own, not after it', async () => {
    renderAs({ clientId: 'c-1' })
    await flush()
    // Both are out before either has answered: one round trip, not two in a row.
    expect(own('c-1')).toHaveLength(1)
    expect(platform()).toHaveLength(1)
  })

  it('applies its own row when it lands and ends loading only when both have', async () => {
    renderAs({ clientId: 'c-1' })
    await flush()
    await answer(own('c-1')[0], { data: { client_id: 'c-1', app_name: 'Bloom Cafe' }, error: null })
    expect(probe()).toMatchObject({ app: 'Bloom Cafe', settingsFor: 'c-1', loading: true, platformLoaded: false })

    await answer(platform()[0], { data: { contact_email: 'help@crest.example' }, error: null })
    expect(probe()).toMatchObject({ email: 'help@crest.example', platformLoaded: true, platformError: false, loading: false })
  })

  it('applies the platform row even when it answers first', async () => {
    renderAs({ clientId: 'c-1' })
    await flush()
    await answer(platform()[0], { data: { contact_email: 'help@crest.example' }, error: null })
    expect(probe()).toMatchObject({ loading: true, platformLoaded: false })
    await answer(own('c-1')[0], { data: { client_id: 'c-1', app_name: 'Bloom Cafe' }, error: null })
    expect(probe()).toMatchObject({ app: 'Bloom Cafe', email: 'help@crest.example', platformLoaded: true, loading: false })
  })

  it('keeps the last known platform values when that read fails, and says so', async () => {
    const view = renderAs({ clientId: 'c-1' })
    await flush()
    await answer(own('c-1')[0], { data: { client_id: 'c-1', app_name: 'Bloom Cafe' }, error: null })
    await answer(platform()[0], { data: { contact_email: 'help@crest.example' }, error: null })

    useAuth.mockReturnValue({ isPremium: false, isAdmin: false, clientId: 'c-2' })
    view.rerender(<SettingsProvider><Probe /></SettingsProvider>)
    await flush()
    await answer(own('c-2')[0], { data: { client_id: 'c-2', app_name: 'Pokhara Kitchen' }, error: null })
    await answer(platform()[1], { data: null, error: { message: 'Failed to fetch' } })
    expect(probe()).toMatchObject({
      app: 'Pokhara Kitchen', email: 'help@crest.example', platformLoaded: true, platformError: true, loading: false,
    })
  })

  it('says its own read failed and still reads the platform row', async () => {
    renderAs({ clientId: 'c-1' })
    await flush()
    await answer(own('c-1')[0], { data: null, error: { message: 'Failed to fetch' } })
    await answer(platform()[0], { data: { contact_email: 'help@crest.example' }, error: null })
    expect(probe()).toMatchObject({ app: 'Crest Suite', settingsError: true, email: 'help@crest.example', platformError: false, loading: false })
  })

  it('applies nothing from a load a client switch superseded', async () => {
    const view = renderAs({ clientId: 'c-1' })
    await flush()
    useAuth.mockReturnValue({ isPremium: false, isAdmin: false, clientId: 'c-2' })
    view.rerender(<SettingsProvider><Probe /></SettingsProvider>)
    await flush()

    await answer(own('c-1')[0], { data: { client_id: 'c-1', app_name: 'Bloom Cafe' }, error: null })
    await answer(platform()[0], { data: { contact_email: 'old@crest.example' }, error: null })
    expect(probe()).toMatchObject({ app: 'Crest Suite', email: null, loading: true })

    await answer(own('c-2')[0], { data: { client_id: 'c-2', app_name: 'Pokhara Kitchen' }, error: null })
    await answer(platform()[1], { data: { contact_email: 'help@crest.example' }, error: null })
    expect(probe()).toMatchObject({ app: 'Pokhara Kitchen', email: 'help@crest.example', settingsFor: 'c-2', loading: false })
  })
})

describe('no client (signed out, or support with none selected)', () => {
  it('reads the platform row once, as its own', async () => {
    renderAs({ clientId: null, isAdmin: true })
    await flush()
    expect(settingsReads()).toHaveLength(1)
    expect(platform()).toHaveLength(1)
    await answer(platform()[0], { data: { app_name: 'Crest Suite', contact_email: 'help@crest.example' }, error: null })
    expect(probe()).toMatchObject({ email: 'help@crest.example', platformLoaded: true, settingsFor: null, loading: false })
  })
})
