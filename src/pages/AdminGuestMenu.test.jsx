/**
 * Admin → Guest Menu — the S746 re-analysis. The preview frame cannot say WHY a guest menu looks
 * the way it does, so this page states it: POS switched off (no menu at all), dishes left off for
 * having no price, and a table marked inactive (menu, no ordering). Inactive tables used to be
 * filtered out of the list, which hid the one case worth previewing.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

let mockData = {}

function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'order', 'or']) b[op] = () => b
  b.single = () => b
  b.then = (resolve, reject) => Promise.resolve({ data: mockData[table], error: null }).then(resolve, reject)
  return b
}

jest.mock('../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table) } }))
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ adminViewClientId: 'c1' }) }))

// eslint-disable-next-line import/first
import AdminGuestMenu from './AdminGuestMenu'

const renderPage = () => render(<MemoryRouter><AdminGuestMenu /></MemoryRouter>)

test('POS switched off says so instead of previewing an unavailable menu', async () => {
  mockData = {
    clients: { name: 'Casa Acai', pos_enabled: false },
    pos_tables: [{ id: 't1', name: 'T1', status: 'available' }],
    recipes: [{ id: 'r1', selling_price: 300 }],
  }
  renderPage()
  expect(await screen.findByText(/Crest POS is switched off for Casa Acai/)).toBeInTheDocument()
  expect(screen.queryByTitle(/Guest menu preview/)).toBeNull()
})

test('inactive tables stay listed, and selecting one explains that ordering is off', async () => {
  mockData = {
    clients: { name: 'Casa Acai', pos_enabled: true },
    pos_tables: [{ id: 't1', name: 'Patio 1', status: 'inactive' }],
    recipes: [{ id: 'r1', selling_price: 300, image_url: 'x', description: 'y', is_veg: true }],
  }
  renderPage()
  expect(await screen.findByRole('option', { name: 'Patio 1 (inactive)' })).toBeInTheDocument()
  expect(screen.getByText(/Patio 1 is marked inactive/)).toBeInTheDocument()
})

test('dishes with no selling price are counted as left off, and an all-unpriced menu is called empty', async () => {
  mockData = {
    clients: { name: 'Casa Acai', pos_enabled: true },
    pos_tables: [{ id: 't1', name: 'T1', status: null }],
    recipes: [{ id: 'r1', selling_price: null }, { id: 'r2', selling_price: 0 }],
  }
  renderPage()
  expect(await screen.findByText(/Guests see no menu at all/)).toBeInTheDocument()
  expect(screen.getByText(/2 dishes are switched on for POS but have no selling price/)).toBeInTheDocument()
})
