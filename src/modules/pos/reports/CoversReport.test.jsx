/**
 * The Covers Report's Reservations tab says there are no bookings (S842).
 *
 * The page's shared empty card was keyed on the tab's own emptiness, so an empty Reservations tab
 * reached it, and it spoke about BILLS: "No paid bills in this range", or "only takeaway or delivery
 * (N bills)" when there were bills. The tab's own "No bookings in this range" card could never render.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// The answer per table, set per test.
let mockAnswers = {}

// One chainable, awaitable builder that answers its table's rows on `then`.
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.then = (ok, fail) => Promise.resolve(mockAnswers[table] || { data: [], error: null }).then(ok, fail)
  return b
}
// Stable across renders: scopedFrom is a dependency of the page's loader.
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => (ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', hasPosAccess: () => true }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))

// eslint-disable-next-line import/first
import CoversReport from './CoversReport'

const takeawayBill = {
  id: 'o1', table_id: null, part_of_order_id: null, table_name: null, covers: 0,
  opened_at: new Date().toISOString(), closed_at: new Date().toISOString(),
  opened_by: 'u1', discount_amount: 0, credit_note_id: null, vat_registered: true,
}

beforeEach(() => { mockAnswers = {} })

async function openReservations() {
  render(<CoversReport />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Reservations' }))
}

test('with takeaway bills and no bookings, Reservations says there are no bookings, not "no dine-in bills"', async () => {
  mockAnswers = { pos_orders: { data: [takeawayBill], error: null } }
  await openReservations()
  expect(await screen.findByText(/No bookings in this range\./)).toBeTruthy()
  expect(screen.queryByText(/No dine-in bills in this range/)).toBeNull()
})

test('with no bills and no bookings, Reservations still speaks about bookings', async () => {
  await openReservations()
  expect(await screen.findByText(/No bookings in this range\./)).toBeTruthy()
  expect(screen.queryByText('No paid bills in this range.')).toBeNull()
})

test('the bill tabs keep their own empty sentence', async () => {
  render(<CoversReport />)
  expect(await screen.findByText('No paid bills in this range.')).toBeTruthy()
  expect(screen.queryByText(/No bookings in this range/)).toBeNull()
})
