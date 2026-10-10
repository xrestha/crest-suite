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
