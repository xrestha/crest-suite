/**
 * The Kitchen Display never shows a board it did not read (S842).
 *
 * A failed FIRST read used to say "Nothing on the board right now… no refresh needed" over three
 * "(0)" columns, under a banner citing a "last successful check" there never was. And a front-of-house
 * login switching Kitchen → Bar whose bar read failed kept the kitchen's tickets on screen under
 * "Bar (BOT)", with live Start buttons. Each read applied now records the station it was for, a switch
 * clears the board, and until this station's read lands the board is an error card or "Loading…".
 */

import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The tickets read's answer per station, set per test. A function so a test can change it between polls.
let mockTicketAnswer = () => ({ data: [], error: null })
const mockTicketReads = []

// One chainable, awaitable builder: records the station and which read it is, answers on `then`.
function mockBuilder(table) {
  const q = { table, filters: [] }
  const b = {}
  for (const op of ['eq', 'in', 'gte', 'order', 'limit', 'select', 'not']) {
    b[op] = (...args) => { q.filters.push([op, ...args]); return b }
  }
  const answer = () => {
    if (table !== 'pos_kot_log') return { data: [], error: null }
    const station = q.filters.find(f => f[0] === 'eq' && f[1] === 'station')?.[2]
    const voided = q.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'cancelled')
    if (voided) return { data: [], error: null }
    mockTicketReads.push(station)
    return mockTicketAnswer(station)
  }
  b.then = (ok, fail) => Promise.resolve(answer()).then(ok, fail)
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table), scopedUpdate: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({ fetchAllRows: makeQuery => makeQuery() }))
jest.mock('../../../supabaseClient', () => ({ supabase: {} }))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', pos_role: 'staff' }, hasPosAccess: () => true, posTeam: 'foh',
    isAdmin: false, isOwner: false, signOut: () => Promise.resolve(true),
  }),
}))
jest.mock('../posChime', () => ({
  playGuestAlert: () => {}, soundBlocked: () => false, unlockAudio: () => {}, primeAudio: () => {},
}))
jest.mock('../../../shared/releaseWatch', () => ({ useReleaseReload: () => {} }))
// The standing alert is not under test here, and jsdom has no ResizeObserver for its measured height.
jest.mock('../../../components/ArrivalAlert', () => ({ __esModule: true, default: () => null }))

// eslint-disable-next-line import/first
import KitchenDisplay from './KitchenDisplay'

const ticket = (id, station, table) => ({
  id, order_id: `o-${id}`, order_no: 12, table_name: table, station, items: [{ name: 'VEG MOMO', qty: 2 }],
  sent_at: new Date().toISOString(), status: 'new', started_at: null, ready_at: null,
  estimated_prep_minutes: null, pos_orders: { table_name: table },
})
const dead = { data: null, error: { message: 'TypeError: Failed to fetch' } }

const renderBoard = () => render(<MemoryRouter><KitchenDisplay /></MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  mockTicketReads.length = 0
  mockTicketAnswer = () => ({ data: [], error: null })
})
afterEach(() => jest.useRealTimers())

test('a first read that fails shows an error card, not an empty board or "(0)" columns', async () => {
  mockTicketAnswer = () => dead
  renderBoard()
  expect(await screen.findByText('Could not load the kitchen tickets')).toBeTruthy()
  expect(screen.getByText(/This is not an empty kitchen/)).toBeTruthy()
  expect(screen.getByText('TypeError: Failed to fetch')).toBeTruthy() // the detail, as fine print
  expect(screen.queryByText(/Nothing on the board/)).toBeNull()
  expect(screen.queryByText('(0)')).toBeNull()
  expect(screen.queryByText(/last successful check/)).toBeNull()
})

test('the board appears on the next good poll, and a later failure keeps it under the stale banner', async () => {
  jest.useFakeTimers()
  mockTicketAnswer = () => dead
  renderBoard()
  expect(await screen.findByText('Could not load the kitchen tickets')).toBeTruthy()

  mockTicketAnswer = () => ({ data: [ticket('t1', 'KOT', 'Table 5')], error: null })
  await act(async () => { jest.advanceTimersByTime(4000) })
  expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
  expect(screen.queryByText('Could not load the kitchen tickets')).toBeNull()

  mockTicketAnswer = () => dead
  await act(async () => { jest.advanceTimersByTime(4000) })
  expect(await screen.findByText(/Could not refresh the board — the tickets shown are from the last successful check/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
})

test('switching to Bar never leaves the kitchen\'s tickets under the bar heading when the bar read fails', async () => {
  mockTicketAnswer = station => (station === 'KOT' ? { data: [ticket('t1', 'KOT', 'Table 5')], error: null } : dead)
  renderBoard()
  expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
  expect(screen.getByText('Table 5')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Bar (BOT)' }))
  expect(await screen.findByText('Could not load the bar tickets')).toBeTruthy()
  expect(screen.queryByText('Table 5')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  expect(screen.queryByText(/Nothing on the board/)).toBeNull()
  expect(mockTicketReads).toEqual(['KOT', 'BOT'])
})
