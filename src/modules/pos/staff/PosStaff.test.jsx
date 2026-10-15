/**
 * POS Staff (S842): each row's controls name the person they change, and a refusal about one login
 * is shown under that login's row, where the press was, rather than at the top of the page.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const STAFF = [
  { id: 'u1', full_name: 'Ravi', pos_role: 'staff', pos_job_title: 'Staff', pos_team: 'foh', pos_discount_limit: 0, pos_allow_void: false, last_seen_at: null },
  { id: 'u2', full_name: 'Sita', pos_role: 'staff', pos_job_title: 'Staff', pos_team: 'foh', pos_discount_limit: null, pos_allow_void: false, last_seen_at: null },
]
let mockInvokeResult = { data: { ok: true }, error: null }
let mockInvokes = []

function mockBuilder() {
  const b = {}
  for (const op of ['select', 'eq', 'order', 'in', 'maybeSingle', 'update', 'insert']) b[op] = () => b
  b.then = (resolve, reject) => Promise.resolve({ data: { id: 's1', pos_custom_roles: [] }, error: null }).then(resolve, reject)
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: () => mockBuilder(),
    rpc: name => Promise.resolve(name === 'get_pos_staff_list' ? { data: STAFF, error: null } : { data: [], error: null }),
    functions: { invoke: (fn, opts) => { mockInvokes.push(opts.body); return Promise.resolve(mockInvokeResult) } },
  },
}))
// A POS manager capped at a 10% discount, who cannot void: Sita's unlimited discount is beyond them.
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', hasPosAccess: () => true, hrEnabled: false, isAdmin: false, isOwner: false,
    profile: { id: 'm1', pos_role: 'manager', pos_discount_limit: 10, pos_allow_void: false },
  }),
}))

// eslint-disable-next-line import/first
import PosStaff from './PosStaff'

beforeEach(() => {
  mockInvokeResult = { data: { ok: true }, error: null }
  mockInvokes = []
})

const rowOf = name => screen.getByText(name).closest('tr') // eslint-disable-line testing-library/no-node-access
// The table row a message row sits under.
const rowAbove = el => el.closest('tr').previousElementSibling // eslint-disable-line testing-library/no-node-access

test("each row's controls are named for the person they change", async () => {
  render(<PosStaff />)
  await screen.findByText('Ravi')
  for (const name of ['Ravi', 'Sita']) {
    expect(screen.getByRole('combobox', { name: `POS role for ${name}` })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: `POS team for ${name}` })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: `Discount limit percent for ${name}` })).toBeInTheDocument()
  }
})

test("a press refused before any call says why under that login's row", async () => {
  render(<PosStaff />)
  await screen.findByText('Sita')
  fireEvent.click(within(rowOf('Sita')).getByRole('button', { name: 'Delete' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Sita can give bigger discounts than your login can')
  expect(rowAbove(alert)).toBe(rowOf('Sita'))
  expect(mockInvokes).toHaveLength(0)
})

test("a server refusal goes under its row, and the next action clears it", async () => {
  render(<PosStaff />)
  await screen.findByText('Ravi')
  mockInvokeResult = { data: { error: 'This login cannot be moved to the kitchen.' }, error: null }
  fireEvent.change(screen.getByRole('combobox', { name: 'POS team for Ravi' }), { target: { value: 'kitchen' } })

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('The team was not changed. This login cannot be moved to the kitchen.')
  expect(rowAbove(alert)).toBe(rowOf('Ravi'))

  mockInvokeResult = { data: { ok: true }, error: null }
  fireEvent.change(screen.getByRole('combobox', { name: 'POS team for Sita' }), { target: { value: 'bar' } })
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

test('the header action group can wrap on a phone (no flexShrink: 0)', async () => {
  render(<PosStaff />)
  const search = await screen.findByRole('textbox', { name: 'Search staff' })
  const group = search.parentElement // eslint-disable-line testing-library/no-node-access
  expect(group.parentElement).toHaveClass('page-header--split') // eslint-disable-line testing-library/no-node-access
  expect(group.style.flexShrink).toBe('')
  expect(group.style.flexWrap).toBe('wrap')
})
