import {
  DEFAULT_PAY_WITHIN_DAYS, payWithinDays, hasOwnPayTerms, isOverdue, payTermsLabel, parsePayTerms,
} from './payTerms'

describe('payWithinDays', () => {
  it('uses the supplier number, 0 included', () => {
    expect(payWithinDays({ pay_within_days: 7 })).toBe(7)
    expect(payWithinDays({ pay_within_days: 0 })).toBe(0)
  })
  it('falls back to 60 days when none is set', () => {
    expect(payWithinDays({ pay_within_days: null })).toBe(DEFAULT_PAY_WITHIN_DAYS)
    expect(payWithinDays({})).toBe(60)
    expect(payWithinDays(null)).toBe(60)
    expect(hasOwnPayTerms({ pay_within_days: null })).toBe(false)
    expect(hasOwnPayTerms({ pay_within_days: 0 })).toBe(true)
  })
})

describe('isOverdue', () => {
  it('is overdue only after the supplier days have passed', () => {
    expect(isOverdue(7, { pay_within_days: 7 })).toBe(false)
    expect(isOverdue(8, { pay_within_days: 7 })).toBe(true)
    expect(isOverdue(1, { pay_within_days: 0 })).toBe(true)
    expect(isOverdue(0, { pay_within_days: 0 })).toBe(false)
  })
  it('keeps the old 60-day rule for a supplier with no terms', () => {
    expect(isOverdue(60, {})).toBe(false)
    expect(isOverdue(61, {})).toBe(true)
  })
})

describe('payTermsLabel', () => {
  it('names cash on delivery, a number of days and the default', () => {
    expect(payTermsLabel({ pay_within_days: 0 })).toBe('Due on delivery')
    expect(payTermsLabel({ pay_within_days: 1 })).toBe('Pay within 1 day')
    expect(payTermsLabel({ pay_within_days: 30 })).toBe('Pay within 30 days')
    expect(payTermsLabel({})).toBe('Pay within 60 days (default)')
  })
})

describe('parsePayTerms', () => {
  it.each([
    ['30', 30], ['30 days', 30], ['30 Days', 30], ['30d', 30], ['Net 30', 30], ['net30', 30],
    ['  15   days  ', 15], ['within 15 days', 15], ['in 7 days', 7], ['30 days credit', 30],
    ['credit 45 days', 45], ['Credit of 45 days', 45], ['1 day', 1],
    ['Weekly credit', 7], ['weekly', 7], ['Monthly credit', 30], ['MONTHLY', 30],
  ])('reads %p as %p days', (text, days) => {
    expect(parsePayTerms(text)).toBe(days)
  })

  it.each(['COD', 'cod', 'C.O.D.', 'Cash', 'cash on delivery', 'On delivery'])('reads %p as due on delivery', text => {
    expect(parsePayTerms(text)).toBe(0)
  })

  it.each(['50% advance', 'credit', 'CREDIT', 'twice monthly', '30-60 days', 'after 2 bills', 'cheque', '', null, undefined, '400 days', '1 month'])(
    'leaves %p unread', text => {
      expect(parsePayTerms(text)).toBeNull()
    })
})
