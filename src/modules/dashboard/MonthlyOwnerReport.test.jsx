/**
 * The Monthly Owner Report takes its months from the shared list (S876, PERF-10). On a revisit the
 * stored report of the month it will open on is read beside a fresh read of the list. Nothing else
 * follows that guess: the lazy generate, which freezes a report for good, runs only once the fresh
 * list shows the month closed. And a failed month list offers Try again.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

let mockAuth = {}
// Each table's answer: a value, or a function returning one (a promise holds a read open).
let mockTables = {}
// Every table read, in the order they were sent.
const mockSeen = []

function mockBuilder(table) {
  const b = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'maybeSingle', 'single']) b[m] = () => b
  b.then = (res, rej) => {
    mockSeen.push(table)
    const v = mockTables[table]
    return Promise.resolve(typeof v === 'function' ? v() : (v || { data: [], error: null })).then(res, rej)
  }
  return b
}

jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../supabaseClient', () => ({ supabase: { from: t => mockBuilder(t), rpc: () => mockBuilder('rpc') } }))
jest.mock('../../context/SettingsContext', () => ({ useSettings: () => ({ settings: {} }) }))
jest.mock('../../shared/hooks/useBizInfo', () => ({
  useBizInfo: () => ({ name: 'BLOOM CAFE', vat: '', address: '', vatReg: true, error: null, ready: true }),
}))
jest.mock('../../components/SuiteGate', () => ({
  __esModule: true,
  default: ({ children }) => (typeof children === 'function' ? children() : children),
  SUITE_PAGES: { ownerReport: {}, ownerDashboard: {} },
  useSuiteAccess: () => ({ allowed: true }),
}))
jest.mock('../../shared/profileNames', () => ({
  loadProfileNames: () => Promise.resolve({ map: {}, error: null }),
  fillMissingNames: (s, c, map) => Promise.resolve({ map, error: null }),
}))
const mockGenerate = jest.fn()
jest.mock('../ownerReport/generateMonthlyReport', () => ({
  generateMonthlyReport: (...args) => mockGenerate(...args),
  saveGeneratedReport: () => Promise.resolve({ error: null }),
  regenerateReport: () => Promise.resolve({ error: null, updated: true }),
}))

// eslint-disable-next-line import/first
import MonthlyOwnerReport from './MonthlyOwnerReport'
// eslint-disable-next-line import/first
import { clearPeriodLists, readPeriodList } from '../../shared/periodList'

const BHADRA = { id: 'p5', client_id: 'c1', bs_year: 2083, bs_month: 5, status: 'closed', created_at: '2026-08-17' }

beforeEach(() => {
  // The month list is shared and kept between pages (periodList.js): each test starts with none.
  clearPeriodLists()
  mockSeen.length = 0
  mockGenerate.mockReset()
  mockGenerate.mockResolvedValue({ snapshot: {}, modulesIncluded: { ims: true } })
  mockAuth = { clientId: 'c1', isAdmin: false, isOwner: true, hasFeature: () => true }
  mockTables = {
    monthly_periods: { data: [BHADRA], error: null },
    // No report stored for the month yet: the Owner's first view makes one.
    monthly_owner_reports: { data: null, error: null },
  }
})

const renderPage = () => render(<MemoryRouter><MonthlyOwnerReport /></MemoryRouter>)
const reportReads = () => mockSeen.filter(t => t === 'monthly_owner_reports').length
const settle = () => new Promise(res => setTimeout(res, 20))

// An earlier page left Bhadra (closed) in memory; this visit's fresh read is held open until answered.
async function revisit() {
  await readPeriodList('c1')
  let answer
  mockTables.monthly_periods = () => new Promise(res => { answer = res })
  mockSeen.length = 0
  renderPage()
  await waitFor(() => expect(typeof answer).toBe('function'))
  return res => answer(res)
}

test('a revisit reads the stored report beside the month list, and makes one only once the list confirms the month closed', async () => {
  const answer = await revisit()
  // The guessed month's stored report is asked for while the list is still out.
  await waitFor(() => expect(reportReads()).toBe(1))
  await settle()
  // It came back empty, and still nothing is made from a guessed month.
  expect(mockGenerate).not.toHaveBeenCalled()
  answer({ data: [BHADRA], error: null })
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))
  expect(mockGenerate.mock.calls[0][0]).toEqual({ clientId: 'c1', period: BHADRA })
  // loadReport took the early read rather than reading the month again: one read, then the read-back.
  await waitFor(() => expect(reportReads()).toBe(2))
  await settle()
  expect(mockGenerate).toHaveBeenCalledTimes(1)
})

test('a guessed month the fresh list shows reopened is never made', async () => {
  const answer = await revisit()
  await waitFor(() => expect(reportReads()).toBe(1))
  await settle()
  answer({ data: [{ ...BHADRA, status: 'open' }], error: null })
  expect(await screen.findByText(/is still open\./)).toBeTruthy()
  await settle()
  expect(mockGenerate).not.toHaveBeenCalled()
})

test('a guessed month that is not the one the fresh list opens on is dropped, and the right month is read', async () => {
  const answer = await revisit()
  await waitFor(() => expect(reportReads()).toBe(1))
  const ashwin = { ...BHADRA, id: 'p6', bs_month: 6 }
  answer({ data: [ashwin, BHADRA], error: null })
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))
  expect(mockGenerate.mock.calls[0][0].period).toEqual(ashwin)
})

test('a failed month list offers Try again, which reads the months again', async () => {
  mockTables.monthly_periods = { data: null, error: { message: 'boom', code: '500' } }
  renderPage()
  expect(await screen.findByText('Could not load this report')).toBeTruthy()
  expect(mockGenerate).not.toHaveBeenCalled()
  mockTables.monthly_periods = { data: [{ ...BHADRA, status: 'open' }], error: null }
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText(/is still open\./)).toBeTruthy()
})
