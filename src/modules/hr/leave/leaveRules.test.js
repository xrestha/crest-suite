import { findOverlappingRequest, finalizedMonthsFor, quotaOverrun } from './leaveRules'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
const req = over => ({ id: 'r1', employee_id: 'e1', leave_type_id: 't1', status: 'approved', day_type: 'full', ...over })

describe('findOverlappingRequest', () => {
  const existing = req({ start_date: '2026-09-10', end_date: '2026-09-14' })

  it('finds an open request sharing a day, including a range touching only its last day', () => {
    expect(findOverlappingRequest([existing], { employeeId: 'e1', startDate: '2026-09-14', endDate: '2026-09-20' })).toBe(existing)
    expect(findOverlappingRequest([existing], { employeeId: 'e1', startDate: '2026-09-01', endDate: '2026-09-10' })).toBe(existing)
  })

  it('ignores the day after, another employee, a decided request and the request itself', () => {
    expect(findOverlappingRequest([existing], { employeeId: 'e1', startDate: '2026-09-15', endDate: '2026-09-16' })).toBeNull()
    expect(findOverlappingRequest([existing], { employeeId: 'e2', startDate: '2026-09-12', endDate: '2026-09-12' })).toBeNull()
    expect(findOverlappingRequest([{ ...existing, status: 'cancelled' }], { employeeId: 'e1', startDate: '2026-09-12', endDate: '2026-09-12' })).toBeNull()
    expect(findOverlappingRequest([existing], { employeeId: 'e1', startDate: '2026-09-12', endDate: '2026-09-12', excludeId: 'r1' })).toBeNull()
  })

  it('treats a pending request as open', () => {
    expect(findOverlappingRequest([{ ...existing, status: 'pending' }], { employeeId: 'e1', startDate: '2026-09-12', endDate: '2026-09-12' })).not.toBeNull()
  })
})

describe('finalizedMonthsFor', () => {
  const periods = [{ id: 'p5', bs_year: 2083, bs_month: 5 }, { id: 'p6', bs_year: 2083, bs_month: 6 }]

  it('names only the months whose payroll is finalized', () => {
    const r = req({ start_date: ad(2083, 5, 30), end_date: ad(2083, 6, 2) })
    expect(finalizedMonthsFor(r, periods, new Set(['p5']))).toEqual([{ bsYear: 2083, bsMonth: 5 }])
    expect(finalizedMonthsFor(r, periods, new Set())).toEqual([])
  })

  it('a month with no period yet is not locked — nothing has been paid for it', () => {
    const r = req({ start_date: ad(2083, 7, 1), end_date: ad(2083, 7, 3) })
    expect(finalizedMonthsFor(r, periods, new Set(['p5', 'p6']))).toEqual([])
  })
})

describe('quotaOverrun', () => {
  const type = { id: 't1', annual_quota: 18 }
  const taken = req({ start_date: ad(2083, 2, 1), end_date: ad(2083, 2, 16), days: 16 })

  it('reports how far a pending request takes the balance past the quota', () => {
    const pending = req({ id: 'r2', status: 'pending', start_date: ad(2083, 3, 1), end_date: ad(2083, 3, 4), days: 4 })
    expect(quotaOverrun({ requests: [taken, pending], settlements: [], leaveType: type, request: pending }))
      .toMatchObject({ quota: 18, after: 20, over: 2, bsYear: 2083 })
  })

  it('is null within the quota, and for an uncapped type', () => {
    const pending = req({ id: 'r2', status: 'pending', start_date: ad(2083, 3, 1), end_date: ad(2083, 3, 2), days: 2 })
    expect(quotaOverrun({ requests: [taken, pending], settlements: [], leaveType: type, request: pending })).toBeNull()
    expect(quotaOverrun({ requests: [taken], settlements: [], leaveType: { id: 't1', annual_quota: 0 }, request: pending })).toBeNull()
  })

  it('counts a request in the BS year it starts in, not the year on screen', () => {
    const nextYear = req({ id: 'r3', status: 'pending', start_date: ad(2084, 1, 5), end_date: ad(2084, 1, 9), days: 5 })
    expect(quotaOverrun({ requests: [taken, nextYear], settlements: [], leaveType: type, request: nextYear })).toBeNull()
  })
})
