// Pure(ish) computation for the Monthly Owner/Manager Report — no React. Reuses the exact
// formulas OwnerDashboard.jsx (IMS/HR figures), SalesReport.jsx (POS figures), and
// payrollCompute.js already established, parameterized by an arbitrary CLOSED period instead of
// always "the currently open one." See CLAUDE.md's Monthly Owner/Manager Report section.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { bsToAd, daysInBsMonth, formatAd, bsDayBoundaryIso } from '../../utils/bsCalendar'
import { tallyAttendance } from '../hr/payroll/payrollCompute'
import { explodeRecipeIngredients, computeRecipeCosts } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { buildStockRows, summarizeReorder } from '../ims/stockcount/stockReportCalc'
import { allocateBillDiscounts, returnCostValue } from '../ims/reports/supplierAttribution'
import { periodRevenue, periodStockMaps, valuePeriodItems, periodWastageValue, periodGap, WASTAGE_VALUE_SELECT } from '../ims/reports/periodCost'
import { readPeriodTransfers, transferTotals } from '../ims/transfers/transferFlows'
import { UNCOUNTED_NAME_LIMIT } from '../../shared/uncountedItems'
import { fcThresholds } from '../../shared/imsFormulas'
import { zeroAmounts, addAmounts, billAmounts, buildSalesEntries, buildGroupedRows, buildPaymentRows, forgoneMenuValue } from '../pos/reports/salesReportMath'
import { coversTotals } from '../pos/reports/coversMath'
import { computeMenuEngineeringSection } from './computeMenuEngineeringSection'
import { computeLaborAnalyticsSection } from './computeLaborAnalyticsSection'
import { computeVendorPurchasingSection } from './computeVendorPurchasingSection'
import { computeInventoryDepthSection } from './computeInventoryDepthSection'
import { unpaidCreditBills, unpaidCreditTotals, returnedByEntryOf } from './unpaidCreditBills'
import { splitOverheadBuckets, resolveOutletLabour, payrollLabourTotal } from '../dashboard/labourSource'
import { estimateLabour } from '../dashboard/labourEstimate'
import { loadLabourEstimateInputs } from '../dashboard/loadOutletLabour'
import { loadMonthOtherLabour } from '../dashboard/loadOtherLabourPay'
import { loadDeliveryCommission, bsMonthWindow } from '../../shared/deliveryCommission'
import { parseAdDateLocal } from '../../shared/nepalTime'

// ── Net purchases (pure) ─────────────────────────────────────────────────────
// Purchases NET of bill discounts, less returns — the definition Consolidated P&L and Monthly
// Summary use (S601/S720), so the frozen report's Purchases, Cash/Credit split and Inventory
// Turnover agree with those pages for the same month. Food Cost %, Prime Cost % and Net Margin %
// are NOT built on this since schema v9 (S792, D30): they use COGS, see computeImsSection.
// `discount_amount` is a BILL-level figure repeated on every line; allocateBillDiscounts() dedupes
// it per bill and spreads it across that bill's lines, so the rows passed in must carry
// `discount_amount`, `purchase_group_id` and the `vendor_id`/`invoice_ref`/`bs_day` fallback key.
// Returns are taken at list value, exactly as on those two pages. The Cash/Credit split is built
// off the same line values so the two halves still add up to the total (every return comes off
// Cash, as before).
// On the COST basis since schema v11 (S792, D32): `lineCost`, and each return at its line's basis —
// the rows must carry `vat_inclusive, vat_is_cost` and returns the `purchase_entries` embed.
// Single-period input by use. Since S792 the fallback bill key also carries `period_id`
// (supplierAttribution.js allocationBillKey), so a multi-period batch that selects it is safe too.
//
// Stock transfers between outlets (S849, PNL-8, schema 18): Net Purchases = gross − bill discounts −
// returns + transfers in − transfers out, as Monthly Summary and Consolidated P&L count them, so the
// month's own figures move with the stock. `transfers` are this outlet's ims_stock_transfer_lines for
// the month (a line exists only when it counts here). The Cash / Credit split stays supplier-only —
// a transfer is paid in neither — so the two halves add up to the total less the transfers' net,
// which `transferIn` / `transferOut` carry so the page can show it.
export function netPurchaseFigures(purchases, returns, transfers = null) {
  const allocated = allocateBillDiscounts(purchases || [])
  const returnTotal = (returns || []).reduce((s, r) => s + returnCostValue(r), 0)
  let cashNet = 0, creditNet = 0
  allocated.forEach(p => {
    if (p.payment_method === 'Credit') creditNet += p.lineCost; else cashNet += p.lineCost
  })
  cashNet -= returnTotal
  const { inVal: transferIn, outVal: transferOut } = transferTotals(transfers)
  const purchaseTotal = allocated.reduce((s, p) => s + p.lineCost, 0) - returnTotal + transferIn - transferOut
  return { purchaseTotal, cashNet, creditNet, transferIn, transferOut }
}

// ── IMS section ──────────────────────────────────────────────────────────────
// Same tables/formulas as OwnerDashboard.jsx's loadImsFigures/loadReorderStats. Revenue excludes
// source='pos_comp' rows — sales_entries already carries POS revenue for POS-enabled clients
// (PosOrders.jsx stamps a 'pos'/'pos_comp' row per bill at close), so this figure is already
// POS-inclusive; the POS section below is independently derived from pos_orders and will not tie
// out to the penny with this Revenue figure — that's expected, not a bug (different discount/VAT
// rounding basis). Reorder/"Items Below Par" reads closing_stock for a CLOSED period, which is
// finalized real data — "stock position at period close," not a live estimate. Payables is
// deliberately redefined from Owner Dashboard's live ">60 days overdue, any period" formula: a
// frozen report must show a period-bound fact ("this period's Credit purchases still unpaid as
// of generation"), not a live "how overdue is it right now" figure that drifts once time passes.
async function computeImsSection(clientId, period) {
  const results = await Promise.all([
    // discount_amount + the bill-key columns feed netPurchaseFigures() — see its comment.
    fetchAllRows(() => supabase.from('purchase_entries').select('id, item_id, qty, rate, payment_method, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost').eq('period_id', period.id).order('id')),
    // Paged with a unique tiebreaker, like every per-item-per-period read below (S756). Six reads
    // in this batch were bare while purchase_entries/wastages/sales_entries beside them were paged,
    // so past PostgREST's silent 1000-row cap the FROZEN snapshot lost returns, items, pars and
    // stock rows with no error for throwFirstError to see — and nothing ever recomputes it. A
    // missing items row values its stock at rate 0; a missing closing row reads as a zero count.
    fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty, rate, purchase_entries(vat_inclusive, vat_is_cost)').eq('period_id', period.id).order('id')),
    // ONE sales read answers both questions, because the comp filter runs in JS. REVENUE excludes
    // comps (a comped dish collected nothing; periodRevenue drops them), CONSUMPTION includes them
    // (its ingredients were still used). Until S792 revenue had its own read with a server-side
    // `.neq('source', 'pos_comp')` — and `source` is nullable, so `NULL <> 'pos_comp'` dropped every
    // legacy row: a Regenerate Snapshot froze a revenue LOWER than Monthly Summary's, the
    // denominator of Food Cost %, Labour %, Prime % and Net Margin % (FIGURES-8, ims-figures.md
    // S699). bs_day + source also feed the shared depletion rule in buildStockRows (S696), and
    // ingredient_deltas a customized plate's option stock lines (S758).
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, bs_day, source, ingredient_deltas').eq('period_id', period.id).order('id')),
    // Paged (S792): the price fallback for a legacy sales row with no unit_price, and the ids that
    // seed the reorder walk. A recipe past the 1000-row cap prices its sales at 0 and consumes
    // nothing — frozen.
    fetchAllRows(() => scopedFrom('recipes', clientId, 'id, selling_price').order('id')),
    // EVERY bucket since schema 18 (S849, GAPS-4 / OWNER-REPORT-9): Overheads and Tax & Fees are cost
    // lines (Tax & Fees since v12), and the Labor tab is read so the one labour rule can decide what it
    // is — labour itself for an outlet without Crest HR, named "not counted" beside payroll on an outlet
    // with it. Until v17 the read left `labor` out (`.or(NON_LABOUR_OVERHEADS)`), so a Suite outlet
    // without HR froze no labour and no Net Margin at all. Tens of rows per period, not paged.
    supabase.from('overheads').select('amount, bucket').eq('period_id', period.id),
    // Each row carries its item's rate (WASTAGE_VALUE_SELECT): Wastage Value is the Wastage Report's
    // total over every item, prep and hidden ones included, since schema v10 (S792, FIGURES-5).
    fetchAllRows(() => supabase.from('wastages').select(WASTAGE_VALUE_SELECT).eq('period_id', period.id).order('id')),
    // EVERY item, active or not, since S792: the two uses below want different sets.
    //   - Opening/Closing Stock keep the active-only set, which matches Stock.js's
    //     own Summary tab — without it a leftover opening_stock row on a deactivated item inflated
    //     Opening Stock Value above what Stock Count showed for the same period (found live, S436:
    //     NPR 179,232 here vs NPR 179,189.95 on Stock Count). Sub-recipes stay IN those, since Stock
    //     Count counts them too (its own "Sub-Recipes" category row).
    //   - COGS (Food Cost %, D30) is valued over every non-sub-recipe item with a row in the
    //     month, hidden or not — hiding an item never changes history (D29, FIGURES-1).
    fetchAllRows(() => scopedFrom('items', clientId, 'id, name, per_uom_rate, yield_pct, is_active, is_sub_recipe').order('id')),
    fetchAllRows(() => scopedFrom('par_levels', clientId, 'item_id, par_qty').order('id')),
    fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id).order('id')),
    fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id).order('id')),
    // Every settlement the client has ever recorded, one row per line per payment — the fastest-
    // growing read in this batch, and a truncated one reads a paid bill as unpaid (S723, S756).
    fetchAllRows(() => scopedFrom('payable_payments', clientId, 'purchase_entry_id, amount').order('id')),
    // Staff meals come off the shelf in the shared on-hand calculation the reorder figure is
    // built from (S696).
    fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', period.id).order('id')),
    // The client's Food Cost thresholds, frozen with the report since schema 18 (S849, OWNER-REPORT-5)
    // so a later change in Settings never re-judges an old month. `settings` has a nullable
    // client_id, so it stays on raw supabase.from (CLAUDE.md).
    supabase.from('settings').select('fc_warning_pct, fc_critical_pct').eq('client_id', clientId).maybeSingle(),
    // Stock sent to or received from another outlet this month (S849, PNL-8): received stock adds like
    // a purchase, sent stock comes off like a return, in Net Purchases, COGS and on-hand. Paged, and a
    // failed read fails the section like every read here.
    readPeriodTransfers((t, c) => scopedFrom(t, clientId, c), period.id),
  ])
  // A failed read must THROW so runSection() records it as a section error the page names —
  // otherwise it flows through `|| []` and freezes zeros into the immutable snapshot (S612).
  throwFirstError(results)
  const [
    { data: purchases }, { data: returns }, { data: salesData }, { data: recipes },
    { data: overheadsData }, { data: wastagesData }, { data: allItems }, { data: parLevels },
    { data: opening }, { data: closing }, { data: payablePayments }, { data: staffMealsData },
    { data: settingsRow }, { data: transfers },
  ] = results
  // `is_active === true`, not truthy-ness: the old read was `.eq('is_active', true)`, which a NULL
  // never passed either.
  const items = (allItems || []).filter(i => i.is_active === true)

  // Net of bill discounts since schema v6 — v1–v5 snapshots summed a raw qty × rate here. Plus stock
  // transfers in, less transfers out, since schema 18 (PNL-8).
  const { purchaseTotal, cashNet, creditNet, transferIn, transferOut } = netPurchaseFigures(purchases, returns, transfers)

  // Monthly Summary's own revenue arithmetic (periodCost.js): the price charged at the time of sale,
  // net of the row's discount, comps excluded in JS.
  const revenueTotal = periodRevenue(salesData, recipes)

  // Overheads (the `overhead` bucket and rows with none) and Tax & Fees, as Consolidated P&L splits
  // them. Until schema v12 only the first was read and Tax & Fees was in no figure here. The Labor tab
  // (v18) is frozen on its own; the labour rule decides what it means (resolveReportLabour below).
  const { overhead: overheadTotal, taxFees: taxFeesTotal, labor: laborTabTotal } = splitOverheadBuckets(overheadsData)

  const itemRateMap = {}; items.forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
  // The one Wastage Value every tile shows (periodCost.js, S792 FIGURES-5): every item, prep and
  // hidden ones included. Until v10 it took this active-only map, so a hidden item's wastage was
  // left out here while the Wastage Report and both dashboards counted it. Information only — COGS
  // below takes off raw-item wastage through valuePeriodItems, never this figure: wasted prep was
  // made from raw items COGS already counts as used, so taking it off COGS as well would drop that
  // real cost from Food Cost % and Net Margin %.
  const wastageValueTotal = periodWastageValue(wastagesData)
  // Same qty × per_uom_rate valuation MonthlySummary.js/Stock.js use for their own Opening/
  // Closing Stock figures — an owner reading this report needs to see what stock the period
  // started and ended with, same as every other IMS report already shows.
  const openingStockValueTotal = (opening || []).reduce((s, o) => s + parseFloat(o.qty || 0) * (itemRateMap[o.item_id] || 0), 0)
  const closingStockValueTotal = (closing || []).reduce((s, c) => s + parseFloat(c.physical_qty || 0) * (itemRateMap[c.item_id] || 0), 0)

  const paidMap = {}
  ;(payablePayments || []).forEach(p => { paidMap[p.purchase_entry_id] = (paidMap[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })

  const recipeIds = (recipes || []).map(r => r.id)
  const creditIds = (purchases || []).filter(p => p.payment_method === 'Credit').map(p => p.id)
  // Both walks throw on a failed read, so runSection records the IMS section as failed rather
  // than freezing zero usage; the delta walk adds customized plates' option stock lines (S758).
  // The returns against this month's credit lines come from ANY month (S849, OWNER-REPORT-8): what
  // is owed on a bill falls when goods go back, whenever that was, as on Outstanding Payables.
  // Chunked: the line ids travel in the URL.
  const [ingredientBreakdown, deltaExplosion, creditReturnsRes] = await Promise.all([
    recipeIds.length > 0 ? explodeRecipeIngredients(supabase, recipeIds) : {},
    loadDeltaExplosion(supabase, (salesData || []).map(s => s.ingredient_deltas)),
    creditIds.length > 0
      ? fetchAllRowsChunked(creditIds, ids => scopedFrom('vendor_returns', clientId, 'id, purchase_entry_id, qty, rate').in('purchase_entry_id', ids).order('id'))
      : { data: [], error: null },
  ])
  throwFirstError([creditReturnsRes])

  // "Unpaid Credit (this period)": what is still OWED on this month's credit bills — VAT added, the
  // bill discount taken off, returns credited at their discounted price — less what was paid, per
  // BILL (S849, OWNER-REPORT-8, schema 18). Until v17 each LINE's raw qty × rate was compared with its
  // payments, so a discounted bill paid in full read its discount as unpaid, a VAT bill paid half
  // read too little, and `unpaidCount` counted lines. `basis: 'owed'` marks it.
  const { unpaidTotal: payablesUnpaidTotal, unpaidCount: payablesUnpaidCount } = unpaidCreditTotals(
    unpaidCreditBills({ lines: purchases, returnedByEntry: returnedByEntryOf(creditReturnsRes.data), paidByEntry: paidMap }))
  // Every sales row, comps included — comps consumed ingredients even though they earned nothing.
  // The on-hand / below-par figures come from the ONE calculation the live Reorder Report and
  // both dashboards use (S696, schema v4); v3 snapshots carried this section's own copy, which
  // deducted neither wastage nor staff meals and summed sales raw. Active, non-sub-recipe items:
  // "on the shelf at close" is a question about the items still in use.
  const stockRows = buildStockRows({
    items: items.filter(i => !i.is_sub_recipe),
    opening, closing, purchases, returns, wastages: wastagesData, staffMeals: staffMealsData,
    sales: salesData, breakdown: ingredientBreakdown, pars: parLevels, explosion: deltaExplosion, transfers,
  })
  const { count: reorderCount, estValueTotal: reorderEstValueTotal } = summarizeReorder(stockRows)

  // ── Food Cost % = food USED (COGS) ÷ revenue (S792, owner decision D30) ──
  // A closed month's food cost is what was used, not what was bought. Until schema v9 this was net
  // purchases ÷ revenue, so a month that ended with more stock than it began (opening 1 L,
  // purchases 5 L, closing 2.5 L, revenue 10 L) froze 50% ▲ here while Monthly Summary, Consolidated
  // P&L, Annual Summary and Period Comparison said 35% for the same month (FIGURES-3). COGS is
  // Monthly Summary's own arithmetic from periodCost.js — per-item values, purchases net of bill
  // discounts, returns off, `computeUsed()` with staff meals in — over every non-sub-recipe item
  // with a row this month, hidden or not (D29). Prep (sub-recipe) stock is outside COGS, as on
  // Monthly Summary, so the Opening/Closing Stock rows above (which include prep, as Stock Count
  // does) do not add up to it exactly when prep was counted.
  const cogsItems = (allItems || []).filter(i => !i.is_sub_recipe)
  const stockMaps = periodStockMaps({ opening, closing, purchases, returns, wastages: wastagesData, staffMeals: staffMealsData, transfers })
  const cogs = valuePeriodItems(cogsItems, stockMaps)
  const cogsTotal = cogs.cogsVal
  const foodCostPct = revenueTotal > 0 ? (cogsTotal / revenueTotal) * 100 : null

  // The count COGS rests on (S756, D6): an item with stock and NO closing count is counted as all
  // used. The totals stand — they must tie to Monthly Summary — but the gap is frozen with them,
  // and while it is material the report withholds the food-cost verdict, as Monthly Summary does.
  // Counted = a row whose physical_qty is not null; a count of 0 is a count (S695). Monthly
  // Summary's own gap (periodGap), so stock that only arrived by transfer and was never counted is
  // uncounted too (S849).
  const gap = periodGap({ items: cogsItems, maps: stockMaps, closing, cogs: cogsTotal })
  const fcT = fcThresholds(settingsRow)

  return {
    revenueTotal, purchaseTotal, overheadTotal, taxFeesTotal, wastageValueTotal, openingStockValueTotal, closingStockValueTotal, cashNet, creditNet, foodCostPct,
    // New in schema v9 (D30). Absent on an older snapshot, whose foodCostPct is purchases ÷ revenue.
    foodCostBasis: 'cogs', cogsTotal, staffMealsValueTotal: cogs.staffMealsVal,
    // Schema 18 (S849). Absent on an older snapshot, and never rendered as NPR 0 there:
    //   - cogsWastageTotal: raw stock wasted, COGS's own wastage term (the raw-item part of Wastage
    //     Value; wasted prep is already inside COGS). Net Margin subtracts it (GAPS-1).
    //   - cogsOpeningValue / cogsClosingValue: the stock of the items COGS counts, for Inventory
    //     Turnover on the same footing (OWNER-REPORT-15).
    //   - laborTabTotal: the Overheads Labor tab as typed (OWNER-REPORT-9 / GAPS-4).
    //   - transferIn / transferOut: stock received from / sent to another outlet, in purchaseTotal (PNL-8).
    //   - fcThresholds: the Food Cost bands the report is judged against (OWNER-REPORT-5).
    cogsWastageTotal: cogs.wastageVal, cogsOpeningValue: cogs.openingVal, cogsClosingValue: cogs.closingVal,
    laborTabTotal, transferIn, transferOut,
    fcThresholds: { warn: fcT.warn, critical: fcT.critical },
    countGap: {
      presentCount: gap.presentCount, uncountedCount: gap.uncountedCount, uncountedValue: gap.uncountedValue,
      material: gap.material,
      // Names resolved at generation, like everything else in a frozen snapshot (S435).
      names: gap.uncounted.slice(0, UNCOUNTED_NAME_LIMIT).map(u => u.name),
    },
    reorder: { count: reorderCount, estValueTotal: reorderEstValueTotal },
    payables: { unpaidTotal: payablesUnpaidTotal, unpaidCount: payablesUnpaidCount, basis: 'owed' },
  }
}

// ── Employment, attendance and leave in the month (pure, schema 18) ─────────────────────────────

/**
 * Whether one employee was employed at any time in the month, by their dates (S849, OWNER-REPORT-7).
 * `startAd` / `endAd` are the month's first and last day as local midnights (bsToAd).
 *
 * Employed when they had joined by the month's end AND either their End Date is on or after the
 * month's start, or they have no End Date and are on payroll (active / probation). An off-payroll
 * status (resigned, terminated, inactive) with NO End Date is `unknown`: nothing says how far into the
 * month they worked, so they are not counted, and the report says how many there are. Until v17 the
 * headcount used today's status, so a report made (or regenerated) after two staff resigned counted
 * neither of them in a month they worked in full (CASA read 2 where payroll paid 4).
 *
 * @returns {{ employed: boolean, joined: boolean, left: boolean, unknown: boolean }}
 */
export function employmentInMonth(emp, startAd, endAd) {
  const none = { employed: false, joined: false, left: false, unknown: false }
  if (!emp) return none
  const joinAd = emp.join_date ? parseAdDateLocal(emp.join_date) : null
  if (joinAd && joinAd > endAd) return none
  const endDate = emp.end_date ? parseAdDateLocal(emp.end_date) : null
  const onPayroll = emp.status === 'active' || emp.status === 'probation'
  let employed = false, left = false
  if (endDate) {
    employed = endDate >= startAd
    left = employed && endDate <= endAd
  } else if (onPayroll) {
    employed = true
  } else {
    return { ...none, unknown: true }
  }
  const joined = employed && !!joinAd && joinAd >= startAd && joinAd <= endAd
  return { employed, joined, left, unknown: false }
}

/**
 * Attendance Rate over the days staff were DUE to work (S849, OWNER-REPORT-13): present-equivalent
 * days ÷ (sheet rows − weekly offs − public holidays). Paid leave counts as present, unpaid leave as
 * absent, a half day as half. Until v17 the denominator was every sheet row, so a month of perfect
 * attendance read about 84% (four weekly offs and a holiday in 31 days). Null with no sheet rows, or
 * no working day on them. `basis: 'working_days'` marks it.
 */
export function attendanceRate(rows) {
  const list = rows || []
  if (list.length === 0) return null
  const t = tallyAttendance(list)
  const totalTrackedDays = list.length
  const presentDays = t.present + t.half_day * 0.5 + t.paid_leave + t.half_paid_leave * 0.5
  const absentDays = t.absent + t.unpaid_leave + t.half_unpaid_leave * 0.5
  const workingDays = totalTrackedDays - t.weekly_off - t.holiday
  return {
    presentDays, absentDays, totalTrackedDays, workingDays,
    rate: workingDays > 0 ? (presentDays / workingDays) * 100 : null,
    basis: 'working_days',
  }
}

/**
 * The days of one approved leave request that fall inside the month (S849, OWNER-REPORT-14). A request
 * wholly inside keeps its stored `days` (which already leaves out the days it does not count); one that
 * crosses a month edge is shared out by calendar days — days × (its calendar days inside the month ÷
 * its calendar days) — rounded to the half day. Until v17 a crossing leave counted in full in BOTH
 * months.
 */
export function leaveDaysInMonth(lr, startAd, endAd) {
  const days = parseFloat(lr?.days) || 0
  if (!lr?.start_date || !lr?.end_date) return days
  const start = parseAdDateLocal(lr.start_date)
  const end = parseAdDateLocal(lr.end_date)
  if (start >= startAd && end <= endAd) return days
  const DAY = 86400000
  // Local midnights both, so differences are whole days; round so a daylight-saving hour cannot drop one.
  const total = Math.round((end - start) / DAY) + 1
  const from = start > startAd ? start : startAd
  const to = end < endAd ? end : endAd
  const inside = Math.max(0, Math.round((to - from) / DAY) + 1)
  if (!(total > 0)) return 0
  return Math.round(days * (inside / total) * 2) / 2
}

// ── HR section ──────────────────────────────────────────────────────────────
// Labour for a closed month (S849, GAPS-4 / SU11 (a), schema 18): the finalized payroll run, else the
// ONE HR wage estimate every Suite page uses (`estimateLabour`, labourEstimate.js) — payroll's own
// roster, unpaid days on the attendance sheet, attendance-based pay for daily and hourly staff, sheet
// overtime and approved overtime priced as payroll prices them. Its inputs come through
// `loadLabourEstimateInputs` (loadOutletLabour.js), paged. Until v17 the report had its own estimate
// (`estimatePayrollAccrual` + an approved-overtime loop) that read no attendance at all, so a month
// whose overtime was on the sheet froze none of it, and the Owner Dashboard and this report could
// disagree for the same month. A CLOSED period is fully elapsed, so the estimate runs to its last day.
//
// Returns the frozen section and, apart, what `resolveReportLabour` needs (the estimate object holds
// names, which are not frozen; only counts are).
async function computeHrSection(clientId, period) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const periodStartAd = bsToAd(period.bs_year, period.bs_month, 1)
  const periodEndAd   = bsToAd(period.bs_year, period.bs_month, monthDays)
  const from = (t, c) => scopedFrom(t, clientId, c)

  const results = await Promise.all([
    // Employees (with names, status and dates), earning components, approved overtime, the month's
    // attendance and finalized settlements: every read paged with a unique tiebreaker (S849,
    // OWNER-REPORT-16: three of them were bare and stopped at 1,000 rows with no error).
    loadLabourEstimateInputs(from, period),
    // Approved requests that touch the month, filtered by the server and paged (S798 2e,
    // LABOUR-FIGURES-6). It read the client's whole leave history in one request, so past ~1,000
    // requests the newest were cut and the frozen Leave section came out short or empty. formatAd
    // bounds compare as calendar days, not as UTC instants.
    fetchAllRows(() => scopedFrom('hr_leave_requests', clientId, 'id, leave_type_id, status, start_date, end_date, days')
      .eq('status', 'approved').lte('start_date', formatAd(periodEndAd)).gte('end_date', formatAd(periodStartAd))
      .order('id')),
    // A name map of the client's leave types: tens of rows, not paged.
    scopedFrom('hr_leave_types', clientId, 'id, name'),
    scopedFrom('hr_payroll_runs', clientId, 'id').eq('period_id', period.id).eq('status', 'finalized').maybeSingle(),
    // Festival allowance, incentives and final settlements finalized for this month (S798 3c, H18):
    // labour in the month paid, on top of the run or the estimate. A failed read fails the section.
    loadMonthOtherLabour(from, period.bs_year, period.bs_month),
  ])
  throwFirstError(results)
  const [
    { inputs }, { data: leaveRequests }, { data: leaveTypes }, { data: finalizedRun }, { other: otherLabour },
  ] = results
  const employees = inputs.employees || []
  const attendanceRows = inputs.attendance || []
  // Frozen as plain figures, the festival name resolved now (the S435 rule for a frozen artifact).
  const other = {
    festival: otherLabour.festival, festivalName: otherLabour.festivalName,
    incentive: otherLabour.incentive, settlement: otherLabour.settlement,
    settlementCount: otherLabour.settlementCount, total: otherLabour.total,
  }
  const leaveTypeNameMap = Object.fromEntries((leaveTypes || []).map(lt => [lt.id, lt.name]))

  // Headcount is a lifecycle fact (who was employed, joined or left in the month), decided by join and
  // End Dates, not by today's status (schema 18, OWNER-REPORT-7: employmentInMonth). "Employed" is
  // everyone employed at any time in the month, joiners and leavers included.
  let employedCount = 0, newHiresCount = 0, terminationsCount = 0, noEndDateCount = 0
  employees.forEach(emp => {
    const e = employmentInMonth(emp, periodStartAd, periodEndAd)
    if (e.unknown) {
      // Only someone who could have worked the month: joined by its end.
      const joinAd = emp.join_date ? parseAdDateLocal(emp.join_date) : null
      if (!joinAd || joinAd <= periodEndAd) noEndDateCount += 1
      return
    }
    if (!e.employed) return
    employedCount += 1
    if (e.joined) newHiresCount += 1
    if (e.left) terminationsCount += 1
  })

  // ── Payroll figures: prefer the actual finalized payroll run over the estimate ──
  // A finalized hr_payroll_runs/hr_payslips is the exact, authoritative Nepal-payroll-engine
  // computation (payrollCompute.js — real OT from BOTH attendance and approved claims, real
  // TDS/absence-based deductions). Only when the month's payroll was never finalized does the
  // report fall back to the estimate (the client does not use Payroll Run, or has not finalized yet).
  let payroll, payrollSource, labourInput, estimateNotes = null
  if (finalizedRun?.id) {
    // Paged: one row per employee per run.
    const payslipRes = await fetchAllRows(() => scopedFrom('hr_payslips', clientId, 'id, gross, absence_deduction, ot_hours, ot_amount, ssf_employer')
      .eq('run_id', finalizedRun.id).order('id'))
    // A finalized run whose payslips cannot be read must fail the section, not freeze a payroll
    // of NPR 0 under payrollSource:'finalized' — the label would vouch for the wrong figure.
    throwFirstError([payslipRes])
    const { data: payslips } = payslipRes
    const gross = (payslips || []).reduce((s, p) => s + (parseFloat(p.gross) || 0), 0)
    // S798 3c (H19): only what was earned — unpaid days and days before joining or after leaving
    // come off, as on the payroll sheet's Cost to business (payrollLabourTotal).
    const absenceDeduction = (payslips || []).reduce((s, p) => s + (parseFloat(p.absence_deduction) || 0), 0)
    const otHours = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_hours) || 0), 0)
    const otAmount = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_amount) || 0), 0)
    const ssfEmployer = (payslips || []).reduce((s, p) => s + (parseFloat(p.ssf_employer) || 0), 0)
    const payrollBase = payrollLabourTotal(payslips || [])
    payroll = { gross, absenceDeduction, ot: { hours: otHours, amount: otAmount }, ssfEmployer, other, total: payrollBase + other.total }
    payrollSource = 'finalized'
    labourInput = { payroll: payrollBase, estimate: null, otherPay: other }
  } else {
    const est = estimateLabour({ ...inputs, period, throughDay: monthDays })
    const otHours = est.sheetOt.hours + est.approvedOt.hours
    const otAmount = est.sheetOt.amount + est.approvedOt.amount
    // The estimate prorates joiners and leavers and docks unpaid days itself; it has no separate
    // unpaid-day figure to show.
    payroll = { gross: est.gross, absenceDeduction: null, ot: { hours: otHours, amount: otAmount }, ssfEmployer: est.ssfEmployer, other, total: est.amount + other.total }
    payrollSource = 'estimated'
    labourInput = { payroll: null, estimate: est, otherPay: other }
    // What the page owes the reader about the estimate, as counts (names are not frozen).
    estimateNotes = {
      staffCounted: est.staffCounted, onPayroll: est.onPayroll, noPay: est.noPay.length,
      unended: est.unended.length, settledOut: est.settledOut, calendarStaff: est.calendarStaff,
      sheetOt: { hours: est.sheetOt.hours, amount: est.sheetOt.amount },
    }
  }

  // Leave taken — hr_leave_requests has no period_id, only AD start_date/end_date. Since schema 18
  // (OWNER-REPORT-14) a request crossing a month edge counts only its days inside this month.
  const leaveByType = {}
  ;(leaveRequests || []).forEach(lr => {
    // The query already holds only approved requests overlapping the month; kept as a guard.
    if (lr.status !== 'approved') return
    const start = parseAdDateLocal(lr.start_date), end = parseAdDateLocal(lr.end_date)
    if (end < periodStartAd || start > periodEndAd) return
    const key = lr.leave_type_id || 'unspecified'
    if (!leaveByType[key]) {
      // Resolved to a name AT GENERATION TIME, same as everything else in a frozen snapshot —
      // if the leave type is later renamed or deleted, this report must keep showing what was
      // true when it was generated, not silently go blank or fall back to the raw id.
      const name = lr.leave_type_id ? (leaveTypeNameMap[lr.leave_type_id] || 'Unknown Leave Type') : 'Unspecified'
      leaveByType[key] = { leaveTypeName: name, days: 0, requestCount: 0 }
    }
    leaveByType[key].days += leaveDaysInMonth(lr, periodStartAd, periodEndAd)
    leaveByType[key].requestCount += 1
  })

  return {
    section: {
      payroll, payrollSource,
      ...(estimateNotes ? { estimate: estimateNotes } : {}),
      headcount: { employed: employedCount, newHires: newHiresCount, terminations: terminationsCount, noEndDate: noEndDateCount, basis: 'dates' },
      leave: Object.values(leaveByType),
      leaveBasis: 'in_month',
      // Best-effort/nullable; not every client uses the daily Attendance Sheet (OWNER-REPORT-13).
      attendance: attendanceRate(attendanceRows),
    },
    labourInput,
  }
}

// ── POS section ─────────────────────────────────────────────────────────────
// pos_orders has no period_id/BS columns — only AD closed_at/opened_at — so the BS month becomes a
// range of NEPAL days first (bsDayBoundaryIso, +05:45). It was `bsToAd(...).toISOString()`, which
// reads the date as the generating device's midnight: a report made on a laptop outside Nepal moved
// both month edges by the zone difference (S809 3m, with IMS-HANDOFF-4).
//
// Since schema v15 (S809 3m, IMS-HANDOFF-4) the figures follow the Sales Report's own rules, through
// its own arithmetic (salesReportMath.js, S754): every paid bill CLOSED in the month counts at full
// value, a credit-noted one included, each valued as it was issued (billVatRegistered); every credit
// note ISSUED in the month is a minus at its own stored figures, whichever month its bill was in; a
// Split bill is spread over its payment legs. Until v15 a credited bill was dropped from its month
// and its note never subtracted, so a bill credited in a later month left both months' Net Sales,
// and the bill count, covers, average check and payment mix left the bill out where Sales Report
// keeps it. Covers are the guests SEATED at tables (coversMath.seatedCovers via coversTotals, owner
// decision 2026-10-10), as on the Covers Report, the POS Dashboard and Home. Since v17 (S836) a part
// bill, split off a table's bill so one guest could pay, is dine-in though it has no table of its
// own, so the read carries `part_of_order_id` beside `table_id` (coversMath.isDineIn needs both).
// This is a summary artifact — aggregated rollups only, not a bill ledger.
const POS_ORDER_COLUMNS = 'id, discount_amount, closed_at, payment_method, covers, table_id, part_of_order_id, vat_registered'
const POS_NOTE_COLUMNS = 'id, order_id, gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount, created_at'

// The section's sales figures from rows already read, so the rules above can be asserted without a
// database. `orders`: the month's paid bills. `creditNotes`: the notes issued in the month.
// `orderById`: those bills AND every bill a note credits (some closed before the month).
// `itemsByOrder`: each bill's charged lines, comped ones left out. `paymentsByOrder`: Split legs.
export function posSalesFigures({ orders, creditNotes, orderById = {}, itemsByOrder = {}, paymentsByOrder = {}, vatReg }) {
  const bills = orders || []
  const notes = creditNotes || []
  const entries = buildSalesEntries({ orders: bills, creditNotes: notes, orderById, itemsByOrder, vatReg })
  const total = zeroAmounts()
  let returnsNet = 0
  for (const e of entries) {
    addAmounts(total, e.amounts)
    if (e.kind === 'return') returnsNet += e.amounts.net
  }
  // Category Wise's rows: a note returns its bill's lines in the month it was issued.
  const categoryBreakdown = buildGroupedRows({
    orders: bills, creditNotes: notes, orderById, itemsByOrder, vatReg,
    keyOf: i => i.category || 'Uncategorized', labelOf: i => i.category || 'Uncategorized',
  }).map(r => ({ category: r.name, qty: r.qtySales - r.qtyReturn, net: r.gross - r.discount + r.vat }))
  // Payment Summary's rows: a note comes off the method(s) its bill was paid with.
  const paymentMix = buildPaymentRows(entries, paymentsByOrder)
    .map(p => ({ method: p.method, net: p.net, pctOfNet: total.net > 0 ? (p.net / total.net) * 100 : 0 }))
    .sort((a, b) => b.net - a.net)
  // The Covers Report's headline: guests seated, and dine-in Net Sales after dine-in returns.
  const netOf = o => billAmounts(o, itemsByOrder[o.id], vatReg).net
  const returns = notes.map(n => ({ order: orderById[n.order_id] || null, net: -(Number(n.net_amount) || 0) }))
  const seated = coversTotals(bills, netOf, returns)
  return {
    totalNetSales: total.net, totalGross: total.gross, totalDiscount: total.discount, totalVat: total.vat,
    billCount: bills.length, totalQty: total.qty,
    creditNotes: { count: notes.length, net: returnsNet },
    categoryBreakdown,
    paymentMix,
    covers: {
      // Present from v15: its absence says covers were every bill's, takeaway included.
      basis: 'seated',
      totalCovers: seated.covers,
      dineInBills: seated.bills,
      takeawayBills: seated.takeaway.bills,
      avgCheckPerCover: seated.covers > 0 ? seated.net / seated.covers : null,
      avgBillValue: bills.length > 0 ? total.net / bills.length : null,
    },
  }
}

async function computePosSection(clientId, period) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const fromTs = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
  const toTs = bsDayBoundaryIso(period.bs_year, period.bs_month, monthDays, true)
  if (!fromTs || !toTs) throw new Error(`No calendar dates for ${period.bs_year}-${period.bs_month}`)

  const posResults = await Promise.all([
    supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
    // Paged: a busy month passes 1,000 paid bills, and a bare select stopped there with no error,
    // freezing a short POS section into the snapshot.
    fetchAllRows(() => scopedFrom('pos_orders', clientId, POS_ORDER_COLUMNS)
      .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs).order('id')),
    // Credit notes by the moment they were ISSUED, on the same Nepal-day bounds as the bills.
    fetchAllRows(() => scopedFrom('pos_credit_notes', clientId, POS_NOTE_COLUMNS)
      .gte('created_at', fromTs).lte('created_at', toTs).order('id')),
  ])
  throwFirstError(posResults)
  const [{ data: settings }, { data: orderData }, { data: noteData }] = posResults
  const vatReg = settings?.is_vat_registered ?? true
  const orders = orderData || []
  const creditNotes = noteData || []
  const inMonth = new Set(orders.map(o => o.id))

  // The bills this month's notes credit that closed BEFORE it: a minus needs its bill's lines, table
  // and payment method. Chunked, like every `.in()` read here.
  const outsideIds = [...new Set(creditNotes.map(n => n.order_id).filter(id => id && !inMonth.has(id)))]
  const outsideRes = await fetchAllRowsChunked(outsideIds,
    ids => scopedFrom('pos_orders', clientId, POS_ORDER_COLUMNS).in('id', ids).order('id'))
  throwFirstError([outsideRes])
  const allOrders = [...orders, ...(outsideRes.data || [])]
  const orderById = Object.fromEntries(allOrders.map(o => [o.id, o]))

  const splitIds = allOrders.filter(o => o.payment_method === 'Split').map(o => o.id)
  const lineResults = await Promise.all([
    // Paged: a month of bill lines runs to thousands. This one is written into a FROZEN snapshot,
    // so a truncated read wouldn't just be wrong once — it would be preserved as the permanent
    // record of that period, with no later recompute to correct it (S529).
    // Chunked as well: every paid bill's id goes in the URL, and a month of a few hundred bills
    // was a 400 Bad Request that froze the POS section as failed.
    // selection_key marks a combo's dish ('@'), which takes none of the bill discount (S839, isComboItem).
    fetchAllRowsChunked(allOrders.map(o => o.id),
      ids => scopedFrom('pos_order_items', clientId, 'order_id, recipe_id, name, category, qty, unit_price, vat_rate, comped, comp_no, selection_key').in('order_id', ids).order('id')),
    // The legs of every Split bill, the read Sales Report's Payment Summary and the Z-report make.
    fetchAllRowsChunked(splitIds,
      ids => scopedFrom('pos_order_payments', clientId, 'order_id, payment_method, amount').in('order_id', ids).order('id')),
  ])
  throwFirstError(lineResults)
  const [{ data: itemRows }, { data: legRows }] = lineResults

  const itemsByOrder = {}
  const compedItems = []
  ;(itemRows || []).forEach(i => {
    // A comp belongs to the month its bill closed in, so a bill pulled in for a note brings none.
    if (i.comped) { if (inMonth.has(i.order_id)) compedItems.push(i); return }
    ;(itemsByOrder[i.order_id] = itemsByOrder[i.order_id] || []).push(i)
  })
  const paymentsByOrder = {}
  ;(legRows || []).forEach(p => { (paymentsByOrder[p.order_id] = paymentsByOrder[p.order_id] || []).push(p) })

  const figures = posSalesFigures({ orders, creditNotes, orderById, itemsByOrder, paymentsByOrder, vatReg })

  let compedCount = 0, compedFoodCost = 0, compedPotentialValue = 0
  if (compedItems.length > 0) {
    const recipeIds = [...new Set(compedItems.map(i => i.recipe_id).filter(Boolean))]
    const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
    const compGroups = new Set()
    compedItems.forEach(i => {
      compGroups.add(`${i.order_id}:${i.comp_no}`)
      compedFoodCost += i.qty * (costMap[i.recipe_id] || 0)
      // Menu price before VAT since schema 16 (S814 4d, owner decision D1): the Sales Exceptions
      // basis, and the voids beside it were already ex-VAT.
      compedPotentialValue += forgoneMenuValue([i])
    })
    compedCount = compGroups.size
  }

  const voidRowsRes = await fetchAllRows(() => scopedFrom('pos_orders', clientId, 'id')
    .in('close_type', ['void', 'writeoff']).gte('closed_at', fromTs).lte('closed_at', toTs).order('id'))
  throwFirstError([voidRowsRes])
  const voidOrderIds = (voidRowsRes.data || []).map(o => o.id)
  let voidsAmount = 0
  if (voidOrderIds.length > 0) {
    const voidItemsRes = await fetchAllRowsChunked(voidOrderIds, ids => scopedFrom('pos_order_items', clientId, 'order_id, qty, unit_price').in('order_id', ids).order('id'))
    throwFirstError([voidItemsRes])
    voidsAmount = forgoneMenuValue(voidItemsRes.data)
  }

  return {
    ...figures,
    // `basis: 'ex_vat'` (schema 16) marks a potential value before VAT; an older report's has none
    // and was frozen with VAT, which the page and the workbook say.
    compedBillsTotal: { count: compedCount, foodCost: compedFoodCost, potentialValue: compedPotentialValue, basis: 'ex_vat' },
    voidsWriteoffsTotal: { count: voidOrderIds.length, amount: voidsAmount },
  }
}

// The labour figure for the report, by the ONE rule every Suite page uses (S849, GAPS-4 / SU11 (a),
// OWNER-REPORT-9; `resolveOutletLabour`, labourSource.js), for a closed month (scale 1):
//   - Crest HR in the report: the finalized run, else the HR estimate, plus other labour. A non-empty
//     Overheads Labor tab is NOT added; it is frozen as `laborTabNotCounted` and named on the page.
//     The HR section failed → `failed`: no labour figure and no Net Margin, never the Labor tab.
//   - Crest HR not in the report (SU18): the Labor tab is the labour, "from Overheads"; an empty tab is
//     `none` (no Labor Cost %, and Net Margin is shown unbanded with "no labour entered on Overheads").
// `hrLabour` is computeHrSection's `labourInput` (null when HR is off or failed).
export function resolveReportLabour({ hrIncluded, hrLabour, ims }) {
  if (!ims) return null
  const labour = resolveOutletLabour({
    hrOn: !!hrIncluded,
    payroll: hrLabour?.payroll ?? null,
    payrollReadFailed: !!hrIncluded && !hrLabour,
    estimate: hrLabour?.estimate ?? null,
    labourBucket: ims.laborTabTotal || 0,
    otherPay: hrLabour?.otherPay ?? null,
  })
  return {
    source: labour.source,
    amount: labour.amount,
    laborTabNotCounted: labour.ignoredBucket || 0,
    reason: labour.reason || '',
    noPayCount: labour.reason === 'nopay' ? (labour.estimate?.noPay?.length || 0) : 0,
  }
}

// What an older caller (or an older test) passes instead of `labour`: the HR payroll total.
const labourFromHr = hr => (hr?.payroll ? {
  source: hr.payrollSource === 'finalized' ? 'payroll' : 'estimate', amount: hr.payroll.total, laborTabNotCounted: 0, reason: '', noPayCount: 0,
} : null)

// Prime Cost % / True Net Margin %. Always computed when inputs exist; True Net Margin's verdict is
// gated behind hasFeature('overheads') by the report page, not here (mirrors Owner Dashboard's own
// canOverheads pattern).
//
// Since schema v9 (S792, D30) the food cost in all three is COGS — what was used — because the
// report is always of a closed month. `foodCostBasis` names the basis so a reader, and the Trend
// section comparing against older snapshots, can tell.
//
// Since schema v13 (S798 3c, LABOUR-FIGURES-1/-3) labour is pay EARNED (gross less the absence
// deduction) + overtime + employer SSF, plus festival allowance, incentives and final settlements
// finalized for the month. `labourBasis: 'earned'` marks it; Labor, Prime and Net Margin get no
// Trend delta across the line.
//
// Since schema v12 (S798 2e, LABOUR-FIGURES-4) Net Margin also subtracts Tax & Fees, as Overheads,
// the Dashboard and Consolidated P&L do. `netMarginTaxFees: true` marks it.
//
// Since schema 18 (S849, GAPS-1 / SU23, PNL-1) Net Margin takes off the same costs Consolidated P&L
// does: revenue − COGS − raw stock wasted − staff meals − delivery commission − labour − overheads −
// Tax & Fees. COGS takes wastage and staff meals OUT of food used (they are shown on their own lines),
// so a margin that subtracted only COGS left them out of every cost and read higher than the P&L by
// them. Delivery commission is what Foodmandu, Pathao and the like kept from the month's bills
// (`loadDeliveryCommission`); when its read failed, Net Margin is null — never a margin without it.
// `netMarginPnlCosts: true` marks it; Trend gives no Net Margin delta across the line. Prime Cost
// stays Food Cost % + Labor Cost % (D30).
//
// Labour comes from `labour` (resolveReportLabour, v18). Its markers are kept when IMS failed, so a
// reader can still tell which rule the empty ratios were computed under (OWNER-REPORT-2).
export function computeCombinedMetrics({ ims, hr, labour, deliveryCommission = null, commissionFailed = false }) {
  const markers = { netMarginTaxFees: true, labourBasis: LABOUR_BASIS, netMarginPnlCosts: true }
  const lab = labour !== undefined ? labour : labourFromHr(hr)
  if (!ims) {
    return {
      revenueTotal: null, foodCostPct: null, laborCostPct: null, primeCostPct: null, netMarginPct: null,
      foodCostBasis: 'cogs', ...markers, labour: lab || null, fcThresholds: null,
    }
  }
  const revenueTotal = ims.revenueTotal || 0
  const foodCostPct = ims.foodCostPct
  const hasLabourFigure = !!lab && lab.amount != null
  // `none` (no HR and an empty Labor tab) has no Labor Cost %: 0.0% would read as a verdict.
  const laborCostPct = hasLabourFigure && lab.source !== 'none' && revenueTotal > 0 ? (lab.amount / revenueTotal) * 100 : null
  const primeCostPct = foodCostPct != null && laborCostPct != null ? foodCostPct + laborCostPct : null
  const commission = Number(deliveryCommission?.amount) || 0
  const netMarginPct = hasLabourFigure && !commissionFailed && revenueTotal > 0
    ? ((revenueTotal - ims.cogsTotal - (ims.cogsWastageTotal || 0) - (ims.staffMealsValueTotal || 0) - commission
      - lab.amount - ims.overheadTotal - (ims.taxFeesTotal || 0)) / revenueTotal) * 100
    : null
  return {
    revenueTotal, foodCostPct, laborCostPct, primeCostPct, netMarginPct, foodCostBasis: ims.foodCostBasis, ...markers,
    labour: lab || null,
    fcThresholds: ims.fcThresholds || null,
  }
}

// ── Trend section ────────────────────────────────────────────────────────────
// Compares this period against its own already-frozen neighbors — reads prior
// monthly_owner_reports rows directly rather than re-deriving figures live (cheaper, and
// philosophically consistent: those numbers are already frozen facts for their own period).
// Deliberately never generates a missing prior snapshot as a side effect of viewing this one —
// that would be surprising, expensive, and inconsistent with "generate on close or on deliberate
// view of THAT period." BS years always have exactly 12 months, so month rollover is plain
// integer arithmetic — no bsToAd round-trip needed (this doesn't need day-level AD precision).
async function lookupPriorSnapshot(clientId, bsYear, bsMonth) {
  // Failed reads throw rather than masquerading as reason:'no_period'/'no_report' — a frozen
  // trend claiming "no prior data exists" is an assertion about the client's history, and it
  // must not be made off a network blip (S612).
  const priorPeriodRes = await scopedFrom('monthly_periods', clientId, 'id, status')
    .eq('bs_year', bsYear).eq('bs_month', bsMonth).maybeSingle()
  throwFirstError([priorPeriodRes])
  const priorPeriod = priorPeriodRes.data
  if (!priorPeriod) return { available: false, reason: 'no_period', period: null, snapshot: null }
  if (priorPeriod.status !== 'closed') return { available: false, reason: 'not_closed', period: { bs_year: bsYear, bs_month: bsMonth }, snapshot: null }
  const reportRes = await scopedFrom('monthly_owner_reports', clientId, 'snapshot')
    .eq('period_id', priorPeriod.id).maybeSingle()
  throwFirstError([reportRes])
  const report = reportRes.data
  if (!report) return { available: false, reason: 'no_report', period: { bs_year: bsYear, bs_month: bsMonth }, snapshot: null }
  return { available: true, reason: null, period: { bs_year: bsYear, bs_month: bsMonth }, snapshot: report.snapshot }
}

// The basis a snapshot's Food Cost % was computed on. Absent before schema v9, when it was always
// net purchases ÷ revenue.
export const foodCostBasisOf = snapshot => snapshot?.combined?.foodCostBasis || 'purchases'

// Whether a snapshot's Net Margin % subtracts Tax & Fees. Absent before schema v12, when it did not.
export const netMarginTaxFeesOf = snapshot => snapshot?.combined?.netMarginTaxFees === true

// The labour definition a snapshot froze. Absent before schema v13: gross + overtime + employer SSF,
// no unpaid days taken off, and no festival, incentive or settlement pay.
export const LABOUR_BASIS = 'earned'
export const labourBasisOf = snapshot => snapshot?.combined?.labourBasis || 'gross'

// Whether a snapshot's Net Margin takes off wastage, staff meals and delivery commission as
// Consolidated P&L does. Absent before schema 18, when it did not (S849, GAPS-1).
export const netMarginPnlCostsOf = snapshot => snapshot?.combined?.netMarginPnlCosts === true

// Whether a snapshot's closing count left a MATERIAL gap, so its food-cost verdicts are withheld (D6).
// A trimmed Trend copy (v18) carries it as `countGapMaterial`; a full snapshot carries `ims.countGap`.
export const countGapMaterialOf = snapshot => {
  if (!snapshot) return false
  if (typeof snapshot.countGapMaterial === 'boolean') return snapshot.countGapMaterial
  return foodCostBasisOf(snapshot) === 'cogs' && !!snapshot.ims?.countGap?.material
}

export function buildDeltas(current, prior) {
  if (!prior) return null
  const pctDelta = (curVal, priorVal) => (curVal == null || priorVal == null) ? null : curVal - priorVal // percentage-point delta
  const moneyDelta = (curVal, priorVal) => {
    if (curVal == null || priorVal == null) return null
    const absoluteChange = curVal - priorVal
    const pctChange = priorVal !== 0 ? (absoluteChange / Math.abs(priorVal)) * 100 : null
    return { absoluteChange, pctChange }
  }
  // A v9 Food Cost % is COGS ÷ revenue and a v8 one purchases ÷ revenue (D30). Across that line the
  // difference is mostly the change of formula, not a change in the kitchen, so the three ratios
  // that contain it get no delta, and the section says why rather than print a move that is not one.
  const sameBasis = foodCostBasisOf(current) === foodCostBasisOf(prior)
  // The same for Net Margin across the v11→v12 line, where it started subtracting Tax & Fees, and
  // across v17→v18, where it started subtracting wastage, staff meals and delivery commission (S849).
  const sameTaxFees = netMarginTaxFeesOf(current) === netMarginTaxFeesOf(prior)
  const samePnlCosts = netMarginPnlCostsOf(current) === netMarginPnlCostsOf(prior)
  const sameNetBasis = sameBasis && sameTaxFees && samePnlCosts
  // And for the three labour-bearing ratios across v12→v13, where labour started taking off unpaid
  // days and counting festival, incentive and settlement pay (S798 3c).
  const sameLabour = labourBasisOf(current) === labourBasisOf(prior)
  return {
    foodCostBasisChanged: !sameBasis,
    netMarginBasisChanged: sameBasis && !sameTaxFees,
    netMarginCostsChanged: sameBasis && sameTaxFees && !samePnlCosts,
    labourBasisChanged: !sameLabour,
    // A material count gap on EITHER side (S849, OWNER-REPORT-12): page 1 withholds the food-cost
    // verdicts for such a month, so Trend shows the change with no better/worse word on Food Cost,
    // Prime Cost and Net Margin.
    verdictWithheld: countGapMaterialOf(current) || countGapMaterialOf(prior),
    revenueTotal: moneyDelta(current.combined?.revenueTotal, prior.combined?.revenueTotal),
    foodCostPct: sameBasis ? pctDelta(current.combined?.foodCostPct, prior.combined?.foodCostPct) : null,
    laborCostPct: sameLabour ? pctDelta(current.combined?.laborCostPct, prior.combined?.laborCostPct) : null,
    primeCostPct: sameBasis && sameLabour ? pctDelta(current.combined?.primeCostPct, prior.combined?.primeCostPct) : null,
    netMarginPct: sameNetBasis && sameLabour ? pctDelta(current.combined?.netMarginPct, prior.combined?.netMarginPct) : null,
    posNetSales: moneyDelta(current.pos?.totalNetSales, prior.pos?.totalNetSales),
    otHours: moneyDelta(current.hr?.payroll?.ot?.hours, prior.hr?.payroll?.ot?.hours),
    otAmount: moneyDelta(current.hr?.payroll?.ot?.amount, prior.hr?.payroll?.ot?.amount),
  }
}

// What a Trend entry keeps of the prior snapshot it compares against (S792 stage 3). It used to
// store the WHOLE prior snapshot — that month's own trend included, which held ITS two priors whole,
// and so on — so each month's row carried nested copies of every month before it and grew month on
// month. The report page and the workbook read only these fields of `t.snapshot`;
// the deltas are computed from the full prior before it is trimmed. A row stored before v10 keeps
// its nested copy and renders as before, since every reader optional-chains the same fields.
export function trendSnapshotOf(snapshot) {
  if (!snapshot) return null
  const c = snapshot.combined || {}
  const failed = Object.keys(snapshot.sectionErrors || {})
  return {
    schemaVersion: snapshot.schemaVersion ?? null,
    // Since v18 (S849, OWNER-REPORT-12 / -2): whether the prior's closing count was materially
    // incomplete (its food-cost verdicts were withheld), and which of its sections failed, so Trend
    // can say why a ratio is not judged or not compared.
    countGapMaterial: countGapMaterialOf(snapshot),
    sectionErrors: failed.length > 0 ? failed : null,
    combined: {
      revenueTotal: c.revenueTotal ?? null,
      foodCostPct: c.foodCostPct ?? null,
      laborCostPct: c.laborCostPct ?? null,
      primeCostPct: c.primeCostPct ?? null,
      netMarginPct: c.netMarginPct ?? null,
      // Absent before v9 on purpose: its absence is what says "on purchases" (foodCostBasisOf).
      ...(c.foodCostBasis ? { foodCostBasis: c.foodCostBasis } : {}),
      // Absent before v12 on purpose: its absence says Net Margin left Tax & Fees out.
      ...(c.netMarginTaxFees ? { netMarginTaxFees: true } : {}),
      // Absent before v13 on purpose: its absence says labour was gross + OT + SSF (labourBasisOf).
      ...(c.labourBasis ? { labourBasis: c.labourBasis } : {}),
      // Absent before v18 on purpose: its absence says Net Margin left wastage, staff meals and
      // delivery commission out (netMarginPnlCostsOf).
      ...(c.netMarginPnlCosts ? { netMarginPnlCosts: true } : {}),
    },
    pos: snapshot.pos ? { totalNetSales: snapshot.pos.totalNetSales ?? null } : null,
  }
}

async function computeTrendSection(clientId, period, currentPartial) {
  const lastMonth = period.bs_month === 1 ? { y: period.bs_year - 1, m: 12 } : { y: period.bs_year, m: period.bs_month - 1 }
  const lastYear = { y: period.bs_year - 1, m: period.bs_month }

  const [last, sameMonthLastYear] = await Promise.all([
    lookupPriorSnapshot(clientId, lastMonth.y, lastMonth.m),
    lookupPriorSnapshot(clientId, lastYear.y, lastYear.m),
  ])

  const entry = prior => ({ ...prior, snapshot: trendSnapshotOf(prior.snapshot), deltas: buildDeltas(currentPartial, prior.snapshot) })
  return {
    vsLastPeriod: entry(last),
    vsSameMonthLastYear: entry(sameMonthLastYear),
  }
}

// Orchestrates the three section computations + combined metrics. `modulesIncluded` is resolved
// by the caller (generateMonthlyReport.js) from the client's actual module subscription, not
// guessed here.
// Current shape version — bump whenever a new top-level snapshot field is added. Never branched
// on anywhere (no migration/upgrade system exists) — reads just optional-chain defensively, same
// as every existing render site already does for a module that was never enabled.
// 3: no shape change, but theoretical usage (and the reorder shortfall derived from it) now
// includes comped covers, where v1/v2 snapshots excluded them. Bumped anyway because the Trend
// section compares this period against already-frozen prior snapshots — a v2 row and a v3 row are
// not computed the same way, and the version is the only trace of that a reader will ever have.
// 4 (S696): no shape change; `ims.reorder` now comes from the shared `buildStockRows` — wastage
// and staff meals deducted, sales deduplicated through the POS-supersedes-manual rule, "below
// par" strictly below — where v3 kept a local copy that did none of those. Same reasoning as v3.
// 5 (S715): `menuEngineering` classifies through the shared `shared/menuEngineering.js` rather
// than a local copy of it, and two inputs changed with the move — a dish with no selling price or
// no costed ingredients is no longer given a food cost of 0% (it was passing the ≤35% test and
// freezing into the snapshot as a Star), and a dish that sold nothing is no longer "high
// popularity" when the period's median is 0. `quadrantCounts` gains an `Unrated` key and
// `items[].quadrant` can be null. A v4 matrix and a v5 matrix are not computed the same way.
// 6: no shape change; two figures changed meaning. `ims.purchaseTotal` (with cashNet/creditNet
// and everything computed from purchaseTotal — combined.foodCostPct, primeCostPct, netMarginPct
// and inventoryDepth's turnover) is now NET of supplier bill discounts, allocated per bill through
// allocateBillDiscounts(), where v1–v5 summed a raw qty × rate and so ran HIGH by every discount
// against Consolidated P&L / Monthly Summary for the same month. And the ESTIMATED payroll branch
// (`hr.payrollSource === 'estimated'`) adds employer SSF only for staff who are enrolled AND have
// an SSF number (isSsfContributor, payroll's own gate), where v1–v5 used the flag alone; the
// finalized branch was always right, since it sums stored payslips. Snapshots already generated
// stay frozen — a v5 row and a v6 row are not computed the same way, and a Trend delta across
// that boundary includes the change of basis.
// 7 (S756, D20): `inventoryDepth.deadSlowStock` classifies through the shared
// `ims/stockcount/deadStockCalc.js`, the rule the live Dead Stock page uses. v1–v6 called an item
// Dead after ONE month with no use; v7 calls it Dead only after 3 consecutive counted months with
// no use (1–2 still months, or under 20% used, is Slow), reading up to 12 periods ending at the
// report's own. An uncounted month, a count above what was available, no stock or a calendar gap
// breaks the streak; staff meals count as use; sub-recipe mirrors are excluded, as on the page.
// The section gains `rule: 'streak'`, `deadAfterMonths`, `historyMonths`, the S717 counts
// (`assessedCount`/`uncountedCount`/`inconsistentCount`), and per item `stillMonths`/`atLeast`/
// `suggestion`/`lastBought`/`supplier`. A v6 dead-stock count and a v7 one are not the same
// measurement — the v7 count is lower by every item that was still for only one or two months.
// v7 also changes the VENDOR section (same S756 release, one bump for both): returns are credited at
// their bill's discounted rate — including returns against an earlier month's bill — rather than list
// price, returns carry their own payment_method in the cash/credit split (every return had read as
// Cash), and the returns read is paged. A v6 and a v7 vendor section for one month can differ.
// 8 (S758, Crest Customization): no shape change; theoretical usage — and so the reorder figure,
// item variance and shrinkage trend — now adds each customized plate's option stock lines
// (sales_entries.ingredient_deltas: "+30 g cheese", "−5 pcs momo" for a Half). NULL on every sale
// without options, so a month with no customized plates computes exactly as v7 did; a month with
// them does not, and the version is the only trace of that.
// 9 (S792 stage 2): several figures changed meaning at once; one bump for all of them.
//   - D30 / FIGURES-3: `combined.foodCostPct` is COGS ÷ revenue (food USED: opening + net purchases
//     − wastage − staff meals − closing, Monthly Summary's arithmetic over every non-sub-recipe
//     item with a row, hidden or not, D29), where v1–v8 froze net purchases ÷ revenue. Prime Cost %
//     and Net Margin % follow it. New fields: `combined.foodCostBasis: 'cogs'`, `ims.foodCostBasis`,
//     `ims.cogsTotal`, `ims.staffMealsValueTotal`, and `ims.countGap` (items with stock and no
//     closing count; the verdict is withheld while it is material, D6). Trend gives no Food Cost /
//     Prime / Net Margin delta across the v8→v9 line (`deltas.foodCostBasisChanged`).
//   - FIGURES-8: revenue keeps legacy NULL-source sales rows (comps filtered in JS, not by `.neq`),
//     so it can only rise against a v8 figure for a month holding such rows; Menu Engineering's qty
//     and revenue likewise.
//   - FIGURES-2 / SALES-3: `inventoryDepth.variance` and `.shrinkageTrend` are the live pages'
//     arithmetic — paged reads, an uncounted item not judged, the client's tolerance and the NPR
//     floor (frozen as `tolerancePct`/`floorValue`), credit notes and superseded manual days out of
//     theoretical usage, staff meals in actual usage, D17 no-recipe items and D36 no-sales items.
//     Variance drops the quantity totals (kg + L) and stores only the flagged rows, with counts of
//     what was not judged; `variancePct` is null for a no-sales row.
//   - PLANNING-4: `deadSlowStock` treats staff meals as movement (`movement: 'staff_meals_count'`,
//     per-item `staffMeals`) — staff rice is no longer Dead.
//   - RECIPES-1: while Crest Customization is on, build-your-own dishes are Not rated in
//     `menuEngineering` (`quadrant: null`, `byo: true`, `byoCount`, `byoItems`) — the live menu
//     reports' `isCostedByBuild` rule — not quadranted on their bowl-and-spoon cost.
//   - TAX-7: `vendorPurchasing` names a deactivated or archived supplier instead of "Unknown Vendor".
// 10 (S792 stage 3): `ims.wastageValueTotal` changed meaning. v1–v9 valued wastage over ACTIVE
// items only (prep included); v10 values it over every item — hidden ones too (D29) — through the
// one definition every Wastage tile and the Wastage Report share (periodCost.js
// `periodWastageValue`, FIGURES-5). A v10 figure can only be higher, by a hidden item's wastage.
// The report page reads the version to say which set its Wastage tip describes. Two changes ride
// along that no reader needs to tell apart: `trend.*.snapshot` stores only the fields the Trend
// section reads (`trendSnapshotOf`), not the whole prior snapshot with its own nested trend; and
// the recipes reads behind the IMS, Menu Engineering, Variance and Shrinkage sections are paged.
// 11 (S792 stage 4, owner decision D32): on a PAN-bill outlet (not VAT-registered) the 13% VAT on a
// VAT-ticked line of a bill saved with `purchase_entries.vat_is_cost` is FOOD COST — it cannot be
// claimed back. `ims.purchaseTotal`, the Cash/Credit split, COGS (and so Food Cost %, Prime Cost %,
// Net Margin %) and `vendorPurchasing`'s gross/discount/returned/net take lineCost (lineNet × 1.13 on
// those lines; a return at its line's basis). A VAT-registered outlet's figures are unchanged; a
// PAN outlet's v11 figure is higher than a v10 one by the VAT on its vat_is_cost bills. The flag is
// per bill, set at save; only the open month was backfilled (Q1 a), so closed months and frozen
// reports keep the ex-VAT basis they were made on.
// 12 (S798 stage 2e): labour and overheads.
//   - LABOUR-FIGURES-4: `combined.netMarginPct` also subtracts Tax & Fees (`ims.taxFeesTotal`, new),
//     and `ims.overheadTotal` counts Overheads rows with no bucket; both were left out by S384's
//     `.eq('bucket','overhead')`. A v12 Net Margin is lower than a v11 one by that month's Tax & Fees.
//     `combined.netMarginTaxFees: true` marks it; Trend gives no Net Margin delta across the line
//     (`deltas.netMarginBasisChanged`).
//   - LABOUR-FIGURES-5: the payroll estimate and headcount read stored dates as local dates, so a
//     leaver whose last day is the month's last day is in the estimate and counted as a termination,
//     and a joiner accrues from their first day. An estimated v12 payroll can be higher.
//   - LABOUR-FIGURES-6: Leave taken reads approved requests overlapping the month, paged; a v11
//     section could be short once the client passed ~1,000 leave requests.
//   - LABOUR-FIGURES-7 (H31): `laborAnalytics` gains `workingDays` and `workingDaysWithoutHours`, and
//     `hoursWithheld` with Schedule Variance and Sales per Labour Hour null when more than half the
//     working days carry no clock times.
// 13 (S798 stage 3c): labour.
//   - LABOUR-FIGURES-3 (H19 (A)): a finalized run's labour is gross − absence deduction + overtime +
//     employer SSF, the payroll sheet's Cost to business. `hr.payroll.absenceDeduction` is new (null
//     on an estimate). A v13 labour is lower than a v12 one by the month's unpaid days and the days
//     before joiners started.
//   - LABOUR-FIGURES-1 (H18 (A)): `hr.payroll.other` = { festival, festivalName, incentive,
//     settlement, settlementCount, total }, the month's finalized festival allowance, incentives and
//     Final Settlements (by settle month, gratuity included), added to `hr.payroll.total` on both
//     the finalized and the estimated path.
//   - `combined.labourBasis: 'earned'` marks both; Trend gives no Labor / Prime / Net Margin delta
//     across the line (`deltas.labourBasisChanged`).
// 14 (S798 stage 4b): LABOUR-FIGURES-8. The ESTIMATED payroll's employer SSF is on basic only, the
//   way payroll charges it: min(basic × days employed ÷ month days, SSF cap) for monthly staff
//   (`estimatedEmployerSsf`, labourSource.js, shared with the Owner Dashboard). v13 charged it on
//   basic + allowances, so an estimated v14 labour is lower by 20% of the SSF staff's allowances.
//   A finalized-run labour is unchanged. No Trend marker: an estimate corrected, as at v12.
// 15 (S809 3m): the Crest POS section.
//   - IMS-HANDOFF-4: credit notes follow the Sales Report's rule (salesReportMath.js, S754). Every
//     paid bill closed in the month counts at full value, a credit-noted one included, and every
//     credit note ISSUED in the month is a minus at its own stored figures, whichever month its bill
//     was in (`pos.creditNotes` = { count, net }, new; `net` is negative). v1–v14 dropped a credited
//     bill from its month and never subtracted the note, so a bill credited in a later month was in
//     neither month's Net Sales, and a credited bill was missing from the bill count, covers, average
//     check, payment mix and category quantities. A month whose notes all credit its own bills has
//     the same Net Sales either way, give or take rounding; its bill count is higher.
//   - With it, Sales Report's other two rules: each bill is valued as it was issued
//     (`billVatRegistered`, S809 2c) where v14 used today's VAT flag, and a Split bill is spread over
//     its payment legs (a blank method is "Not recorded") where v14 kept 'Split' whole and called a
//     blank method Cash. Comped Bills now include a comp on a bill that was later credited.
//   - Covers are guests SEATED at tables (coversMath.seatedCovers; owner decision 2026-10-10), and
//     Avg Check / Cover is dine-in Net Sales, after the notes on dine-in bills, ÷ those guests: the
//     Covers Report's Revenue per cover. v1–v14 added every bill's covers, a takeaway's default 1
//     included, and divided ALL Net Sales by them. `pos.covers.basis: 'seated'` marks it, with
//     `dineInBills` and `takeawayBills`; the report page and the workbook say so on an older report.
//   - The month runs on Nepal's day edges (bsDayBoundaryIso), not the generating device's clock zone.
//   No Trend marker: POS Net Sales differs across the line only by a note that credits another
//   month's bill.
// 16 (S814 4d, REPORTS-7, owner decision D1): the Crest POS section's Comped Bills potential value is
//   menu price BEFORE VAT (salesReportMath.forgoneMenuValue), one basis with Sales Exceptions, the
//   Sales Report's Comped Bills tab and the shift Z-report's Voided Value. v15 added each comped
//   line's VAT, so a VAT-registered outlet's v16 figure is lower by 13% of its taxable comped lines.
//   `pos.compedBillsTotal.basis: 'ex_vat'` marks it; the page and the workbook label an older
//   report's figure "incl. VAT". Food cost and the voids figure are unchanged (voids were already
//   ex-VAT). No Trend marker: Trend does not compare comps.
// 17 (S836): a part bill (pos_orders.part_of_order_id, split off a table's open bill so one guest
//   could pay for their own dishes) is DINE-IN, though it has no table of its own (coversMath.isDineIn).
//   Its guests are in `pos.covers.totalCovers`, it is one of `dineInBills` and not of
//   `takeawayBills`, and its sales are in Avg Check / Cover. v16 read no `part_of_order_id`, so a
//   part bill there was a takeaway and its guests went uncounted. A month before S836 has no part
//   bills and the same figures either way. No Trend marker: Trend compares POS Net Sales only, which
//   a part bill does not move.
// 18 (S849): several figures changed meaning at once; one bump for all of them.
//   - GAPS-1 (SU23) / PNL-1 (SU3 a): Net Margin also subtracts raw stock wasted (`ims.cogsWastageTotal`,
//     COGS's wastage term), staff meals and delivery-partner commission (top-level `deliveryCommission`
//     = { amount, unsettledBills, basis: 'sold_month' }, bills SOLD in the month, read only with Crest
//     POS in the report): the costs Consolidated P&L takes off. A v18 Net Margin is lower than a v17
//     one by them. `combined.netMarginPnlCosts: true` marks it; Trend gives no Net Margin delta across
//     the line (`deltas.netMarginCostsChanged`). A failed commission read is a named section error
//     and Net Margin is null.
//   - GAPS-4 (SU11 a) / OWNER-REPORT-9 (SU18): labour by the ONE rule every Suite page uses
//     (resolveOutletLabour), frozen as `combined.labour` = { source, amount, laborTabNotCounted,
//     reason, noPayCount }. With Crest HR: the finalized run, else the shared HR estimate
//     (estimateLabour: payroll's roster, unpaid days on the attendance sheet, daily/hourly pay by
//     attendance, sheet overtime) — v17's own estimate read no attendance; the Overheads Labor tab is
//     named, never added. Without Crest HR: the Labor tab is the labour, "from Overheads"
//     (`ims.laborTabTotal`), where v17 froze no labour and no Net Margin at all. No Trend marker: a
//     v17 no-HR report had no labour, so its delta is null already; the HR estimate was corrected,
//     as at v12/v14.
//   - OWNER-REPORT-5: the Food Cost thresholds are frozen (`ims.fcThresholds`, `combined.fcThresholds`).
//   - OWNER-REPORT-7: Staff Employed is decided by join and End Dates (employmentInMonth), not by
//     today's status: `hr.headcount` = { employed, newHires, terminations, noEndDate, basis: 'dates' }
//     where v17 had `active`. A report made after staff left counts them in the months they worked.
//   - OWNER-REPORT-8: Unpaid Credit is what is still owed per BILL (VAT, discount and returns in, the
//     Outstanding Payables arithmetic), `ims.payables.basis: 'owed'`, `unpaidCount` counts bills; the
//     vendor section's bill aging the same (`billAging.basis: 'owed'`).
//   - OWNER-REPORT-13: Attendance Rate is over working days (weekly offs and holidays left out),
//     `hr.attendance.basis: 'working_days'`, `workingDays`.
//   - OWNER-REPORT-14: a leave crossing a month edge counts only its days inside the month,
//     `hr.leaveBasis: 'in_month'`.
//   - OWNER-REPORT-15: Inventory Turnover is COGS ÷ the average stock of the items COGS counts
//     (`ims.cogsOpeningValue` / `cogsClosingValue`, `inventoryDepth.turnover.basis: 'cogs'`).
//   - OWNER-REPORT-12 / -2: a Trend entry keeps the prior's `countGapMaterial` and failed `sectionErrors`
//     keys; `deltas.verdictWithheld` when either side's count gap is material.
//   - PNL-8: stock transfers between outlets fold into Net Purchases, COGS, on-hand and the count gap
//     (`ims.transferIn` / `transferOut`); in the Inventory Depth sub-sections as well. A month with no
//     transfers computes as before.
export const CURRENT_SCHEMA_VERSION = 18

// Runs one section's computation without letting its failure take down the rest of the report —
// a huge menu timing out Menu Engineering, or one malformed row in a new formula, must not mean
// NO report gets written for the period (that used to be the failure mode: computeMonthlyReport
// awaited a flat Promise.all, so any single section throwing rejected everything). Returns
// `null` + records the error string on failure; the report page shows a "couldn't be generated"
// note for that section instead of pretending the client just has zero data there.
async function runSection(key, fn, errors) {
  try {
    return await fn()
  } catch (e) {
    console.error(`computeMonthlyReport: section "${key}" failed:`, e)
    errors[key] = e.message || String(e)
    return null
  }
}

// Delivery-partner commission on the bills SOLD in the month (S849, PNL-1), the P&L's own helper and
// month window, so the two agree to the paisa. A failed read THROWS, so it is a named section error
// and Net Margin is null — a margin without it would be the P&L's figure plus the commission.
async function computeDeliveryCommissionSection(clientId, period) {
  const { startIso, endIso } = bsMonthWindow(period.bs_year, period.bs_month)
  const db = { scopedFrom: (t, c) => scopedFrom(t, clientId, c) }
  const { amount, unsettledBills, error } = await loadDeliveryCommission(db, { startIso, endIso })
  if (error) throw new Error(error.message || 'Delivery commission could not be read')
  return { amount, unsettledBills, basis: 'sold_month' }
}

export async function computeMonthlyReport({ clientId, period, modulesIncluded }) {
  if (!period || period.status !== 'closed') {
    throw new Error('Monthly owner reports are only generated for closed periods')
  }
  const sectionErrors = {}
  let hrLabour = null
  // Commission is read only with Crest POS in the report, as the P&L reads it only for a POS client:
  // an outlet without the till has no delivery bills (its commission is 0, with no read).
  const commissionIncluded = !!(modulesIncluded.ims && modulesIncluded.pos)
  const [ims, hr, pos, deliveryCommission] = await Promise.all([
    modulesIncluded.ims ? runSection('ims', () => computeImsSection(clientId, period), sectionErrors) : null,
    modulesIncluded.hr  ? runSection('hr', async () => {
      const r = await computeHrSection(clientId, period)
      hrLabour = r.labourInput
      return r.section
    }, sectionErrors) : null,
    modulesIncluded.pos ? runSection('pos', () => computePosSection(clientId, period), sectionErrors) : null,
    commissionIncluded ? runSection('deliveryCommission', () => computeDeliveryCommissionSection(clientId, period), sectionErrors) : null,
  ])
  const labour = resolveReportLabour({ hrIncluded: !!modulesIncluded.hr, hrLabour: hr ? hrLabour : null, ims })
  const combined = computeCombinedMetrics({
    ims, hr, labour, deliveryCommission,
    commissionFailed: commissionIncluded && !deliveryCommission,
  })

  const generatedAt = new Date()
  const [trend, menuEngineering, laborAnalytics, vendorPurchasing, inventoryDepth] = await Promise.all([
    runSection('trend', () => computeTrendSection(clientId, period, { ims, hr, pos, combined }), sectionErrors),
    modulesIncluded.ims ? runSection('menuEngineering', () => computeMenuEngineeringSection(clientId, period), sectionErrors) : null,
    modulesIncluded.hr  ? runSection('laborAnalytics', () => computeLaborAnalyticsSection(clientId, period, { hr, ims }), sectionErrors) : null,
    modulesIncluded.ims ? runSection('vendorPurchasing', () => computeVendorPurchasingSection(clientId, period, generatedAt), sectionErrors) : null,
    modulesIncluded.ims ? runSection('inventoryDepth', () => computeInventoryDepthSection(clientId, period, { ims }), sectionErrors) : null,
  ])

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    period: { id: period.id, bs_year: period.bs_year, bs_month: period.bs_month },
    modulesIncluded,
    ims, hr, pos, trend, menuEngineering, laborAnalytics, vendorPurchasing, inventoryDepth,
    deliveryCommission,
    combined,
    sectionErrors: Object.keys(sectionErrors).length > 0 ? sectionErrors : null,
  }
}
