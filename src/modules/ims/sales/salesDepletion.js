// Which sales_entries rows actually deplete stock — the single definition of a rule that two
// different code paths need and must never disagree about:
//
//   • the WRITE path (depleteManualSales in persistSalesDay.js) decides which rows to write
//     stock_movements for, at save time;
//   • the READ path (subRecipeUsage.js) re-derives sub-recipe consumption from sales_entries,
//     because stock_movements stores only fully-exploded raw items and has no column for the
//     sub-recipe a depletion passed through.
//
// If the read path re-implemented this rule, the Sub-Recipe Usage figures would silently drift
// from the ledger sitting on the same page the first time either side was touched.
//
// The rule itself:
//   - 'pos' / 'pos_comp' rows always deplete — PosOrders.jsx writes movements on every close.
//   - 'pos_credit' rows never deplete — a credit note reverses revenue, not stock.
//   - a Daily manual row depletes only if POS did not sell that recipe on the same bs_day. Two
//     different facts about the same recipe/day must not both deplete stock for it.
//   - a Bulk manual row (bs_day 0) is the owner-decision D35 case (S792), below.
//   - sales_entries.source is nullable: rows written before the column had a DEFAULT read as
//     NULL and must still count as manual (same reasoning as persistSalesDay.js's `manualOnly`).
//
// THE BULK ROW (D35, S792). A Bulk total is a month-so-far figure that cannot say which days it
// covers. Until S792 the till's first sale of that dish ANYWHERE in the month made every stock
// report ignore the Bulk total outright — while revenue still counted it and the Stock Movements
// ledger still deducted it — so the days before the till read as "stock used, nothing sold". The
// owner's decision: Sales Entry asks for those pre-till days as daily figures, and the Bulk total
// stops counting for stock only once they exist. So a Bulk row the till has also sold is
// superseded only when
//   - the period holds a manual DATED row for that dish on a day before the till started (the
//     re-entry has begun), or
//   - the till started on day 1, so there is no earlier day for the Bulk total to cover (the old
//     rule, for the case D35 does not describe).
// "The till started" is the first bs_day of ANY till sale in the period, not this dish's first:
// a dish the till only happened to sell from day 20 still had the till from day 12, and days
// 12–19 are till days on which nobody ordered it. In practice save_sales_day deletes a dish's Bulk
// row the moment a dated row for it is saved, so the first branch mostly guards legacy data; the
// live effect of D35 is that the Bulk total keeps depleting until that first re-entered day.

export function isManualSource(source) {
  return source == null || source === 'manual'
}

export function isPosSource(source) {
  return source === 'pos' || source === 'pos_comp'
}

// Bulk rows carry bs_day 0; a NULL bs_day is treated as Bulk rather than as day 0's own dated row,
// since only the Bulk path ever leaves it unset.
const dayOf = row => Number(row.bs_day) || 0

// Indexes POS rows for the supersedes check below. `anyDay` and `tillStart` back the Bulk case,
// `byDay` the Daily one. Rows may be pre-scoped to a single day by the caller's own query (the
// write path does this) — the Daily half is correct either way.
//
// The Bulk half needs two facts a recipe-scoped POS read cannot give (D35), so a caller may hand
// them in: `tillStart`, the period's first till day across EVERY dish (otherwise the lowest day in
// `posRows`), and `manualRows`, the manual rows to test for a re-entered pre-till day. Without
// `manualRows` no re-entry is seen, so a Bulk row the till sold keeps depleting unless the till
// started on day 1.
export function buildPosIndex(posRows, { tillStart, manualRows } = {}) {
  const byDay = new Map()
  const anyDay = new Set()
  let firstDay = null
  for (const r of posRows || []) {
    if (!isPosSource(r.source) && r.source !== undefined) continue
    const day = dayOf(r)
    if (!byDay.has(day)) byDay.set(day, new Set())
    byDay.get(day).add(r.recipe_id)
    anyDay.add(r.recipe_id)
    if (day > 0 && (firstDay == null || day < firstDay)) firstDay = day
  }
  const start = tillStart !== undefined ? tillStart : firstDay
  const preTillManual = new Set()
  if (start != null) {
    for (const r of manualRows || []) {
      if (!isManualSource(r.source)) continue
      const day = dayOf(r)
      if (day > 0 && day < start) preTillManual.add(r.recipe_id)
    }
  }
  return { byDay, anyDay, tillStart: start, preTillManual }
}

export function posSupersedesManual(recipeId, bsDay, posIndex) {
  if (!posIndex) return false
  if (Number(bsDay) === 0) return bulkSupersededByTill(recipeId, posIndex)
  return posIndex.byDay.get(Number(bsDay))?.has(recipeId) ?? false
}

// The Bulk case of the rule (D35) — see the header. A dish the till never sold this period keeps
// its Bulk total whatever else is true.
export function bulkSupersededByTill(recipeId, posIndex) {
  if (!posIndex?.anyDay?.has(recipeId)) return false
  const start = posIndex.tillStart
  // No dated till sale (POS never writes day 0, so this is the defensive case) or a till that ran
  // from day 1: there is no pre-till day for the Bulk total to stand for.
  if (start == null || start <= 1) return true
  return posIndex.preTillManual?.has(recipeId) ?? false
}

// One period's index over its OWN rows: POS rows for the supersedes checks, and the manual rows
// for D35's re-entry test. The read path's single way in, so the notice on Sales Entry and every
// stock report ask the same question of the same rows. `tillStart` overrides the first till day
// the rows imply — only Sales Entry passes one (bulkTillHandover's `billTillStart`).
function periodIndex(rows, { tillStart } = {}) {
  const all = rows || []
  return buildPosIndex(all.filter(r => isPosSource(r.source)), {
    ...(tillStart !== undefined ? { tillStart } : {}),
    manualRows: all.filter(r => isManualSource(r.source)),
  })
}

// The earlier of two first-till-days, either of which may be unknown (null). Anything that is not
// a day of the month (0, negative, NaN) counts as unknown — POS never writes day 0.
export function earlierTillDay(a, b) {
  const days = [a, b].map(Number).filter(d => Number.isInteger(d) && d > 0)
  return days.length > 0 ? Math.min(...days) : null
}

/**
 * What Sales Entry has to say about Bulk totals in a period the till also sold in (D35, S792).
 * `rows` is every sales_entries row of ONE period (recipe_id, qty_sold, bs_day, source).
 *
 * - `tillStart`: the first day the till sold anything this period, or null.
 * - `needsReentry`: dishes with a Bulk total the till has also sold, whose pre-till days have not
 *   been entered as daily figures — their Bulk total still counts for stock. `[{ recipeId, bulkQty }]`
 * - `ignoredForStock`: dishes whose Bulk total stock already ignores — the till ran from day 1, or
 *   the pre-till days are there — while revenue still counts it. `[{ recipeId, bulkQty, reason }]`,
 *   reason 'till_from_day_one' | 'reentered'.
 * - `manualBeforeTill`: the period holds a manual figure (Bulk, or a day before the till) — i.e.
 *   this month was started by hand and the till took over. Sales Entry keeps the pre-till days
 *   enterable for a POS client in exactly that case.
 *
 * `billTillStart` (S792.4): the first day of the period the TILL billed a dish on, read from the
 * till's own bills rather than from sales_entries. `rows` only hold the bills that have reached
 * IMS, so an offline till that has not synced, or a hand-off still waiting for Periods → Post POS
 * bills to Inventory, made the till's real first days look pre-till — and Sales Entry then took
 * hand-typed figures for days the till had already sold, which count twice once the bills post.
 * The earlier of the two is the till's first day. It is what the stock reports will read once those
 * bills post; until then they still go by the rows (selectDepletingSales takes no override).
 */
export function bulkTillHandover(rows, { billTillStart } = {}) {
  const imsIndex = periodIndex(rows)
  const tillStart = earlierTillDay(imsIndex.tillStart, billTillStart)
  const posIndex = tillStart === imsIndex.tillStart ? imsIndex : periodIndex(rows, { tillStart })
  const bulkQty = new Map()
  let manualBeforeTill = false
  for (const r of rows || []) {
    if (!isManualSource(r.source)) continue
    const day = dayOf(r)
    if (day === 0) bulkQty.set(r.recipe_id, (bulkQty.get(r.recipe_id) || 0) + (Number(r.qty_sold) || 0))
    if (tillStart != null && day < tillStart) manualBeforeTill = true
  }
  const needsReentry = []
  const ignoredForStock = []
  for (const [recipeId, qty] of bulkQty) {
    if (!(qty > 0) || !posIndex.anyDay.has(recipeId)) continue
    if (!bulkSupersededByTill(recipeId, posIndex)) needsReentry.push({ recipeId, bulkQty: qty })
    else ignoredForStock.push({ recipeId, bulkQty: qty, reason: posIndex.preTillManual.has(recipeId) ? 'reentered' : 'till_from_day_one' })
  }
  return { tillStart, needsReentry, ignoredForStock, manualBeforeTill }
}

// Read-path convenience: given every sales_entries row for A SINGLE PERIOD, return only those that
// (should have) depleted stock. Same rule as above, applied in one pass.
//
// SINGLE PERIOD IS PART OF THE CONTRACT, not an incidental fact about the callers (S718). The
// supersedes test is keyed on `bs_day`, and `bs_day` is a day NUMBER within a month — day 5 exists
// in every one of them. Hand this function a fiscal year's worth of rows and a POS sale of a dish
// on 5 Shrawan suppresses the MANUAL sale of that same dish on 5 Bhadra, four months later; a Bulk
// row (bs_day 0) is judged against a year-wide `anyDay` and a "till start" that is really the
// earliest day number of any month, so another month's till decides it. Suppressed rows are
// dropped from consumption, so stock that was eaten reads as
// still on the shelf — which on an ageing report inflates the 90+ figure and on an expiry report
// inflates what is at risk. Use `selectDepletingSalesAcrossPeriods` for any multi-period window.
export function selectDepletingSales(rows) {
  const posIndex = periodIndex(rows)
  return (rows || []).filter(r => {
    if (isPosSource(r.source)) return true
    if (!isManualSource(r.source)) return false // pos_credit, and anything added later
    return !posSupersedesManual(r.recipe_id, dayOf(r), posIndex)
  })
}

/**
 * The same rule over a window spanning SEVERAL periods: partition by `period_id`, apply the
 * single-period rule inside each, concatenate.
 *
 * Rows must carry `period_id` — a row without one is its own group rather than being lumped in
 * with another month's, since guessing which period it belongs to is exactly the mistake this
 * function exists to stop. Source order is preserved within each period and periods come back in
 * first-seen order, so a caller that only sums is unaffected by the grouping.
 *
 * ShrinkageReport has always done this by hand (it needed per-period totals anyway, so the
 * grouping fell out of what it was already doing). StockAgeing and FifoReport did not, and were
 * the two pages reading a whole fiscal year through the single-period form.
 */
export function selectDepletingSalesAcrossPeriods(rows) {
  const byPeriod = new Map()
  for (const r of rows || []) {
    const key = r.period_id == null ? `__none__${byPeriod.size}` : r.period_id
    if (!byPeriod.has(key)) byPeriod.set(key, [])
    byPeriod.get(key).push(r)
  }
  const out = []
  for (const group of byPeriod.values()) out.push(...selectDepletingSales(group))
  return out
}
