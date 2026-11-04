/**
 * IMS Staff (S875, owner decision 2026-11-04, "Block, keep the name"): a leaver's login is blocked,
 * not deleted, as POS Staff does for till logins (S809 3i). Delete is only for a login that recorded
 * nothing; the server refuses the rest (staff_login_has_records) and the page offers Block instead.
 */

import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'

const STAFF = [
  { id: 'me', full_name: 'Maya', email: 'maya@example.com', ims_role: 'manager', ims_job_title: 'Manager', last_seen_at: null },
  { id: 'u1', full_name: 'Ravi', email: 'ravi@example.com', ims_role: 'staff', ims_job_title: 'Staff', last_seen_at: null },
  { id: 'u2', full_name: 'Sita', email: 'sita@example.com', ims_role: 'staff', ims_job_title: 'Staff', last_seen_at: null, staff_blocked_at: '2026-11-03T06:00:00Z' },
  { id: 'u3', full_name: 'Hari', email: 'hari@example.com', ims_role: 'staff', ims_job_title: 'Staff', last_seen_at: null, settlement_blocked: true },
  { id: 'u4', full_name: 'Gita', email: null, ims_role: 'staff', ims_job_title: 'Stock Counter', has_pin: true, last_seen_at: null },
]
let mockAnswers = {}
let mockInvokes = []

function mockBuilder() {
  const b = {}
  for (const op of ['select', 'eq', 'order', 'in', 'maybeSingle', 'update', 'insert']) b[op] = () => b
  b.then = (resolve, reject) => Promise.resolve({ data: { id: 's1', ims_custom_roles: [] }, error: null }).then(resolve, reject)
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: () => mockBuilder(),
    rpc: name => Promise.resolve(name === 'get_ims_staff_list' ? { data: STAFF, error: null } : { data: [], error: null }),
    functions: {
      invoke: (fn, opts) => {
        mockInvokes.push(opts.body)
        return Promise.resolve(mockAnswers[opts.body.action] || { data: { success: true }, error: null })
      },
    },
  },
}))
// An IMS manager who is not the Owner, signed in as Maya.
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', hasImsAccess: () => true, hrEnabled: false, session: { user: { id: 'me' } },
    profile: { id: 'me', ims_role: 'manager' }, adminViewClientName: '', isAdmin: false, isOwner: false,
  }),
}))

// eslint-disable-next-line import/first
import ImsStaff from './ImsStaff'

// A non-2xx answer from admin-user-ops: supabase-js leaves the body on error.context, a Response.
const httpError = (status, body) => ({
  data: null,
  error: {
    name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
    context: { status, json: async () => body, clone: () => ({ json: async () => body }) },
  },
})

beforeEach(() => {
  mockAnswers = {}
  mockInvokes = []
})

const rowOf = name => screen.getByText(name).closest('tr') // eslint-disable-line testing-library/no-node-access
// The table row a message row sits under.
const rowAbove = el => el.closest('tr').previousElementSibling // eslint-disable-line testing-library/no-node-access

test('a row blocked here shows its badge and offers Unblock; a settlement block and your own login offer no Block', async () => {
  render(<ImsStaff />)
  await screen.findByText('Sita')

  const sita = within(rowOf('Sita'))
  expect(sita.getByText('Login blocked')).toBeInTheDocument()
  expect(sita.getByRole('button', { name: 'Unblock' })).toBeInTheDocument()
  expect(sita.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  expect(sita.getByRole('button', { name: 'Delete' })).toBeInTheDocument()

  expect(within(rowOf('Ravi')).getByRole('button', { name: 'Block' })).toBeInTheDocument()
  expect(within(rowOf('Gita')).getByRole('button', { name: 'Block' })).toBeInTheDocument()

  const hari = within(rowOf('Hari'))
  expect(hari.getByText('Blocked at settlement')).toBeInTheDocument()
  expect(hari.queryByText('Login blocked')).not.toBeInTheDocument()
  expect(hari.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  expect(hari.queryByRole('button', { name: 'Unblock' })).not.toBeInTheDocument()

  const maya = within(rowOf('Maya'))
  expect(maya.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  expect(maya.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
})

test('Reset on a blocked login says why under its row and calls nothing', async () => {
  render(<ImsStaff />)
  await screen.findByText('Sita')
  const reset = within(rowOf('Sita')).getByRole('button', { name: 'Reset Password' })
  expect(reset).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(reset)

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('This login is blocked. Unblock it first')
  expect(rowAbove(alert)).toBe(rowOf('Sita'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mockInvokes).toHaveLength(0)
})

test('the Delete confirm says Delete is only for a login that recorded nothing', async () => {
  render(<ImsStaff />)
  await screen.findByText('Ravi')
  fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }))

  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('Delete the IMS login of Ravi?')
  expect(dialog).toHaveTextContent('Delete is only for a login that has not recorded anything.')
  expect(dialog).toHaveTextContent('you will be offered Block instead, which keeps it')
  expect(dialog).not.toHaveTextContent('is touched')
})

test('a Delete refused for a login that recorded something offers Block, and Block sends block_ims_staff', async () => {
  const why = 'Ravi has recorded 2 stock counts and 1 gate pass, so deleting the login would take the name off them. Block it instead.'
  mockAnswers = {
    delete_ims_staff: httpError(409, { error: why, code: 'staff_login_has_records', records: ['2 stock counts', '1 gate pass'] }),
    block_ims_staff: { data: { success: true, outcome: 'blocked' }, error: null },
  }
  render(<ImsStaff />)
  await screen.findByText('Ravi')
  fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Login' }))

  const offer = await screen.findByText('Block the login of Ravi instead?')
  const dialog = offer.closest('[role="dialog"]') // eslint-disable-line testing-library/no-node-access
  expect(dialog).toHaveTextContent(why)
  expect(dialog).toHaveTextContent('their name stays on every count, gate pass, requisition and transfer they recorded.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block Login' }))

  expect(await screen.findByText('Ravi can no longer sign in. The login is kept, so their name stays on everything they recorded.')).toBeInTheDocument()
  expect(mockInvokes).toEqual([
    { action: 'delete_ims_staff', client_id: 'c1', userId: 'u1' },
    { action: 'block_ims_staff', client_id: 'c1', userId: 'u1' },
  ])
})

test('a Delete refused on a login already blocked says it stays blocked, and asks nothing more', async () => {
  mockAnswers = { delete_ims_staff: httpError(409, { error: 'Sita has recorded 4 stock counts.', code: 'staff_login_has_records' }) }
  render(<ImsStaff />)
  await screen.findByText('Sita')
  fireEvent.click(within(rowOf('Sita')).getByRole('button', { name: 'Delete' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Login' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('The login of Sita stays')
  expect(alert).toHaveTextContent('It is already blocked, so it cannot sign in.')
  expect(rowAbove(alert)).toBe(rowOf('Sita'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mockInvokes.map(b => b.action)).toEqual(['delete_ims_staff'])
})

test('an Unblock that HR refuses shows the sentence as written, under the row', async () => {
  const why = 'HR shows Sita as gone, so the login stays blocked. Take them back in HR Employees with a new join date first.'
  mockAnswers = { unblock_ims_staff: httpError(409, { error: why, code: 'staff_unblock_leaver' }) }
  render(<ImsStaff />)
  await screen.findByText('Sita')
  fireEvent.click(within(rowOf('Sita')).getByRole('button', { name: 'Unblock' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Unblock Login' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(why)
  expect(alert).not.toHaveTextContent('was not unblocked')
  expect(rowAbove(alert)).toBe(rowOf('Sita'))
  expect(mockInvokes).toEqual([{ action: 'unblock_ims_staff', client_id: 'c1', userId: 'u2' }])
})

test('blocking a counting PIN says the tablet stops taking it', async () => {
  render(<ImsStaff />)
  await screen.findByText('Gita')
  fireEvent.click(within(rowOf('Gita')).getByRole('button', { name: 'Block' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('Block the IMS login of Gita?')
  expect(dialog).toHaveTextContent('their counting PIN stops working on the stock-count tablet')
  expect(mockInvokes).toHaveLength(0)
})
