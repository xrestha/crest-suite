/**
 * POS → Parking Slips (S814, CUSTOMERS-PARKING-15). The Open tab reads open slips only and sweeps
 * an earlier day's by rule, not by id; the All tab reads a date range only when it is opened; a Mark
 * Exited answer is applied to the list without re-reading every slip ever issued.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

let mockReads = []
let mockUpdates = []
let mockOpenRows = []
let mockAllRows = []

const DAY = 24 * 60 * 60 * 1000
const nowIso = () => new Date().toISOString()

function mockSelect(table) {
  const q = { table, filters: [] }
  const b = {}
  for (const op of ['eq', 'gte', 'lt', 'order']) b[op] = (...args) => { q.filters.push([op, ...args]); return b }
  b.range = () => {
    mockReads.push(q)
    const isOpen = q.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'open')
    return Promise.resolve({ data: isOpen ? mockOpenRows : mockAllRows, error: null })
  }
  return b
}

function mockUpdate(table, patch) {
  const u = { table, patch, filters: [] }
  mockUpdates.push(u)
  const b = {}
  for (const op of ['eq', 'lt', 'in']) b[op] = (...args) => { u.filters.push([op, ...args]); return b }
  b.select = cols => {
    u.select = cols
    if (patch.auto_closed) {
      const stale = mockOpenRows.filter(r => Date.parse(r.time_in) < Date.now() - DAY)
      return Promise.resolve({ data: stale.map(r => ({ id: r.id, status: 'closed', time_out: nowIso(), exited_by: null, auto_closed: true })), error: null })
    }
    const id = u.filters.find(f => f[0] === 'eq' && f[1] === 'id')?.[2]
    return Promise.resolve({ data: [{ id, status: 'closed', time_out: nowIso(), exited_by: 'u1', auto_closed: false }], error: null })
  }
  return b
}

// Stable identities, as the real hook memoizes them on clientId.
const mockScopedDb = { scopedFrom: table => mockSelect(table), scopedUpdate: (table, patch) => mockUpdate(table, patch) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: [{ id: 'u1', full_name: 'Sita' }], error: null }),
    from: table => {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.single = () => Promise.resolve({ data: { name: 'Casa Acai' }, error: null })
      b.maybeSingle = () => Promise.resolve({ data: { property_address: 'Thamel' }, error: null })
      return b
    },
  },
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', profile: { id: 'u1', full_name: 'Sita' }, hasPosAccess: () => true }),
}))
jest.mock('../../../utils/viewPosBill', () => ({ viewPosBill: () => {} }))

// eslint-disable-next-line import/first
import PosParkingSlips from './PosParkingSlips'

const row = (id, slipNo, timeIn) => ({
  id, slip_no: slipNo, vehicle_number: `BA ${slipNo} PA`, status: 'open', time_in: timeIn, issued_by: 'u1', print_count: 1,
})

beforeEach(() => {
  mockReads = []
  mockUpdates = []
  mockOpenRows = [row('fresh', 2, nowIso()), row('stale', 1, new Date(Date.now() - 3 * DAY).toISOString())]
  mockAllRows = [row('fresh', 2, nowIso())]
})

test('reads only the open slips, and closes an earlier day\'s by rule rather than by a list of ids', async () => {
  render(<PosParkingSlips />)
  expect(await screen.findByText('BA 2 PA')).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByText('BA 1 PA')).toBeNull())

  expect(mockReads).toHaveLength(1)
  expect(mockReads[0].filters).toContainEqual(['eq', 'status', 'open'])
  const sweep = mockUpdates.find(u => u.patch.auto_closed)
  expect(sweep.filters.map(f => f.slice(0, 2))).toEqual([['eq', 'status'], ['lt', 'time_in']])
  expect(sweep.filters.some(f => f[0] === 'in')).toBe(false)
})

test('the All tab reads a date range only once it is opened', async () => {
  render(<PosParkingSlips />)
  await screen.findByText('BA 2 PA')
  expect(mockReads.some(q => q.filters.some(f => f[0] === 'gte'))).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'All' }))
  await waitFor(() => expect(mockReads.some(q => q.filters.some(f => f[0] === 'gte'))).toBe(true))
  const q = mockReads.find(r => r.filters.some(f => f[0] === 'gte'))
  const gte = q.filters.find(f => f[0] === 'gte')
  const lt = q.filters.find(f => f[0] === 'lt')
  expect(gte[1]).toBe('time_in')
  expect(gte[2]).toMatch(/T00:00:00\+05:45$/)
  expect(lt[2]).toMatch(/T00:00:00\+05:45$/)
  expect(await screen.findByText('BA 2 PA')).toBeInTheDocument()
})

test('Mark Exited takes the slip off the Open list from the server\'s answer', async () => {
  render(<PosParkingSlips />)
  const vehicle = await screen.findByText('BA 2 PA')
  // The next Open read no longer has it, as the server would answer.
  mockOpenRows = []
  fireEvent.click(within(vehicle.closest('tr')).getByRole('button', { name: 'Mark Exited' }))
  expect(await screen.findByText('No vehicles currently parked.')).toBeInTheDocument()
  const exit = mockUpdates.find(u => u.patch.status === 'closed' && !u.patch.auto_closed)
  expect(exit.filters).toEqual([['eq', 'id', 'fresh']])
  expect(exit.select).toBe('id, status, time_out, exited_by, auto_closed')
})
