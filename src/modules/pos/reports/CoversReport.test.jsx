/**
 * The Covers Report's Reservations tab says there are no bookings (S842).
 *
 * The page's shared empty card was keyed on the tab's own emptiness, so an empty Reservations tab
 * reached it, and it spoke about BILLS: "No paid bills in this range", or "only takeaway or delivery
 * (N bills)" when there were bills. The tab's own "No bookings in this range" card could never render.
 */
import React from 'react'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import * as XLSX from 'xlsx'
import { formatBsDay } from '../../../utils/bsCalendar'
import { todayNepalBs } from './reportRange'

// The answer per table, set per test.
let mockAnswers = {}

// One chainable, awaitable builder that answers its table's rows on `then`. A write answers
// `table:update` / `table:insert` when the test set one, so a save can fail while the read beside it
// succeeds.
function mockBuilder(table) {
  let write = null
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.update = () => { write = 'update'; return b }
  b.insert = () => { write = 'insert'; return b }
  b.then = (ok, fail) => Promise.resolve(
    (write && mockAnswers[`${table}:${write}`]) || mockAnswers[table] || { data: [], error: null },
  ).then(ok, fail)
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
// The letterhead comes from useBizInfo(), as on KOT Log and Sales Exceptions (2026-10-15 audit).
const BIZ = { name: 'Test Cafe', vat: '301234567', address: 'Thamel, Kathmandu', vatReg: true, error: null }
const mockBiz = { ...BIZ }
jest.mock('../../../shared/hooks/useBizInfo', () => ({ useBizInfo: () => mockBiz }))
// The real workbook is built; only the download is caught, so the test can read the sheet.
jest.mock('xlsx', () => ({ ...jest.requireActual('xlsx'), writeFile: jest.fn() }))

// eslint-disable-next-line import/first
import CoversReport from './CoversReport'

const takeawayBill = {
  id: 'o1', table_id: null, part_of_order_id: null, table_name: null, covers: 0,
  opened_at: new Date().toISOString(), closed_at: new Date().toISOString(),
  opened_by: 'u1', discount_amount: 0, credit_note_id: null, vat_registered: true,
}

beforeEach(() => { mockAnswers = {}; Object.assign(mockBiz, BIZ) })

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

/**
 * 2026-10-15 audit: the charts are h2s under the page h1, the Trend / Peak / Server tables carry a
 * TOTAL row (revenue per cover from the totals), the busiest day names its month, a failed hours
 * save is an ActionError, and a failed letterhead read is the report-error card.
 */
const now = new Date().toISOString()
const dineIn = (id, covers, by) => ({
  id, table_id: 't1', part_of_order_id: null, table_name: 'T1', covers, opened_at: now, closed_at: now,
  opened_by: by, discount_amount: 0, credit_note_id: null, vat_registered: false,
})
function withDineInBills() {
  mockAnswers = {
    pos_orders: { data: [dineIn('d1', 2, 'u1'), dineIn('d2', 4, 'u2')], error: null },
    pos_order_items: { data: [
      { order_id: 'd1', qty: 1, unit_price: 1000, vat_rate: 0, comped: false, selection_key: '' },
      { order_id: 'd2', qty: 1, unit_price: 500, vat_rate: 0, comped: false, selection_key: '' },
    ], error: null },
    settings: { data: { id: 's1', is_vat_registered: false, pos_open_time: null, pos_close_time: null }, error: null },
  }
}
async function openTab(name) {
  render(<CoversReport />)
  fireEvent.click(await screen.findByRole('tab', { name }))
}
const footRow = () => within(screen.getByRole('table').querySelector('tfoot')).getByRole('row') // eslint-disable-line testing-library/no-node-access

test('Daily Trend: an h2 chart, a TOTAL row with revenue per cover from the totals, and the busiest day by name', async () => {
  withDineInBills()
  await openTab('Daily Trend')
  expect(await screen.findByRole('heading', { level: 2, name: 'Covers Served by Day' })).toBeTruthy()
  const cells = within(footRow()).getAllByRole('cell').map(c => c.textContent)
  // 2 bills, 2 + 4 covers, NPR 1,500, and 1,500 ÷ 6 = NPR 250 (the days' own averages are not averaged).
  expect(cells).toEqual(['Total', '2', '6', 'NPR 1,500', 'NPR 250'])
  const bs = todayNepalBs()
  expect(screen.getByText(formatBsDay(bs.day, bs.month))).toBeTruthy()
  expect(screen.queryByText(`${bs.day}/${bs.month}`)).toBeNull()
})

test('Peak Hours: an h2 chart and a TOTAL row of bills and covers', async () => {
  withDineInBills()
  await openTab('Peak Hours')
  expect(await screen.findByRole('heading', { level: 2, name: 'Covers by Hour Seated' })).toBeTruthy()
  expect(within(footRow()).getAllByRole('cell').map(c => c.textContent)).toEqual(['Total', '2', '6'])
})

test('By Server: a TOTAL row, revenue per cover from the totals', async () => {
  withDineInBills()
  await openTab('By Server')
  await screen.findAllByRole('row')
  expect(within(footRow()).getAllByRole('cell').map(c => c.textContent)).toEqual(['Total', '2', '6', 'NPR 1,500', 'NPR 250'])
})

test('a refused hours save is an ActionError that names the consequence and keeps the code', async () => {
  withDineInBills()
  mockAnswers['settings:update'] = { data: null, error: { code: '42501', message: 'permission denied for table settings' } }
  render(<CoversReport />)
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  const err = await screen.findByRole('alert')
  expect(err.className).toBe('action-error')
  expect(within(err).getByText(/^The hours could not be confirmed as saved\./)).toBeTruthy()
  expect(within(err).getByText('42501 · permission denied for table settings').className).toBe('action-error-detail')
})

test('a save that matched no row says the hours were not saved, and a good one says Saved', async () => {
  withDineInBills()
  mockAnswers['settings:update'] = { data: [], error: null }
  render(<CoversReport />)
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/^The hours were not saved — nothing was updated\./)

  mockAnswers['settings:update'] = { data: [{ id: 's1' }], error: null }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('status')).textContent).toBe('✓ Saved.')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a failed letterhead read is the report-error card, and Excel is off', async () => {
  withDineInBills()
  mockBiz.error = { code: 'PGRST301', message: 'JWT expired' }
  mockBiz.name = ''
  await openTab('Daily Trend')
  const card = (await screen.findByText("Could not load this outlet's name")).closest('.report-error') // eslint-disable-line testing-library/no-node-access
  expect(card.getAttribute('role')).toBe('alert')
  expect(within(card).getByText(/Excel is switched off/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Excel/ }).disabled).toBe(true)
})

test('Excel stays off until the letterhead read has answered', async () => {
  withDineInBills()
  mockBiz.name = '' // useBizInfo before its read lands: no name, no error yet
  await openTab('Daily Trend')
  await screen.findByRole('columnheader', { name: 'Date (BS)' })
  expect(screen.getByRole('button', { name: /Excel/ }).disabled).toBe(true)
  expect(screen.queryByText("Could not load this outlet's name")).toBeNull()
})

test('the export carries the shared letterhead: company, VAT number and address above the range line', async () => {
  withDineInBills()
  XLSX.writeFile.mockClear()
  await openTab('Daily Trend')
  await screen.findByRole('columnheader', { name: 'Date (BS)' })
  fireEvent.click(screen.getByRole('button', { name: /Excel/ }))
  await waitFor(() => expect(XLSX.writeFile).toHaveBeenCalledTimes(1))
  const [wb, filename] = XLSX.writeFile.mock.calls[0]
  expect(filename).toMatch(/^covers-daily-trend-/)
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Daily Trend'], { header: 1, blankrows: true })
  expect(rows.slice(0, 5)).toEqual([
    ['Covers Report - Daily Trend'],
    ['CompanyName : Test Cafe'],
    ['VATNO : 301234567'],
    ['ADDRESS : Thamel, Kathmandu'],
    [],
  ])
  expect(rows[5][0]).toMatch(/^@As On Dated : .*@Division : Test Cafe {2}@Basis : dine-in bills only/)
  // The shared letterhead's closing blank row holds no cell, so `sheet_add_json(origin: -1)` starts
  // the columns straight under the range line, on every report that uses it.
  expect(rows[6][0]).toBe('Date (BS)')
  expect(rows[7].slice(1)).toEqual([2, 6, 1500, 250])
})

test('a PAN-registered outlet\'s letterhead says PAN No', async () => {
  withDineInBills()
  Object.assign(mockBiz, { vatReg: false, vat: '601234567' })
  XLSX.writeFile.mockClear()
  await openTab('By Server')
  await screen.findAllByRole('row')
  fireEvent.click(screen.getByRole('button', { name: /Excel/ }))
  await waitFor(() => expect(XLSX.writeFile).toHaveBeenCalledTimes(1))
  const rows = XLSX.utils.sheet_to_json(XLSX.writeFile.mock.calls[0][0].Sheets['By Server'], { header: 1, blankrows: true })
  expect(rows[2]).toEqual(['PAN No : 601234567'])
})
