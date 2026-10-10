/**
 * The PIN screen says what a till lock kept (S776). The lock happens while nobody is looking, so this
 * is the screen the waiter comes back to — and a different waiter must see that it is not theirs.
 *
 * And it never sits on top of a live login (S809 ACCESS-1): on an activated tablet it signs out any
 * session it finds, on this tablet only, before it shows a single name.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { keepLockedCart } from '../posLockedCart'

const STAFF = [
  { id: 'p-ram', full_name: 'Ram', pos_job_title: 'Waiter' },
  { id: 'p-sita', full_name: 'Sita', pos_job_title: 'Waiter' },
]

// The staff picker's answer for either picker; the guest-order poll's answer is set per test (S809 3c).
// Plain functions, not jest.fn: CRA resets mock implementations before every test.
let mockGuestAnswer = { data: [], error: null }
const mockRpcCalls = []
jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: (name, args) => {
    mockRpcCalls.push([name, args])
    if (name === 'get_pos_device_guest_alerts') return Promise.resolve(mockGuestAnswer)
    return Promise.resolve({ data: [
      { id: 'p-ram', full_name: 'Ram', pos_job_title: 'Waiter' },
      { id: 'p-sita', full_name: 'Sita', pos_job_title: 'Waiter' },
    ], error: null })
  } },
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
  mockRpcCalls.length = 0
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
    expect(await screen.findByText(/isn't set up yet/)).toBeTruthy()
    expect(mockAuth.signOut).not.toHaveBeenCalled()
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
    expect(await screen.findByRole('button', { name: /Ram/ })).toBeTruthy()
    expect(guestCalls()).toEqual([])
  })
})
