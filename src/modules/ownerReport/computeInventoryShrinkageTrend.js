// Shrinkage Trend — fundamentally a multi-period concept (ShrinkageReport.js picks the 3/6/12
// most-recent CLOSED periods regardless of what's being viewed). For a frozen per-period report,
// adapted to a TRAILING window ENDING at the report's own period (bs_year*100+bs_month <= this
// period's, most recent 6) instead of "most recent N regardless" — reuses the exact same
// per-item actual/theoretical math and status thresholds as the live page. Returns null when
// fewer than 2 closed periods are available (not enough signal for a trend).
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { explodeRecipeIngredients } from '../../utils/recipeCost'

const WINDOW_SIZE = 6

function shrinkageStatus(shrinkCount, coveredPeriods) {
  const ratio = coveredPeriods > 0 ? shrinkCount / coveredPeriods : 0
  if (ratio >= 0.67 && shrinkCount >= 2) return 'Consistent'
  if (shrinkCount >= 2) return 'Occasional'
  if (shrinkCount === 1) return 'Once'
  return 'Clear'
}

export async function computeInventoryShrinkageTrend(clientId, period) {
  const { data: closedPeriods } = await scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month')
    .eq('status', 'closed')
    .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })

  const thisKey = period.bs_year * 100 + period.bs_month
  const window = (closedPeriods || [])
    .filter(p => p.bs_year * 100 + p.bs_month <= thisKey)
    .slice(0, WINDOW_SIZE)
  if (window.length < 2) return null

  const windowIds = window.map(p => p.id)
  const [{ data: opening }, { data: purchases }, { data: returns }, { data: wastages }, { data: closing }, { data: staffMeals }, { data: salesData }, { data: items }, { data: recipes }] = await Promise.all([
    supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', windowIds),
    supabase.from('purchase_entries').select('period_id, item_id, qty').in('period_id', windowIds),
    supabase.from('vendor_returns').select('period_id, item_id, qty').in('period_id', windowIds),
    supabase.from('wastages').select('period_id, item_id, qty').in('period_id', windowIds),
    supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', windowIds),
    supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', windowIds),
    // Comps are deliberately INCLUDED here, unlike every revenue query in this report. A comped
    // dish collected no money but its ingredients were still consumed, so excluding it understates
    // theoretical usage and inflates apparent shrinkage. Matches ShrinkageReport.js, which this
    // section mirrors, and the same reasoning PosOrders.jsx documents for the consumption reports.
    supabase.from('sales_entries').select('period_id, recipe_id, qty_sold').in('period_id', windowIds),
    scopedFrom('items', clientId, 'id, name, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false),
    scopedFrom('recipes', clientId, 'id'),
  ])

  const recipeIds = (recipes || []).map(r => r.id)
  const ingredientBreakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}

  // Bucket every row by period_id first, then aggregate per (period, item).
  const byPeriodItem = (rows, key) => {
    const m = {}
    ;(rows || []).forEach(r => {
      m[r.period_id] = m[r.period_id] || {}
      m[r.period_id][r.item_id] = (m[r.period_id][r.item_id] || 0) + (parseFloat(r[key]) || 0)
    })
    return m
  }
  const openByPeriod = byPeriodItem(opening, 'qty')
  const purchByPeriod = byPeriodItem(purchases, 'qty')
  const retByPeriod = byPeriodItem(returns, 'qty')
  const wasteByPeriod = byPeriodItem(wastages, 'qty')
  const closeByPeriod = byPeriodItem(closing, 'physical_qty')
  const staffMealByPeriod = byPeriodItem(staffMeals, 'qty')

  const soldByPeriod = {}
  ;(salesData || []).forEach(s => {
    soldByPeriod[s.period_id] = soldByPeriod[s.period_id] || {}
    soldByPeriod[s.period_id][s.recipe_id] = (soldByPeriod[s.period_id][s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
  })
  const theoreticalByPeriod = {}
  windowIds.forEach(pid => {
    theoreticalByPeriod[pid] = {}
    const soldMap = soldByPeriod[pid] || {}
    Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
      const sold = soldMap[recipeId] || 0
      if (sold <= 0) return
      rows.forEach(({ item_id, qty }) => { theoreticalByPeriod[pid][item_id] = (theoreticalByPeriod[pid][item_id] || 0) + sold * qty })
    })
  })

  const perItem = {}
  ;(items || []).forEach(i => { perItem[i.id] = { itemId: i.id, name: i.name, rate: parseFloat(i.per_uom_rate || 0), shrinkCount: 0, coveredPeriods: 0, totalShrinkQty: 0 } })

  windowIds.forEach(pid => {
    ;(items || []).forEach(i => {
      const theoretical = theoreticalByPeriod[pid]?.[i.id] || 0
      if (theoretical <= 0) return // not "covered" this period — no recipe/sales signal to compare against
      perItem[i.id].coveredPeriods += 1
      const netPurchases = (purchByPeriod[pid]?.[i.id] || 0) - (retByPeriod[pid]?.[i.id] || 0)
      const actual = (openByPeriod[pid]?.[i.id] || 0) + netPurchases - (closeByPeriod[pid]?.[i.id] || 0)
        - (wasteByPeriod[pid]?.[i.id] || 0) - (staffMealByPeriod[pid]?.[i.id] || 0)
      const variance = actual - theoretical
      if (variance > 0.001) { perItem[i.id].shrinkCount += 1; perItem[i.id].totalShrinkQty += variance }
    })
  })

  const flagged = Object.values(perItem)
    .filter(i => i.shrinkCount > 0)
    .map(i => ({
      ...i, avgShrinkQty: i.totalShrinkQty / i.shrinkCount, totalShrinkValue: i.totalShrinkQty * i.rate,
      status: shrinkageStatus(i.shrinkCount, i.coveredPeriods),
    }))
    .sort((a, b) => b.totalShrinkValue - a.totalShrinkValue)

  return {
    periodsAnalyzed: window.length, windowPeriodIds: windowIds,
    consistentCount: flagged.filter(i => i.status === 'Consistent').length,
    anyFlaggedCount: flagged.length,
    totalLossValue: flagged.reduce((s, i) => s + i.totalShrinkValue, 0),
    items: flagged.slice(0, 15),
  }
}
