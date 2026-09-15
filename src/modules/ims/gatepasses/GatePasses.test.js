import { gatePassDayStartMs } from './GatePasses'

// GatePasses.jsx imports AuthContext/scopedDb (and POS parking's modal), which import the real
// supabaseClient — mock it so this test exercises only the pure day helper (S756, D27).
// jest.mock is hoisted above the import by babel-jest, so the mock is in place before it loads.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

const at = iso => Date.parse(iso)

describe('gatePassDayStartMs — the gate-pass day ends at 6 AM Nepal time', () => {
  test('after 6 AM, the day began at 6 AM today', () => {
    expect(gatePassDayStartMs(at('2026-09-15T07:00:00+05:45'))).toBe(at('2026-09-15T06:00:00+05:45'))
    expect(gatePassDayStartMs(at('2026-09-15T23:30:00+05:45'))).toBe(at('2026-09-15T06:00:00+05:45'))
  })

  test('between midnight and 6 AM, the day still began at 6 AM yesterday', () => {
    // A van logged in at 11:30 PM is not stale at 12:30 AM — the viewer-midnight sweep closed it.
    const start = gatePassDayStartMs(at('2026-09-16T00:30:00+05:45'))
    expect(start).toBe(at('2026-09-15T06:00:00+05:45'))
    expect(at('2026-09-15T23:30:00+05:45') < start).toBe(false)
    expect(gatePassDayStartMs(at('2026-09-16T05:59:00+05:45'))).toBe(at('2026-09-15T06:00:00+05:45'))
  })

  test('a pass issued at 3 AM is stale once 6 AM has passed', () => {
    const start = gatePassDayStartMs(at('2026-09-16T06:01:00+05:45'))
    expect(start).toBe(at('2026-09-16T06:00:00+05:45'))
    expect(at('2026-09-16T03:00:00+05:45') < start).toBe(true)
  })

  test('the boundary is Nepal time, whatever the instant is written in', () => {
    // 00:30 UTC is 06:15 in Kathmandu: the day has already rolled over there.
    expect(gatePassDayStartMs(at('2026-09-16T00:30:00Z'))).toBe(at('2026-09-16T06:00:00+05:45'))
  })
})
