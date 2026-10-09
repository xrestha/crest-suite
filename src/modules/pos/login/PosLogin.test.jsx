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

jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: () => Promise.resolve({ data: [
    { id: 'p-ram', full_name: 'Ram', pos_job_title: 'Waiter' },
    { id: 'p-sita', full_name: 'Sita', pos_job_title: 'Waiter' },
  ], error: null }) },
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
