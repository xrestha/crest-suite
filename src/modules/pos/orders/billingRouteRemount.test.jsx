/**
 * /pos/orders and /pos/billing render the same PosOrders, which picks its starting view once, in
 * useState. With no key React kept the one instance across a switch between the two routes, and the
 * view with it: a Staff PIN typing /pos/billing was redirected to /pos/orders by the page's own guard
 * and still saw the bills list there (S856, found on a real phone; a refresh showed the order screen).
 * Each route's PosOrders carries its own key, so a switch mounts a fresh one.
 */

import fs from 'fs'
import path from 'path'
import React, { useState } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'

// The page's shape in miniature: the view starts from the prop, and Billing sends a waiter to Orders.
function Screen({ billingStation = false, canBill }) {
  const [view] = useState(billingStation ? 'bills' : 'floor')
  if (billingStation && !canBill) return <Navigate to="/pos/orders" replace />
  return <p>{view === 'bills' ? 'BILLS LIST' : 'ORDER SCREEN'}</p>
}

const renderRoutes = (keyed) => render(
  <MemoryRouter initialEntries={['/pos/billing']}>
    <Routes>
      <Route path="/pos/orders" element={keyed ? <Screen key="orders" canBill={false} /> : <Screen canBill={false} />} />
      <Route path="/pos/billing" element={keyed ? <Screen key="billing" billingStation canBill={false} /> : <Screen billingStation canBill={false} />} />
    </Routes>
  </MemoryRouter>
)

it('without keys the redirected waiter keeps the bills view (the defect)', () => {
  renderRoutes(false)
  expect(screen.getByText('BILLS LIST')).toBeTruthy()
})

it('with a key per route the waiter lands on the order screen', () => {
  renderRoutes(true)
  expect(screen.getByText('ORDER SCREEN')).toBeTruthy()
})

it('App.js gives the two PosOrders routes their own keys', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'App.js'), 'utf8')
  expect(app).toMatch(/path="\/pos\/orders" element=\{[^\n]*<PosOrders key="orders" \/>/)
  expect(app).toMatch(/path="\/pos\/billing" element=\{[^\n]*<PosOrders key="billing" billingStation \/>/)
})
