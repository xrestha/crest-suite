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
//   - a manual row depletes only if POS did not already sell that recipe. "Already" means the
//     same bs_day for a Daily row; anywhere in the period for a Bulk row (bs_day 0), since POS
//     never posts a bs_day=0 row. Two different facts about the same recipe/day must not both
//     deplete stock for it.
//   - sales_entries.source is nullable: rows written before the column had a DEFAULT read as
//     NULL and must still count as manual (same reasoning as persistSalesDay.js's `manualOnly`).

export function isManualSource(source) {
  return source == null || source === 'manual'
}

export function isPosSource(source) {
  return source === 'pos' || source === 'pos_comp'
}

// Bulk rows carry bs_day 0; a NULL bs_day is treated as Bulk rather than as day 0's own dated row,
// since only the Bulk path ever leaves it unset.
const dayOf = row => Number(row.bs_day) || 0

// Indexes POS rows for the supersedes check below. `anyDay` backs the Bulk case, `byDay` the
// Daily one. Rows may be pre-scoped to a single day by the caller's own query (the write path
// does this) — the index is correct either way.
export function buildPosIndex(posRows) {
  const byDay = new Map()
  const anyDay = new Set()
  for (const r of posRows || []) {
    if (!isPosSource(r.source) && r.source !== undefined) continue
    const day = dayOf(r)
    if (!byDay.has(day)) byDay.set(day, new Set())
    byDay.get(day).add(r.recipe_id)
    anyDay.add(r.recipe_id)
  }
  return { byDay, anyDay }
}

export function posSupersedesManual(recipeId, bsDay, posIndex) {
  if (!posIndex) return false
  if (Number(bsDay) === 0) return posIndex.anyDay.has(recipeId)
  return posIndex.byDay.get(Number(bsDay))?.has(recipeId) ?? false
}

// Read-path convenience: given every sales_entries row for A SINGLE PERIOD, return only those that
// (should have) depleted stock. Same rule as above, applied in one pass.
//
// SINGLE PERIOD IS PART OF THE CONTRACT, not an incidental fact about the callers (S718). The
// supersedes test is keyed on `bs_day`, and `bs_day` is a day NUMBER within a month — day 5 exists
// in every one of them. Hand this function a fiscal year's worth of rows and a POS sale of a dish
// on 5 Shrawan suppresses the MANUAL sale of that same dish on 5 Bhadra, four months later; a Bulk
// row (bs_day 0) is suppressed if POS sold that dish anywhere in the whole year, since `anyDay` is
// then year-wide. Suppressed rows are dropped from consumption, so stock that was eaten reads as
// still on the shelf — which on an ageing report inflates the 90+ figure and on an expiry report
// inflates what is at risk. Use `selectDepletingSalesAcrossPeriods` for any multi-period window.
export function selectDepletingSales(rows) {
  const posIndex = buildPosIndex((rows || []).filter(r => isPosSource(r.source)))
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
