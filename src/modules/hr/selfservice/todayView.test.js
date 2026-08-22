import { todayView, nextShift, pendingSwapsForMe } from './todayView'

// Bhadra 2082, days 4–10 — one ordinary week, all in one BS month.
const week = [4, 5, 6, 7, 8, 9, 10].map(day => ({ bsYear: 2082, bsMonth: 5, bsDay: day }))
const TODAY = { year: 2082, month: 5, day: 6 }
const published = new Map([['2082-5', true]])
const unpublished = new Map([['2082-5', false]])

const rosterOf = rows => new Map(rows.map(([day, name]) => [
  `2082-5-${day}`, { bs_day: day, shift_type_name: name, shift_start: '09:00', shift_end: '18:00' },
]))

describe('todayView', () => {
  it('reports the shift on a working day', () => {
    const v = todayView({ days: week, roster: rosterOf([[6, 'Morning']]), publishMap: published, today: TODAY })
    expect(v.state).toBe('working')
    expect(v.row.shift_type_name).toBe('Morning')
    expect(v.cell.bsDay).toBe(6)
  })

  it('separates a day off from a day with no row at all', () => {
    expect(todayView({ days: week, roster: rosterOf([[6, 'Day Off']]), publishMap: published, today: TODAY }).state).toBe('off')
    expect(todayView({ days: week, roster: rosterOf([[7, 'Morning']]), publishMap: published, today: TODAY }).state).toBe('not-scheduled')
  })

  it('never reports "not scheduled" for a month the manager has not published', () => {
    // get_my_roster only returns published days, so these two are identical in the data and
    // completely different to someone deciding whether to turn up.
    const v = todayView({ days: week, roster: new Map(), publishMap: unpublished, today: TODAY })
    expect(v.state).toBe('unpublished')
  })

  it('says nothing at all when today is outside the loaded week', () => {
    const v = todayView({ days: week, roster: rosterOf([[6, 'Morning']]), publishMap: published, today: { year: 2082, month: 5, day: 20 } })
    expect(v.state).toBe('unknown')
  })

  it('does not match a day number in a different month or year', () => {
    // The trap this guard exists for: paging the roster forward to Ashwin and reading its day 6
    // as today.
    const ashwin = [{ bsYear: 2082, bsMonth: 6, bsDay: 6 }]
    const roster = new Map([['2082-6-6', { bs_day: 6, shift_type_name: 'Morning' }]])
    const pub = new Map([['2082-6', true]])
    expect(todayView({ days: ashwin, roster, publishMap: pub, today: TODAY }).state).toBe('unknown')
  })

  it('is safe before anything has loaded', () => {
    expect(todayView({ days: week, roster: null, publishMap: published, today: TODAY }).state).toBe('unknown')
    expect(todayView({}).state).toBe('unknown')
  })
})

describe('nextShift', () => {
  it('finds the next working day after today', () => {
    const r = nextShift({ days: week, roster: rosterOf([[6, 'Morning'], [7, 'Evening']]), publishMap: published, today: TODAY })
    expect(r.cell.bsDay).toBe(7)
    expect(r.row.shift_type_name).toBe('Evening')
  })

  it('skips a run of off days rather than announcing one', () => {
    const roster = rosterOf([[6, 'Morning'], [7, 'Day Off'], [8, 'OFF DAY'], [9, 'Afternoon']])
    expect(nextShift({ days: week, roster, publishMap: published, today: TODAY }).cell.bsDay).toBe(9)
  })

  it('never returns today itself', () => {
    const r = nextShift({ days: week, roster: rosterOf([[6, 'Morning']]), publishMap: published, today: TODAY })
    expect(r).toBeNull()
  })

  it('crosses into next week when this week has nothing left', () => {
    // Bhadra runs 31 days, so days 11–17 are the following week — the case that matters on a
    // Saturday, where the useful answer is Monday.
    const twoWeeks = [...week, ...[11, 12, 13, 14, 15, 16, 17].map(day => ({ bsYear: 2082, bsMonth: 5, bsDay: day }))]
    const roster = rosterOf([[6, 'Morning'], [12, 'Morning']])
    expect(nextShift({ days: twoWeeks, roster, publishMap: published, today: TODAY }).cell.bsDay).toBe(12)
  })

  it('ignores a month whose roster is not published', () => {
    expect(nextShift({ days: week, roster: rosterOf([[8, 'Morning']]), publishMap: unpublished, today: TODAY })).toBeNull()
  })

  it('returns null rather than guessing when today is not in range', () => {
    expect(nextShift({ days: week, roster: rosterOf([[8, 'Morning']]), publishMap: published, today: { year: 2082, month: 9, day: 1 } })).toBeNull()
  })
})

describe('pendingSwapsForMe', () => {
  const ME = 'emp-me'
  const rows = [
    { id: 1, target_employee_id: ME, status: 'pending_target' },
    { id: 2, target_employee_id: ME, status: 'pending_admin' },
    { id: 3, target_employee_id: 'emp-other', status: 'pending_target' },
    { id: 4, requester_employee_id: ME, target_employee_id: 'emp-other', status: 'pending_target' },
  ]

  it('returns only the ones this employee has to answer', () => {
    expect(pendingSwapsForMe(rows, ME).map(r => r.id)).toEqual([1])
  })

  it('excludes a swap already accepted and waiting on the manager', () => {
    expect(pendingSwapsForMe(rows, ME).some(r => r.status === 'pending_admin')).toBe(false)
  })

  it('is safe with nothing loaded, or with no linked employee record', () => {
    expect(pendingSwapsForMe(null, ME)).toEqual([])
    expect(pendingSwapsForMe(rows, null)).toEqual([])
  })
})
