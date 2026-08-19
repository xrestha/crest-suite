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
//   cannot be a batch-precise allocation, and neither can FifoReport, which solves the same
//   problem the same way (see its own comment). What it does instead is the standard FIFO
//   ASSUMPTION: each item's total consumption over the window is eaten off that item's own
//   batches oldest-first, and whatever survives is what is still on the shelf. That is the same
//   level of precision every other stock figure in this app already works at.
//
// Stock carried into the window (the first period's opening count) is modelled as one batch dated
// at the window start and flagged `carriedForward`. Its TRUE age is unknown and is at least that
// old, which the page states rather than implying precision it does not have. Because FIFO eats
// oldest-first, ordinary turnover consumes it before touching real purchases — so anything left
// in it is genuinely stale, which is the whole point of the report.

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
 * Eat each item's consumption off its own batches, oldest first.
 *
 * batches: [{ item_id, qty, rate, date, carriedForward? }]  (qty already net of returns)
 * consumedByItem: { [item_id]: qty consumed over the window }
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
 * about capital already committed.
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
        carriedForwardQty: 0, bands: emptyBands(),
      })
    }
    const row = items.get(b.item_id)
    row.qty += b.remaining
    row.value += value
    row.oldestDays = Math.max(row.oldestDays, age)
    if (b.carriedForward) row.carriedForwardQty += b.remaining
    row.bands[band].qty += b.remaining
    row.bands[band].value += value
  }

  const totals = { qty: 0, value: 0, bands: emptyBands() }
  for (const row of items.values()) {
    totals.qty += row.qty
    totals.value += row.value
    for (const b of AGE_BANDS) {
      totals.bands[b.key].qty += row.bands[b.key].qty
      totals.bands[b.key].value += row.bands[b.key].value
    }
  }

  return { items: [...items.values()], totals }
}
