import { isOwnEmployeeRecord } from './ownRecord'

// ownRecord.js also exports the hook, which imports AuthContext and through it the real Supabase
// client; the pure test needs neither. babel-jest hoists this above the import.
jest.mock('../../context/AuthContext', () => ({ useAuth: jest.fn() }))

describe('isOwnEmployeeRecord — the page copy of hr_is_own_employee()', () => {
  const emp = { id: 'e1', email: '  Ram@Example.com ' }

  test('the login linked to the employee record is its owner', () => {
    expect(isOwnEmployeeRecord({ employeeId: 'e1', employee: emp, linkedEmployeeId: 'e1', email: '' })).toBe(true)
  })

  test('a record carrying the login email is its owner, trimmed and case-blind', () => {
    expect(isOwnEmployeeRecord({ employeeId: 'e1', employee: emp, linkedEmployeeId: null, email: 'ram@example.com' })).toBe(true)
  })

  test('someone else\'s record is not, and a blank email never matches a blank email', () => {
    expect(isOwnEmployeeRecord({ employeeId: 'e1', employee: emp, linkedEmployeeId: 'e2', email: 'sita@example.com' })).toBe(false)
    expect(isOwnEmployeeRecord({ employeeId: 'e3', employee: { id: 'e3', email: '' }, linkedEmployeeId: null, email: '' })).toBe(false)
    expect(isOwnEmployeeRecord({ employeeId: 'e3', employee: undefined, linkedEmployeeId: null, email: 'ram@example.com' })).toBe(false)
  })

  test('the Owner and the operator are exempt, as hr_self_decision_exempt() makes them', () => {
    expect(isOwnEmployeeRecord({ employeeId: 'e1', employee: emp, linkedEmployeeId: 'e1', email: 'ram@example.com', exempt: true })).toBe(false)
  })
})
