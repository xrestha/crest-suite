// Item-level Theoretical vs Actual Variance — a real gap that existed before this: the IMS
// section already builds a theoretical-usage map (via the shared explodeRecipeIngredients util)
// for its reorder/par estimate, but never exposed the per-item variance itself anywhere in the
// report. Mirrors Variance.js's exact formula (not TheoreticalVariance.js's separate
// implementation, which uses its own local ingredient-expansion and a different 5% threshold) —
// Variance.js already shares the same explodeRecipeIngredients util this report uses elsewhere,
// the lowest-friction, most internally-consistent choice.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { explodeRecipeIngredients } from '../../utils/recipeCost'

export async function computeInventoryVariance(clientId, period) {
  const [{ data: opening }, { data: purchases }, { data: returns }, { data: wastages }, { data: closing }, { data: items }, { data: recipes }, { data: salesData }] = await Promise.all([
    supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id),
    supabase.from('purchase_entries').select('item_id, qty').eq('period_id', period.id),
    supabase.from('vendor_returns').select('item_id, qty').eq('period_id', period.id),
    supabase.from('wastages').select('item_id, qty').eq('period_id', period.id),
    supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id),
    scopedFrom('items', clientId, 'id, name, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false),
    scopedFrom('recipes', clientId, 'id'),
    // Comps INCLUDED — this is a consumption figure, not a revenue one. See the same note in
    // computeInventoryShrinkageTrend.js; Variance.js (which this mirrors) has never filtered them.
    supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', period.id),
  ])

  const sum = (rows, key) => { const m = {}; (rows || []).forEach(r => { m[r.item_id] = (m[r.item_id] || 0) + (parseFloat(r[key]) || 0) }); return m }
  const openMap = sum(opening, 'qty'), purchMap = sum(purchases, 'qty'), retMap = sum(returns, 'qty')
  const wasteMap = sum(wastages, 'qty'), closeMap = sum(closing, 'physical_qty')

  const recipeIds = (recipes || []).map(r => r.id)
  const ingredientBreakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}
  const soldMap = {}; (salesData || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) })
  const theoreticalMap = {}
  Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
    const sold = soldMap[recipeId] || 0
    if (sold <= 0) return
    rows.forEach(({ item_id, qty }) => { theoreticalMap[item_id] = (theoreticalMap[item_id] || 0) + sold * qty })
  })

  let totalActualUsed = 0, totalTheoreticalUsed = 0, totalVarianceValue = 0, flaggedCount = 0
  const rows = []
  ;(items || []).forEach(i => {
    const theoretical = theoreticalMap[i.id] || 0
    if (theoretical <= 0) return // no recipe coverage this period — nothing to compare against
    const netPurchases = (purchMap[i.id] || 0) - (retMap[i.id] || 0)
    const actual = (openMap[i.id] || 0) + netPurchases - (closeMap[i.id] || 0) - (wasteMap[i.id] || 0)
    const variance = actual - theoretical
    const variancePct = (variance / theoretical) * 100
    const flag = variancePct > 10 ? 'over' : variancePct < -10 ? 'under' : 'ok'
    const rate = parseFloat(i.per_uom_rate || 0)
    const value = variance * rate
    totalActualUsed += actual; totalTheoreticalUsed += theoretical; totalVarianceValue += value
    if (flag !== 'ok') flaggedCount += 1
    rows.push({ itemId: i.id, name: i.name, actualUsed: actual, theoreticalUsed: theoretical, variance, variancePct, value, flag })
  })

  return {
    totalActualUsed, totalTheoreticalUsed, totalVarianceValue, flaggedCount,
    items: rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
  }
}
