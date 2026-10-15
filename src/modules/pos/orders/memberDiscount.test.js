import {
  pctText, membershipReason, isMembershipReason, memberStatus, creditLimitWarning, normalizeCardNo,
  todayNepalIso, MEMBERSHIP_REASON_PREFIX,
} from './memberDiscount'

const gold = { name: 'Gold', discount_pct: '10.00', is_active: true }
const row = (over = {}) => ({ id: 'c1', membership_type_id: 't1', card_expires_on: null, pos_membership_types: gold, ...over })

describe('pctText', () => {
  it('says the rate the way a person does', () => {
    expect(pctText('10.00')).toBe('10')
    expect(pctText(12.5)).toBe('12.5')
    expect(pctText('7.50')).toBe('7.5')
    expect(pctText('abc')).toBe('')
  })
})

describe('membershipReason / isMembershipReason', () => {
  it('names the card and its rate', () => {
    expect(membershipReason('Gold', '10.00')).toBe('Membership – Gold 10%')
    expect(isMembershipReason('Membership – Gold 10%')).toBe(true)
  })
  it('does not take a typed reason for a membership one', () => {
    expect(isMembershipReason('Regular customer')).toBe(false)
    expect(isMembershipReason('')).toBe(false)
    expect(isMembershipReason(null)).toBe(false)
    expect(MEMBERSHIP_REASON_PREFIX.endsWith(' ')).toBe(true)
  })
})

describe('memberStatus', () => {
  const today = '2026-10-15'
  it('is none without a row, a card or its type', () => {
    expect(memberStatus(null, today)).toEqual({ kind: 'none' })
    expect(memberStatus(row({ membership_type_id: null }), today)).toEqual({ kind: 'none' })
    expect(memberStatus(row({ pos_membership_types: null }), today)).toEqual({ kind: 'none' })
  })
  it('gives the rate and the reason for an active card', () => {
    expect(memberStatus(row(), today)).toEqual({
      kind: 'active', typeName: 'Gold', pct: 10, reason: 'Membership – Gold 10%', expiresOn: null,
    })
  })
  it('still counts on the expiry day itself, and not the day after', () => {
    expect(memberStatus(row({ card_expires_on: '2026-10-15' }), today).kind).toBe('active')
    expect(memberStatus(row({ card_expires_on: '2026-10-14' }), today)).toEqual({
      kind: 'expired', typeName: 'Gold', expiresOn: '2026-10-14',
    })
  })
  it('gives nothing for a card type a manager switched off', () => {
    expect(memberStatus(row({ pos_membership_types: { ...gold, is_active: false } }), today))
      .toEqual({ kind: 'inactive', typeName: 'Gold' })
  })
  it('gives nothing for a rate that is not a positive number', () => {
    expect(memberStatus(row({ pos_membership_types: { ...gold, discount_pct: 0 } }), today).kind).toBe('none')
    expect(memberStatus(row({ pos_membership_types: { ...gold, discount_pct: 'x' } }), today).kind).toBe('none')
  })
  it('never offers more than the whole bill', () => {
    expect(memberStatus(row({ pos_membership_types: { ...gold, discount_pct: 150 } }), today).pct).toBe(100)
  })
})

describe('creditLimitWarning', () => {
  it('says nothing without a limit', () => {
    expect(creditLimitWarning({ limit: null, owed: 5000, billTotal: 900 })).toBeNull()
    expect(creditLimitWarning({ limit: undefined, owed: 5000, billTotal: 900 })).toBeNull()
    expect(creditLimitWarning({ limit: '', owed: 5000, billTotal: 900 })).toBeNull()
  })
  it('says nothing up to the limit, the paisa included', () => {
    expect(creditLimitWarning({ limit: 5000, owed: 4100, billTotal: 900 })).toBeNull()
    expect(creditLimitWarning({ limit: '5000.00', owed: 4100.004, billTotal: 900 })).toBeNull()
  })
  it('names the balance before and after, and how far over', () => {
    expect(creditLimitWarning({ limit: 5000, owed: 4500, billTotal: 904.5 })).toEqual({
      limit: 5000, before: 4500, after: 5404.5, over: 404.5,
    })
  })
  it('treats a limit of 0 as no credit at all', () => {
    expect(creditLimitWarning({ limit: 0, owed: 0, billTotal: 100 })).toEqual({ limit: 0, before: 0, after: 100, over: 100 })
  })
})

describe('normalizeCardNo', () => {
  it('trims and upper-cases, as the book stores it', () => {
    expect(normalizeCardNo('  gld-0012 ')).toBe('GLD-0012')
    expect(normalizeCardNo('   ')).toBeNull()
    expect(normalizeCardNo(null)).toBeNull()
  })
})

describe('todayNepalIso', () => {
  it('is the Nepal calendar day, not the UTC one', () => {
    // 2026-10-14 18:30 UTC is 00:15 on the 15th in Kathmandu.
    expect(todayNepalIso(Date.UTC(2026, 9, 14, 18, 30))).toBe('2026-10-15')
    expect(todayNepalIso(Date.UTC(2026, 9, 14, 18, 0))).toBe('2026-10-14')
  })
})
