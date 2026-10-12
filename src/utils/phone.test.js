import { normalizePhone, phoneForRecord, customerPhoneKey, phoneMatchesSearch } from './phone'

// The generated column pos_customers.phone_canonical and pos_phone_canonical() (migration
// 20261010110000) write a number the same way; these pin the JS twin the till matches with.
describe('normalizePhone', () => {
  test('every way a cashier types one Nepali mobile number is the same number', () => {
    for (const typed of ['9841234567', '984-1234567', '+977 9841234567', '+977-98-4123-4567', '09841234567', '098 4123 4567', ' 9841234567 ']) {
      expect([typed, normalizePhone(typed)]).toEqual([typed, '9841234567'])
    }
  })

  test('a landline with its area code keeps it; a leading 977 is dropped only from 11 digits or more', () => {
    expect(normalizePhone('01-4412345')).toBe('14412345')
    expect(normalizePhone('9779841')).toBe('9779841')
    expect(normalizePhone('977 1 4412345')).toBe('14412345')
  })

  test('under 7 digits, or no digits, is not a number', () => {
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('N/A')).toBeNull()
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone(null)).toBeNull()
  })
})

describe('phoneForRecord — what a bill and the customer book store (S809 3k)', () => {
  test('a number is stored as the number, however it was typed', () => {
    expect(phoneForRecord('+977 984-1234567')).toBe('9841234567')
    expect(phoneForRecord('09841234567')).toBe('9841234567')
    expect(phoneForRecord('9841234567')).toBe('9841234567')
  })

  test('a short code or a note is kept as typed, trimmed, never lost', () => {
    expect(phoneForRecord(' 12345 ')).toBe('12345')
    expect(phoneForRecord('1-2345')).toBe('1-2345')
    expect(phoneForRecord('walk-in')).toBe('walk-in')
  })

  test('nothing typed stays nothing', () => {
    expect(phoneForRecord('')).toBe('')
    expect(phoneForRecord('   ')).toBe('')
    expect(phoneForRecord(null)).toBe('')
    expect(phoneForRecord(undefined)).toBe('')
  })
})

describe('customerPhoneKey — how the till finds the customer the server will (S809 3k)', () => {
  test('a number is looked up by phone_canonical, so another spelling still finds the regular', () => {
    expect(customerPhoneKey('+977 984-1234567')).toEqual({ column: 'phone_canonical', value: '9841234567' })
    expect(customerPhoneKey('9841234567')).toEqual({ column: 'phone_canonical', value: '9841234567' })
  })

  test('under 7 digits it matches the text exactly as typed, as the server does', () => {
    expect(customerPhoneKey(' 12345 ')).toEqual({ column: 'phone', value: '12345' })
    expect(customerPhoneKey('1-2345')).toEqual({ column: 'phone', value: '1-2345' })
  })

  test('nothing typed looks nothing up', () => {
    expect(customerPhoneKey('')).toBeNull()
    expect(customerPhoneKey('  ')).toBeNull()
    expect(customerPhoneKey(null)).toBeNull()
  })

  test('what the till stores is found again by the same key', () => {
    for (const typed of ['+977 984-1234567', '12345', '1-2345', '01-4412345']) {
      const stored = phoneForRecord(typed)
      const key = customerPhoneKey(typed)
      const storedKey = customerPhoneKey(stored)
      expect([typed, storedKey]).toEqual([typed, key])
    }
  })
})

describe('phoneMatchesSearch — a customer search finds the number however it is typed (S815 4g)', () => {
  test('+977, spaces, dashes and a leading 0 do not hide a customer', () => {
    for (const typed of ['+977 984-123', '9779841234567', '984 123', '0984123', '9841234567']) {
      expect([typed, phoneMatchesSearch('9841234567', typed)]).toEqual([typed, true])
    }
  })

  test('a customer stored another way is still found', () => {
    expect(phoneMatchesSearch('+977 984-1234567', '9841234')).toBe(true)
    expect(phoneMatchesSearch('01-4412345', '4412345')).toBe(true)
  })

  test('another number, or under 3 digits, is no match', () => {
    expect(phoneMatchesSearch('9841234567', '9851')).toBe(false)
    expect(phoneMatchesSearch('9841234567', '98')).toBe(false)
    expect(phoneMatchesSearch('9841234567', 'Ram')).toBe(false)
    expect(phoneMatchesSearch(null, '984')).toBe(false)
  })
})
