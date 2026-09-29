import { gatePassDayStartMs, settleSweep } from './GatePasses'

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

// S792 (COSTS-12): two devices open Gate Passes after 6 AM and both sweep the same stale passes.
describe('settleSweep', () => {
  const nowIso = '2026-09-16T01:00:00.000Z'
  const open = id => ({ id, status: 'open', time_in: '2026-09-15T10:00:00Z', auto_closed: false })
  const today = { id: 't', status: 'open', time_in: '2026-09-16T00:50:00Z' }
  const passes = [today, open('a'), open('b'), open('c')]

  test('the device whose update closed them shows them closed, and nothing is still open', () => {
    const r = settleSweep(passes, { staleIds: ['a', 'b', 'c'], closedIds: ['a', 'b', 'c'], nowIso, reread: null })
    expect(r.stillOpen).toBe(0)
    expect(r.passes.map(x => x.status)).toEqual(['open', 'closed', 'closed', 'closed'])
    expect(r.passes[1]).toMatchObject({ time_out: nowIso, auto_closed: true })
  })

  test('the device that lost the race shows what the other device wrote, with no false warning', () => {
    const other = [
      { ...open('a'), status: 'closed', auto_closed: true, time_out: '2026-09-16T00:59:59Z' },
      { ...open('b'), status: 'closed', auto_closed: true, time_out: '2026-09-16T00:59:59Z' },
      { ...open('c'), status: 'voided' },
    ]
    const r = settleSweep(passes, { staleIds: ['a', 'b', 'c'], closedIds: [], nowIso, reread: other })
    expect(r.stillOpen).toBe(0)
    expect(r.passes.map(x => x.status)).toEqual(['open', 'closed', 'closed', 'voided'])
    expect(r.passes[1].time_out).toBe('2026-09-16T00:59:59Z')
  })

  test('a pass that is really still open after the re-read is counted, so the warning stays true', () => {
    const r = settleSweep(passes, { staleIds: ['a', 'b', 'c'], closedIds: ['a'], nowIso, reread: [open('b'), { ...open('c'), status: 'closed' }] })
    expect(r.stillOpen).toBe(1)
    expect(r.passes.find(x => x.id === 'b').status).toBe('open')
  })

  test('a failed re-read leaves the unmatched passes as they were and counts them', () => {
    const r = settleSweep(passes, { staleIds: ['a', 'b', 'c'], closedIds: ['a'], nowIso, reread: null })
    expect(r.stillOpen).toBe(2)
    expect(r.passes.map(x => x.status)).toEqual(['open', 'closed', 'open', 'open'])
  })

  test('a pass gone from a successful re-read leaves the list', () => {
    const r = settleSweep(passes, { staleIds: ['a', 'b', 'c'], closedIds: ['a', 'b'], nowIso, reread: [] })
    expect(r.stillOpen).toBe(0)
    expect(r.passes.map(x => x.id)).toEqual(['t', 'a', 'b'])
  })
})
