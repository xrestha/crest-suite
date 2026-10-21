/**
 * Where a signed-out visitor is sent (S809 ACCESS-7). On an activated till a session can end by itself
 * (its tablet revoked, the login blocked, a refused refresh), and that till goes back to its own PIN
 * screen, never to the owner's email login.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

let mockAuth = {}
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('./SubscriptionLock', () => () => null)
jest.mock('./LegalReacceptance', () => () => null)

// eslint-disable-next-line import/first
import ProtectedRoute from './ProtectedRoute'

const renderAt = () => render(
  <MemoryRouter initialEntries={['/pos/orders']}>
    <Routes>
      <Route path="/pos/orders" element={<ProtectedRoute><p>ORDERS</p></ProtectedRoute>} />
      <Route path="/pos/login" element={<p>PIN SCREEN</p>} />
      <Route path="/ims/count" element={<p>COUNT PIN SCREEN</p>} />
      <Route path="/login" element={<p>EMAIL LOGIN</p>} />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => {
  localStorage.clear()
  mockAuth = { session: null, profile: null, ready: true, loading: false }
})

it('an activated till whose session ended goes back to its PIN screen', () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  renderAt()
  expect(screen.getByText('PIN SCREEN')).toBeTruthy()
})

it('any other device goes to the email login, as before', () => {
  renderAt()
  expect(screen.getByText('EMAIL LOGIN')).toBeTruthy()
})

it('a signed-in session is let through', () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  mockAuth = { session: { user: { id: 'u-1' } }, profile: { id: 'u-1', role: 'client', pos_role: 'staff' }, ready: true, loading: false }
  renderAt()
  expect(screen.getByText('ORDERS')).toBeTruthy()
})

// S833 (S809.4): a session whose profile could not be read is no signed-in user either. On an
// activated till it goes to the PIN screen (which signs it out), never to the owner's email login.
it('a profile-less session on an activated till goes to its PIN screen', () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  mockAuth = { session: { user: { id: 'u-1' } }, profile: null, ready: true, loading: false }
  renderAt()
  expect(screen.getByText('PIN SCREEN')).toBeTruthy()
})

// S856, found on a real storeroom phone: the count tablet's idle lock asked for /ims/count, and this
// guard's own redirect to /login landed after it. A counting device goes back to its PIN screen.
it('a counting device whose session ended goes back to its PIN screen', () => {
  localStorage.setItem('ims_count_client_id', 'c-1')
  renderAt()
  expect(screen.getByText('COUNT PIN SCREEN')).toBeTruthy()
})

it('a till that is also set up for counting stays a till', () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  localStorage.setItem('ims_count_client_id', 'c-1')
  renderAt()
  expect(screen.getByText('PIN SCREEN')).toBeTruthy()
})

it('a profile-less session anywhere else goes to the email login, as before', () => {
  mockAuth = { session: { user: { id: 'u-1' } }, profile: null, ready: true, loading: false }
  renderAt()
  expect(screen.getByText('EMAIL LOGIN')).toBeTruthy()
})
