// Food Cost % and Spend % so far: which figure a month gets, and what it is called (S792, D30).
//
// "Food Cost %" was two formulas under one label (FIGURES-3). Monthly Summary, the P&L, Annual
// Summary and Period Comparison divided what was USED (COGS: opening + purchases − closing −
// wastage − staff meals) by sales; the Dashboard, the Owner Dashboard, the Group Console and the
// frozen Owner Report divided what was BOUGHT. For one closed, counted month they differ by
// (opening − closing − wastage − staff meals) ÷ sales, so a month that ended with more on the shelf
// than it began read 50% ▲ on one page and 35% ✓ on the next, and three places said they agreed.
//
// The owner's decision (D30): a closed month's Food Cost % is COGS ÷ sales, everywhere. A running
// month has no closing count, so its COGS would count every shelf as used; it shows what has been
// SPENT instead, under its own name — "Spend % so far" — so the two can never be read as one
// figure again. Owner Reports already generated keep the figure they were frozen with.
//
// This file holds the rule, the two names and their tips, so a page cannot pick one without the
// other. The arithmetic of COGS itself stays in periodCost.js / imsFormulas.js.
import { computeUsed } from '../../../shared/imsFormulas'

export const FOOD_COST_LABEL = 'Food Cost %'
export const SPEND_SO_FAR_LABEL = 'Spend % so far'
/** Purchases ÷ sales for a month that has closed — Monthly Summary shows it beside Food Cost %. */
export const SPEND_LABEL = 'Spend %'

export const FOOD_COST_TIP =
  'What you USED ÷ what you sold: (opening stock + purchases − closing stock − wastage − staff meals) ÷ sales. ' +
  'It needs the month-end stock count, so it is final only once the month is closed.'

export const SPEND_SO_FAR_TIP =
  'What you have SPENT on stock this month ÷ what you have sold, so far. This is not Food Cost %: food cost ' +
  'needs the month-end stock count to know what was actually used, and a running month has not been counted yet. ' +
  'Buying a month of rice in one go lifts it; cooking from last month’s stock lowers it. ' +
  'Once the month is closed, its Food Cost % takes over.'

export const SPEND_TIP =
  'Net purchases ÷ sales: what you spent on stock, not what you used. It ignores opening and closing stock, ' +
  'so buying ahead lifts it and using up old stock lowers it. Food Cost % is the figure that counts what was used.'

/** 'cogs' for a closed month, 'spend' for anything else — an open month, or one whose status is unknown. */
export function fcBasisOf(status) {
  return status === 'closed' ? 'cogs' : 'spend'
}

const num = v => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * One month's headline cost ratio. Closed → COGS ÷ revenue as Food Cost %; otherwise net purchases
 * ÷ revenue as Spend % so far. A closed month with no COGS figure is `pct: null` — it never falls
 * back to spend, because a spend figure under the Food Cost label is the defect this file ends.
 * An absence is null, never 0 (no revenue → null).
 */
export function periodCostRatio({ status, revenue, cogs, netPurchases }) {
  const basis = fcBasisOf(status)
  const rev = num(revenue)
  const top = num(basis === 'cogs' ? cogs : netPurchases)
  const pct = rev != null && rev > 0 && top != null ? (top / rev) * 100 : null
  return { basis, pct, label: basis === 'cogs' ? FOOD_COST_LABEL : SPEND_SO_FAR_LABEL }
}

/**
 * COGS from one `get_group_pnl` row's raw components — the arithmetic ConsolidatedPnl's
 * `buildStatement` applies to the same row. `purchases_val` is already net of bill discounts.
 */
export function cogsOfGroupPnlRow(r) {
  if (!r) return null
  return computeUsed({
    opening: num(r.opening_val) || 0, purchases: num(r.purchases_val) || 0, returns: num(r.returns_val) || 0,
    wastage: num(r.wastage_val) || 0, staffMeals: num(r.staff_meals_val) || 0, closing: num(r.closing_val) || 0,
  })
}

/**
 * The Group Console's rows with each outlet's month status and COGS added, from `get_group_pnl`
 * for the same (bs_year, bs_month). `get_group_summary` stays as it is: it returns raw aggregates
 * and the page derives the ratios, and `get_group_pnl` already returns every COGS component — so
 * the group's COGS is valued by ONE SQL definition (the P&L's), not a second copy inside the
 * summary. `cogs` is null unless the outlet's month is closed (D30).
 */
export function withGroupCogs(summaryRows, pnlRows) {
  const byId = new Map((pnlRows || []).map(r => [r.client_id, r]))
  return (summaryRows || []).map(r => {
    const p = byId.get(r.client_id)
    const status = p?.period_status ?? null
    return { ...r, period_status: status, cogs: status === 'closed' ? cogsOfGroupPnlRow(p) : null }
  })
}

/**
 * The group's ratio over outlets whose months may stand differently — outlets keep independent
 * periods, so one branch can have closed Bhadra while another is still in it. Only when EVERY
 * included outlet with a period has closed it is the group figure a Food Cost %; otherwise it is
 * the group's Spend % so far over all of them. A mix of the two bases would be neither.
 */
export function groupCostRatio(rows) {
  const inScope = (rows || []).filter(r => r.is_included && r.has_period !== false)
  const revenue = inScope.reduce((s, r) => s + (num(r.revenue) || 0), 0)
  const allClosed = inScope.length > 0 && inScope.every(r => r.period_status === 'closed' && num(r.cogs) != null)
  if (allClosed) {
    return periodCostRatio({ status: 'closed', revenue, cogs: inScope.reduce((s, r) => s + num(r.cogs), 0) })
  }
  return periodCostRatio({ status: 'open', revenue, netPurchases: inScope.reduce((s, r) => s + (num(r.net_purchases) || 0), 0) })
}
