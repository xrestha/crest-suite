/**
 * Sales Exceptions (S842): the Staff filter never outlives its option, and a hung read ends.
 *
 * The Staff options come from the range's own rows. Pick a person, move the range to one where
 * they closed nothing, and the select showed "All staff" while still filtering to them, and picking
 * "All staff" fired no change. And the page's reads had no limit, so a hung one left "Loading…" up
 * for good.
 */
import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { nepalDayStartTs, todayNepalAdIso } from './reportRange'

const TODAY_START = nepalDayStartTs(todayNepalAdIso())

// Bills per range: today's are Ram's, any other range's are Sita's. `mockHang` holds every bill read.
// `mockVoidLinesError` makes today's bill a void and fails the read of its lines.
let mockHang = false
let mockVoidLinesError = null
let mockNoBills = false
const bill = (id, closedBy) => ({
  id, order_no: 7, invoice_no: 41, invoice_fy: '82/83', invoice_prefix: 'CAC', close_type: 'paid',
  close_reason: null, discount_amount: 100, discount_reason: 'Regular guest', paid_amount: 1030,
  table_name: 'T1', closed_at: new Date().toISOString(), closed_by: closedBy, vat_registered: true,
})

function mockBuilder(table) {
  const filters = []
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = (...args) => { filters.push([op, ...args]); return b }
  }
  const answer = () => {
    if (table === 'rpc') return { data: [{ id: 'u-ram', full_name: 'Ram Thapa' }, { id: 'u-sita', full_name: 'Sita Rai' }], error: null }
    if (table === 'pos_order_items' && mockVoidLinesError && filters.some(f => f[0] === 'in')) return { data: null, error: mockVoidLinesError }
    if (table !== 'pos_orders' || mockNoBills) return { data: [], error: null }
    const from = filters.find(f => f[0] === 'gte' && f[1] === 'closed_at')?.[2]
    const b = from === TODAY_START ? bill('b-ram', 'u-ram') : bill('b-sita', 'u-sita')
    return { data: [mockVoidLinesError ? { ...b, close_type: 'void', discount_amount: 0 } : b], error: null }
  }
  b.then = (ok, fail) => (table === 'pos_orders' && mockHang
    ? new Promise(() => {})
    : Promise.resolve(answer()).then(ok, fail))
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => (ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', hasPosAccess: () => true, isAdmin: false, imsEnabled: false, clientModules: {}, customizationEnabled: false }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
const mockBiz = { name: 'Test Cafe', error: null }
jest.mock('../../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => mockBiz }))

// eslint-disable-next-line import/first
import PosExceptionReport from './PosExceptionReport'

beforeEach(() => { mockHang = false; mockVoidLinesError = null; mockNoBills = false; mockBiz.error = null })
afterEach(() => jest.useRealTimers())

const staffSelect = () => screen.getByLabelText('Staff')
const detailTable = () => screen.getAllByRole('table').at(-1)

test('a person picked for one range stays the shown filter in a range where they closed nothing', async () => {
  render(<PosExceptionReport />)
  expect(await screen.findByRole('option', { name: 'Ram Thapa' })).toBeTruthy()
  fireEvent.change(staffSelect(), { target: { value: 'u-ram' } })
  expect(within(detailTable()).getByText('Ram Thapa')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Last month' }))
  // The new range's rows are Sita's, so the By Staff table names her.
  expect(await screen.findByRole('option', { name: 'Sita Rai' })).toBeTruthy()
  // The select still says Ram (it used to fall back to showing "All staff"), and says why it is empty.
  expect(staffSelect().value).toBe('u-ram')
  expect(screen.getByRole('option', { name: 'Ram Thapa (none in this range)' }).selected).toBe(true)
  expect(screen.getByText(/Nothing matches these filters/)).toBeTruthy()

  // Picking All staff is a real change now, and brings the range's rows back.
  fireEvent.change(staffSelect(), { target: { value: 'all' } })
  expect(within(detailTable()).getByText('Sita Rai')).toBeTruthy()
  expect(screen.queryByRole('option', { name: /none in this range/ })).toBeNull()
})

test('a staff option is a name, never a raw login id', async () => {
  render(<PosExceptionReport />)
  await screen.findByRole('option', { name: 'Ram Thapa' })
  for (const o of within(staffSelect()).getAllByRole('option')) expect(o.textContent).not.toMatch(/^u-/)
})

test('a bill read that never answers ends on the could-not-load card, not "Loading…" for good', async () => {
  jest.useFakeTimers()
  mockHang = true
  render(<PosExceptionReport />)
  expect(screen.getByText('Loading…')).toBeTruthy()
  await act(async () => { jest.advanceTimersByTime(60000) })
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  expect(screen.queryByText('Loading…')).toBeNull()
  expect(screen.queryByText('No discounts, voids or comps in this range.')).toBeNull()
})

// 2026-10-15 audit.
test('By Staff Member is a real h2 section heading', async () => {
  render(<PosExceptionReport />)
  expect(await screen.findByRole('heading', { level: 2, name: /By Staff Member/ })).toBeTruthy()
})

test('a failed read of the voided lines reaches the could-not-load card with its code, not a bare message', async () => {
  mockVoidLinesError = { code: '42501', message: 'permission denied for table pos_order_items' }
  render(<PosExceptionReport />)
  const card = await screen.findByRole('alert')
  expect(within(card).getByText('Could not load this report')).toBeTruthy()
  expect(within(card).getByText('42501 · permission denied for table pos_order_items').className).toBe('action-error-detail')
})

test('an empty range says so in plain words, with no celebration emoji', async () => {
  mockNoBills = true
  render(<PosExceptionReport />)
  expect(await screen.findByText('No discounts, voids or comps in this range.')).toBeTruthy()
  expect(screen.queryByText(/🎉/)).toBeNull()
})

test('a failed letterhead read is the report-error card, and Excel is off', async () => {
  mockBiz.error = { code: 'PGRST301', message: 'JWT expired' }
  render(<PosExceptionReport />)
  const card = (await screen.findByText("Could not load this outlet's name")).closest('.report-error') // eslint-disable-line testing-library/no-node-access
  expect(card.getAttribute('role')).toBe('alert')
  expect(within(card).getByText(/The figures below are unaffected/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Excel/ }).disabled).toBe(true)
})
