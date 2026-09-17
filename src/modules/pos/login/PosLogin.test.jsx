/**
 * The PIN screen says what a till lock kept (S776). The lock happens while nobody is looking, so this
 * is the screen the waiter comes back to — and a different waiter must see that it is not theirs.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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

// eslint-disable-next-line import/first
import PosLogin from './PosLogin'

const renderPin = () => render(<MemoryRouter><PosLogin /></MemoryRouter>)

beforeEach(() => {
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
