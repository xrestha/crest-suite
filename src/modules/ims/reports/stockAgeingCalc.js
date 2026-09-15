// Stock ageing — how long the stock still on hand has been sitting.
//
// Kept pure and separate from the page for the same reason supplierAttribution.js is: this is a
// stock VALUATION, and a wrong figure here reads as a perfectly plausible one. Everything below
// is deterministic and covered by stockAgeingCalc.test.js.
//
// The model, and its one honest limitation:
//
//   There is no batch-level consumption ledger in this schema — sales_entries, wastages and
//   staff_meals record item-level totals, never which purchase lot they came out of. So this
//   cannot be a batch-precise allocation, and neither can FifoReport — which as of S717 does not
//   merely solve the problem "the same way" but imports `allocateFifo` from here, because two
//   pages carrying the same FIFO walk is how they drift. What it does instead is the standard FIFO
//   ASSUMPTION: each item's total consumption over the window is eaten off that item's own
//   batches oldest-first, and whatever survives is what is still on the shelf. That is the same
//   level of precision every other stock figure in this app already works at.
//
// Stock carried into the window (the first period's opening count) is modelled as one batch dated
// at the window start and flagged `carriedForward`. Its TRUE age is unknown and is at least that
// old, which the page states rather than implying precision it does not have. Because FIFO eats
// oldest-first, ordinary turnover consumes it before touching real purchases — so anything left
// in it is genuinely stale, which is the whole point of the report.

import { bsToAd, adToBs, adToBsSafe, daysInBsMonth } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

export const AGE_BANDS = [
  { key: '0-30', label: '0–30 days', min: 0, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '61-90', label: '61–90 days', min: 61, max: 90 },
  { key: '90+', label: '90+ days', min: 91, max: Infinity },
]

// The band an age in days falls into. Negative ages (a purchase dated in the future — a typo, or
// a BS→AD conversion at the edge of the table) clamp to the youngest band rather than falling
// through to undefined: a mis-dated row must still be counted somewhere, or the bands stop
// summing to the total and the page silently under-reports what is on hand.
export function bandOf(ageDays) {
  if (!(ageDays > 0)) return AGE_BANDS[0].key
  for (const b of AGE_BANDS) if (ageDays <= b.max) return b.key
  return AGE_BANDS[AGE_BANDS.length - 1].key
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Whole days between two dates, floored at 0. Both are treated as local dates. */
export function ageInDays(from, asOf) {
  const a = from instanceof Date ? from : new Date(from)
  const b = asOf instanceof Date ? asOf : new Date(asOf)
  if (isNaN(a) || isNaN(b)) return 0
  return Math.max(0, Math.floor((b - a) / MS_PER_DAY))
}

/**
 * `'YYYY-MM-DD'` as LOCAL midnight, or null.
 *
 * `new Date('2026-09-09')` is parsed as UTC midnight — at Nepal's +05:45 that is 05:45 on the 9th
 * local, so a bare date string compared against a local wall clock is out by most of a day. Same
 * family as the `.toISOString()` trap the BS rules name, in the other direction.
 */
export function parseDateLocal(iso) {
  const [y, m, d] = String(iso || '').split('T')[0].split('-').map(Number)
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  return isNaN(dt) ? null : dt
}

/**
 * Whole days from `asOf` to a stored date, negative once it has passed. `null` if unparseable —
 * never 0, which would read as "expires today".
 *
 * The mirror of `ageInDays`: that one looks back from a purchase, this one looks forward to an
 * expiry. Both sides are floored to local midnight so the answer is a whole number of days rather
 * than a fraction of one — FifoReport's own copy mixed a UTC-parsed date with `new Date()` and
 * `Math.ceil`'d the result, which produced `-0` for a batch that expired earlier the same day and
 * therefore rendered it as in-date (S717).
 */
export function daysUntilExpiry(expiryIso, asOf) {
  const e = parseDateLocal(expiryIso)
  const b = asOf instanceof Date ? asOf : new Date(asOf)
  if (!e || isNaN(b)) return null
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((e - bMid) / MS_PER_DAY)
}

/**
 * Today IN NEPAL, as `{ date, bs, isToday: true }` — `date` at the runtime's local midnight carrying
 * Nepal's Y/M/D, so `ageInDays`/`daysUntilExpiry` (which read local getters) count Nepal's days.
 *
 * `new Date()` is today for a viewer in Kathmandu and yesterday or tomorrow for the operator viewing
 * the client from anywhere else near midnight — the S670 display rule, applied to an as-of date.
 */
export function nepalTodayRef(now = new Date()) {
  const date = nepalCivilDate(now) || new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return { date, bs: adToBsSafe(date) || adToBs(date), isToday: true }
}

/**
 * The date a stock report measures ages or expiry AGAINST, for a window ending with `lastPeriod`.
 *
 * Today (Nepal) when the window is the NEWEST one the client has, or has not ended yet; otherwise
 * the last day of `lastPeriod` — "how things stood when that month ended" (S594/S717).
 *
 * WHY "newest", not "the current BS month" (S756): the page defaults to the latest period, and
 * early in a month — before anyone opens the new period — the latest period is LAST month. Measured
 * to that month's end, a batch that expired three days ago read "Expiring in 4d" and the Expired
 * card said 0 ✓, on the exact days the stock is going off. When nothing newer exists, what that
 * window left on the shelf is what is on the shelf today, so today is the honest as-of date.
 */
export function asOfForWindow(lastPeriod, { isNewest = false } = {}, now = new Date()) {
  const today = nepalTodayRef(now)
  if (!lastPeriod) return today
  const day = daysInBsMonth(lastPeriod.bs_year, lastPeriod.bs_month)
  const end = bsToAd(lastPeriod.bs_year, lastPeriod.bs_month, day)
  if (isNewest || !(end < today.date)) return today
  return { date: end, bs: { year: lastPeriod.bs_year, month: lastPeriod.bs_month, day }, isToday: false }
}

/**
 * Split vendor returns into the ones that come off a batch in the window and the ones that do not
 * (S756). A return names its purchase line where it can; a line OUTSIDE the window (a bill from an
 * earlier fiscal year, returned this one) matches no batch here, and used to land in the by-entry
 * map and be subtracted from nothing — the goods left the building and the report kept them on the
 * shelf. Those, like a return with no line at all, are taken off the item as consumption, which
 * FIFO eats from the carried-forward stock first: exactly where an earlier year's bill now lives.
 *
 * `entryIds` is the Set of purchase_entries ids the window's batches were built from.
 */
export function splitReturns(returns, entryIds) {
  const byEntry = {}
  const byItem = {}
  for (const r of returns || []) {
    const q = parseFloat(r.qty) || 0
    if (r.purchase_entry_id && entryIds.has(r.purchase_entry_id)) byEntry[r.purchase_entry_id] = (byEntry[r.purchase_entry_id] || 0) + q
    else if (r.item_id) byItem[r.item_id] = (byItem[r.item_id] || 0) + q
  }
  return { byEntry, byItem }
}

/**
 * Eat each item's consumption off its own batches, oldest first.
 *
 * batches: [{ item_id, qty, rate, date, carriedForward? }]  (qty already net of returns)
 * consumedByItem: { [item_id]: qty consumed over the window }
 *
 * Extra fields on a batch ride through untouched (the two spreads below copy the whole object) and
 * FifoReport depends on that: it hangs the `purchase_entries` row itself off each batch as `entry`
 * so it can render the expiry date and rate of whatever survives. Do not narrow the spreads to a
 * fixed field list.
 *
 * Returns a NEW array of batches with `remaining` set; input is not mutated. Batches are returned
 * in the same oldest-first order they were consumed in, which is also the order the page renders.
 * A batch that is fully consumed is kept with remaining 0 rather than dropped, so a caller can
 * still report on it (the page filters); dropping it here would hide the distinction between "no
 * such batch" and "this batch is used up".
 */
export function allocateFifo(batches, consumedByItem) {
  const byItem = new Map()
  for (const b of batches || []) {
    if (!byItem.has(b.item_id)) byItem.set(b.item_id, [])
    byItem.get(b.item_id).push({ ...b })
  }
  const out = []
  for (const [itemId, rows] of byItem) {
    // Oldest first. carriedForward sorts before same-dated purchases — it is by definition older
    // than anything bought inside the window, and eating it first is what makes leftovers real.
    rows.sort((x, y) => {
      const d = new Date(x.date) - new Date(y.date)
      if (d !== 0) return d
      return (y.carriedForward ? 1 : 0) - (x.carriedForward ? 1 : 0)
    })
    let left = Math.max(0, parseFloat(consumedByItem?.[itemId]) || 0)
    for (const r of rows) {
      const qty = Math.max(0, parseFloat(r.qty) || 0)
      const eaten = Math.min(qty, left)
      left -= eaten
      out.push({ ...r, qty, consumed: eaten, remaining: qty - eaten })
    }
  }
  return out
}

/**
 * Full report: allocate, then age and value whatever is left.
 *
 * Returns { items, totals } where items is one row per item carrying a per-band {qty, value} and
 * `oldestDays`, and totals is the same shape aggregated. Value uses each batch's OWN rate (the
 * price actually paid for the stock still sitting there), not the current master rate — ageing is
 * about capital already committed. **The carried-forward batch is the exception and the caller
 * supplies its rate**: there is no purchase line behind it, so the page passes the current master
 * rate and says so. Do not let that exception quietly become the rule for real batches.
 *
 * `carriedForwardValue` and `carriedForwardBand` are surfaced per item (S718) because the page has
 * to disclose two things the age arithmetic cannot express on its own:
 *
 *   - **A quantity total across items is meaningless.** Carried-forward stock is kg of flour plus
 *     litres of oil plus pieces of napkin, and the page used to add them up and print the result as
 *     "units" in a KPI card — while the table's own TOTAL row printed "—" in the On Hand column for
 *     exactly that reason, two hundred pixels away. Value is the only figure that sums.
 *   - **Its age is a floor, not a measurement.** It is dated at the window start, so early in a
 *     fiscal year it necessarily lands in a young band: two months in, stock that has genuinely sat
 *     for three years is 60 days old to this report, and the 90+ headline reads NPR 0 in green with
 *     a ✓. `carriedForwardBand` lets the caller withhold that verdict.
 */
export function buildAgeing(batches, consumedByItem, asOf = new Date()) {
  const allocated = allocateFifo(batches, consumedByItem)
  const items = new Map()
  const emptyBands = () => Object.fromEntries(AGE_BANDS.map(b => [b.key, { qty: 0, value: 0 }]))

  for (const b of allocated) {
    if (!(b.remaining > 1e-9)) continue
    const age = ageInDays(b.date, asOf)
    const band = bandOf(age)
    const value = b.remaining * (parseFloat(b.rate) || 0)

    if (!items.has(b.item_id)) {
      items.set(b.item_id, {
        item_id: b.item_id, qty: 0, value: 0, oldestDays: 0,
        carriedForwardQty: 0, carriedForwardValue: 0, carriedForwardBand: null,
        bands: emptyBands(),
      })
    }
    const row = items.get(b.item_id)
    row.qty += b.remaining
    row.value += value
    row.oldestDays = Math.max(row.oldestDays, age)
    if (b.carriedForward) {
      row.carriedForwardQty += b.remaining
      row.carriedForwardValue += value
      row.carriedForwardBand = band
    }
    row.bands[band].qty += b.remaining
    row.bands[band].value += value
  }

  const totals = { qty: 0, value: 0, carriedForwardValue: 0, unknownAgeValue: 0, bands: emptyBands() }
  const oldestKey = AGE_BANDS[AGE_BANDS.length - 1].key
  for (const row of items.values()) {
    totals.qty += row.qty
    totals.value += row.value
    totals.carriedForwardValue += row.carriedForwardValue
    // Carried-forward stock that did NOT land in the oldest band is the part whose true age the
    // report is actively unable to see: it is at least window-old and could be years older, and
    // the only reason it is not in the 90+ column is that the window itself is not 91 days long.
    if (row.carriedForwardBand && row.carriedForwardBand !== oldestKey) {
      totals.unknownAgeValue += row.carriedForwardValue
    }
    for (const b of AGE_BANDS) {
      totals.bands[b.key].qty += row.bands[b.key].qty
      totals.bands[b.key].value += row.bands[b.key].value
    }
  }

  return { items: [...items.values()], totals }
}
