/**
 * The PIN screen says what a till lock kept (S776). The lock happens while nobody is looking, so this
 * is the screen the waiter comes back to — and a different waiter must see that it is not theirs.
 *
 * And it never sits on top of a live login (S809 ACCESS-1): on an activated tablet it signs out any
 * session it finds, on this tablet only, before it shows a single name.
 */

import React from 'react'
import fs from 'fs'
import path from 'path'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { keepLockedCart } from '../posLockedCart'

const STAFF = [
  { id: 'p-ram', full_name: 'Ram', pos_job_title: 'Waiter' },
  { id: 'p-sita', full_name: 'Sita', pos_job_title: 'Waiter' },
]

// The staff picker's answer for either picker; the guest-order poll's answer is set per test (S809 3c).
// Plain functions, not jest.fn: CRA resets mock implementations before every test.
let mockGuestAnswer = { data: [], error: null }
// The staff picker's own answer when a test sets one (S841): a function, so a test can hand back a
// promise that never settles, or one that rejects. Null answers with STAFF.
let mockStaffCall = null
const mockRpcCalls = []
// pos-staff-login's answer and setSession's, set per test (S809 3h).
let mockSignInAnswer = { data: null, error: null }
let mockSetSessionAnswer = { data: {}, error: null }
const mockInvokeCalls = []
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      mockRpcCalls.push([name, args])
      if (name === 'get_pos_device_guest_alerts') return Promise.resolve(mockGuestAnswer)
      if (mockStaffCall) return mockStaffCall(args)
      return Promise.resolve({ data: [
        { id: 'p-ram', full_name: 'Ram', pos_job_title: 'Waiter' },
        { id: 'p-sita', full_name: 'Sita', pos_job_title: 'Waiter' },
      ], error: null })
    },
    functions: { invoke: (name, opts) => { mockInvokeCalls.push([name, opts]); return Promise.resolve(mockSignInAnswer) } },
    auth: { setSession: () => Promise.resolve(mockSetSessionAnswer) },
  },
}))
jest.mock('../../../context/ThemeContext', () => ({ useTheme: () => ({ colors: { bg: '#111111' } }) }))
// No session unless a test puts one there. `signOut` is created in beforeEach (CRA resets mocks).
let mockAuth = { session: null, ready: true, signOut: () => Promise.resolve(true) }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))

// eslint-disable-next-line import/first
import PosLogin from './PosLogin'

const renderPin = () => render(<MemoryRouter><PosLogin /></MemoryRouter>)

beforeEach(() => {
  mockAuth = { session: null, ready: true, signOut: jest.fn(() => Promise.resolve(true)) }
  mockGuestAnswer = { data: [], error: null }
  mockStaffCall = null
  mockRpcCalls.length = 0
  mockSignInAnswer = { data: null, error: null }
  mockSetSessionAnswer = { data: {}, error: null }
  mockInvokeCalls.length = 0
  localStorage.clear()
  localStorage.setItem('pos_device_client_id', 'c-1')
  localStorage.setItem('pos_device_secret', 'secret')
  localStorage.setItem('pos_device_id', 'd-1')
})

it('names what the lock kept, and for whom, before anyone picks a name', async () => {
  keepLockedCart({ profileId: 'p-ram', profileName: 'Ram', clientId: 'c-1', tableName: 'Table 5', items: [{ name: 'VEG MOMO', qty: 3 }], unsentUnits: 3 })
  renderPin()
  expect(await screen.findByRole('button', { name: new RegExp(STAFF[0].full_name) })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('Kept for Ram: 3 items not sent on Table 5. They come back when Ram signs in.')
})

it('tells the waiter it belongs to, and nobody else, on the PIN pad', async () => {
  keepLockedCart({ profileId: 'p-ram', profileName: 'Ram', clientId: 'c-1', tableName: 'Table 5', items: [{ name: 'VEG MOMO', qty: 1 }], unsentUnits: 1 })
  const { unmount } = renderPin()
  fireEvent.click(await screen.findByRole('button', { name: /Ram/ }))
  expect(screen.getByRole('status').textContent).toBe('Your 1 item not sent on Table 5 comes back when you sign in.')
  unmount()

  renderPin()
  fireEvent.click(await screen.findByRole('button', { name: /Sita/ }))
  expect(screen.queryByRole('status')).toBeNull()
})

it('says nothing about a cart kept on another outlet', async () => {
  keepLockedCart({ profileId: 'p-ram', profileName: 'Ram', clientId: 'c-2', tableName: 'Table 5', items: [{ name: 'VEG MOMO', qty: 3 }], unsentUnits: 3 })
  renderPin()
  expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})

describe('a login left signed in on the tablet (S809 ACCESS-1)', () => {
  it('is signed out on this tablet only, and no staff show until it is gone', async () => {
    let finish
    mockAuth.session = { user: { id: 'owner' } }
    mockAuth.signOut = jest.fn(() => new Promise(resolve => { finish = resolve }))
    const { rerender } = renderPin()
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalledTimes(1))
    expect(mockAuth.signOut).toHaveBeenCalledWith({ to: '/pos/login', scope: 'local' })
    expect(screen.getByRole('status').textContent).toMatch(/Signing out the login that was left open/)
    expect(screen.queryByRole('button', { name: /Ram/ })).toBeNull()

    // The sign-out lands: the session is gone and the staff come back.
    mockAuth = { ...mockAuth, session: null }
    await act(async () => { finish(true) })
    rerender(<MemoryRouter><PosLogin /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1)
  })

  it('waits for the auth state to settle before deciding', async () => {
    mockAuth.ready = false
    mockAuth.session = { user: { id: 'owner' } }
    renderPin()
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })

  it('leaves a tablet that was never activated alone', async () => {
    localStorage.removeItem('pos_device_client_id')
    localStorage.removeItem('pos_device_secret')
    mockAuth.session = { user: { id: 'owner' } }
    renderPin()
    expect(await screen.findByRole('heading', { level: 1, name: 'This device is not set up yet' })).toBeTruthy()
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })

  // S852: the steps in order, who can do them, and where to get help, not one run-on paragraph.
  it('says how to set the tablet up as numbered steps, who can do it, and who to ask', async () => {
    localStorage.removeItem('pos_device_client_id')
    localStorage.removeItem('pos_device_secret')
    renderPin()
    await screen.findByRole('heading', { level: 1, name: 'This device is not set up yet' })
    const steps = within(screen.getByRole('list')).getAllByRole('listitem').map(li => li.textContent)
    expect(steps).toEqual([
      'Sign in with the Owner account.',
      'Open POS → Admin → Till Devices and press Activate.',
      'Press Sign out and open the PIN screen. Your staff then show here.',
    ])
    expect(screen.getByText('Ask the Owner to do this. Staff PINs cannot set up a device.')).toBeTruthy()
    expect(screen.getByText(/Crest support:/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Owner Login' })).toBeTruthy()
  })

  it('signs nobody out when nobody is signed in', async () => {
    renderPin()
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })
})

// A locked till hears a guest's QR order (S809 3c, FLOOR-KITCHEN-1; owner decision Q14 1). This
// screen is every PIN till's resting state, and nothing announced a guest order here before.
describe('a guest order waiting while the till is locked', () => {
  const guestCalls = () => mockRpcCalls.filter(([name]) => name === 'get_pos_device_guest_alerts')

  it('is announced, asking through this tablet\'s own key', async () => {
    mockGuestAnswer = { data: [{ table_name: 'Table 7', waiting_since: new Date(Date.now() - 125000).toISOString() }], error: null }
    renderPin()
    expect(await screen.findByText('New guest order — Table 7')).toBeTruthy()
    expect(screen.getByText('Waiting 2 min. Nothing reaches the kitchen until a staff member signs in and accepts it.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mute 5 min' })).toBeTruthy()
    expect(guestCalls()[0][1]).toEqual({ p_client_id: 'c-1', p_device_id: 'd-1', p_device_secret: 'secret' })
  })

  it('counts several tables in one banner', async () => {
    const at = new Date(Date.now() - 30000).toISOString()
    mockGuestAnswer = { data: [{ table_name: 'Table 7', waiting_since: at }, { table_name: 'Table 3', waiting_since: at }], error: null }
    renderPin()
    expect(await screen.findByText('2 new guest orders — Table 7, Table 3')).toBeTruthy()
  })

  it('says nothing when nothing waits', async () => {
    renderPin()
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    await waitFor(() => expect(guestCalls().length).toBeGreaterThan(0))
    expect(screen.queryByText(/new guest order/i)).toBeNull()
  })

  it('says nothing on a tablet whose key was refused', async () => {
    mockGuestAnswer = { data: null, error: { message: 'pos_device_not_active', code: '28000' } }
    renderPin()
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    await waitFor(() => expect(guestCalls().length).toBeGreaterThan(0))
    expect(screen.queryByText(/new guest order/i)).toBeNull()
  })

  it('is not asked about on a tablet still on the restaurant\'s old shared key', async () => {
    localStorage.removeItem('pos_device_id')
    renderPin()
    expect(await screen.findByText('This till needs to be activated again by the Owner')).toBeTruthy()
    expect(guestCalls()).toEqual([])
  })
})

// S809 3h: the shared key's picker is gone; the sign-in's own answers.
describe('signing in', () => {
  const renderAt = () => render(
    <MemoryRouter initialEntries={['/pos/login']}>
      <Routes>
        <Route path="/pos/login" element={<PosLogin />} />
        <Route path="/pos/orders" element={<p>ORDERS</p>} />
      </Routes>
    </MemoryRouter>
  )
  const typePinAndLogin = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Ram/ }))
    for (const k of ['1', '2', '3', '4']) fireEvent.click(screen.getByRole('button', { name: k }))
    fireEvent.click(screen.getByRole('button', { name: /Login/ }))
  }
  const httpError = (status, body) => ({
    name: 'FunctionsHttpError',
    context: { status, json: () => Promise.resolve(body) },
  })

  it('a tablet holding only the old shared key asks nothing and says it needs activating again', async () => {
    localStorage.removeItem('pos_device_id')
    renderPin()
    expect(await screen.findByText('This till needs to be activated again by the Owner')).toBeTruthy()
    expect(mockRpcCalls.map(([name]) => name).filter(n => n !== 'get_pos_device_guest_alerts')).toEqual([])
  })

  it('sends this tablet\'s own key, and opens the till once the session is kept', async () => {
    mockSignInAnswer = { data: { access_token: 'a', refresh_token: 'r' }, error: null }
    renderAt()
    await typePinAndLogin()
    expect(await screen.findByText('ORDERS')).toBeTruthy()
    expect(mockInvokeCalls[0][0]).toBe('pos-staff-login')
    expect(mockInvokeCalls[0][1].body).toEqual({ client_id: 'c-1', device_id: 'd-1', device_secret: 'secret', staff_id: 'p-ram', pin: '1234' })
  })

  it('a right PIN whose session could not be kept stays on the PIN pad with the PIN, and says why (ACCESS-12)', async () => {
    mockSignInAnswer = { data: { access_token: 'a', refresh_token: 'r' }, error: null }
    mockSetSessionAnswer = { data: { session: null }, error: { message: 'Failed to fetch', status: 0 } }
    renderAt()
    await typePinAndLogin()
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't reach the server — check the connection")
    expect(screen.queryByText('ORDERS')).toBeNull()
    expect(screen.getByText('Enter PIN for Ram')).toBeTruthy()
    expect(screen.getByText('4 digits entered')).toBeTruthy()
  })

  it('a switched-off login gets its own answer, not "Incorrect PIN", and the list is read again', async () => {
    mockSignInAnswer = { data: null, error: httpError(403, { error: 'This login is switched off', switched_off: true }) }
    renderAt()
    await typePinAndLogin()
    expect((await screen.findByRole('alert')).textContent).toBe('This login is switched off. Ask a manager or the owner.')
    await waitFor(() => expect(mockRpcCalls.filter(([name]) => name === 'get_pos_device_staff').length).toBe(2))
  })

  it('a wrong PIN still reads as one', async () => {
    mockSignInAnswer = { data: null, error: httpError(401, { error: 'Invalid credentials', locked: false }) }
    renderAt()
    await typePinAndLogin()
    expect((await screen.findByRole('alert')).textContent).toBe('Incorrect PIN. Try again.')
  })

  // S842: the function's own words used to sit inside the headline ("Couldn't sign in (…)").
  it('an answer it does not recognise says so plainly, with the server\'s words only as fine print', async () => {
    mockSignInAnswer = { data: null, error: httpError(409, { error: 'staff_id does not belong to client_id' }) }
    renderAt()
    await typePinAndLogin()
    const alert = await screen.findByRole('alert')
    // An exact match: the headline holds the sentence and nothing of the server's.
    expect(within(alert).getByText("Couldn't sign in. Ask your manager.")).toBeTruthy()
    expect(within(alert).getByText('409 · staff_id does not belong to client_id')).toHaveClass('action-error-detail')
    expect(screen.getByText('4 digits entered')).toBeTruthy() // not a wrong PIN, so the PIN stays
  })
})

// S841: the staff list is every till's resting screen. A request that stalled, or rejected, left
// "Loading…" up for good, with no Try again and no way back but a reload.
describe('a staff list that does not come', () => {
  const UNREACHABLE = "Couldn't reach the server. Check this device's connection and try again."
  afterEach(() => jest.useRealTimers())

  it('gives up after 20 seconds with no answer, says why, and Try again asks once more', async () => {
    jest.useFakeTimers()
    mockStaffCall = () => new Promise(() => {})
    renderPin()
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(19000) })
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => { jest.advanceTimersByTime(1000) })
    expect((await screen.findByText(UNREACHABLE)).getAttribute('role')).toBe('alert')
    expect(screen.queryByText('Loading…')).toBeNull()

    mockStaffCall = null
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
  })

  it('a request that fails outright says the same, with Try again', async () => {
    mockStaffCall = () => Promise.reject(new TypeError('Failed to fetch'))
    renderPin()
    expect((await screen.findByText(UNREACHABLE)).getAttribute('role')).toBe('alert')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a refused device key still says the till needs activating again', async () => {
    mockStaffCall = () => Promise.resolve({ data: null, error: { message: 'pos_device_not_active', code: '28000' } })
    renderPin()
    expect(await screen.findByText('This till needs to be activated again by the Owner')).toBeTruthy()
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
  })

  it('an older answer never lands over a newer one', async () => {
    let answerFirst
    mockStaffCall = args => (args.p_device_id === 'd-1'
      ? new Promise(resolve => { answerFirst = resolve })
      : Promise.resolve({ data: [{ id: 'p-gita', full_name: 'Gita', pos_job_title: 'Cook' }], error: null }))
    const { rerender } = renderPin()
    await waitFor(() => expect(answerFirst).toBeDefined())

    localStorage.setItem('pos_device_id', 'd-2')
    rerender(<MemoryRouter><PosLogin /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: /Gita/ })).toBeTruthy()

    await act(async () => { answerFirst({ data: STAFF, error: null }) })
    expect(screen.queryByRole('button', { name: /Ram/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Gita/ })).toBeTruthy()
  })
})

// POS audit 2026-10-15. A tablet is the PIN screen's real device: the press and hover move from mouse
// events into posLogin.css, the two Back buttons wear the product's button, and the page clears an
// installed iPhone's status bar and home indicator.
describe('the PIN screen on a touch screen', () => {
  const css = fs.readFileSync(path.join(__dirname, 'posLogin.css'), 'utf8')
  const rule = sel => {
    const at = css.indexOf(`${sel} {`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
  }

  it('lights a staff tile and a PIN key from the stylesheet, never from mouse events', async () => {
    renderPin()
    const tile = await screen.findByRole('button', { name: /Ram/ })
    expect(tile.className).toBe('pos-staff-tile')
    expect(tile.getAttribute('style')).toBeNull()
    fireEvent.mouseEnter(tile)
    expect(tile.getAttribute('style')).toBeNull() // used to stay tinted after a tap: a touch sends no mouse-leave

    fireEvent.click(tile)
    const key = screen.getByRole('button', { name: '5' })
    expect(key.className).toBe('pos-pin-key')
    expect(screen.getByRole('button', { name: 'Clear PIN' }).className).toBe('pos-pin-key pos-pin-key--clear')
    expect(screen.getByRole('button', { name: 'Delete last digit' }).className).toBe('pos-pin-key pos-pin-key--delete')
    fireEvent.mouseEnter(key)
    fireEvent.mouseDown(key)
    expect(key.getAttribute('style')).toBeNull() // the scale and glow used to land only after the finger lifted
    fireEvent.click(key)
    expect(screen.getByText('1 digit entered')).toBeTruthy()
  })

  it('presses with :active, hovers only where a pointer can hover, and keeps the focus pair', () => {
    expect(rule('.pos-pin-key:active:not(:disabled)')).toMatch(/transform: scale\(0\.92\)/)
    const hover = css.slice(css.indexOf('@media (hover: hover)'))
    expect(hover).toMatch(/\.pos-staff-tile:hover/)
    expect(hover).toMatch(/\.pos-pin-key:hover:not\(:disabled\)/)
    expect(css.indexOf('.pos-staff-tile:hover')).toBeGreaterThan(css.indexOf('@media (hover: hover)'))
    const focus = css.slice(css.indexOf('.pos-staff-tile:focus-visible'))
    expect(focus).toMatch(/0 0 0 2px var\(--theme-focus-outline\), 0 0 0 5px var\(--theme-focus-ring\)/)
    const still = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(still).toMatch(/\.pos-pin-key:active:not\(:disabled\) {\s*transform: none;/)
  })

  it('clears the status bar and the home indicator, and the guest banner without adding the two', () => {
    const page = rule('.pos-login')
    expect(page).toMatch(/max\(var\(--arrival-alert-h, 0px\), env\(safe-area-inset-top, 0px\)\)/)
    expect(page).toMatch(/calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)/)
  })

  it('puts the page on the stylesheet, and the outlet name on the type scale', async () => {
    renderPin()
    await screen.findByRole('button', { name: /Ram/ })
    const main = screen.getByRole('main')
    expect(main.className).toBe('pos-login')
    expect(main.getAttribute('style')).toBeNull() // an inline padding would beat the safe-area rule
    expect(screen.getByRole('heading', { level: 1 }).style.fontSize).toBe('24px')
  })

  it('gives both Back buttons the product\'s ghost button', async () => {
    renderPin()
    const ram = await screen.findByRole('button', { name: /Ram/ })
    const back = screen.getByRole('button', { name: '← Back' })
    expect(back.className).toBe('btn btn-ghost')
    expect(back.getAttribute('style')).toBeNull()
    fireEvent.click(ram)
    const padBack = screen.getByRole('button', { name: '← Back' })
    expect(padBack.className).toBe('btn btn-ghost')
    expect(padBack.style.background).toBe('') // colour, border and radius come from the classes
    expect(padBack.style.border).toBe('')
  })
})
