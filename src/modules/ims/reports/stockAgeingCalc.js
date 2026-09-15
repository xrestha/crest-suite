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
//
// S756 (D19): QUANTITIES FOLLOW THE COUNTS. Both pages now walk a rolling 12-month window through
// `anchorToCounts`, which forces each item's remaining stock to its closing count at every closed
// month that has one — so theft and spillage leave the shelf here as they do on Stock Report,
// instead of ageing into the 90+ band as "old stock". Ages are still estimated from purchase dates,
// oldest used first; only the quantities are anchored.

import { bsToAd, adToBs, adToBsSafe, daysInBsMonth } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'
import { deltaItems } from '../../../utils/orderLineIngredients'

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
  // The same off-batch returns, keyed by the period they were made in (S756, D19). The count
  // anchoring below walks the window month by month, so a return has to come off in ITS month —
  // before that month's count, not smeared across the year. Rows with no period_id land under '_'.
  const byPeriodItem = {}
  for (const r of returns || []) {
    const q = parseFloat(r.qty) || 0
    if (r.purchase_entry_id && entryIds.has(r.purchase_entry_id)) byEntry[r.purchase_entry_id] = (byEntry[r.purchase_entry_id] || 0) + q
    else if (r.item_id) {
      byItem[r.item_id] = (byItem[r.item_id] || 0) + q
      const pk = r.period_id || '_'
      if (!byPeriodItem[pk]) byPeriodItem[pk] = {}
      byPeriodItem[pk][r.item_id] = (byPeriodItem[pk][r.item_id] || 0) + q
    }
  }
  return { byEntry, byItem, byPeriodItem }
}

/** A period's position on a single month axis — for ordering and for "is this the next month". */
export function periodMonthIndex(p) {
  return p.bs_year * 12 + (p.bs_month - 1)
}

/**
 * The window a stock report ages within: every period whose month falls in the `months` months
 * ending with `selected`, oldest first (S756, D19).
 *
 * WHY ROLLING, NOT THE FISCAL YEAR: the window used to reset on Shrawan 1. A tin bought in Ashadh
 * with a two-year shelf life was then simply outside both reports from the first day of the new
 * year — gone from the expiry check the week it was most likely to be forgotten — and early in
 * every year the window was too short to place anything in the 90+ band. Twelve months back from
 * the as-of month always reaches past the 90-day band and never forgets a recent purchase.
 * Months with no period (a paused client) are simply absent; the window does not reach further back
 * to make up the count, because "12 months" is a length of time, not a number of rows.
 */
export function rollingWindow(allPeriods, selected, months = 12) {
  if (!selected) return []
  const end = periodMonthIndex(selected)
  return (allPeriods || [])
    .filter(p => { const i = periodMonthIndex(p); return i <= end && i > end - months })
    .sort((a, b) => periodMonthIndex(a) - periodMonthIndex(b))
}

/**
 * Consumption per period per item: recipe-exploded sales + wastage + staff meals + off-batch
 * returns (S756, D19). The two FIFO pages computed this as one whole-window total; the count
 * anchoring needs it month by month, because a count only settles the consumption BEFORE it.
 *
 * `sales` must already have been through `selectDepletingSalesAcrossPeriods` (S718) and carry
 * `period_id`; `breakdown` is `explodeRecipeIngredients`' `{ recipeId: [{ item_id, qty }] }`;
 * `returnsByPeriodItem` is `splitReturns(...).byPeriodItem`; `explosion` is
 * `loadDeltaExplosion`'s result for the sales rows' `ingredient_deltas` (null when none carry any).
 */
export function sumConsumptionByPeriod({ sales, breakdown, wastages, staffMeals, returnsByPeriodItem, explosion = null } = {}) {
  const out = {}
  const add = (pid, itemId, q) => {
    if (!itemId || !(q > 0)) return
    const key = pid || '_'
    if (!out[key]) out[key] = {}
    out[key][itemId] = (out[key][itemId] || 0) + q
  }
  const soldByPeriodRecipe = {}
  // Crest Customization (S758): a customized plate's option deltas are SIGNED ("Half" takes momo
  // off), so sales usage is netted per item before `add` drops what is not positive — adding each
  // term on its own would keep the recipe's +10 momo and discard the option's −5.
  const deltaSoldByKey = {}
  const salesUse = {}
  const bump = (pid, itemId, q) => {
    if (!itemId || !q) return
    const key = pid || '_'
    if (!salesUse[key]) salesUse[key] = {}
    salesUse[key][itemId] = (salesUse[key][itemId] || 0) + q
  }
  for (const s of sales || []) {
    if (!s.recipe_id) continue
    const key = `${s.period_id || '_'}|${s.recipe_id}`
    soldByPeriodRecipe[key] = (soldByPeriodRecipe[key] || 0) + (parseFloat(s.qty_sold) || 0)
    if (s.ingredient_deltas) {
      const dKey = `${key}|${JSON.stringify(s.ingredient_deltas)}`
      const e = deltaSoldByKey[dKey] || (deltaSoldByKey[dKey] = { pid: s.period_id || '_', deltas: s.ingredient_deltas, sold: 0 })
      e.sold += parseFloat(s.qty_sold) || 0
    }
  }
  for (const [key, sold] of Object.entries(soldByPeriodRecipe)) {
    // A period's net sales of a dish can go negative through a credit note; it consumes nothing.
    if (!(sold > 0)) continue
    const [pid, recipeId] = key.split('|')
    for (const { item_id, qty } of (breakdown || {})[recipeId] || []) bump(pid, item_id, sold * (parseFloat(qty) || 0))
  }
  // Same net-negative rule for the options, per dish + selection.
  for (const { pid, deltas, sold } of Object.values(deltaSoldByKey)) {
    if (!(sold > 0)) continue
    for (const { item_id, qty } of deltaItems(deltas, explosion)) bump(pid, item_id, sold * qty)
  }
  for (const [pid, byItem] of Object.entries(salesUse)) {
    for (const [itemId, q] of Object.entries(byItem)) add(pid, itemId, q)
  }
  for (const w of wastages || []) add(w.period_id, w.item_id, parseFloat(w.qty) || 0)
  for (const m of staffMeals || []) add(m.period_id, m.item_id, parseFloat(m.qty) || 0)
  for (const [pid, byItem] of Object.entries(returnsByPeriodItem || {})) {
    for (const [itemId, q] of Object.entries(byItem)) add(pid, itemId, q)
  }
  return out
}

const QTY_EPS = 1e-9

function batchOrder(x, y) {
  const d = new Date(x.date) - new Date(y.date)
  if (d !== 0) return d
  // Carried-in stock is by definition older than anything bought on the same day.
  return (y.carriedForward ? 1 : 0) - (x.carriedForward ? 1 : 0)
}

/**
 * Walk the window month by month, eating consumption oldest-first and ANCHORING each item's stock
 * to its physical count wherever one exists (S756, D19).
 *
 * WHY: both FIFO pages used to start from the window's opening count, add purchases, subtract
 * recipe-theoretical usage and never read a closing count again. So they disagreed with Stock
 * Report (which follows the count), and stock that was stolen, spilled or over-portioned — gone
 * from the shelf, never in theoretical usage — stayed in the batches and aged into the 90+ band as
 * "old stock". The count is the anchor everywhere else in IMS (ims-figures.md); here too.
 *
 * For each period, oldest first:
 *   1. that period's batches join their item's queue;
 *   2. that period's consumption is eaten off the OLDEST remaining batches;
 *   3. where `countsByPeriod[period][item]` exists, the item's remaining quantity is FORCED to it —
 *      a lower count takes the difference off the oldest batches (FIFO: the old stock is what went),
 *      a higher count adds the surplus as ONE carried-in batch dated at the count and flagged
 *      `fromCount` + `carriedForward`: its age is unknown and at least that old. No purchase is
 *      invented; the S718 unknown-age floor treatment then applies to it like any carried-in stock.
 * Between counts the estimate stands. Consumption beyond what is held is dropped rather than
 * carried into later months — it means a bill or an opening count is missing, and eating next
 * month's real purchases with it would age a fresh delivery as used.
 *
 * `periods`: `[{ id, endDate }]` oldest first. `batches`: `[{ item_id, qty, rate, date, period_id,
 * carriedForward? }]` (extra fields ride through, as in allocateFifo). `countsByPeriod`:
 * `{ [period_id]: { [item_id]: qty } }` — the CALLER decides which counts are anchors (closed
 * periods only) and a count of 0 is a count (S695). `surplusRateOf(itemId)` values a surplus batch,
 * which has no purchase line (the caller passes the master rate and says so). `itemIds`, when
 * given, is the Set of items the report covers; everything else is ignored (sub-recipe mirrors,
 * inactive items).
 *
 * Returns `{ batches, lastCountByItem }` — every batch (surplus ones included) with `consumed`
 * (everything taken off it), `countedOff` (the part of that the count took) and `remaining`, in
 * oldest-first order per item; and the id of the latest period whose count anchored each item.
 * Input is not mutated.
 */
export function anchorToCounts({ periods, batches, consumedByPeriod = {}, countsByPeriod = {}, surplusRateOf = () => 0, itemIds = null } = {}) {
  const admit = id => !!id && (!itemIds || itemIds.has(id))
  const plist = periods || []
  const idx = new Map(plist.map((p, i) => [p.id, i]))
  const joining = plist.map(() => [])
  for (const b of batches || []) {
    if (!admit(b.item_id)) continue
    const i = idx.has(b.period_id) ? idx.get(b.period_id) : 0
    const qty = Math.max(0, parseFloat(b.qty) || 0)
    if (joining[i]) joining[i].push({ ...b, qty, consumed: 0, countedOff: 0, remaining: qty })
  }

  const queues = new Map()
  const all = []
  const lastCountByItem = {}
  const queueOf = itemId => {
    if (!queues.has(itemId)) queues.set(itemId, [])
    return queues.get(itemId)
  }
  const take = (queue, amount, fromCount) => {
    let left = amount
    for (const b of queue) {
      if (left <= QTY_EPS) break
      if (!(b.remaining > QTY_EPS)) continue
      const t = Math.min(b.remaining, left)
      b.remaining -= t
      b.consumed += t
      if (fromCount) b.countedOff += t
      left -= t
    }
  }

  plist.forEach((p, i) => {
    const touched = new Set()
    for (const b of joining[i]) { queueOf(b.item_id).push(b); all.push(b); touched.add(b.item_id) }
    for (const itemId of touched) queues.get(itemId).sort(batchOrder)

    for (const [itemId, q] of Object.entries(consumedByPeriod[p.id] || {})) {
      if (!admit(itemId) || !queues.has(itemId)) continue
      take(queues.get(itemId), Math.max(0, parseFloat(q) || 0), false)
    }

    for (const [itemId, raw] of Object.entries(countsByPeriod[p.id] || {})) {
      if (!admit(itemId)) continue
      const counted = Math.max(0, parseFloat(raw) || 0)
      const queue = queueOf(itemId)
      const held = queue.reduce((s, b) => s + b.remaining, 0)
      if (held > counted + QTY_EPS) {
        take(queue, held - counted, true)
      } else if (counted > held + QTY_EPS) {
        const surplus = {
          item_id: itemId, qty: counted - held, rate: surplusRateOf(itemId) || 0,
          date: p.endDate, period_id: p.id, carriedForward: true, fromCount: true,
          consumed: 0, countedOff: 0, remaining: counted - held,
        }
        queue.push(surplus)
        all.push(surplus)
      }
      lastCountByItem[itemId] = p.id
    }
  })

  // Snap float residue to zero so a fully-counted-off batch reads as used up, not 1e-15 on the shelf.
  for (const b of all) if (Math.abs(b.remaining) <= QTY_EPS) b.remaining = 0
  const itemOrder = new Map()
  all.forEach(b => { if (!itemOrder.has(b.item_id)) itemOrder.set(b.item_id, itemOrder.size) })
  all.sort((x, y) => (itemOrder.get(x.item_id) - itemOrder.get(y.item_id)) || batchOrder(x, y))
  return { batches: all, lastCountByItem }
}

/**
 * The anchors a window uses: `closing_stock` rows of its CLOSED periods, as
 * `{ [period_id]: { [item_id]: qty } }` (S756, D19). An open month's count is usually half-entered —
 * forcing stock to it would empty every uncounted shelf mid-month — so it is an estimate until the
 * month closes. Presence is the row, not the quantity: `physical_qty = 0` is a count (S695).
 */
export function countsFromClosedPeriods(closingRows, periods) {
  const closed = new Set((periods || []).filter(p => p.status === 'closed').map(p => p.id))
  const out = {}
  for (const r of closingRows || []) {
    if (!closed.has(r.period_id) || !r.item_id || r.physical_qty == null) continue
    if (!out[r.period_id]) out[r.period_id] = {}
    out[r.period_id][r.item_id] = parseFloat(r.physical_qty) || 0
  }
  return out
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
  return ageAllocated(allocateFifo(batches, consumedByItem), asOf)
}

/**
 * The ageing half of `buildAgeing`, over batches that already carry `remaining` — so the count-
 * anchored walk (`anchorToCounts`, S756) and the plain whole-window allocation age identically.
 * A surplus batch a count added (`fromCount`) is carried-forward stock like any other, and is ALSO
 * totalled on its own as `countSurplusQty`/`countSurplusValue` so the page can say where it came from.
 */
export function ageAllocated(allocated, asOf = new Date()) {
  const items = new Map()
  const oldestKey = AGE_BANDS[AGE_BANDS.length - 1].key
  const emptyBands = () => Object.fromEntries(AGE_BANDS.map(b => [b.key, { qty: 0, value: 0 }]))

  for (const b of allocated || []) {
    if (!(b.remaining > 1e-9)) continue
    const age = ageInDays(b.date, asOf)
    const band = bandOf(age)
    const value = b.remaining * (parseFloat(b.rate) || 0)

    if (!items.has(b.item_id)) {
      items.set(b.item_id, {
        item_id: b.item_id, qty: 0, value: 0, oldestDays: 0,
        carriedForwardQty: 0, carriedForwardValue: 0, carriedForwardBand: null,
        countSurplusQty: 0, countSurplusValue: 0, unknownAgeValue: 0,
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
      // The YOUNGEST carried-in band wins (S756): with count surpluses an item can hold two
      // carried-in batches, and the unknown-age test below must see the one the window is too short
      // to have aged, not whichever happened to be walked last.
      if (!row.carriedForwardBand || AGE_BANDS.findIndex(x => x.key === band) < AGE_BANDS.findIndex(x => x.key === row.carriedForwardBand)) {
        row.carriedForwardBand = band
      }
      // Carried-forward stock that did NOT land in the oldest band is the part whose true age the
      // report is actively unable to see: it is at least as old as its date and could be years
      // older, and the only reason it is not in the 90+ column is where that date falls. Summed per
      // BATCH (S756): an item can now hold an old carried-in batch in 90+ and a young count surplus,
      // and only the young one is unknown-age.
      if (band !== oldestKey) row.unknownAgeValue += value
    }
    if (b.fromCount) {
      row.countSurplusQty += b.remaining
      row.countSurplusValue += value
    }
    row.bands[band].qty += b.remaining
    row.bands[band].value += value
  }

  const totals = { qty: 0, value: 0, carriedForwardValue: 0, unknownAgeValue: 0, countSurplusValue: 0, bands: emptyBands() }
  for (const row of items.values()) {
    totals.qty += row.qty
    totals.value += row.value
    totals.carriedForwardValue += row.carriedForwardValue
    totals.unknownAgeValue += row.unknownAgeValue
    totals.countSurplusValue += row.countSurplusValue
    for (const b of AGE_BANDS) {
      totals.bands[b.key].qty += row.bands[b.key].qty
      totals.bands[b.key].value += row.bands[b.key].value
    }
  }

  return { items: [...items.values()], totals }
}
