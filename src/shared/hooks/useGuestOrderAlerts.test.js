/**
 * The app-wide guest-order alert's list (S763), and what S809 3c changed in it.
 *
 * S809.4: the till that accepted a guest order kept hearing the alarm for it until it saved, because
 * the request still waits in the database until the save marks it. The till now says which orders it
 * holds, and those are neither announced nor counted toward the wait that turns the banner red.
 */

import { renderHook, waitFor, act } from '@testing-library/react'
import { useGuestOrderAlerts, ESCALATE_MS } from './useGuestOrderAlerts'
import { resetGuestAlertBridge } from '../guestAlertBridge'

let mockRows = []
let mockRpcAnswer = { data: [], error: null }
const mockRpcCalls = []
// One object for the whole file: scopedFrom is an effect dependency, so it must keep its identity.
const mockScoped = {
  clientId: 'c-1',
  scopedFrom: () => ({ eq: () => ({ order: () => Promise.resolve({ data: mockRows, error: null }) }) }),
}
jest.mock('./useScopedDb', () => ({ useScopedDb: () => mockScoped }))
jest.mock('../../supabaseClient', () => ({
  supabase: { rpc: (name, args) => { mockRpcCalls.push([name, args]); return Promise.resolve(mockRpcAnswer) } },
}))

const ago = ms => new Date(Date.now() - ms).toISOString()

beforeEach(() => {
  mockRows = []
  mockRpcAnswer = { data: [], error: null }
  mockRpcCalls.length = 0
})
afterEach(() => { act(() => resetGuestAlertBridge()) })

describe('a signed-in session', () => {
  it('lists the waiting orders and how long the oldest has waited', async () => {
    mockRows = [
      { id: 'r1', table_id: 't1', created_at: ago(4 * 60000), pos_tables: { name: 'Table 1' } },
      { id: 'r2', table_id: 't2', created_at: ago(60000), pos_tables: { name: 'Table 2' } },
    ]
    const { result } = renderHook(() => useGuestOrderAlerts(true))
    await waitFor(() => expect(result.current.requests).toHaveLength(2))
    expect(result.current.requests.map(r => r.tableName)).toEqual(['Table 1', 'Table 2'])
    expect(result.current.urgent).toBe(true)
  })

  it('leaves out an order this till already holds, from the list and from the wait (S809.4)', async () => {
    mockRows = [
      { id: 'r1', table_id: 't1', created_at: ago(ESCALATE_MS + 60000), pos_tables: { name: 'Table 1' } },
      { id: 'r2', table_id: 't2', created_at: ago(60000), pos_tables: { name: 'Table 2' } },
    ]
    const { result, rerender } = renderHook(({ held }) => useGuestOrderAlerts(true, { heldIds: held }), {
      initialProps: { held: new Set(['r1']) },
    })
    await waitFor(() => expect(result.current.requests).toHaveLength(1))
    expect(result.current.requests[0].id).toBe('r2')
    expect(result.current.urgent).toBe(false)
    expect(result.current.waitedMs).toBeLessThan(ESCALATE_MS)

    // Walked away without saving: the till lets go, and the order is announced again.
    rerender({ held: new Set() })
    expect(result.current.requests).toHaveLength(2)
    expect(result.current.urgent).toBe(true)
  })

  it('says nothing when switched off', async () => {
    mockRows = [{ id: 'r1', table_id: 't1', created_at: ago(1000), pos_tables: { name: 'Table 1' } }]
    const { result } = renderHook(() => useGuestOrderAlerts(false))
    await act(async () => {})
    expect(result.current.requests).toEqual([])
  })
})

describe('the PIN screen, asking through the tablet\'s key (S809 3c)', () => {
  const device = { clientId: 'c-1', deviceId: 'd-1', deviceSecret: 's' }

  it('asks get_pos_device_guest_alerts and lists table and time only', async () => {
    mockRpcAnswer = { data: [{ table_name: 'Table 7', waiting_since: ago(30000) }], error: null }
    const { result } = renderHook(() => useGuestOrderAlerts(true, { device }))
    await waitFor(() => expect(result.current.requests).toHaveLength(1))
    expect(result.current.requests[0]).toMatchObject({ tableName: 'Table 7', tableId: null })
    expect(mockRpcCalls[0]).toEqual(['get_pos_device_guest_alerts', { p_client_id: 'c-1', p_device_id: 'd-1', p_device_secret: 's' }])
  })

  it('asks nothing, of anyone, with an incomplete key', async () => {
    mockRows = [{ id: 'r1', table_id: 't1', created_at: ago(1000), pos_tables: { name: 'Table 1' } }]
    const { result } = renderHook(() => useGuestOrderAlerts(true, { device: { clientId: 'c-1', deviceId: 'd-1', deviceSecret: null } }))
    await act(async () => {})
    expect(result.current.requests).toEqual([])
    expect(mockRpcCalls).toEqual([])
  })

  it('goes quiet when the key is refused', async () => {
    mockRpcAnswer = { data: [{ table_name: 'Table 7', waiting_since: ago(30000) }], error: null }
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useGuestOrderAlerts(true, { device }))
      await act(async () => {})
      expect(result.current.requests).toHaveLength(1)
      mockRpcAnswer = { data: null, error: { message: 'pos_device_not_active', code: '28000' } }
      await act(async () => { jest.advanceTimersByTime(15000) })
      expect(result.current.requests).toEqual([])
      const asked = mockRpcCalls.length
      await act(async () => { jest.advanceTimersByTime(45000) })
      expect(mockRpcCalls.length).toBe(asked)
    } finally {
      jest.useRealTimers()
    }
  })
})
