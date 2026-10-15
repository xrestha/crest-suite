import {
  normaliseCardNo, cardExpiryIso, formFromCustomer, validateCustomerForm, buildCustomerPatch, takesCardAway,
} from './membershipForm'

// S843: the customer edit form. Calendar facts from the verified table: 2026-10-15 is 29 Ashwin 2083
// and 2027-10-16 is 29 Ashwin 2084; 2026-07-16 is 32 Asar 2083 and Asar 2084 has 31 days
// (2027-07-16 is its 31st); 2027-03-29 is 15 Chaitra 2083 and 2027-04-28 is 15 Baisakh 2084.

const TODAY_BS = { year: 2083, month: 6, day: 29 }
const NOW = '2026-10-15T06:00:00.000Z'
const PLAIN = {
  id: 'c1', name: 'Asha', phone: '9800000001', membership_type_id: null, card_no: null, card_issued_on: null,
  card_expires_on: null, credit_limit: null, birth_month: null, birth_day: null, birth_year: null, birth_calendar: null,
  anniv_month: null, anniv_day: null, anniv_year: null, anniv_calendar: null, consent_at: null, consent_by: null,
}
const MEMBER = { ...PLAIN, membership_type_id: 't1', card_no: 'GOLD-7', card_issued_on: '2026-10-15', card_expires_on: '2027-10-16', credit_limit: '5000.00' }
const AGREED = { ...PLAIN, consent_at: '2026-10-01T04:00:00+00:00', consent_by: 'u1', birth_month: 6, birth_day: 29, birth_year: 2050, birth_calendar: 'BS' }
const ctx = (customer, more = {}) => ({ customer, canEditCard: true, canEditDates: true, todayBs: TODAY_BS, todayAdYear: 2026, ...more })

describe('card number and expiry', () => {
  test('a card number is kept trimmed and upper-cased; blank is none', () => {
    expect(normaliseCardNo('  gold 12 ')).toBe('GOLD 12')
    expect(normaliseCardNo('   ')).toBeNull()
    expect(normaliseCardNo(null)).toBeNull()
  })

  test('the same BS date the type\'s months later', () => {
    expect(cardExpiryIso('2026-10-15', 12)).toBe('2027-10-16')
    expect(cardExpiryIso('2027-03-29', 1)).toBe('2027-04-28') // 15 Chaitra → 15 Baisakh, across the year
  })

  test('a day the later month does not have falls on its last day', () => {
    expect(cardExpiryIso('2026-07-16', 12)).toBe('2027-07-16') // 32 Asar 2083 → 31 Asar 2084
  })

  test('no months, or no issue date, is no expiry', () => {
    expect(cardExpiryIso('2026-10-15', null)).toBe('')
    expect(cardExpiryIso('', 12)).toBe('')
  })
})

describe('the form as a row stands', () => {
  test('a member with a limit and a birthday', () => {
    const f = formFromCustomer({ ...MEMBER, ...AGREED, membership_type_id: 't1', card_no: 'GOLD-7', credit_limit: '5000.00' })
    expect(f).toMatchObject({ typeId: 't1', cardNo: 'GOLD-7', creditLimit: '5000', agreed: true, withdraw: false })
    expect(f.birth).toEqual({ calendar: 'BS', month: '6', day: '29', year: '2050' })
    expect(f.anniv).toEqual({ calendar: 'BS', month: '', day: '', year: '' })
  })
})

describe('what the form checks', () => {
  test('a date needs the customer\'s agreement first', () => {
    const f = { ...formFromCustomer(PLAIN), birth: { calendar: 'BS', month: '6', day: '29', year: '' } }
    expect(validateCustomerForm(f, ctx(PLAIN))).toEqual({ agreed: 'Tick that the customer agreed before saving a birthday or an anniversary.' })
    expect(validateCustomerForm({ ...f, agreed: true }, ctx(PLAIN))).toEqual({})
    // Already agreed: no tick needed again.
    expect(validateCustomerForm(formFromCustomer(AGREED), ctx(AGREED))).toEqual({})
  })

  test('a half-picked date, a day the month does not have, and a year not yet come', () => {
    const f = formFromCustomer(PLAIN)
    const errs = validateCustomerForm({
      ...f, agreed: true,
      birth: { calendar: 'BS', month: '7', day: '', year: '' },
      anniv: { calendar: 'BS', month: '7', day: '31', year: '2083' },
    }, ctx(PLAIN))
    expect(errs.birth).toBe('Pick both the month and the day of the birthday, or clear it.')
    expect(errs.anniv).toBe('Kartik 2083 has 30 days. Pick a day up to 30.')
    const later = validateCustomerForm({ ...f, agreed: true, birth: { calendar: 'AD', month: '2', day: '29', year: '2027' } }, ctx(PLAIN))
    expect(later.birth).toMatch(/^2027 has not come yet/)
    const plainYear = validateCustomerForm({ ...f, agreed: true, birth: { calendar: 'AD', month: '2', day: '29', year: '2025' } }, ctx(PLAIN))
    expect(plainYear.birth).toBe('February 2025 has 28 days. Pick a day up to 28.')
    expect(validateCustomerForm({ ...f, agreed: true, birth: { calendar: 'AD', month: '2', day: '29', year: '' } }, ctx(PLAIN))).toEqual({})
  })

  test('withdrawing the agreement checks no date', () => {
    const f = { ...formFromCustomer(AGREED), withdraw: true, birth: { calendar: 'BS', month: '6', day: '', year: '' } }
    expect(validateCustomerForm(f, ctx(AGREED))).toEqual({})
  })

  test('the card: an expiry before the issue date, a long number, a bad limit', () => {
    const f = { ...formFromCustomer(MEMBER), expiresOn: '2026-10-01', cardNo: 'X'.repeat(31), creditLimit: '-5' }
    const errs = validateCustomerForm(f, ctx(MEMBER))
    expect(Object.keys(errs).sort()).toEqual(['cardNo', 'creditLimit', 'expiresOn'])
  })

  test('a login that cannot change the card is not held to it', () => {
    const f = { ...formFromCustomer(MEMBER), creditLimit: 'abc' }
    expect(validateCustomerForm(f, ctx(MEMBER, { canEditCard: false }))).toEqual({})
  })
})

describe('the PATCH a save sends', () => {
  const opts = { canEditCard: true, canEditDates: true, nowIso: NOW }

  test('nothing changed sends nothing (a stored "5000.00" equals a typed 5000)', () => {
    expect(buildCustomerPatch(MEMBER, formFromCustomer(MEMBER), opts)).toEqual({})
    expect(buildCustomerPatch(AGREED, formFromCustomer(AGREED), opts)).toEqual({})
  })

  test('giving a card: the type, the number upper-cased, the dates and a limit', () => {
    const f = { ...formFromCustomer(PLAIN), typeId: 't1', cardNo: ' gold-7 ', issuedOn: '2026-10-15', expiresOn: '2027-10-16', creditLimit: ' 2500.5 ' }
    expect(buildCustomerPatch(PLAIN, f, opts)).toEqual({
      membership_type_id: 't1', card_no: 'GOLD-7', card_issued_on: '2026-10-15', card_expires_on: '2027-10-16', credit_limit: 2500.5,
    })
  })

  test('taking a card away clears its number and dates with it; a cleared limit is no limit', () => {
    const f = { ...formFromCustomer(MEMBER), typeId: '', creditLimit: '' }
    expect(takesCardAway(MEMBER, f, true)).toBe(true)
    expect(buildCustomerPatch(MEMBER, f, opts)).toEqual({
      membership_type_id: null, card_no: null, card_issued_on: null, card_expires_on: null, credit_limit: null,
    })
  })

  test('a supervisor\'s save never carries the card columns', () => {
    const f = { ...formFromCustomer(MEMBER), typeId: '', creditLimit: '99', agreed: true, anniv: { calendar: 'AD', month: '3', day: '14', year: '' } }
    expect(buildCustomerPatch(MEMBER, f, { ...opts, canEditCard: false })).toEqual({
      anniv_month: 3, anniv_day: 14, anniv_calendar: 'AD', consent_at: NOW,
    })
    expect(takesCardAway(MEMBER, f, false)).toBe(false)
  })

  test('a first agreement is sent with the dates; one already recorded is never re-sent', () => {
    const f = { ...formFromCustomer(PLAIN), agreed: true, birth: { calendar: 'BS', month: '6', day: '29', year: '2050' } }
    expect(buildCustomerPatch(PLAIN, f, opts)).toEqual({
      birth_month: 6, birth_day: 29, birth_year: 2050, birth_calendar: 'BS', consent_at: NOW,
    })
    const changed = { ...formFromCustomer(AGREED), birth: { calendar: 'BS', month: '6', day: '30', year: '2050' } }
    expect(buildCustomerPatch(AGREED, changed, opts)).toEqual({ birth_day: 30 })
  })

  test('withdrawing the agreement clears both dates in the same save', () => {
    const withAnniv = { ...AGREED, anniv_month: 2, anniv_day: 14, anniv_year: null, anniv_calendar: 'AD' }
    const f = { ...formFromCustomer(withAnniv), withdraw: true }
    expect(buildCustomerPatch(withAnniv, f, opts)).toEqual({
      birth_month: null, birth_day: null, birth_year: null, birth_calendar: null,
      anniv_month: null, anniv_day: null, anniv_calendar: null, consent_at: null,
    })
  })

  test('clearing a date keeps the agreement', () => {
    const f = { ...formFromCustomer(AGREED), birth: { calendar: 'BS', month: '', day: '', year: '' } }
    expect(buildCustomerPatch(AGREED, f, opts)).toEqual({ birth_month: null, birth_day: null, birth_year: null, birth_calendar: null })
  })
})
