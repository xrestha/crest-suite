import { todayView, nextShift, pendingSwapsForMe, swapLapsed, rowKind } from './todayView'

// Bhadra 2082, days 4–10 — one ordinary week, all in one BS month.
const week = [4, 5, 6, 7, 8, 9, 10].map(day => ({ bsYear: 2082, bsMonth: 5, bsDay: day }))
const TODAY = { year: 2082, month: 5, day: 6 }
// Publishing is per day (S798): a Set of "year-month-day" keys. Every day of Bhadra here, or none.
const published = new Set(Array.from({ length: 32 }, (_, i) => `2082-5-${i + 1}`))
const unpublished = new Set()

// Rows as get_my_roster sends them since S798, with the database's shift_kind ('Day Off' and
// 'OFF DAY' are the zero-hour markers in these fixtures).
const rosterOf = rows => new Map(rows.map(([day, name]) => [
  `2082-5-${day}`, { bs_day: day, shift_type_name: name, shift_start: '09:00', shift_end: '18:00', shift_kind: /off/i.test(name) ? 'off' : 'work' },
]))

describe('todayView', () => {
  it('reports the shift on a working day', () => {
    const v = todayView({ days: week, roster: rosterOf([[6, 'Morning']]), publishedDays: published, today: TODAY })
    expect(v.state).toBe('working')
    expect(v.row.shift_type_name).toBe('Morning')
    expect(v.cell.bsDay).toBe(6)
  })

  it('separates a day off from a day with no row at all', () => {
    expect(todayView({ days: week, roster: rosterOf([[6, 'Day Off']]), publishedDays: published, today: TODAY }).state).toBe('off')
    expect(todayView({ days: week, roster: rosterOf([[7, 'Morning']]), publishedDays: published, today: TODAY }).state).toBe('not-scheduled')
  })

  it('never reports "not scheduled" for a month the manager has not published', () => {
    // get_my_roster only returns published days, so these two are identical in the data and
    // completely different to someone deciding whether to turn up.
    const v = todayView({ days: week, roster: new Map(), publishedDays: unpublished, today: TODAY })
    expect(v.state).toBe('unpublished')
  })

  // S798 (ROSTER-4): publishing is per day. With the first days of the month published and today
  // still a draft, today is "not published yet", never "not scheduled".
  it('calls a draft day unpublished even when other days of its month are published', () => {
    const firstDays = new Set(['2082-5-4', '2082-5-5'])
    const v = todayView({ days: week, roster: new Map(), publishedDays: firstDays, today: TODAY })
    expect(v.state).toBe('unpublished')
    expect(todayView({ days: week, roster: new Map(), publishedDays: new Set(['2082-5-6']), today: TODAY }).state).toBe('not-scheduled')
  })

  // S798 (ATTENDANCE-7 / ROSTER-5): the database's shift_kind decides, not a substring of the name.
  it('reads the shift kind the database sends', () => {
    const coffee = new Map([['2082-5-6', { bs_day: 6, shift_type_name: 'Coffee Bar', shift_start: '07:00', shift_kind: 'work' }]])
    expect(todayView({ days: week, roster: coffee, publishedDays: published, today: TODAY }).state).toBe('working')
    const leave = new Map([['2082-5-6', { bs_day: 6, shift_type_name: 'Annual Leave', shift_kind: 'leave' }]])
    expect(todayView({ days: week, roster: leave, publishedDays: published, today: TODAY }).state).toBe('off')
  })

  it('says nothing at all when today is outside the loaded week', () => {
    const v = todayView({ days: week, roster: rosterOf([[6, 'Morning']]), publishedDays: published, today: { year: 2082, month: 5, day: 20 } })
    expect(v.state).toBe('unknown')
  })

  it('does not match a day number in a different month or year', () => {
    // The trap this guard exists for: paging the roster forward to Ashwin and reading its day 6
    // as today.
    const ashwin = [{ bsYear: 2082, bsMonth: 6, bsDay: 6 }]
    const roster = new Map([['2082-6-6', { bs_day: 6, shift_type_name: 'Morning' }]])
    const pub = new Set(['2082-6-6'])
    expect(todayView({ days: ashwin, roster, publishedDays: pub, today: TODAY }).state).toBe('unknown')
  })

  it('is safe before anything has loaded', () => {
    expect(todayView({ days: week, roster: null, publishedDays: published, today: TODAY }).state).toBe('unknown')
    expect(todayView({}).state).toBe('unknown')
  })
})

describe('nextShift', () => {
  it('finds the next working day after today', () => {
    const r = nextShift({ days: week, roster: rosterOf([[6, 'Morning'], [7, 'Evening']]), publishedDays: published, today: TODAY })
    expect(r.cell.bsDay).toBe(7)
    expect(r.row.shift_type_name).toBe('Evening')
  })

  it('skips a run of off days rather than announcing one', () => {
    const roster = rosterOf([[6, 'Morning'], [7, 'Day Off'], [8, 'OFF DAY'], [9, 'Afternoon']])
    expect(nextShift({ days: week, roster, publishedDays: published, today: TODAY }).cell.bsDay).toBe(9)
  })

  it('never returns today itself', () => {
    const r = nextShift({ days: week, roster: rosterOf([[6, 'Morning']]), publishedDays: published, today: TODAY })
    expect(r).toBeNull()
  })

  it('crosses into next week when this week has nothing left', () => {
    // Bhadra runs 31 days, so days 11–17 are the following week — the case that matters on a
    // Saturday, where the useful answer is Monday.
    const twoWeeks = [...week, ...[11, 12, 13, 14, 15, 16, 17].map(day => ({ bsYear: 2082, bsMonth: 5, bsDay: day }))]
    const roster = rosterOf([[6, 'Morning'], [12, 'Morning']])
    expect(nextShift({ days: twoWeeks, roster, publishedDays: published, today: TODAY }).cell.bsDay).toBe(12)
  })

  it('ignores a month whose roster is not published', () => {
    expect(nextShift({ days: week, roster: rosterOf([[8, 'Morning']]), publishedDays: unpublished, today: TODAY })).toBeNull()
  })

  it('skips a draft day inside a month that is partly published', () => {
    const roster = rosterOf([[7, 'Morning'], [9, 'Evening']])
    const r = nextShift({ days: week, roster, publishedDays: new Set(['2082-5-9']), today: TODAY })
    expect(r.cell.bsDay).toBe(9)
  })

  it('returns null rather than guessing when today is not in range', () => {
    expect(nextShift({ days: week, roster: rosterOf([[8, 'Morning']]), publishedDays: published, today: { year: 2082, month: 9, day: 1 } })).toBeNull()
  })
})

describe('rowKind', () => {
  it('takes shift_kind when the database sends it', () => {
    expect(rowKind({ shift_type_name: 'Back Office', shift_kind: 'work' })).toBe('work')
    expect(rowKind({ shift_type_name: 'Day Off', shift_kind: 'off' })).toBe('off')
  })
  it('falls back to the same rule from the name and start time on an older row', () => {
    expect(rowKind({ shift_type_name: 'Day Off', shift_start: null })).toBe('off')
    expect(rowKind({ shift_type_name: 'Coffee Bar', shift_start: '07:00' })).toBe('work')
    expect(rowKind({ shift_type_name: 'Holiday Duty', shift_start: '09:00' })).toBe('work')
    expect(rowKind({ shift_type_name: null })).toBe('off')
    expect(rowKind(null)).toBe('off')
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

  // S798 3d (ROSTER-3): a request with a day already gone cannot be accepted, so it is not counted.
  it('leaves out a request whose earlier day has passed', () => {
    const dated = [
      { id: 'past', target_employee_id: ME, status: 'pending_target', bs_year: 2082, bs_month: 5, requester_bs_day: 9, target_bs_day: 5 },
      { id: 'today', target_employee_id: ME, status: 'pending_target', bs_year: 2082, bs_month: 5, requester_bs_day: 6, target_bs_day: 8 },
    ]
    expect(pendingSwapsForMe(dated, ME, TODAY).map(r => r.id)).toEqual(['today'])
    expect(swapLapsed(dated[0], TODAY)).toBe(true)
    expect(swapLapsed(dated[1], TODAY)).toBe(false)
    expect(pendingSwapsForMe(dated, ME).map(r => r.id)).toEqual(['past', 'today']) // no date: as before
  })

  it('is safe with nothing loaded, or with no linked employee record', () => {
    expect(pendingSwapsForMe(null, ME)).toEqual([])
    expect(pendingSwapsForMe(rows, null)).toEqual([])
  })
})
