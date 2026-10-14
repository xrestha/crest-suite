/**
 * Seat dialog busy marks (S835). The page's list poll stops while a dialog is open, so the dialog
 * reads the outlet's tables and open orders itself, on opening and every 15 s, and a failed read
 * keeps the last marks it had and says they may be out of date.
 */

import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import SeatTableModal from './SeatTableModal'

// What each table answers on the next read: { data, error } per table name.
let mockAnswers = {}
let mockReads = []

function mockBuilder(table) {
  const b = {}
  for (const op of ['order', 'eq']) b[op] = () => b
  b.then = (resolve, reject) => {
    mockReads.push(table)
    return Promise.resolve(mockAnswers[table] || { data: [], error: null }).then(resolve, reject)
  }
  return b
}

// One object for every render: the dialog's read callback depends on scopedFrom's identity.
const mockDb = { clientId: 'c1', scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))

const T1 = { id: 't1', name: 'T1', section: '', capacity: 4, status: 'available' }
const T2 = { id: 't2', name: 'T2', section: '', capacity: 2, status: 'available' }
const RES = { id: 'r1', customer_name: 'Gurung', party_size: 4, pos_reservation_tables: [] }

const button = name => screen.getByRole('button', { name: new RegExp(`^${name}`) })

beforeEach(() => {
  mockAnswers = {}
  mockReads = []
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  console.error.mockRestore()
  jest.useRealTimers()
})

test('the dialog replaces the page’s marks with its own read', async () => {
  // The page last saw T1 in use; the outlet now has T1 free and T2 taken.
  mockAnswers = {
    pos_tables: { data: [T1, T2], error: null },
    pos_orders: { data: [{ id: 'o1', table_id: 't2' }], error: null },
  }
  render(<SeatTableModal reservation={RES} tables={[T1, T2]} openTableIds={new Set(['t1'])} onClose={() => {}} onPick={() => {}} />)
  expect(button('T1')).toBeDisabled() // painted from the page at once
  await waitFor(() => expect(button('T1')).not.toBeDisabled())
  expect(button('T2')).toBeDisabled()
  expect(mockReads).toEqual(expect.arrayContaining(['pos_tables', 'pos_orders']))
  expect(screen.queryByText(/Couldn't refresh/)).toBeNull()
})

test('a failed first read keeps the page’s marks and says so', async () => {
  mockAnswers = {
    pos_tables: { data: null, error: { message: 'network' } },
    pos_orders: { data: [], error: null },
  }
  render(<SeatTableModal reservation={RES} tables={[T1, T2]} openTableIds={new Set(['t1'])} onClose={() => {}} onPick={() => {}} />)
  await screen.findByText(/Couldn't refresh which tables are in use, so the marks below may be out of date/)
  expect(button('T1')).toBeDisabled()
  expect(button('T2')).not.toBeDisabled()
})

test('a failed poll keeps the last good marks, and a later good one clears the line', async () => {
  jest.useFakeTimers()
  mockAnswers = {
    pos_tables: { data: [T1, T2], error: null },
    pos_orders: { data: [{ id: 'o1', table_id: 't2' }], error: null },
  }
  render(<SeatTableModal reservation={RES} tables={[T1, T2]} openTableIds={new Set()} onClose={() => {}} onPick={() => {}} />)
  await waitFor(() => expect(button('T2')).toBeDisabled())

  // The next poll fails: T2 stays marked, nothing is blanked, and the line names the last check.
  mockAnswers = { ...mockAnswers, pos_orders: { data: null, error: { message: 'timeout' } } }
  await act(async () => { jest.advanceTimersByTime(15000) })
  await screen.findByText(/Couldn't refresh which tables are in use — last checked at/)
  expect(button('T2')).toBeDisabled()

  // The one after answers with T2 freed: the mark moves and the line goes.
  mockAnswers = { ...mockAnswers, pos_orders: { data: [], error: null } }
  await act(async () => { jest.advanceTimersByTime(15000) })
  await waitFor(() => expect(button('T2')).not.toBeDisabled())
  expect(screen.queryByText(/Couldn't refresh/)).toBeNull()
})
