// Dead stock / slow movers — the verdict and the next step, kept pure so they can be tested.
//
// S756 (D20), decided with the owner:
//
//   DEAD used to mean "zero consumption in ONE month". A month is too short to call food dead: an
//   item bought for a festival, a sauce base between menu changes, a case that arrived on the 28th
//   — each reads Dead for a month and is fine the next. So Dead now needs the item to have sat
//   still for DEAD_AFTER_MONTHS (3) CONSECUTIVE months in which it had stock and was counted.
//
//   SLOW keeps its old meaning (used less than 20% of what was available this month) AND absorbs
//   what a one- or two-month standstill used to be called: Dead. Those are the same finding — "this
//   is barely moving, watch it" — at two strengths, and splitting them into a third status would
//   give the owner a word to learn for no difference in what to do.
//
//   A month with no closing count for the item is NOT JUDGED (the S717 three-state rule: assessed,
//   not counted, inconsistent). It breaks the streak rather than counting as a still month — "we
//   did not look" is not evidence that nothing moved. So is a month in which the item had no stock
//   at all, and so is a gap in the period list: a streak is consecutive calendar months or nothing.

import { computeUsed } from '../../../shared/imsFormulas'
import { daysUntilExpiry, ageInDays } from '../reports/stockAgeingCalc'

// Item is "Slow" if used < 20% of net available
export const SLOW_THRESHOLD = 0.2
// Consecutive still months before an item is called Dead.
export const DEAD_AFTER_MONTHS = 3
// Still for MORE than this many months → write it off rather than hoping it sells.
export const WRITE_OFF_AFTER_MONTHS = 3
// A purchase this recent can plausibly still go back to the supplier.
export const RECENT_PURCHASE_DAYS = 45

// Quantity tolerance (S756): `computeUsed` is a chain of float subtractions, so a fully consistent
// item can land at −1.1e-16. Far below any real quantity in a base unit.
export const QTY_EPS = 1e-6

/**
 * One item in one month: `absent` (no stock and no count — nothing to judge), `uncounted` (had
 * stock, no closing count — consumption is unknowable), `inconsistent` (counted higher than was
 * available — a missing bill, and "never used" would be the wrong thing to say), or `judged` with
 * the measured `used`. Presence of the count is `hasCount`; a count of 0 is a count (S695).
 */
export function judgeItemPeriod({ opening = 0, purchased = 0, returned = 0, wasted = 0, staffUsed = 0, hasCount = false, closing = 0 }) {
  const available = opening + purchased - returned
  if (available <= QTY_EPS && !hasCount) return { state: 'absent', available }
  if (!hasCount) return { state: 'uncounted', available }
  // Counted zero on an item nothing was available of: no stock presence, not a Dead item worth NPR 0.
  if (available <= QTY_EPS && closing <= QTY_EPS) return { state: 'absent', available }
  const rawUsed = computeUsed({ opening, purchases: purchased, returns: returned, wastage: wasted, staffMeals: staffUsed, closing })
  if (rawUsed < -QTY_EPS) return { state: 'inconsistent', available }
  // Inside the tolerance a residue either side of zero IS zero — so a row prints 0, not −0.0.
  const used = Math.abs(rawUsed) <= QTY_EPS ? 0 : rawUsed
  return { state: 'judged', available, used, closing }
}

/**
 * How many consecutive months, newest first, the item sat still: judged, used nothing, and each
 * month the calendar month before the one after it. `history` is `[{ monthIndex, judgement }]`
 * newest first. Anything else — uncounted, inconsistent, absent, a gap — ends the streak.
 */
export function stillStreak(history) {
  let n = 0
  for (let i = 0; i < (history || []).length; i++) {
    const h = history[i]
    if (i > 0 && history[i - 1].monthIndex - h.monthIndex !== 1) break
    const j = h.judgement
    if (!j || j.state !== 'judged' || j.used !== 0) break
    n += 1
  }
  return n
}

/**
 * The verdict for an item, from its month-by-month history (newest first). The newest month must
 * itself be judged or there is no verdict — that item is counted as uncounted/inconsistent by the
 * page, exactly as before.
 *
 * Returns `{ status: 'Dead' | 'Slow' | null, stillMonths, atLeast }`. `atLeast` is true when the
 * streak runs to the oldest month the page read, so "3 months" may really be longer.
 */
export function classifyItem(history) {
  const latest = history?.[0]?.judgement
  if (!latest || latest.state !== 'judged') return { status: null, stillMonths: 0, atLeast: false }
  const stillMonths = stillStreak(history)
  const atLeast = stillMonths > 0 && stillMonths === history.length
  if (stillMonths >= DEAD_AFTER_MONTHS) return { status: 'Dead', stillMonths, atLeast }
  if (stillMonths >= 1) return { status: 'Slow', stillMonths, atLeast }
  if (latest.available > 0 && latest.used / latest.available < SLOW_THRESHOLD) return { status: 'Slow', stillMonths: 0, atLeast: false }
  return { status: null, stillMonths: 0, atLeast: false }
}

/**
 * One plain-language next step per flagged item. Deterministic, in this order:
 *
 *   1. the latest batch is past its expiry date      → write it off as wastage
 *   2. still for more than 3 months                   → write it off as wastage
 *   3. still (any months) and bought in the last 45 days → ask that supplier to take it back
 *      (or "return to supplier" when the bill names none)
 *   4. moving but slowly, and bought in the last 45 days → buy less next time
 *   5. otherwise                                       → put it on the menu as a special
 *
 * Write-off first because food past its date or that has sat a season is a loss already; saying
 * "run a special" about it would be advice to serve it. `lastPurchase` is
 * `{ date: Date, vendorName?, expiryDate? }` or null when no purchase is in the months read.
 */
export function suggestNextStep({ status, stillMonths = 0, lastPurchase = null, asOf = new Date() }) {
  if (!status) return null
  const daysToExpiry = lastPurchase?.expiryDate ? daysUntilExpiry(lastPurchase.expiryDate, asOf) : null
  if (daysToExpiry !== null && daysToExpiry < 0) {
    return { key: 'write_off', text: 'Write it off as wastage — the latest batch is past its expiry date.' }
  }
  if (stillMonths > WRITE_OFF_AFTER_MONTHS) {
    return { key: 'write_off', text: `Write it off as wastage — nothing has been used for ${stillMonths} months.` }
  }
  const daysSince = lastPurchase?.date ? ageInDays(lastPurchase.date, asOf) : null
  const recent = daysSince !== null && daysSince <= RECENT_PURCHASE_DAYS
  if (recent && stillMonths >= 1) {
    return lastPurchase.vendorName
      ? { key: 'return', text: `Ask ${lastPurchase.vendorName} to take it back — bought ${daysSince} day${daysSince === 1 ? '' : 's'} ago.` }
      : { key: 'return', text: 'Return to supplier — it was bought recently.' }
  }
  if (recent) {
    return { key: 'buy_less', text: 'Buy less next time — you are buying more than you use.' }
  }
  return { key: 'special', text: 'Put it on the menu as a special to use it up.' }
}
