/**
 * POS Setup (S842): the dialogs are named and fit a phone, a Save says what happened in a way a
 * screen reader hears, a refused HSC code goes back to the stored one under its own row, and the
 * small × buttons say what they remove.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

let mockData = {}
let mockWrites = []
let mockWriteResult = {}
let mockReadError = {}

function mockBuilder(table) {
  const b = { _op: 'select', _single: false }
  for (const op of ['eq', 'neq', 'order', 'or', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'range', 'abortSignal']) b[op] = () => b
  b.select = () => b
  b.maybeSingle = () => { b._single = true; return b }
  b.single = () => { b._single = true; return b }
  b.update = patch => { b._op = 'update'; b._write = { table, op: 'update', patch }; mockWrites.push(b._write); return b }
  b.insert = row => { b._op = 'insert'; b._write = { table, op: 'insert', row }; mockWrites.push(b._write); return b }
  b.then = (resolve, reject) => {
    let res
    if (b._op === 'select' && mockReadError[table]) {
      res = { data: null, error: mockReadError[table] }
    } else if (b._op === 'select') {
      const d = mockData[table]
      res = { data: b._single ? (Array.isArray(d) ? d[0] ?? null : d ?? null) : (d ?? []), error: null }
    } else {
      res = mockWriteResult[table] || { data: [{ id: 'w1' }], error: null }
    }
    return Promise.resolve(res).then(resolve, reject)
  }
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: { from: table => mockBuilder(table), rpc: () => Promise.resolve({ data: null, error: null }) },
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', hasPosAccess: () => true, hasWeather: false }),
}))
jest.mock('qrcode', () => ({ toDataURL: () => Promise.resolve('data:image/png;base64,AAAA') }))
jest.mock('./GuestMenuSetup', () => () => null)
jest.mock('../printing/PosPrintersPanel', () => () => null)
jest.mock('../../dashboard/WeatherCityPicker', () => () => null)

// eslint-disable-next-line import/first
import PosTableManagement from './PosTableManagement'

// Structure the roles cannot express: which grid a field sits in, which row a message sits under.
const find = (el, selector) => el.querySelector(selector) // eslint-disable-line testing-library/no-node-access
const parentOf = el => el.parentElement // eslint-disable-line testing-library/no-node-access

const TABLE = { id: 't1', name: 'Table 1', section: null, capacity: 4, status: 'available', sort_order: 1 }
const REFUSED = { data: null, error: { message: 'permission denied for table', code: '42501' } }

beforeEach(() => {
  mockWrites = []
  mockWriteResult = {}
  mockReadError = {}
  mockData = { pos_tables: [TABLE], settings: { id: 's1' }, recipes: [] }
})

async function openSection(name) {
  render(<PosTableManagement />)
  await screen.findByRole('button', { name: 'Table 1' })
  fireEvent.click(screen.getByRole('tab', { name }))
}

describe('Quick Setup', () => {
  test('opens by itself on an empty floor, named by its title, its fields on .field-grid', async () => {
    mockData.pos_tables = []
    render(<PosTableManagement />)
    const dialog = await screen.findByRole('dialog', { name: 'Quick Setup' })
    expect(within(dialog).getAllByRole('heading')).toHaveLength(1)
    expect(dialog.style.maxWidth).toBe('520px')
    const grid = find(dialog, '.field-grid')
    for (const label of [/^Prefix/, /^Start #/, /^Count/, /^Section/, /^Seats/]) {
      expect(grid).toContainElement(within(dialog).getByLabelText(label))
    }
    // The five-track inline row is gone: nothing in the dialog pins a track list.
    expect(find(dialog, '[style*="grid-template-columns"]')).toBeNull()
  })

  test('a failed Generate is an alert naming what did not happen; a good one is a status', async () => {
    mockData.pos_tables = []
    render(<PosTableManagement />)
    const dialog = await screen.findByRole('dialog', { name: 'Quick Setup' })
    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent('')

    mockWriteResult.pos_tables = REFUSED
    fireEvent.click(within(dialog).getByRole('button', { name: /Generate 10 Tables/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^No tables were created\./)

    mockWriteResult.pos_tables = { data: [{ id: 'n1' }], error: null }
    fireEvent.click(within(dialog).getByRole('button', { name: /Generate 10 Tables/ }))
    await waitFor(() => expect(status).toHaveTextContent('Created 10 tables.'))
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })
})

describe('the other two dialogs are named by their titles', () => {
  test('Edit and the guest menu QR', async () => {
    render(<PosTableManagement />)
    fireEvent.click(await screen.findByRole('button', { name: 'Table 1' }))
    let dialog = screen.getByRole('dialog', { name: 'Edit — Table 1' })
    expect(within(dialog).getAllByRole('heading')).toHaveLength(1)
    expect(dialog.style.maxWidth).toBe('480px')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: /QR/ }))
    dialog = await screen.findByRole('dialog', { name: 'Table 1 — Guest Menu QR' })
    expect(within(dialog).getAllByRole('heading')).toHaveLength(1)
    expect(dialog.style.maxWidth).toBe('480px')
  })
})

describe('Ticket Routing Save', () => {
  test('a refusal is an alert with the consequence and the detail; a save is a status', async () => {
    mockData.recipes = [{ category: 'Food' }, { category: 'Beverage' }]
    mockData.settings = { id: 's1', pos_bot_categories: ['Beverage'] }
    await openSection('Ticket Routing')
    const save = await screen.findByRole('button', { name: 'Save Routing' })

    mockWriteResult.settings = REFUSED
    fireEvent.click(save)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^The ticket routing was not saved — kitchen and bar still print as before\./)
    expect(within(alert).getByText(/42501/)).toHaveClass('action-error-detail')

    mockWriteResult.settings = { data: [{ id: 's1' }], error: null }
    fireEvent.click(save)
    await waitFor(() => expect(screen.getByText('Routing saved.')).toHaveAttribute('role', 'status'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('HSC codes', () => {
  const COKE = { id: 'r1', name: 'Coke', category: 'Beverage', hsc_code: null }
  const MOMO = { id: 'r2', name: 'Momo', category: 'Food', hsc_code: '1902' }
  const boxFor = name => screen.getByRole('textbox', { name: `HSC code for ${name}` })
  const rowOf = box => parentOf(parentOf(box))
  function enter(box, value) {
    fireEvent.change(box, { target: { value } })
    fireEvent.blur(box)
  }

  beforeEach(() => { mockData.recipes = [COKE, MOMO] })

  test('a refused code goes back to the stored one, with the reason under that dish', async () => {
    await openSection('HSC Codes')
    await screen.findByRole('textbox', { name: 'HSC code for Coke' })
    mockWriteResult.recipes = REFUSED
    enter(boxFor('Coke'), '2202')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^The HSC code for Coke was not saved — bills still print "none"\./)
    expect(boxFor('Coke')).toHaveValue('')
    expect(rowOf(boxFor('Coke'))).toContainElement(alert)
    expect(rowOf(boxFor('Momo'))).not.toContainElement(alert)
    expect(boxFor('Coke')).toHaveAttribute('aria-describedby', parentOf(alert).id)
  })

  test('a write that lands says Saved under the dish, and clears its earlier refusal', async () => {
    await openSection('HSC Codes')
    await screen.findByRole('textbox', { name: 'HSC code for Coke' })
    mockWriteResult.recipes = REFUSED
    enter(boxFor('Coke'), '2202')
    await screen.findByRole('alert')

    mockWriteResult.recipes = { data: [{ id: 'r1' }], error: null }
    enter(boxFor('Coke'), '2202')
    const row = rowOf(boxFor('Coke'))
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Saved'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(boxFor('Coke')).toHaveValue('2202')
    expect(within(rowOf(boxFor('Momo'))).getByRole('status')).toHaveTextContent('')
    expect(mockWrites.filter(w => w.table === 'recipes').pop().patch).toEqual({ hsc_code: '2202' })
  })

  test('a write that changed no row is not called saved', async () => {
    await openSection('HSC Codes')
    await screen.findByRole('textbox', { name: 'HSC code for Momo' })
    mockWriteResult.recipes = { data: [], error: null }
    enter(boxFor('Momo'), '2203')
    expect(await screen.findByRole('alert')).toHaveTextContent(/^The HSC code for Momo was not saved — bills still print "1902"\./)
    expect(boxFor('Momo')).toHaveValue('1902')
  })

  test('no answer is not called a refusal: the box keeps what was typed', async () => {
    await openSection('HSC Codes')
    await screen.findByRole('textbox', { name: 'HSC code for Coke' })
    mockWriteResult.recipes = { data: null, error: { message: 'TypeError: Failed to fetch' } }
    enter(boxFor('Coke'), '2202')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/it is not known whether the HSC code for Coke was saved/)
    expect(alert).not.toHaveTextContent(/was not saved/)
    expect(boxFor('Coke')).toHaveValue('2202')
  })
})

describe('the × buttons say what they remove', () => {
  test('quick notes', async () => {
    mockData.settings = { id: 's1', pos_note_presets: ['No onion', 'Extra spicy'] }
    await openSection('Quick Notes')
    const rm = await screen.findByRole('button', { name: 'Remove No onion' })
    expect(rm).toHaveClass('btn', 'btn-ghost', 'btn-icon', 'btn-icon--delete')
    expect(rm).toHaveAttribute('title', 'Remove No onion')
    fireEvent.click(rm)
    expect(screen.queryByRole('button', { name: 'Remove No onion' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Extra spicy' })).toBeInTheDocument()
  })

  test('discount reasons and delivery partners', async () => {
    mockData.settings = {
      id: 's1',
      pos_discount_reasons: ['Loyalty customer'],
      pos_delivery_partners: [{ name: 'Foodmandu', commission_pct: 20, phone: '9800000001' }],
    }
    await openSection('Discounts')
    expect(await screen.findByRole('button', { name: 'Remove Loyalty customer' })).toHaveClass('btn-icon')
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery Partners' }))
    expect(await screen.findByRole('button', { name: 'Remove Foodmandu' })).toHaveClass('btn-icon--delete')
  })

})

test('a list tab whose read failed says so under its disabled Save', async () => {
  mockReadError.settings = { message: 'TypeError: Failed to fetch' }
  await openSection('Quick Notes')
  const save = await screen.findByRole('button', { name: 'Save Quick Notes' })
  expect(save).toBeDisabled()
  expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not load the quick notes — Save is disabled until it loads\./)
})
