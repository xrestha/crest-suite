import { leaveBalance, leaveUsed, leaveEncashed } from './leaveBalance'

// Bhadra 2083 ≈ Aug/Sep 2026; Chaitra 2082 ≈ Mar 2026 (the previous BS year).
const HOME = { id: 'type-home', name: 'Home / Annual Leave', annual_quota: 18 }
const UNPAID = { id: 'type-unpaid', name: 'Unpaid', annual_quota: 0 }
const ME = 'emp-1'

const req = (o) => ({ employee_id: ME, leave_type_id: HOME.id, status: 'approved', days: 1, ...o })

describe('leaveUsed', () => {
  it('sums approved days for that employee, type and BS year', () => {
    const rows = [
      req({ start_date: '2026-08-01', days: 3 }),
      req({ start_date: '2026-09-10', days: 2.5 }),
    ]
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(5.5)
  })

  it('ignores other people, other types, and anything not approved', () => {
    const rows = [
      req({ start_date: '2026-08-01', days: 3, employee_id: 'someone-else' }),
      req({ start_date: '2026-08-01', days: 3, leave_type_id: UNPAID.id }),
      req({ start_date: '2026-08-01', days: 3, status: 'pending' }),
      req({ start_date: '2026-08-01', days: 3, status: 'rejected' }),
      req({ start_date: '2026-08-01', days: 3, status: 'cancelled' }),
    ]
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(0)
  })

  it('buckets by BS year, so last year does not count against this one', () => {
    const rows = [
      req({ start_date: '2026-03-20', days: 4 }),   // Chaitra 2082
      req({ start_date: '2026-08-01', days: 2 }),   // Bhadra 2083
    ]
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(2)
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2082 })).toBe(4)
  })

  it('counts half days as 0.5 and survives junk', () => {
    const rows = [req({ start_date: '2026-08-01', days: 0.5 }), req({ start_date: '2026-08-02', days: null })]
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(0.5)
    expect(leaveUsed(null, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(0)
  })
})

describe('leaveEncashed', () => {
  const settle = (o) => ({
    employee_id: ME, leave_type_id: HOME.id, status: 'finalized',
    last_working_date: '2026-08-20', leave_days_encashed: 5, ...o,
  })

  it('counts days paid out on a finalized settlement', () => {
    expect(leaveEncashed([settle()], { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(5)
  })

  it('IGNORES a draft — an abandoned draft must never depress a real balance', () => {
    expect(leaveEncashed([settle({ status: 'draft' })], { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(0)
  })

  it('buckets by the last working date, and ignores other types', () => {
    const rows = [settle({ last_working_date: '2026-03-20' }), settle({ leave_type_id: UNPAID.id })]
    expect(leaveEncashed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(0)
  })
})

describe('leaveBalance', () => {
  const requests = [{ employee_id: ME, leave_type_id: HOME.id, status: 'approved', days: 6, start_date: '2026-08-01' }]

  it('is quota minus taken minus encashed', () => {
    const settlements = [{
      employee_id: ME, leave_type_id: HOME.id, status: 'finalized',
      last_working_date: '2026-08-20', leave_days_encashed: 4,
    }]
    const b = leaveBalance({ requests, settlements, leaveType: HOME, employeeId: ME, bsYear: 2083 })
    expect(b).toMatchObject({ quota: 18, used: 6, encashed: 4, remaining: 8, capped: true })
  })

  it('can go negative rather than clamping — an over-taken balance must stay visible', () => {
    const over = [{ employee_id: ME, leave_type_id: HOME.id, status: 'approved', days: 25, start_date: '2026-08-01' }]
    expect(leaveBalance({ requests: over, leaveType: HOME, employeeId: ME, bsYear: 2083 }).remaining).toBe(-7)
  })

  it('marks an uncapped type, where "remaining" means nothing', () => {
    const b = leaveBalance({ requests: [], leaveType: UNPAID, employeeId: ME, bsYear: 2083 })
    expect(b.capped).toBe(false)
  })

  it('is safe with nothing loaded', () => {
    const b = leaveBalance({ requests: null, settlements: null, leaveType: HOME, employeeId: ME, bsYear: 2083 })
    expect(b).toMatchObject({ used: 0, encashed: 0, remaining: 18 })
    expect(leaveBalance({ leaveType: null, employeeId: ME, bsYear: 2083 }).quota).toBe(0)
  })
})

describe('one employment, up to the last working day (S798 ENGINE-3)', () => {
  // Joined 2026-06-01, leaving 2026-08-31 (Bhadra 2083).
  const span = { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083, from: '2026-06-01', until: '2026-08-31' }

  it('leaves out approved leave booked for after the last working day', () => {
    const rows = [
      req({ start_date: '2026-08-05', end_date: '2026-08-06', days: 2 }),
      req({ start_date: '2026-10-10', end_date: '2026-10-14', days: 5 }),   // Dashain, after leaving
    ]
    expect(leaveUsed(rows, span)).toBe(2)
    expect(leaveUsed(rows, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(7)
  })

  it('prorates a request straddling the last working day by calendar days', () => {
    const rows = [req({ start_date: '2026-08-30', end_date: '2026-09-02', days: 4 })]
    expect(leaveUsed(rows, span)).toBe(2)
  })

  it('leaves out leave from an earlier employment the same year', () => {
    const rows = [req({ start_date: '2026-05-01', end_date: '2026-05-03', days: 3 })]
    expect(leaveUsed(rows, span)).toBe(0)
  })

  it('reads a one-day request with no end date as that day', () => {
    expect(leaveUsed([req({ start_date: '2026-08-10', days: 0.5 })], span)).toBe(0.5)
    expect(leaveUsed([req({ start_date: '2026-09-10', days: 1 })], span)).toBe(0)
  })

  it('counts only settlements of this employment as already paid out', () => {
    const sets = [
      { employee_id: ME, leave_type_id: HOME.id, status: 'finalized', last_working_date: '2026-05-15', leave_days_encashed: 4 },
      { employee_id: ME, leave_type_id: HOME.id, status: 'finalized', last_working_date: '2026-07-01', leave_days_encashed: 1 },
    ]
    expect(leaveEncashed(sets, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083, from: '2026-06-01' })).toBe(1)
    expect(leaveEncashed(sets, { employeeId: ME, leaveTypeId: HOME.id, bsYear: 2083 })).toBe(5)
  })
})
