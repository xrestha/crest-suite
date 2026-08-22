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
