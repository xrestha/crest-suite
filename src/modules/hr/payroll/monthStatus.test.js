import { attendanceGaps, pickStatusPeriod, ssfDeadline, unmarkedDaysFor, unmarkedWindow } from './monthStatus'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

const bhadra = { id: 'p5', bs_year: 2083, bs_month: 5 }
const ad = d => formatAd(bsToAd(2083, 5, d))

describe('attendanceGaps', () => {
  const today = { year: 2083, month: 5, day: 4 }

  it('counts only daily and hourly staff — a blank day is paid for monthly staff', () => {
    const employees = [
      { id: 'm', pay_basis: 'monthly' },
      { id: 'd', pay_basis: 'daily' },
    ]
    const r = attendanceGaps({ period: bhadra, employees, attendance: [], today })
    expect(r).toMatchObject({ wageStaff: 1, gaps: 4, staffWithGaps: 1, cutoff: 4 })
  })

  it('counts a current month to today, and marked days are not gaps', () => {
    const employees = [{ id: 'd', pay_basis: 'hourly' }]
    const attendance = [1, 2, 3].map(d => ({ employee_id: 'd', bs_day: d }))
    expect(attendanceGaps({ period: bhadra, employees, attendance, today }).gaps).toBe(1)
  })

  it('skips days before joining and after leaving', () => {
    const employees = [{ id: 'd', pay_basis: 'daily', join_date: ad(3), end_date: ad(3) }]
    expect(attendanceGaps({ period: bhadra, employees, attendance: [], today }).gaps).toBe(1)
  })

  it('says nothing about a month that has not started', () => {
    const r = attendanceGaps({ period: bhadra, employees: [{ id: 'd', pay_basis: 'daily' }], attendance: [], today: { year: 2083, month: 4, day: 30 } })
    expect(r).toMatchObject({ future: true, gaps: 0 })
  })

  it('counts every day of a past month', () => {
    const r = attendanceGaps({ period: bhadra, employees: [{ id: 'd', pay_basis: 'daily' }], attendance: [], today: { year: 2083, month: 6, day: 2 } })
    expect(r.gaps).toBe(r.cutoff)
    expect(r.cutoff).toBeGreaterThanOrEqual(29)
  })
})

describe('unmarkedDaysFor', () => {
  const today = { year: 2083, month: 5, day: 4 }
  const window = unmarkedWindow(bhadra, today)

  it('is null for monthly staff, whose blank day is paid', () => {
    expect(unmarkedDaysFor({ id: 'm', pay_basis: 'monthly' }, window, () => false)).toBeNull()
  })

  it('counts days employed, to today, with no mark', () => {
    const marked = new Set([1, 3])
    expect(unmarkedDaysFor({ id: 'd', pay_basis: 'daily' }, window, d => marked.has(d))).toBe(2)
    expect(unmarkedDaysFor({ id: 'h', pay_basis: 'hourly', join_date: ad(3) }, window, () => false)).toBe(2)
  })

  it('agrees with attendanceGaps, which counts through it', () => {
    const employees = [{ id: 'a', pay_basis: 'daily' }, { id: 'b', pay_basis: 'hourly', end_date: ad(2) }]
    const attendance = [{ employee_id: 'a', bs_day: 2 }]
    const marked = new Set(attendance.map(r => `${r.employee_id}:${r.bs_day}`))
    const each = employees.reduce((n, e) => n + unmarkedDaysFor(e, window, d => marked.has(`${e.id}:${d}`)), 0)
    expect(each).toBe(attendanceGaps({ period: bhadra, employees, attendance, today }).gaps)
    expect(each).toBe(5)
  })
})

describe('pickStatusPeriod', () => {
  const periods = [
    { id: 'ashwin', bs_year: 2083, bs_month: 6 },
    { id: 'bhadra', bs_year: 2083, bs_month: 5 },
    { id: 'shrawan', bs_year: 2083, bs_month: 4 },
  ]

  // S798 REPORTS-3: on 3 Ashwin with Bhadra's run a draft, the month being paid is Bhadra. It used to
  // pick Ashwin, the month still running, all through payroll week.
  it('shows last month while its payroll is not finalized', () => {
    const today = { year: 2083, month: 6, day: 3 }
    expect(pickStatusPeriod(periods, { shrawan: 'finalized', bhadra: 'draft' }, today).id).toBe('bhadra')
    expect(pickStatusPeriod(periods, { shrawan: 'finalized' }, today).id).toBe('bhadra')
    expect(pickStatusPeriod(periods, { shrawan: 'finalized', ashwin: 'finalized' }, today).id).toBe('bhadra')
  })

  it('moves to the running month once last month is finalized (H32: at Finalize, not at Mark paid)', () => {
    const today = { year: 2083, month: 6, day: 3 }
    expect(pickStatusPeriod(periods, { bhadra: 'finalized' }, today).id).toBe('ashwin')
    expect(pickStatusPeriod(periods, { ashwin: 'finalized', bhadra: 'finalized', shrawan: 'finalized' }, today).id).toBe('ashwin')
  })

  it('never picks a month that has not started', () => {
    const today = { year: 2083, month: 5, day: 30 }
    expect(pickStatusPeriod(periods, { shrawan: 'finalized' }, today).id).toBe('bhadra')
    expect(pickStatusPeriod(periods, {}, today).id).toBe('shrawan')
  })

  // The judge's case: with the running month finalized early, the old search walked back to the newest
  // month with no run — for a client that used IMS before HR, a month from before HR.
  it('never walks back past last month into months from before HR', () => {
    const withPreHr = [...periods, { id: 'ashadh', bs_year: 2083, bs_month: 3 }]
    expect(pickStatusPeriod(withPreHr, { bhadra: 'finalized', ashwin: 'finalized' }, { year: 2083, month: 6, day: 3 }).id).toBe('ashwin')
    // Mid-Bhadra with Shrawan finalized: Bhadra, never Ashadh.
    expect(pickStatusPeriod(withPreHr, { shrawan: 'finalized' }, { year: 2083, month: 5, day: 15 }).id).toBe('bhadra')
  })

  it('finds last month by year and month, across the year end and in any order', () => {
    const yearEnd = [{ id: 'baisakh', bs_year: 2084, bs_month: 1 }, { id: 'chaitra', bs_year: 2083, bs_month: 12 }].reverse()
    expect(pickStatusPeriod(yearEnd, {}, { year: 2084, month: 1, day: 2 }).id).toBe('chaitra')
    expect(pickStatusPeriod(yearEnd, { chaitra: 'finalized' }, { year: 2084, month: 1, day: 2 }).id).toBe('baisakh')
  })

  it('keeps last month when the running month has no period yet, and is null with neither', () => {
    expect(pickStatusPeriod(periods, { ashwin: 'finalized' }, { year: 2083, month: 7, day: 1 }).id).toBe('ashwin')
    expect(pickStatusPeriod(periods, {}, { year: 2083, month: 9, day: 1 })).toBeNull()
  })
})

describe('ssfDeadline', () => {
  it('falls due in the following month, rolling Chaitra into the next year', () => {
    expect(ssfDeadline(2083, 12, { year: 2083, month: 12, day: 1 })).toMatchObject({ year: 2084, month: 1 })
  })

  it('is due this month up to the deposit day, overdue after it', () => {
    expect(ssfDeadline(2083, 5, { year: 2083, month: 6, day: 25 })).toMatchObject({ dueThisMonth: true, overdue: false })
    expect(ssfDeadline(2083, 5, { year: 2083, month: 6, day: 26 })).toMatchObject({ dueThisMonth: false, overdue: true })
    expect(ssfDeadline(2083, 5, { year: 2083, month: 5, day: 30 })).toMatchObject({ dueThisMonth: false, overdue: false })
  })
})
