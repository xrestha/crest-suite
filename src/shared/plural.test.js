import { plural } from './plural'

describe('plural', () => {
  test('one takes the singular', () => {
    expect(plural(1, 'employee')).toBe('1 employee')
  })

  test('zero and many take the plural', () => {
    expect(plural(0, 'employee')).toBe('0 employees')
    expect(plural(3, 'travel claim')).toBe('3 travel claims')
  })

  test('a fraction is plural, and a numeric string of 1 is singular', () => {
    expect(plural(1.5, 'leave day')).toBe('1.5 leave days')
    expect(plural('1', 'leave day')).toBe('1 leave day')
  })

  test('an irregular plural is passed in', () => {
    expect(plural(2, 'person', 'people')).toBe('2 people')
  })
})
