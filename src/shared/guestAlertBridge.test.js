/**
 * The app-wide guest-order alert, and what the till screen tells it (S809 3c, FLOOR-KITCHEN-1).
 *
 * The shell's banner used to be off on the whole of /pos/orders, on the reading that "Orders already
 * shows it". Only the floor does: the order screen shows the table on screen and nothing else. And
 * the shell kept ringing on the very till that had accepted a guest order, until it saved (S809.4).
 */

import { act, renderHook } from '@testing-library/react'
import {
  shellGuestAlertPlan, guestAlertTitle, guestAlertDetail,
  publishTillGuestView, clearTillGuestView, useTillGuestView,
  muteGuestAlerts, useGuestAlertMute, resetGuestAlertBridge, GUEST_ALERT_MUTE_MS,
} from './guestAlertBridge'

const T7 = { id: 'r7', tableId: 't7', tableName: 'Table 7', createdAt: '2026-10-10T09:00:00Z' }
const T3 = { id: 'r3', tableId: 't3', tableName: 'Table 3', createdAt: '2026-10-10T09:01:00Z' }
const view = (v, openTableId = null) => ({ view: v, openTableId, heldIds: new Set() })

afterEach(() => { act(() => resetGuestAlertBridge()) })

describe('shellGuestAlertPlan', () => {
  it('stays silent and hidden on the Kitchen Display, and when nothing waits', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/kds', till: null, requests: [T7] })).toMatchObject({ sound: false, banner: false })
    expect(shellGuestAlertPlan({ pathname: '/stock', till: null, requests: [] })).toMatchObject({ sound: false, banner: false })
  })

  it('rings with Open Orders on any other page', () => {
    expect(shellGuestAlertPlan({ pathname: '/stock', till: null, requests: [T7] })).toEqual({ sound: true, banner: true, where: 'shell' })
  })

  it('on the Orders floor keeps ringing but leaves the banner to the floor', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: view('floor'), requests: [T7] })).toEqual({ sound: true, banner: false, where: 'shell' })
  })

  it('on the order screen says another table is waiting, without an Open Orders that reopens it', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: view('order', 't2'), requests: [T7] })).toEqual({ sound: true, banner: true, where: 'order-screen' })
    // Table 7 is on screen too: still "another table", since Table 3 is waiting.
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: view('order', 't7'), requests: [T7, T3] }).where).toBe('order-screen')
  })

  it('names the strip below when every waiting order is the table on screen', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: view('order', 't7'), requests: [T7] })).toEqual({ sound: true, banner: true, where: 'this-table' })
    expect(shellGuestAlertPlan({ pathname: '/pos/billing', till: view('order', 't7'), requests: [T7] }).where).toBe('this-table')
  })

  it('keeps Open Orders on the Billing station, list and bill alike', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/billing', till: view('bills'), requests: [T7] })).toEqual({ sound: true, banner: true, where: 'shell' })
    expect(shellGuestAlertPlan({ pathname: '/pos/billing', till: view('order', 't2'), requests: [T7] }).where).toBe('shell')
  })

  it('treats a takeaway on the order screen as "another table"', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: view('order', null), requests: [T7] }).where).toBe('order-screen')
  })

  it('rings with the banner before the till screen has said which view is up', () => {
    expect(shellGuestAlertPlan({ pathname: '/pos/orders', till: null, requests: [T7] })).toEqual({ sound: true, banner: true, where: 'shell' })
  })
})

describe('the banner words', () => {
  it('names one table, or counts them', () => {
    expect(guestAlertTitle([T7])).toBe('New guest order — Table 7')
    expect(guestAlertTitle([T7, T3])).toBe('2 new guest orders — Table 7, Table 3')
    expect(guestAlertTitle([{ id: 'x' }])).toBe('New guest order — a table')
  })

  it('says how long, and what to do where the reader is', () => {
    expect(guestAlertDetail({ waitedMs: 20000 })).toBe('Just in. Nothing reaches the kitchen until a staff member accepts it.')
    expect(guestAlertDetail({ waitedMs: 150000 })).toBe('Waiting 2 min. Nothing reaches the kitchen until a staff member accepts it.')
    expect(guestAlertDetail({ waitedMs: 0, where: 'order-screen' })).toMatch(/go back to the floor \(← at the top left\) and tap the table\.$/)
    expect(guestAlertDetail({ waitedMs: 0, where: 'this-table' })).toMatch(/Accept or Dismiss it just below the top bar\.$/)
    expect(guestAlertDetail({ waitedMs: 0, where: 'pin' })).toBe('Just in. Nothing reaches the kitchen until a staff member signs in and accepts it.')
  })

  it('says when the browser is holding the sound', () => {
    expect(guestAlertDetail({ waitedMs: 0, where: 'pin', soundOff: true }))
      .toBe('Just in. Nothing reaches the kitchen until a staff member signs in and accepts it. The sound is off on this tablet until someone taps the screen.')
  })
})

describe('the till view the shell reads', () => {
  it('is null until the till screen publishes, and null again once it has gone', () => {
    const { result } = renderHook(() => useTillGuestView())
    expect(result.current).toBeNull()
    act(() => publishTillGuestView({ view: 'order', openTableId: 't7', heldIds: ['r7'] }))
    expect(result.current.view).toBe('order')
    expect(result.current.openTableId).toBe('t7')
    expect([...result.current.heldIds]).toEqual(['r7'])
    act(() => clearTillGuestView())
    expect(result.current).toBeNull()
  })

  it('notifies nobody for a publish that changes nothing (the till publishes after every render)', () => {
    let renders = 0
    renderHook(() => { renders += 1; return useTillGuestView() })
    act(() => publishTillGuestView({ view: 'floor', heldIds: ['a', 'b'] }))
    const after = renders
    act(() => publishTillGuestView({ view: 'floor', heldIds: ['b', 'a'] }))
    act(() => publishTillGuestView({ view: 'floor', openTableId: undefined, heldIds: ['a', 'b'] }))
    expect(renders).toBe(after)
  })
})

describe('the one Mute', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it('mutes every reader for five minutes, then lets the sound back', () => {
    const a = renderHook(() => useGuestAlertMute())
    const b = renderHook(() => useGuestAlertMute())
    expect(a.result.current.muted).toBe(false)
    act(() => a.result.current.mute())
    expect(a.result.current.muted).toBe(true)
    expect(b.result.current.muted).toBe(true)
    act(() => { jest.advanceTimersByTime(GUEST_ALERT_MUTE_MS - 1000) })
    expect(b.result.current.muted).toBe(true)
    act(() => { jest.advanceTimersByTime(1000) })
    expect(a.result.current.muted).toBe(false)
    expect(b.result.current.muted).toBe(false)
  })

  it('a second press starts the five minutes again', () => {
    const { result } = renderHook(() => useGuestAlertMute())
    act(() => muteGuestAlerts())
    act(() => { jest.advanceTimersByTime(GUEST_ALERT_MUTE_MS - 60000) })
    act(() => muteGuestAlerts())
    act(() => { jest.advanceTimersByTime(120000) })
    expect(result.current.muted).toBe(true)
  })
})
