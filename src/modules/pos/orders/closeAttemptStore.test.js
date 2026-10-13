// S833: a payment try whose answer was lost survives a reload or a PIN lock on the tablet, for the login
// that pressed, and holds the bill for any other login until a read settles it.
import { CLOSE_LAND_GRACE_MS } from './closeAttempt'
import {
  keepOwnCloseAttempts, dropKeptCloseAttempt, restoreCloseAttempts, restoredFinalAfter, foreignCloseText,
  KEPT_CLOSE_MAX_AGE_MS,
} from './closeAttemptStore'

const LIMIT = 20000
const attempt = (over = {}) => ({
  orderId: 'o1', closeType: 'paid', tableId: 't1', where: 'Table 4', sent: { payMethod: 'Cash', tenders: [] },
  writesInFlight: 1, finalAfter: null, lastWriteAt: 1000, ...over,
})

beforeEach(() => localStorage.clear())

describe('keeping and restoring a login\'s own tries', () => {
  test('a kept try comes back whole for the login that pressed, with nothing in flight', () => {
    keepOwnCloseAttempts({ profileId: 'ram', profileName: 'Ram', clientId: 'c1', attempts: [attempt()], now: 2000 })
    const { own, foreign } = restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: 5000 })
    expect(foreign).toEqual([])
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ orderId: 'o1', closeType: 'paid', where: 'Table 4', writesInFlight: 0 })
    expect(own[0].sent).toEqual({ payMethod: 'Cash', tenders: [] })
  })

  test('another outlet\'s tries are left alone', () => {
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c2', attempts: [attempt()], now: 2000 })
    expect(restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: 3000 }).own).toEqual([])
  })

  test('keeping replaces only this login\'s tries at this outlet', () => {
    keepOwnCloseAttempts({ profileId: 'sita', profileName: 'Sita', clientId: 'c1', attempts: [attempt({ orderId: 'o2' })], now: 2000 })
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c1', attempts: [attempt()], now: 2000 })
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c1', attempts: [], now: 3000 })
    const asRam = restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: 4000 })
    expect(asRam.own).toEqual([])
    expect(asRam.foreign.map(f => f.orderId)).toEqual(['o2'])
  })

  test('a try older than a day is dropped', () => {
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c1', attempts: [attempt()], now: 0 })
    expect(restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: KEPT_CLOSE_MAX_AGE_MS + 1 }).own).toEqual([])
  })

  test('an unreadable store reads as nothing kept', () => {
    localStorage.setItem('crest_pos_close_attempts', '{not json')
    expect(restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: 1 })).toEqual({ own: [], foreign: [] })
  })
})

describe('another login\'s try on this tablet', () => {
  test('holds the bill, naming who pressed', () => {
    keepOwnCloseAttempts({ profileId: 'ram', profileName: 'Ram', clientId: 'c1', attempts: [attempt()], now: 2000 })
    const { own, foreign } = restoreCloseAttempts({ profileId: 'sita', clientId: 'c1', writeLimitMs: LIMIT, now: 3000 })
    expect(own).toEqual([])
    expect(foreign).toHaveLength(1)
    expect(foreign[0]).toMatchObject({ orderId: 'o1', foreign: true, profileId: 'ram', by: 'Ram', writesInFlight: 0 })
    expect(foreignCloseText(foreign[0])).toMatch(/^Ram pressed Confirm Payment on this bill/)
  })

  test('a nameless login is still named', () => {
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c1', attempts: [attempt({ closeType: 'void' })], now: 2000 })
    const [mark] = restoreCloseAttempts({ profileId: 'sita', clientId: 'c1', writeLimitMs: LIMIT, now: 3000 }).foreign
    expect(foreignCloseText(mark)).toMatch(/^Another login pressed Void/)
  })

  test('the login\'s own try on a bill wins over another login\'s', () => {
    keepOwnCloseAttempts({ profileId: 'ram', profileName: 'Ram', clientId: 'c1', attempts: [attempt()], now: 2000 })
    keepOwnCloseAttempts({ profileId: 'sita', clientId: 'c1', attempts: [attempt()], now: 2000 })
    const { own, foreign } = restoreCloseAttempts({ profileId: 'sita', clientId: 'c1', writeLimitMs: LIMIT, now: 3000 })
    expect(own).toHaveLength(1)
    expect(foreign).toEqual([])
  })

  test('dropping it forgets it for everyone', () => {
    keepOwnCloseAttempts({ profileId: 'ram', clientId: 'c1', attempts: [attempt()], now: 2000 })
    dropKeptCloseAttempt({ profileId: 'ram', clientId: 'c1', orderId: 'o1' })
    expect(restoreCloseAttempts({ profileId: 'ram', clientId: 'c1', writeLimitMs: LIMIT, now: 3000 }).own).toEqual([])
  })
})

describe('restoredFinalAfter — when "still open" becomes final after a reload', () => {
  test('a write cut off by the reload: the grace runs from the reload', () => {
    expect(restoredFinalAfter({ lastWriteAt: 1000, finalAfter: null }, 6000, LIMIT)).toBe(6000 + CLOSE_LAND_GRACE_MS)
  })

  test('a write that would have stopped at its own limit first: the grace runs from that limit', () => {
    expect(restoredFinalAfter({ lastWriteAt: 1000, finalAfter: null }, 90000, LIMIT)).toBe(1000 + LIMIT + CLOSE_LAND_GRACE_MS)
  })

  test('never earlier than the mark itself said', () => {
    expect(restoredFinalAfter({ lastWriteAt: 1000, finalAfter: 99999 }, 2000, LIMIT)).toBe(99999)
  })
})
