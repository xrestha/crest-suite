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

// Read-path convenience: given every sales_entries row for a period, return only those that
// (should have) depleted stock. Same rule as above, applied in one pass.
export function selectDepletingSales(rows) {
  const posIndex = buildPosIndex((rows || []).filter(r => isPosSource(r.source)))
  return (rows || []).filter(r => {
    if (isPosSource(r.source)) return true
    if (!isManualSource(r.source)) return false // pos_credit, and anything added later
    return !posSupersedesManual(r.recipe_id, dayOf(r), posIndex)
  })
}
