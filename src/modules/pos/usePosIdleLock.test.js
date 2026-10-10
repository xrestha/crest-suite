/**
 * The till's idle lock (S575, S754, S809 ACCESS-2). Idle time runs from the last real touch, and a touch
 * that arrives once the whole period has passed locks instead of buying another three minutes.
 */

import { renderHook, act } from '@testing-library/react'
import {
  usePosIdleLock, posIdleLockApplies, POS_IDLE_LOCK_MS,
  sessionIdFromToken, readLastInput, writeLastInput, IDLE_INPUT_KEY,
} from './usePosIdleLock'

describe('who the lock applies to (S809 ACCESS-2, owner decision Q4 a)', () => {
  const pin = { pinStaff: true, boundTablet: true }
  test('a Front of House PIN locks on the Kitchen Display, as on the till', () => {
    expect(posIdleLockApplies({ ...pin, stationTeam: false, path: '/pos/kds' })).toBe(true)
    expect(posIdleLockApplies({ ...pin, stationTeam: false, path: '/pos/orders' })).toBe(true)
  })
  test('a Kitchen or Bar login stays signed in on the Kitchen Display, and nowhere else', () => {
    expect(posIdleLockApplies({ ...pin, stationTeam: true, path: '/pos/kds' })).toBe(false)
    expect(posIdleLockApplies({ ...pin, stationTeam: true, path: '/dashboard' })).toBe(true)
  })
  test('an Owner or admin session (no pos_role) never locks, on the KDS or anywhere', () => {
    for (const path of ['/pos/kds', '/pos/orders', '/dashboard']) {
      expect(posIdleLockApplies({ pinStaff: false, boundTablet: true, stationTeam: false, path })).toBe(false)
    }
  })
  test('nothing locks on a machine that is not an activated till', () => {
    expect(posIdleLockApplies({ pinStaff: true, boundTablet: false, stationTeam: false, path: '/pos/orders' })).toBe(false)
  })
})

const LOCK = POS_IDLE_LOCK_MS
const noWarn = () => {}
const tap = () => act(() => { window.dispatchEvent(new Event('pointerdown')) })

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-10-09T10:00:00Z'))
})
afterEach(() => {
  jest.useRealTimers()
})

it('locks once the idle period has passed', () => {
  const onLock = jest.fn()
  renderHook(() => usePosIdleLock(true, noWarn, onLock))
  act(() => { jest.advanceTimersByTime(LOCK - 1) })
  expect(onLock).not.toHaveBeenCalled()
  act(() => { jest.advanceTimersByTime(1) })
  expect(onLock).toHaveBeenCalledTimes(1)
})

it('a touch inside the period starts it again', () => {
  const onLock = jest.fn()
  renderHook(() => usePosIdleLock(true, noWarn, onLock))
  act(() => { jest.advanceTimersByTime(LOCK - 1000) })
  tap()
  act(() => { jest.advanceTimersByTime(LOCK - 1000) })
  expect(onLock).not.toHaveBeenCalled()
  act(() => { jest.advanceTimersByTime(1000) })
  expect(onLock).toHaveBeenCalledTimes(1)
})

it('a touch after the period has passed locks, even when the lock timer has not run yet', () => {
  const onLock = jest.fn()
  renderHook(() => usePosIdleLock(true, noWarn, onLock))
  // The clock moves on and no timer runs: a machine asleep while its tab never went hidden. The
  // first tap on waking (on the Kitchen Display, the tap on Exit) must not renew the absent login.
  jest.setSystemTime(Date.now() + LOCK + 60 * 1000)
  tap()
  expect(onLock).toHaveBeenCalledTimes(1)
  // The overdue timer was cleared by the lock, so it cannot lock a second time.
  act(() => { jest.runOnlyPendingTimers() })
  expect(onLock).toHaveBeenCalledTimes(1)
})

it('touches after the lock do nothing more', () => {
  const onLock = jest.fn()
  renderHook(() => usePosIdleLock(true, noWarn, onLock))
  act(() => { jest.advanceTimersByTime(LOCK) })
  expect(onLock).toHaveBeenCalledTimes(1)
  tap()
  act(() => { jest.advanceTimersByTime(LOCK * 2) })
  expect(onLock).toHaveBeenCalledTimes(1)
})

it('does nothing while disabled, and starts a full period when enabled', () => {
  const onLock = jest.fn()
  const { rerender } = renderHook(({ on }) => usePosIdleLock(on, noWarn, onLock), { initialProps: { on: false } })
  act(() => { jest.advanceTimersByTime(LOCK * 3) })
  tap()
  expect(onLock).not.toHaveBeenCalled()
  rerender({ on: true })
  act(() => { jest.advanceTimersByTime(LOCK - 1) })
  expect(onLock).not.toHaveBeenCalled()
  act(() => { jest.advanceTimersByTime(1) })
  expect(onLock).toHaveBeenCalledTimes(1)
})

// S809 ACCESS-6: the idle clock survives a page load. A tablet left signed in whose browser was killed,
// that restarted, or that took a release came back with three fresh minutes in the absent waiter's name.
describe('a page load inside a session (S809 ACCESS-6)', () => {
  beforeEach(() => { window.localStorage.clear() })

  const tokenWith = claims => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`

  test('the session id is read from the access token, and nothing else counts as one', () => {
    expect(sessionIdFromToken(tokenWith({ sub: 'u-1', session_id: 'sid-1' }))).toBe('sid-1')
    expect(sessionIdFromToken(tokenWith({ sub: 'u-1' }))).toBeNull()
    expect(sessionIdFromToken('not a token')).toBeNull()
    expect(sessionIdFromToken(undefined)).toBeNull()
  })

  test('the last input is kept per session, and another session reads nothing', () => {
    writeLastInput('sid-1', 1234)
    expect(readLastInput('sid-1')).toBe(1234)
    expect(readLastInput('sid-2')).toBeNull()
    expect(readLastInput(null)).toBeNull()
    window.localStorage.setItem(IDLE_INPUT_KEY, 'not json')
    expect(readLastInput('sid-1')).toBeNull()
  })

  it('resumes from the last input: only what is left of the period is armed', () => {
    writeLastInput('sid-1', Date.now() - (LOCK - 30 * 1000))
    const onLock = jest.fn()
    renderHook(() => usePosIdleLock(true, noWarn, onLock, LOCK, 'sid-1'))
    act(() => { jest.advanceTimersByTime(30 * 1000 - 1) })
    expect(onLock).not.toHaveBeenCalled()
    act(() => { jest.advanceTimersByTime(1) })
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('locks at once when the period was already spent before the page loaded', () => {
    writeLastInput('sid-1', Date.now() - LOCK - 60 * 60 * 1000)
    const onLock = jest.fn()
    renderHook(() => usePosIdleLock(true, noWarn, onLock, LOCK, 'sid-1'))
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('a new sign-in starts a full period, whatever an earlier session left', () => {
    writeLastInput('sid-old', Date.now() - LOCK * 10)
    const onLock = jest.fn()
    renderHook(() => usePosIdleLock(true, noWarn, onLock, LOCK, 'sid-new'))
    act(() => { jest.advanceTimersByTime(LOCK - 1) })
    expect(onLock).not.toHaveBeenCalled()
    expect(readLastInput('sid-new')).not.toBeNull()
    act(() => { jest.advanceTimersByTime(1) })
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('a touch is kept even while the lock is off, so leaving the Kitchen Display starts from it', () => {
    const onLock = jest.fn()
    const { rerender } = renderHook(({ on }) => usePosIdleLock(on, noWarn, onLock, LOCK, 'sid-1'), { initialProps: { on: false } })
    act(() => { jest.advanceTimersByTime(LOCK * 3) })
    tap()
    expect(readLastInput('sid-1')).toBe(Date.now())
    rerender({ on: true })
    act(() => { jest.advanceTimersByTime(LOCK - 1) })
    expect(onLock).not.toHaveBeenCalled()
    act(() => { jest.advanceTimersByTime(1) })
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('without a session id nothing is kept, as before', () => {
    const onLock = jest.fn()
    renderHook(() => usePosIdleLock(true, noWarn, onLock))
    tap()
    expect(window.localStorage.getItem(IDLE_INPUT_KEY)).toBeNull()
  })
})
