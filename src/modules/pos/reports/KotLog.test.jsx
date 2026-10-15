/**
 * The KOT Register renders a page of tickets at a time, and a tab whose read hangs ends (S842).
 */
import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

let mockAnswers = {}
let mockHang = null // a table whose reads never answer
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.then = (ok, fail) => (table === mockHang
    ? new Promise(() => {})
    : Promise.resolve(mockAnswers[table] || { data: [], error: null }).then(ok, fail))
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => (ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', hasPosAccess: () => true }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
const mockBiz = { name: 'Test Cafe', error: null }
jest.mock('../../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => mockBiz }))

// eslint-disable-next-line import/first
import KotLog from './KotLog'

const tickets = Array.from({ length: 450 }, (_, i) => ({
  id: `k${i}`, order_id: `o${i}`, order_no: i + 1, table_name: 'T1', station: 'KOT', status: 'served',
  items: [{ name: 'Momo', qty: 1 }], sent_at: new Date(Date.now() - i * 1000).toISOString(), sent_by: 'u1',
  started_at: null, ready_at: null, estimated_prep_minutes: null, pos_orders: { status: 'billed' },
}))

beforeEach(() => { mockAnswers = { pos_kot_log: { data: tickets, error: null } }; mockHang = null })
afterEach(() => jest.useRealTimers())

// The register's rows: its row groups are thead, then tbody.
const bodyRows = () => within(within(screen.getByRole('table')).getAllByRole('rowgroup')[1]).getAllByRole('row')

test('the Register renders 200 of 450 tickets and says the export has them all', async () => {
  render(<KotLog />)
  const status = await screen.findByRole('status')
  expect(status.textContent).toBe('200 of 450 tickets shown. Excel exports all of them.')
  expect(bodyRows()).toHaveLength(200)
  fireEvent.click(screen.getByRole('button', { name: 'Show all 450' }))
  expect(bodyRows()).toHaveLength(450)
})

test('a Reconciliation read that never answers ends on the could-not-load card', async () => {
  render(<KotLog />)
  await screen.findByRole('status')
  jest.useFakeTimers()
  mockHang = 'pos_orders'
  fireEvent.click(screen.getByRole('tab', { name: 'Reconciliation' }))
  expect(screen.getByText('Loading…')).toBeTruthy()
  await act(async () => { jest.advanceTimersByTime(60000) })
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  expect(screen.queryByText(/No discrepancies/)).toBeNull()
})
