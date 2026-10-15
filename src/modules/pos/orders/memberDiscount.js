import { formatAd } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

// S843: a member card's discount at the till, and the credit-limit warning beside it.
//
// Owner decisions (2026-10-15): when a member's phone or card number is entered at payment, the
// card's discount fills in by itself as an ordinary bill discount (a real price reduction, so it is
// a discount and not a tender — the S618 rule) and the cashier can take it off; the cashier's own
// discount limit still applies (guard_pos_order_close refuses anything above it, and the till
// clamps to it already); an expired card, or a card type a manager switched off, gives nothing and
// says why. A credit limit only warns.
//
// The reason text is how the bill records which card it was: guard_pos_order_close does not check
// reason text, and Sales Exceptions / the Bill Register group by it.

export const MEMBERSHIP_REASON_PREFIX = 'Membership – '

// 10 → "10", 12.5 → "12.5", "7.50" → "7.5": the way a person says the rate.
export function pctText(pct) {
  const n = Number(pct)
  if (!Number.isFinite(n)) return ''
  return String(Math.round(n * 100) / 100)
}

export function membershipReason(typeName, pct) {
  return `${MEMBERSHIP_REASON_PREFIX}${String(typeName || 'Member').trim()} ${pctText(pct)}%`
}

export function isMembershipReason(reason) {
  return typeof reason === 'string' && reason.startsWith(MEMBERSHIP_REASON_PREFIX)
}

// Today in Nepal as "YYYY-MM-DD", the shape a stored date column compares against as a string.
export function todayNepalIso(now = Date.now()) {
  const d = nepalCivilDate(now)
  return d ? formatAd(d) : null
}

/**
 * What a customer row (with its `pos_membership_types` embed) means at the till today.
 *   { kind: 'none' }                                   no card, or no row
 *   { kind: 'inactive', typeName }                     the card type is switched off
 *   { kind: 'expired',  typeName, expiresOn }           past card_expires_on (the day itself still counts)
 *   { kind: 'active',   typeName, pct, reason, expiresOn }
 * A card with no expiry date never expires. A rate that is not a positive number gives nothing.
 */
export function memberStatus(customer, todayIso) {
  const type = customer?.pos_membership_types
  if (!customer?.membership_type_id || !type) return { kind: 'none' }
  const typeName = String(type.name || '').trim() || 'Member'
  if (type.is_active === false) return { kind: 'inactive', typeName }
  const expiresOn = customer.card_expires_on || null
  if (expiresOn && todayIso && todayIso > String(expiresOn).slice(0, 10)) {
    return { kind: 'expired', typeName, expiresOn }
  }
  const pct = Number(type.discount_pct)
  if (!Number.isFinite(pct) || pct <= 0) return { kind: 'none' }
  return { kind: 'active', typeName, pct: Math.min(pct, 100), reason: membershipReason(typeName, pct), expiresOn }
}

/**
 * The credit-limit warning, or null. `limit` null/undefined means no limit. `owed` is what the
 * customer already owes (pos_credit_open_bills), `billTotal` this bill. Warn only (owner decision):
 * the caller still lets the bill go on Credit.
 */
export function creditLimitWarning({ limit, owed, billTotal }) {
  if (limit == null || limit === '') return null
  const lim = Number(limit)
  if (!Number.isFinite(lim) || lim < 0) return null
  const before = Math.round((Number(owed) || 0) * 100) / 100
  const after = Math.round((before + (Number(billTotal) || 0)) * 100) / 100
  if (after <= lim + 0.005) return null
  return { limit: lim, before, after, over: Math.round((after - lim) * 100) / 100 }
}

// Card numbers are stored trimmed and upper-cased (the membership screens write them that way, and
// the unique key is on upper(btrim(card_no))), so a typed number is looked up the same way.
export function normalizeCardNo(raw) {
  const s = String(raw ?? '').trim().toUpperCase()
  return s || null
}
