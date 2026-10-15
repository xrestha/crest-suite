import { BS_YEAR_MAX, adToBsSafe, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { maxDayOf, monthName } from './occasions'

// The customer edit form's arithmetic (S843): a card number, a card's expiry, what the form checks,
// and the one PATCH a save sends. Pure, so the consent rules are pinned by a test.
//
// Who may change what is the database's (pos_customers_guard_loyalty): the card, its number and
// dates, and the credit limit need a POS manager (or the Owner or the operator); a birthday, an
// anniversary and the customer's agreement need a POS supervisor. A save sends only the columns the
// login may change AND that differ from the row, so a supervisor's birthday save never carries the
// card columns, and an unchanged card is never re-sent.
//
// The agreement (consent_at) is the server's record: agreeing sends any time and the server stamps
// its own with the login that recorded it; an agreement already recorded is never re-sent; taking it
// back sends NULL together with both dates cleared, in the same save (consent_required otherwise).

export const CARD_NO_MAX = 30
export const CREDIT_LIMIT_MAX = 9999999999.99
const CARD_COLUMNS = ['membership_type_id', 'card_no', 'card_issued_on', 'card_expires_on', 'credit_limit']
const PARTS = ['month', 'day', 'year', 'calendar']

/** The columns a save reads back, so the book row can be updated from what was stored. */
export const CUSTOMER_EDIT_COLUMNS = 'id, membership_type_id, card_no, card_issued_on, card_expires_on, credit_limit, '
  + 'birth_month, birth_day, birth_year, birth_calendar, anniv_month, anniv_day, anniv_year, anniv_calendar, consent_at, consent_by'

/** A card number as it is kept and looked up at the till: trimmed and upper-cased; blank is none. */
export function normaliseCardNo(s) {
  const t = String(s ?? '').trim().toUpperCase()
  return t === '' ? null : t
}

function parseIso(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d) // local midnight, never the UTC parse of a bare date
}

/**
 * A card's expiry: the same BS date `months` months after it was given ("5 Shrawan 2082" + 12 →
 * "5 Shrawan 2083"), on the month's last day when that month is shorter. An AD 'YYYY-MM-DD' string,
 * through formatAd (never .toISOString()). Empty for a type with no months, or no issue date. Past
 * the verified BS table it counts AD months instead.
 */
export function cardExpiryIso(issuedIso, months) {
  const n = Number(months)
  if (!issuedIso || !Number.isInteger(n) || n <= 0) return ''
  const start = parseIso(issuedIso)
  if (!start) return ''
  const bs = adToBsSafe(start)
  if (bs) {
    const idx = bs.month - 1 + n
    const y = bs.year + Math.floor(idx / 12)
    const m = (idx % 12) + 1
    if (y <= BS_YEAR_MAX) return formatAd(bsToAd(y, m, Math.min(bs.day, daysInBsMonth(y, m))))
  }
  const target = new Date(start.getFullYear(), start.getMonth() + n, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return formatAd(new Date(target.getFullYear(), target.getMonth(), Math.min(start.getDate(), last)))
}

const emptyDate = () => ({ calendar: 'BS', month: '', day: '', year: '' })

function dateFrom(c, p) {
  if (!c || c[`${p}_month`] == null || c[`${p}_day`] == null) return emptyDate()
  return {
    calendar: c[`${p}_calendar`] === 'AD' ? 'AD' : 'BS',
    month: String(c[`${p}_month`]),
    day: String(c[`${p}_day`]),
    year: c[`${p}_year`] == null ? '' : String(c[`${p}_year`]),
  }
}

/** The form as a customer row stands. */
export function formFromCustomer(c) {
  return {
    typeId: c?.membership_type_id || '',
    cardNo: c?.card_no || '',
    issuedOn: c?.card_issued_on ? String(c.card_issued_on).slice(0, 10) : '',
    expiresOn: c?.card_expires_on ? String(c.card_expires_on).slice(0, 10) : '',
    creditLimit: c?.credit_limit == null || c.credit_limit === '' ? '' : String(Number(c.credit_limit)),
    birth: dateFrom(c, 'birth'),
    anniv: dateFrom(c, 'anniv'),
    agreed: !!c?.consent_at,
    withdraw: false,
  }
}

/** Whether anything was typed or picked in a date. */
export function dateIsSet(d) {
  return !!d && (d.month !== '' || d.day !== '' || d.year !== '')
}

function validateDate(d, what, todayBs, todayAdYear) {
  if (!dateIsSet(d)) return ''
  if (!d.month || !d.day) return `Pick both the month and the day of the ${what}, or clear it.`
  if (d.year !== '') {
    const y = Number(d.year)
    if (!Number.isInteger(y) || y < 1900 || y > 2200) {
      return `Type the year as four digits (for example ${d.calendar === 'AD' ? '1990' : '2047'}), or leave it empty.`
    }
    const nowYear = d.calendar === 'AD' ? todayAdYear : todayBs?.year
    if (nowYear && y > nowYear) return `${y} has not come yet. Check the year (it is in the ${d.calendar === 'AD' ? 'English' : 'Nepali'} calendar), or leave it empty.`
  }
  const max = maxDayOf(d.calendar, d.month, d.year === '' ? null : d.year)
  if (Number(d.day) > max) return `${monthName(d.calendar, d.month)}${d.year ? ` ${d.year}` : ''} has ${max} days. Pick a day up to ${max}.`
  return ''
}

/**
 * What is wrong with the form, as { field: sentence }; empty when it may be saved. Fields:
 * cardNo, expiresOn, creditLimit, birth, anniv, agreed. Only what this login may change is checked.
 */
export function validateCustomerForm(form, { customer, canEditCard, canEditDates, todayBs, todayAdYear }) {
  const errors = {}
  if (canEditCard) {
    if (form.typeId) {
      if (String(form.cardNo || '').trim().length > CARD_NO_MAX) errors.cardNo = `A card number is at most ${CARD_NO_MAX} characters.`
      if (form.issuedOn && form.expiresOn && form.expiresOn < form.issuedOn) errors.expiresOn = 'The card cannot expire before the day it was given. Pick a later date, or clear it for a card that never expires.'
    }
    const limit = String(form.creditLimit ?? '').trim()
    if (limit !== '') {
      const n = Number(limit)
      if (!Number.isFinite(n) || n < 0) errors.creditLimit = 'Type the most this customer may owe, in rupees, or leave it empty for no limit.'
      else if (n > CREDIT_LIMIT_MAX) errors.creditLimit = 'That limit is too large. Type a smaller amount, or leave it empty for no limit.'
    }
  }
  if (canEditDates && !form.withdraw) {
    const b = validateDate(form.birth, 'birthday', todayBs, todayAdYear)
    const a = validateDate(form.anniv, 'anniversary', todayBs, todayAdYear)
    if (b) errors.birth = b
    if (a) errors.anniv = a
    if ((dateIsSet(form.birth) || dateIsSet(form.anniv)) && !customer?.consent_at && !form.agreed) {
      errors.agreed = 'Tick that the customer agreed before saving a birthday or an anniversary.'
    }
  }
  return errors
}

function dateColumns(p, d) {
  if (!d || !d.month || !d.day) return { [`${p}_month`]: null, [`${p}_day`]: null, [`${p}_year`]: null, [`${p}_calendar`]: null }
  return {
    [`${p}_month`]: Number(d.month),
    [`${p}_day`]: Number(d.day),
    [`${p}_year`]: d.year === '' ? null : Number(d.year),
    [`${p}_calendar`]: d.calendar === 'AD' ? 'AD' : 'BS',
  }
}

function same(stored, next) {
  if (stored == null || stored === '') return next == null || next === ''
  if (next == null || next === '') return false
  if (typeof next === 'number') return Number(stored) === next
  return String(stored).slice(0, 10) === String(next).slice(0, 10) || String(stored) === String(next)
}

/**
 * The PATCH a save sends: only the columns this login may change, and only those that differ from
 * the row. `nowIso` is any time; the server stamps its own on an agreement. Assumes a valid form.
 */
export function buildCustomerPatch(customer, form, { canEditCard, canEditDates, nowIso }) {
  const c = customer || {}
  const patch = {}
  if (canEditCard) {
    const typeId = form.typeId || null
    const limitText = String(form.creditLimit ?? '').trim()
    const next = {
      membership_type_id: typeId,
      card_no: typeId ? normaliseCardNo(form.cardNo) : null,
      card_issued_on: typeId && form.issuedOn ? form.issuedOn : null,
      card_expires_on: typeId && form.expiresOn ? form.expiresOn : null,
      credit_limit: limitText === '' ? null : Math.round(Number(limitText) * 100) / 100,
    }
    for (const k of CARD_COLUMNS) if (!same(c[k], next[k])) patch[k] = next[k]
  }
  if (canEditDates) {
    const withdrawing = !!(form.withdraw && c.consent_at)
    const next = {
      ...dateColumns('birth', withdrawing ? null : form.birth),
      ...dateColumns('anniv', withdrawing ? null : form.anniv),
    }
    for (const p of ['birth', 'anniv']) {
      for (const part of PARTS) {
        const k = `${p}_${part}`
        if (!same(c[k], next[k])) patch[k] = next[k]
      }
    }
    if (withdrawing) patch.consent_at = null
    else if (!c.consent_at && form.agreed) patch.consent_at = nowIso
  }
  return patch
}

/** The customer is about to lose a card they hold. */
export function takesCardAway(customer, form, canEditCard) {
  return !!(canEditCard && customer?.membership_type_id && !form.typeId)
}
