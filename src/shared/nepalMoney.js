import { numberToWordsNpr } from '../utils/numberToWords'

/**
 * Money, grouped the way Nepal reads it.
 *
 * WHY (S683): 261 sites formatted money with the `en-NP` locale believing that made the number
 * Nepali. It does not: resolve `en-NP` through Intl and `resolvedOptions().locale` is plain `en` —
 * the region subtag carries no grouping data — so every one of them rendered `1,248,650`. A
 * further 146 sites passed no locale at all and rendered in the VIEWER's browser locale
 * (`1.248.650` on a German laptop, on /pricing, where a buyer picks a plan). Nepal groups in lakh
 * and crore: `12,48,650`. The only place the product rendered that was the subscription agreement,
 * while DESIGN.md derives `.stat-grid`'s 200px floor from "a Nepali-grouped NPR 12,48,650" — a
 * format nothing rendered — and `numberToWords.js` says "Three Lakh" on a bill whose digits read
 * `342500.00`.
 *
 * `en-IN` is the locale whose Latin-digit grouping matches Nepal's (`ne-NP` groups correctly but
 * prints Devanagari digits — १२,४८,६५०). Verified in this runtime:
 * `(1248650).toLocaleString('en-IN') === '12,48,650'`.
 *
 * Same shape as nepalTime.js: the third copy of a decision becomes a file. 52 local formatters
 * were byte-identical one-liners; the functions below ARE those shapes, with the rounding each
 * had. Reach for these, and never write a money `toLocaleString` with any other locale —
 * `nepalMoney.test.js` reads the source and fails on it.
 */

export const NPR_LOCALE = 'en-IN'

// Built once: Intl.NumberFormat is expensive enough to show on a 1000-row register.
const int0 = new Intl.NumberFormat(NPR_LOCALE, { maximumFractionDigits: 0 })
const dec2 = new Intl.NumberFormat(NPR_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** `12,48,650` — Math.round, no prefix. The HR and asset tables' `fmt`. */
export function nprInt(n) {
  return int0.format(Math.round(n || 0))
}

/** `3,42,500.00` — two decimals, no prefix. Bill lines, purchase totals, VAT figures. */
export function npr2(n) {
  return dec2.format(Number(n) || 0)
}

/** `NPR 12,48,650` — the product's default money figure. */
export function npr(n) {
  return `NPR ${nprInt(n)}`
}

/** `NPR 3,42,500.00` */
export function nprExact(n) {
  return `NPR ${npr2(n)}`
}

/**
 * `npr()`, or an em dash when the figure does not exist. A null is "we do not have this number",
 * and `NPR 0` says something else — the Group Console and the frozen report both need the
 * distinction, since a missing outlet figure and a zero-revenue outlet are different facts.
 */
export function nprOrDash(n) {
  return n == null ? '—' : npr(n)
}

/** `Three Lakh Forty-Two Thousand Five Hundred` — the words beside the digits on an IRD bill. */
export { numberToWordsNpr as nprWords }
