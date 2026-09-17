import { attendanceGaps, pickStatusPeriod, ssfDeadline } from './monthStatus'
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

describe('pickStatusPeriod', () => {
  const periods = [
    { id: 'ashwin', bs_year: 2083, bs_month: 6 },
    { id: 'bhadra', bs_year: 2083, bs_month: 5 },
    { id: 'shrawan', bs_year: 2083, bs_month: 4 },
  ]

  it('takes the newest started month not yet finalized', () => {
    const today = { year: 2083, month: 6, day: 3 }
    expect(pickStatusPeriod(periods, { shrawan: 'finalized', bhadra: 'draft' }, today).id).toBe('ashwin')
    expect(pickStatusPeriod(periods, { shrawan: 'finalized', ashwin: 'finalized' }, today).id).toBe('bhadra')
  })

  it('never picks a month that has not started', () => {
    const today = { year: 2083, month: 5, day: 30 }
    expect(pickStatusPeriod(periods, {}, today).id).toBe('bhadra')
  })

  it('falls back to the newest started month when all are finalized', () => {
    const today = { year: 2083, month: 6, day: 3 }
    expect(pickStatusPeriod(periods, { ashwin: 'finalized', bhadra: 'finalized', shrawan: 'finalized' }, today).id).toBe('ashwin')
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
