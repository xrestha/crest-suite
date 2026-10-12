/**
 * POS Setup → Guest Menu (S767). The name and logo are the Owner's (owner decision, fenced by the
 * settings guard); the section order is the Recipe Categories list and any POS manager may move it.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let mockData = {}
let mockWrites = []
let mockAuth = { isAdmin: false, isOwner: true }
// S814 (GUEST-8): what a settings update answers, and what the read-back after it finds.
let mockUpdateResult = null
let mockReadback // undefined: no read-back configured; 'wanted': the logo the update sent; else a value
let mockRemoves = []

const SUPABASE = 'https://x.supabase.co'
const publicUrlOf = path => `${SUPABASE}/storage/v1/object/public/dish-photos/${path}`
const OLD_LOGO = `${publicUrlOf('c1/guest-menu-logo-1.png')}?v=1`

function lastWrittenLogo() {
  const w = [...mockWrites].reverse().find(x => x.patch && 'guest_menu_logo_url' in x.patch)
  return w ? w.patch.guest_menu_logo_url : null
}

function mockBuilder(table) {
  const b = { _table: table, _op: 'select' }
  for (const op of ['select', 'eq', 'order', 'or', 'gt', 'range']) b[op] = () => b
  b.maybeSingle = () => b
  b.update = patch => { mockWrites.push({ table, op: 'update', patch }); b._op = 'update'; return b }
  b.insert = row => { mockWrites.push({ table, op: 'insert', row }); b._op = 'insert'; return b }
  b.then = (resolve, reject) => {
    let res
    if (b._op === 'select') {
      if (table === 'settings' && mockReadback !== undefined && mockWrites.length > 0) {
        res = { data: { id: 's1', guest_menu_logo_url: mockReadback === 'wanted' ? lastWrittenLogo() : mockReadback }, error: null }
      } else {
        res = { data: mockData[table] ?? null, error: null }
      }
    } else {
      res = mockUpdateResult || { data: [{ id: 's1' }], error: null }
    }
    return Promise.resolve(res).then(resolve, reject)
  }
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: {}, error: null }),
        getPublicUrl: path => ({ data: { publicUrl: publicUrlOf(path) } }),
        remove: paths => { mockRemoves.push(paths); return Promise.resolve({ data: [], error: null }) },
      }),
    },
  },
}))
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../../context/SettingsContext', () => ({ DEFAULT_RECIPE_CATS: ['Food', 'Beverage', 'Dessert', 'Snack', 'Other'] }))

// eslint-disable-next-line import/first
import GuestMenuSetup from './GuestMenuSetup'

const realSupabaseUrl = process.env.REACT_APP_SUPABASE_URL
beforeEach(() => {
  mockWrites = []
  mockUpdateResult = null
  mockReadback = undefined
  mockRemoves = []
  process.env.REACT_APP_SUPABASE_URL = SUPABASE
  mockData = {
    settings: { id: 's1', guest_menu_name: null, guest_menu_logo_url: null, recipe_categories: null },
    clients: { name: 'BHATTI CHOILA' },
    recipes: [{ id: 'r1', category: 'Beverage' }, { id: 'r2', category: 'Food' }, { id: 'r3', category: 'Snack' }],
  }
})
afterAll(() => { process.env.REACT_APP_SUPABASE_URL = realSupabaseUrl })

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

// ── S814 (GUEST-8): a logo save whose answer is lost is read back, never assumed to have failed ──

async function uploadLogo(buttonName) {
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  await screen.findByRole('button', { name: buttonName })
  // The file input is hidden behind its button; its label is the field's "Logo".
  fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } })
}

test('a logo save whose answer was lost but which landed says so, and deletes nothing', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  mockUpdateResult = { data: null, error: { message: 'TypeError: Failed to fetch' } }
  mockReadback = 'wanted'
  await uploadLogo('Upload logo')
  expect(await screen.findByText('Saved. The connection was slow, but guests now see this logo.')).toBeInTheDocument()
  expect(mockRemoves).toEqual([])
})

test('a lost answer that landed over an old logo deletes only the old file', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  mockData.settings.guest_menu_logo_url = OLD_LOGO
  mockUpdateResult = { data: null, error: { message: 'TypeError: Failed to fetch' } }
  mockReadback = 'wanted'
  await uploadLogo('Replace logo')
  expect(await screen.findByText('Saved. The connection was slow, but guests now see this logo.')).toBeInTheDocument()
  await waitFor(() => expect(mockRemoves).toEqual([['c1/guest-menu-logo-1.png']]))
})

test('a lost answer that has not landed yet keeps both files and says the save may still go through', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  mockData.settings.guest_menu_logo_url = OLD_LOGO
  mockUpdateResult = { data: null, error: { message: 'TypeError: Failed to fetch' } }
  mockReadback = OLD_LOGO
  await uploadLogo('Replace logo')
  expect(await screen.findByText('The logo uploaded, but saving it to the menu did not answer in time. When this page checked, guests still saw the previous logo — the save may still go through. Reload this page in a minute before uploading it again.')).toBeInTheDocument()
  expect(mockRemoves).toEqual([])
  expect(screen.queryByText(/Saved\./)).toBeNull()
})

test('a refused logo save still removes the new file and keeps its sentence', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  mockUpdateResult = { data: null, error: { code: '42501', message: 'guest_menu_brand_rank' } }
  await uploadLogo('Upload logo')
  expect(await screen.findByText(/^The logo uploaded, but the menu could not be updated, so guests still see the previous one\./)).toBeInTheDocument()
  expect(mockRemoves).toHaveLength(1)
  expect(mockRemoves[0][0]).toMatch(/^c1\/guest-menu-logo-\d+\.png$/)
})

test('a name save with no answer says it may not have saved, never that it did not', async () => {
  mockAuth = { isAdmin: false, isOwner: true }
  mockUpdateResult = { data: null, error: { message: 'TypeError: Failed to fetch' } }
  render(<GuestMenuSetup clientId="c1" tables={[]} />)
  fireEvent.change(await screen.findByLabelText(/Restaurant name on the menu/), { target: { value: 'Thamel' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  expect(await screen.findByText(/^The name may not have saved: the answer did not arrive\./)).toBeInTheDocument()
  expect(screen.queryByText(/was not saved/)).toBeNull()
})
