import { changedEmployeeFields, newEmployeePayload, endDateHasPassed, normaliseEmployeeField } from './employeeFormData'

const KEYS = [
  'employee_code', 'full_name', 'phone', 'status', 'end_date', 'supervisor_id', 'children_count',
  'same_as_permanent', 'perm_district', 'temp_district',
]

// The row as EmployeeList loaded it — including columns this form does NOT own.
const loaded = {
  id: 'e1', client_id: 'c1',
  employee_code: null, full_name: 'Sita Rai', phone: '', status: 'active', end_date: null,
  supervisor_id: null, children_count: null, same_as_permanent: false,
  perm_district: 'Lalitpur', temp_district: 'Kathmandu',
  basic_salary: 25000, bank_account_no: '0123', ssf_enrolled: true, access_blocked: false,
}

describe('changedEmployeeFields — what an Employees save writes (S748)', () => {
  test('an untouched form writes nothing at all', () => {
    const form = { ...loaded, phone: '', employee_code: '' }
    expect(changedEmployeeFields(loaded, form, KEYS)).toEqual({})
  })

  test('editing one field sends that field only — never pay, bank, SSF or login columns', () => {
    const form = { ...loaded, phone: '9800000000' }
    const patch = changedEmployeeFields(loaded, form, KEYS)
    expect(patch).toEqual({ phone: '9800000000' })
    for (const k of ['basic_salary', 'bank_account_no', 'ssf_enrolled', 'access_blocked', 'status', 'end_date']) {
      expect(patch).not.toHaveProperty(k)
    }
  })

  test('a Final Settlement made in another tab survives an unrelated save', () => {
    // The form opened while the employee was active; settlement then set resigned + end date.
    // The form's own status/end_date are untouched, so the patch must not carry them.
    const openedWith = { ...loaded }
    const form = { ...openedWith, phone: '9811111111' }
    const patch = changedEmployeeFields(openedWith, form, KEYS)
    expect(patch).not.toHaveProperty('status')
    expect(patch).not.toHaveProperty('end_date')
  })

  test('clearing an end date writes NULL', () => {
    const withEnd = { ...loaded, end_date: '2026-05-13' }
    expect(changedEmployeeFields(withEnd, { ...withEnd, end_date: '' }, KEYS)).toEqual({ end_date: null })
  })

  test('a blank employee code is NULL, not an empty string', () => {
    expect(normaliseEmployeeField('employee_code', '')).toBeNull()
    expect(newEmployeePayload({ ...loaded, employee_code: '' }, KEYS).employee_code).toBeNull()
  })

  test('same-as-permanent mirrors the address into the patch when it changes the current address', () => {
    const form = { ...loaded, same_as_permanent: true }
    expect(changedEmployeeFields(loaded, form, KEYS)).toEqual({ same_as_permanent: true, temp_district: 'Lalitpur' })
  })

  test('children count: blank is NULL and a negative is refused to NULL', () => {
    expect(normaliseEmployeeField('children_count', '')).toBeNull()
    expect(normaliseEmployeeField('children_count', '-2')).toBeNull()
    expect(normaliseEmployeeField('children_count', '2')).toBe(2)
  })
})

describe('endDateHasPassed — the state that zeroes a monthly employee’s pay', () => {
  test('a past date on someone still on payroll', () => {
    expect(endDateHasPassed('2026-05-13', 'active', '2026-09-14')).toBe(true)
    expect(endDateHasPassed('2026-05-13', 'probation', '2026-09-14')).toBe(true)
  })
  test('not for a leaver, a future date, or no date', () => {
    expect(endDateHasPassed('2026-05-13', 'resigned', '2026-09-14')).toBe(false)
    expect(endDateHasPassed('2026-12-01', 'active', '2026-09-14')).toBe(false)
    expect(endDateHasPassed(null, 'active', '2026-09-14')).toBe(false)
  })
})
