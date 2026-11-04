/**
 * HR Staff (S875, owner decision "Block, keep the name"): a leaver's HR login is blocked, not deleted,
 * as POS Staff does for till logins. A blocked row shows why and offers Unblock; a settlement's block
 * is HR's to undo, so it offers neither; Delete refused because the login recorded something offers
 * Block instead.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const STAFF = [
  { id: 'u1', full_name: 'Ravi', email: 'ravi@x.np', hr_role: 'staff', hr_job_title: 'Staff', last_seen_at: null, settlement_blocked: false, staff_blocked_at: null },
  { id: 'u2', full_name: 'Sita', email: 'sita@x.np', hr_role: 'staff', hr_job_title: 'Staff', last_seen_at: null, settlement_blocked: false, staff_blocked_at: '2026-11-01T06:00:00Z' },
  { id: 'u3', full_name: 'Hari', email: 'hari@x.np', hr_role: 'staff', hr_job_title: 'Staff', last_seen_at: null, settlement_blocked: true, staff_blocked_at: null },
]
let mockInvokes = []
let mockAnswer = () => ({ data: { success: true }, error: null })

function mockBuilder(result) {
  const b = {}
  for (const op of ['select', 'eq', 'order', 'in', 'maybeSingle', 'update', 'insert']) b[op] = () => b
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return b
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: () => mockBuilder({ data: { id: 's1', hr_custom_roles: [] }, error: null }),
    rpc: name => Promise.resolve(name === 'get_hr_role_staff_list' ? { data: STAFF, error: null } : { data: [], error: null }),
    functions: { invoke: (fn, opts) => { mockInvokes.push(opts.body); return Promise.resolve(mockAnswer(opts.body)) } },
  },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: () => mockBuilder({ data: [], error: null }) }),
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: 'c1', hasHrAccess: () => true, isAdmin: false, isOwner: true,
    session: { user: { id: 'o1' } }, profile: { id: 'o1' }, adminViewClientName: '',
  }),
}))

// eslint-disable-next-line import/first
import HrStaff from './HrStaff'

beforeEach(() => {
  mockInvokes = []
  mockAnswer = () => ({ data: { success: true }, error: null })
})

const rowOf = name => screen.getByText(name).closest('tr') // eslint-disable-line testing-library/no-node-access
const httpError = (status, body) => ({
  name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
  context: { status, json: async () => body },
})

test('a blocked row says so, offers Unblock, and keeps Reset Password off', async () => {
  render(<HrStaff />)
  await screen.findByText('Sita')
  const row = within(rowOf('Sita'))
  expect(row.getByText('Login blocked')).toBeInTheDocument()
  expect(row.getByRole('button', { name: 'Unblock the HR login of Sita' })).toBeInTheDocument()
  expect(row.queryByRole('button', { name: 'Block the HR login of Sita' })).toBeNull()

  const reset = row.getByRole('button', { name: 'Reset Password' })
  expect(reset).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(reset)
  expect(await screen.findByRole('alert')).toHaveTextContent('This login is blocked. Unblock it first')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a row blocked at settlement offers neither Block nor Unblock', async () => {
  render(<HrStaff />)
  await screen.findByText('Hari')
  const row = within(rowOf('Hari'))
  expect(row.getByText('Blocked at settlement')).toBeInTheDocument()
  expect(row.queryByRole('button', { name: /^(Block|Unblock) the HR login/ })).toBeNull()
  expect(row.getByRole('button', { name: 'Reset Password' })).toHaveAttribute('aria-disabled', 'true')
})

test('Block asks first, then blocks and says what happened', async () => {
  mockAnswer = () => ({ data: { success: true, outcome: 'blocked' }, error: null })
  render(<HrStaff />)
  await screen.findByText('Ravi')
  fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Block the HR login of Ravi' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('Their name stays on every leave decision, salary payment, travel claim and roster')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block Login' }))

  await screen.findByText(/The login of Ravi is blocked/)
  expect(mockInvokes[0]).toEqual({ action: 'block_hr_staff', client_id: 'c1', userId: 'u1' })
})

test('Delete refused for a login that recorded something offers Block instead', async () => {
  mockAnswer = body => body.action === 'delete_hr_staff'
    ? { data: null, error: httpError(409, { error: 'Ravi has decided 2 leave requests in HR, so deleting this login would take their name off those records. Block the login instead', code: 'staff_login_has_records' }) }
    : { data: { success: true, outcome: 'blocked' }, error: null }
  render(<HrStaff />)
  await screen.findByText('Ravi')
  fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete the HR login of Ravi' }))
  const ask = await screen.findByRole('dialog')
  expect(ask).toHaveTextContent('Delete is only for a login that has not recorded anything')
  fireEvent.click(within(ask).getByRole('button', { name: 'Delete Login' }))

  await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Block the login of Ravi instead?'))
  const offer = screen.getByRole('dialog')
  expect(offer).toHaveTextContent('Ravi has decided 2 leave requests in HR')
  fireEvent.click(within(offer).getByRole('button', { name: 'Block Login' }))

  await screen.findByText(/The login of Ravi is blocked/)
  expect(mockInvokes.map(b => b.action)).toEqual(['delete_hr_staff', 'block_hr_staff'])
})

test('Delete refused for an already blocked login says it stays blocked, and offers nothing more', async () => {
  mockAnswer = () => ({ data: null, error: httpError(409, { error: 'Sita has recorded work in HR. Block the login instead', code: 'staff_login_has_records' }) })
  render(<HrStaff />)
  await screen.findByText('Sita')
  fireEvent.click(within(rowOf('Sita')).getByRole('button', { name: 'Delete the HR login of Sita' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete Login' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('It is already blocked, so it cannot sign in.')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(mockInvokes).toHaveLength(1)
})
