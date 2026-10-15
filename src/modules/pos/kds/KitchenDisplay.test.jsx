/**
 * The Kitchen Display never shows a board it did not read (S842).
 *
 * A failed FIRST read used to say "Nothing on the board right now… no refresh needed" over three
 * "(0)" columns, under a banner citing a "last successful check" there never was. And a front-of-house
 * login switching Kitchen → Bar whose bar read failed kept the kitchen's tickets on screen under
 * "Bar (BOT)", with live Start buttons. Each read applied now records the station it was for, a switch
 * clears the board, and until this station's read lands the board is an error card or "Loading…".
 *
 * And it forgets a ticket id once its read no longer has it (POS audit, 2026-10-15): the board is
 * opened once and reloads only for a release, so the ids it asked to serve and the voided cards it
 * remembers grew all day.
 */

import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The tickets read's answer per station, set per test. A function so a test can change it between polls.
let mockTicketAnswer = () => ({ data: [], error: null })
const mockTicketReads = []
// The voided-tickets read's answer per station, and every write the board sends (its patch).
let mockVoidAnswer = () => ({ data: [], error: null })
const mockUpdates = []

// One chainable, awaitable builder: records the station and which read it is, answers on `then`.
function mockBuilder(table, patch) {
  const q = { table, filters: [] }
  const b = {}
  for (const op of ['eq', 'in', 'gte', 'order', 'limit', 'select', 'not']) {
    b[op] = (...args) => { q.filters.push([op, ...args]); return b }
  }
  const answer = () => {
    if (table !== 'pos_kot_log') return { data: [], error: null }
    if (patch) { mockUpdates.push(patch); return { data: [], error: null } }
    const station = q.filters.find(f => f[0] === 'eq' && f[1] === 'station')?.[2]
    const voided = q.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'cancelled')
    if (voided) return mockVoidAnswer(station)
    mockTicketReads.push(station)
    return mockTicketAnswer(station)
  }
  b.then = (ok, fail) => Promise.resolve(answer()).then(ok, fail)
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table), scopedUpdate: (table, patch) => mockBuilder(table, patch) }
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
import KitchenDisplay, { withoutIds } from './KitchenDisplay'

const ticket = (id, station, table) => ({
  id, order_id: `o-${id}`, order_no: 12, table_name: table, station, items: [{ name: 'VEG MOMO', qty: 2 }],
  sent_at: new Date().toISOString(), status: 'new', started_at: null, ready_at: null,
  estimated_prep_minutes: null, pos_orders: { table_name: table },
})
const dead = { data: null, error: { message: 'TypeError: Failed to fetch' } }
// A ticket of a voided order, as the third read returns it (cancelled by the void, S817 4i).
const voided = (id, station, table) => ({
  ...ticket(id, station, table), status: 'cancelled', cancelled_at: new Date().toISOString(),
  pos_orders: { status: 'voided', table_name: table },
})
// Four-second polls, each one's read settled before the next.
async function pollFor(ms) {
  for (let t = 0; t < ms; t += 4000) await act(async () => { jest.advanceTimersByTime(4000) })
}
const servedAsks = () => mockUpdates.filter(p => p.status === 'served').length
const okButton = () => screen.queryByRole('button', { name: /OK, take the voided ticket for Table 7/ })

const renderBoard = () => render(<MemoryRouter><KitchenDisplay /></MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  mockTicketReads.length = 0
  mockTicketAnswer = () => ({ data: [], error: null })
  mockVoidAnswer = () => ({ data: [], error: null })
  mockUpdates.length = 0
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

describe('the ids the board remembers are forgotten once their read no longer has them (POS audit 2026-10-15)', () => {
  test('withoutIds drops the gone ids from a Set or a Map, and hands back the same one when none is there', () => {
    const set = new Set(['a', 'b', 'c'])
    expect([...withoutIds(set, ['b', 'z'])]).toEqual(['a', 'c'])
    expect(set.size).toBe(3) // a copy: React state is never changed in place
    expect(withoutIds(set, ['z'])).toBe(set)
    expect(withoutIds(set, [])).toBe(set)
    const map = new Map([['a', 1], ['b', 2]])
    expect([...withoutIds(map, ['a'])]).toEqual([['b', 2]])
  })

  test('a Ready ticket is asked to be served once while it stays in Ready, and forgotten once it leaves', async () => {
    jest.useFakeTimers()
    const at = new Date().toISOString()
    const ready = { ...ticket('r1', 'KOT', 'Table 3'), status: 'ready', started_at: at, ready_at: at }
    let inReady = true
    mockTicketAnswer = () => ({ data: inReady ? [ready] : [], error: null })
    renderBoard()
    expect(await screen.findByRole('button', { name: 'Served' })).toBeTruthy()

    await pollFor(10 * 60 * 1000)
    expect(servedAsks()).toBe(1)
    // Reads that still show it in Ready (they left before the serve landed) never ask again.
    await pollFor(60 * 1000)
    expect(servedAsks()).toBe(1)

    // It leaves Ready, and the board lets go of it. A ticket never comes back to Ready; this one does
    // only so the test can see that nothing is held for it any more: it is watched for ten minutes
    // afresh and asked again. Before the fix the id stayed in the set for the rest of the day.
    inReady = false
    await pollFor(4000)
    inReady = true
    await pollFor(4000)
    expect(servedAsks()).toBe(1)
    await pollFor(10 * 60 * 1000)
    expect(servedAsks()).toBe(2)
  })

  test('a voided card a cook tapped OK on stays off while its read has it, a trip to Bar and back included', async () => {
    jest.useFakeTimers()
    mockVoidAnswer = station => ({ data: station === 'KOT' ? [voided('v1', 'KOT', 'Table 7')] : [], error: null })
    renderBoard()
    await screen.findByRole('button', { name: /OK, take the voided ticket for Table 7/ })
    fireEvent.click(okButton())
    expect(okButton()).toBeNull()
    await pollFor(8000)
    expect(okButton()).toBeNull()

    // The bar's read has no voids. It must not make the board forget the kitchen's.
    fireEvent.click(screen.getByRole('button', { name: 'Bar (BOT)' }))
    await pollFor(8000)
    fireEvent.click(screen.getByRole('button', { name: 'Kitchen (KOT)' }))
    await pollFor(8000)
    expect(mockTicketReads).toContain('BOT')
    expect(mockTicketReads[mockTicketReads.length - 1]).toBe('KOT')
    expect(okButton()).toBeNull()
  })

  test('a voided card its read no longer has is forgotten, the OK tapped on it included', async () => {
    jest.useFakeTimers()
    let inRead = true
    mockVoidAnswer = station => ({ data: inRead && station === 'KOT' ? [voided('v1', 'KOT', 'Table 7')] : [], error: null })
    renderBoard()
    await screen.findByRole('button', { name: /OK, take the voided ticket for Table 7/ })
    fireEvent.click(okButton())
    expect(okButton()).toBeNull()

    // Past the read window. A void never comes back into it; this one does only to show the screen
    // kept nothing for it (before the fix its OK and first-seen time were held all day).
    inRead = false
    await pollFor(4000)
    inRead = true
    await pollFor(4000)
    expect(okButton()).toBeTruthy()
  })
})
