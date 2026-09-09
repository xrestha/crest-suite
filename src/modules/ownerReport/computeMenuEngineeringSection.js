// Menu Engineering Matrix — the quadrants this report freezes must always agree with what the
// live Menu Engineering page shows for the same period.
//
// It used to say so in a comment and then keep its OWN copy of `classify()`, `median()` and
// `FC_CUTOFF`, "mirrored verbatim". S715 replaced the copy with the real thing: both files import
// `shared/menuEngineering.js`, so the two cannot drift — which matters more here than anywhere,
// because this section is FROZEN. A quadrant snapshotted wrong stays wrong for good, and nothing
// in the artifact says which of the two definitions produced it.
//
// Still read-only: deliberately does NOT port MenuEngineering.js's recipes.me_class write-back (a
// live POS-suggestion-engine side effect) — a report generator run on an arbitrary historical
// period must never overwrite the CURRENT live classification with whatever period happens to be
// regenerated last. The live page now applies that same rule to itself (it writes only from the
// open/latest period), which is where this reasoning came from in the first place.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { computeRecipeCosts } from '../../utils/recipeCost'
import {
  FC_CUTOFF, classify, median, menuFcPct, unratedReason, emptyQuadrantCounts,
} from '../../shared/menuEngineering'

export async function computeMenuEngineeringSection(clientId, period) {
  const results = await Promise.all([
    // Both NULL-safe (S714). Both columns are nullable and a server-side .neq drops NULL rows,
    // so an uncategorised dish was absent from the matrix — and this section is FROZEN into the
    // monthly snapshot, so it was absent permanently, with no way to tell from the artifact.
    scopedFrom('recipes', clientId, 'id, name, category, selling_price')
      .not('is_active', 'is', false).or('category.is.null,category.neq.Sub-Recipe'),
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount').eq('period_id', period.id).neq('source', 'pos_comp').order('id')),
  ])
  // Throw on a failed read so runSection() names this section as failed instead of freezing a
  // matrix of all-Dogs into the immutable snapshot (S612).
  throwFirstError(results)
  const [{ data: recipes }, { data: salesData }] = results

  const recipeIds = (recipes || []).map(r => r.id)
  const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}

  const qtyMap = {}, revenueMap = {}
  ;(salesData || []).forEach(s => {
    qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    const price = s.unit_price != null ? parseFloat(s.unit_price) : null
    if (price != null) revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) * price - (parseFloat(s.discount) || 0)
  })

  const enriched = (recipes || []).map(r => {
    const sellingPrice = parseFloat(r.selling_price) || 0
    const ingredientCost = costMap[r.id] || 0
    // null, not 0, when the dish has no price or no costed ingredients — a 0 here passed the
    // ≤35% test and froze an uncosted dish into the snapshot as a Star (S715).
    const fcPct = menuFcPct(ingredientCost, sellingPrice)
    const qtySold = qtyMap[r.id] || 0
    // House style: prefer the row's own historical unit_price when present — same basis
    // computeImsSection.revenueTotal already uses. The live page reads this way too as of S715.
    const revenue = revenueMap[r.id] != null ? revenueMap[r.id] : qtySold * sellingPrice
    const contributionMargin = sellingPrice - ingredientCost
    return {
      recipeId: r.id, name: r.name, category: r.category, sellingPrice, ingredientCost, fcPct,
      unrated: unratedReason(ingredientCost, sellingPrice),
      qtySold, revenue, contributionMargin, totalContribution: contributionMargin * qtySold,
    }
  })

  const medianQty = median(enriched.map(r => r.qtySold))
  const items = enriched.map(r => ({ ...r, quadrant: classify(r.fcPct, r.qtySold, medianQty) }))

  const quadrantCounts = emptyQuadrantCounts()
  items.forEach(i => { quadrantCounts[i.quadrant == null ? 'Unrated' : i.quadrant] += 1 })

  const topByRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
  const topByContribution = [...items].sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 10)
  const dogs = items.filter(i => i.quadrant === 'Dog').sort((a, b) => a.totalContribution - b.totalContribution).slice(0, 10)

  return { fcCutoffPct: FC_CUTOFF, medianQty, quadrantCounts, items, topByRevenue, topByContribution, dogs }
}
