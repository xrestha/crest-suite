/**
 * Audit Log — the S745 re-analysis, tested where each defect lived.
 *
 * 1. Clear Logs deleted the NEWEST entries: the time filter became `created_at >= cutoff`, so
 *    "Last 7 days" + Clear erased the most recent week. It is now a purge of entries OLDER than a
 *    window of at least 90 days, through `admin_purge_audit_logs` — and the page must never send a
 *    cutoff, a table name or a window under 90.
 * 2. Load more paged on `created_at`, which every row of one transaction shares, so part of a bulk
 *    save past a page boundary was skipped. It pages on `id` now.
 * 3. A null `user_id` rendered "—"; a percentage read "NPR 10"; a bare date printed a clock time.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const mockCalls = []
const mockRpc = jest.fn()
let mockPages = []

function mockBuilder(table) {
  const call = { table, ops: [] }
  mockCalls.push(call)
  const b = {}
  for (const op of ['select', 'order', 'eq', 'gte', 'lt', 'limit']) {
    b[op] = (...args) => { call.ops.push([op, ...args]); return b }
  }
  b.then = (resolve, reject) => {
    const data = table === 'clients'
      ? [{ id: 'c1', name: 'Casa Acai Cafe' }]
      : (mockPages.shift() || [])
    return Promise.resolve({ data, error: null }).then(resolve, reject)
  }
  return b
}

jest.mock('../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    rpc: (...args) => mockRpc(...args),
  },
}))

jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ loading: false }) }))

// eslint-disable-next-line import/first
import AuditLog from './AuditLog'

const row = (id, over = {}) => ({
  id, created_at: '2026-09-14T10:15:00+00:00', client_id: 'c1', client_name: 'Casa Acai Cafe',
  user_id: 'u1', user_name: 'Aashish', table_name: 'profiles', action: 'UPDATE', record_id: 'r1',
  old_data: { pos_discount_limit: 5 }, new_data: { pos_discount_limit: 10 }, ...over,
})

const auditCalls = () => mockCalls.filter(c => c.table === 'audit_logs')

beforeEach(() => {
  mockCalls.length = 0
  mockRpc.mockReset()
  mockPages = []
})

test('pages newest-first by id, and Load more continues below the last id', async () => {
  mockPages = [Array.from({ length: 500 }, (_, i) => row(10000 - i)), [row(9000)]]
  render(<AuditLog />)
  await screen.findByText('Load next 500')

  const first = auditCalls()[0].ops
  expect(first).toContainEqual(['order', 'id', { ascending: false }])
  expect(first.some(([op, col]) => op === 'order' && col === 'created_at')).toBe(false)

  fireEvent.click(screen.getByText('Load next 500'))
  await waitFor(() => expect(auditCalls()).toHaveLength(2))
  expect(auditCalls()[1].ops).toContainEqual(['lt', 'id', 9501])
})

test('the purge sends an age of at least 90 days and nothing a caller could aim at recent rows', async () => {
  mockPages = [[row(1)], []]
  mockRpc.mockResolvedValue({ data: 42, error: null })
  render(<AuditLog />)
  expect(await screen.findByRole('cell', { name: 'Aashish' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /Delete old entries/ }))
  const dialog = await screen.findByRole('dialog')
  const options = within(dialog).getAllByRole('option').map(o => Number(o.value))
  expect(Math.min(...options)).toBeGreaterThanOrEqual(90)

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete old entries' }))
  await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1))
  const [fn, args] = mockRpc.mock.calls[0]
  expect(fn).toBe('admin_purge_audit_logs')
  expect(Object.keys(args).sort()).toEqual(['p_client_id', 'p_older_than_days'])
  expect(args.p_older_than_days).toBeGreaterThanOrEqual(90)
  expect(args.p_client_id).toBeNull()
  await screen.findByText(/42 entries older than 1 year deleted across all clients/)
})

test('a server-written row says System, and values are formatted by meaning', async () => {
  mockPages = [[
    row(3, { user_id: null, user_name: null, table_name: 'staff_pin_vault', action: 'VIEW', old_data: null, new_data: { kind: 'pos', revealed: true } }),
    row(2),
    row(1, { table_name: 'hr_employees', old_data: { join_date: '2026-01-01', unpaid_days: 2 }, new_data: { join_date: '2026-02-01', unpaid_days: 3 } }),
  ]]
  render(<AuditLog />)
  expect(await screen.findByRole('cell', { name: 'System' })).toBeInTheDocument()
  expect(screen.getByText('Viewed')).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'Staff PIN' })).toBeInTheDocument()
  expect(screen.getByText(/Discount Limit %: 5% → 10%/)).toBeInTheDocument()
  expect(screen.getByText(/Join Date: 2026-01-01 → 2026-02-01 · Unpaid Days: 2 → 3/)).toBeInTheDocument()
  expect(screen.queryByText(/NPR/)).toBeNull()
})
