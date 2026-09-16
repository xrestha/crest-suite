/**
 * POS Setup → Guest Menu (S767). The name and logo are the Owner's (owner decision, fenced by the
 * settings guard); the section order is the Recipe Categories list and any POS manager may move it.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let mockData = {}
let mockWrites = []
let mockAuth = { isAdmin: false, isOwner: true }

function mockBuilder(table) {
  const b = { _table: table, _op: 'select' }
  for (const op of ['select', 'eq', 'order', 'or', 'gt', 'range']) b[op] = () => b
  b.maybeSingle = () => b
  b.update = patch => { mockWrites.push({ table, op: 'update', patch }); b._op = 'update'; return b }
  b.insert = row => { mockWrites.push({ table, op: 'insert', row }); b._op = 'insert'; return b }
  b.then = (resolve, reject) => {
    const data = b._op === 'select' ? (mockData[table] ?? null) : [{ id: 's1' }]
    return Promise.resolve({ data, error: null }).then(resolve, reject)
  }
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: { from: table => mockBuilder(table), storage: { from: () => ({}) } },
}))
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../../context/SettingsContext', () => ({ DEFAULT_RECIPE_CATS: ['Food', 'Beverage', 'Dessert', 'Snack', 'Other'] }))

// eslint-disable-next-line import/first
import GuestMenuSetup from './GuestMenuSetup'

beforeEach(() => {
  mockWrites = []
  mockData = {
    settings: { id: 's1', guest_menu_name: null, guest_menu_logo_url: null, recipe_categories: null },
    clients: { name: 'BHATTI CHOILA' },
    recipes: [{ id: 'r1', category: 'Beverage' }, { id: 'r2', category: 'Food' }, { id: 'r3', category: 'Snack' }],
  }
})

test('shows the tidied account name as what guests see until the owner sets one', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  const input = await screen.findByLabelText(/Restaurant name on the menu/)
  expect(input).toHaveAttribute('placeholder', 'Bhatti Choila')
  expect(screen.getByText(/Guests see “Bhatti Choila”/)).toBeInTheDocument()
})

test('the owner saves the name as a patch of that one column', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  fireEvent.change(await screen.findByLabelText(/Restaurant name on the menu/), { target: { value: '  Bhatti Choila Thamel ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await waitFor(() => expect(mockWrites).toEqual([{ table: 'settings', op: 'update', patch: { guest_menu_name: 'Bhatti Choila Thamel' } }]))
})

test('a POS manager sees the name and logo read-only, and can still order the sections', async () => {
  mockAuth = { isAdmin: false, isOwner: false }
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  expect(await screen.findByText(/Only the account owner can change the restaurant name and logo/)).toBeInTheDocument()
  expect(screen.getByLabelText(/Restaurant name on the menu/)).toBeDisabled()
  expect(screen.queryByRole('button', { name: /Upload logo/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Move Food down/ })).toBeInTheDocument()
})

test('sections follow the default list, and moving one writes the whole list with the rest kept in place', async () => {
  mockAuth = { isAdmin: false, isOwner: false }
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  const rows = await screen.findAllByRole('listitem')
  expect(rows.map(r => r.textContent.replace(/^\d+/, ''))).toEqual(['Food', 'Beverage', 'Snack'])
  fireEvent.click(screen.getByRole('button', { name: /Move Snack up/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Save section order' }))
  await waitFor(() => expect(mockWrites).toEqual([
    { table: 'settings', op: 'update', patch: { recipe_categories: ['Food', 'Snack', 'Dessert', 'Beverage', 'Other'] } },
  ]))
})
