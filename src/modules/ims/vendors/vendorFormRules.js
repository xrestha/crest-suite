// The Add Vendor form's rules that the Excel import shares (S885). nextVendorCodeAfter lived in
// Vendors.js until the import needed it; Vendors.js re-exports it for Vendors.test.js.
import { parsePayTerms, MAX_PAY_WITHIN_DAYS, DEFAULT_PAY_WITHIN_DAYS } from './payTerms'

// S756: the prefix is a free-text setting and went into `new RegExp` raw — "V.N" matched "VXN-004",
// "A+" meant "one or more A", and "(" threw, taking Add Vendor down with it.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The next `PREFIX-NNN` after the highest one in `codes`. */
export function nextVendorCodeAfter(rawPrefix, codes) {
  const prefix = String(rawPrefix).toUpperCase()
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`)
  let maxNum = 0
  ;(codes || []).forEach(code => {
    const match = String(code || '').match(re)
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
  })
  return `${prefix}-${String(maxNum + 1).padStart(3, '0')}`
}

/**
 * The sentence under the Pay within box, or null when the box is fine. The box is text (with a
 * numeric keypad), not type="number": a number input reports "" for "abc", which would save as
 * the 60-day default with nothing said.
 */
export function payWithinError(value) {
  const s = String(value ?? '').trim()
  if (s === '') return null
  if (!/^\d+$/.test(s) || Number(s) > MAX_PAY_WITHIN_DAYS) {
    return `Type whole days from 0 to ${MAX_PAY_WITHIN_DAYS}: 0 means due on delivery. Leave it blank for the usual ${DEFAULT_PAY_WITHIN_DAYS} days.`
  }
  return null
}

/** What the box saves: null when blank (the default applies), else the whole number. */
export function payWithinValue(value) {
  const s = String(value ?? '').trim()
  return s === '' ? null : Number(s)
}

/**
 * The days a typed terms note offers while the box is blank ("Net 30" → 30, "COD" → 0), or null
 * when there is nothing to offer: the box already holds a number, or the note says nothing a
 * number can carry ("50% advance").
 */
export function suggestedPayWithin(form) {
  if (String(form?.pay_within_days ?? '').trim() !== '') return null
  return parsePayTerms(form?.payment_terms)
}

/** The offer button's label for a suggestion. */
export function suggestionLabel(days) {
  return days === 0 ? 'Use: due on delivery' : `Use ${days} day${days === 1 ? '' : 's'}`
}
