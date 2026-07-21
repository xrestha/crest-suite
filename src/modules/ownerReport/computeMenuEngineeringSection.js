// Menu Engineering Matrix — mirrors MenuEngineering.js's classify()/median()/FC_CUTOFF exactly
// (including zero-sale items in the median) so this report's quadrants always agree with what
// the live Menu Engineering page shows for the same period. Read-only: deliberately does NOT
// port MenuEngineering.js's recipes.me_class write-back (a live POS-suggestion-engine side
// effect) — a report generator run on an arbitrary historical period must never overwrite the
// CURRENT live classification with whatever period happens to be regenerated last.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { computeRecipeCosts } from '../../utils/recipeCost'

const FC_CUTOFF = 35

function median(nums) {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Correct spelling used here even though the source page's constant/label says "Plowhouse" —
// this is freshly re-derived classification logic, not a literal import, so the copy is ours.
function classify(fcPct, qtySold, medianQty) {
  const highProfit = fcPct <= FC_CUTOFF
  const highPop = qtySold >= medianQty
  if (highProfit && highPop) return 'Star'
  if (highProfit && !highPop) return 'Plowhorse'
  if (!highProfit && highPop) return 'Puzzle'
  return 'Dog'
}

export async function computeMenuEngineeringSection(clientId, period) {
  const [{ data: recipes }, { data: salesData }] = await Promise.all([
    scopedFrom('recipes', clientId, 'id, name, category, selling_price')
      .neq('is_active', false).neq('category', 'Sub-Recipe'),
    supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', period.id).neq('source', 'pos_comp'),
  ])

  const recipeIds = (recipes || []).map(r => r.id)
  const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}

  const qtyMap = {}, revenueMap = {}
  ;(salesData || []).forEach(s => {
    qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    const price = s.unit_price != null ? parseFloat(s.unit_price) : null
    if (price != null) revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) * price
  })

  const enriched = (recipes || []).map(r => {
    const sellingPrice = parseFloat(r.selling_price) || 0
    const ingredientCost = costMap[r.id] || 0
    const fcPct = sellingPrice > 0 ? (ingredientCost / sellingPrice) * 100 : 0
    const qtySold = qtyMap[r.id] || 0
    // House style: prefer the row's own historical unit_price when present — same basis
    // computeImsSection.revenueTotal already uses. Deliberately NOT MenuEngineering.js's
    // current-price-only revenue; only the classification inputs must match that page 1:1, not
    // the displayed revenue figure.
    const revenue = revenueMap[r.id] != null ? revenueMap[r.id] : qtySold * sellingPrice
    const contributionMargin = sellingPrice - ingredientCost
    return {
      recipeId: r.id, name: r.name, category: r.category, sellingPrice, ingredientCost, fcPct,
      qtySold, revenue, contributionMargin, totalContribution: contributionMargin * qtySold,
    }
  })

  const medianQty = median(enriched.map(r => r.qtySold))
  const items = enriched.map(r => ({ ...r, quadrant: classify(r.fcPct, r.qtySold, medianQty) }))

  const quadrantCounts = { Star: 0, Plowhorse: 0, Puzzle: 0, Dog: 0 }
  items.forEach(i => { quadrantCounts[i.quadrant] += 1 })

  const topByRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 10)
  const topByContribution = [...items].sort((a, b) => b.totalContribution - a.totalContribution).slice(0, 10)
  const dogs = items.filter(i => i.quadrant === 'Dog').sort((a, b) => a.totalContribution - b.totalContribution).slice(0, 10)

  return { fcCutoffPct: FC_CUTOFF, medianQty, quadrantCounts, items, topByRevenue, topByContribution, dogs }
}
