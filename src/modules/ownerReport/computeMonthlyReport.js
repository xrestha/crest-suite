// Pure(ish) computation for the Monthly Owner/Manager Report — no React. Reuses the exact
// formulas OwnerDashboard.jsx (IMS/HR figures), SalesReport.jsx (POS figures), and
// payrollCompute.js already established, parameterized by an arbitrary CLOSED period instead of
// always "the currently open one." See CLAUDE.md's Monthly Owner/Manager Report section.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { throwFirstError } from '../../shared/queryError'
import { bsToAd, daysInBsMonth } from '../../utils/bsCalendar'
import { calcAmount, hourlyRateOf, tallyAttendance, isSsfContributor } from '../hr/payroll/payrollCompute'
import { SSF_CAP, SSF_EMPLOYER_PCT, OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY } from '../hr/payrollConstants'
import { explodeRecipeIngredients, computeRecipeCosts } from '../../utils/recipeCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { buildStockRows, summarizeReorder } from '../ims/stockcount/stockReportCalc'
import { allocateBillDiscounts } from '../ims/reports/supplierAttribution'
import { periodRevenue, periodStockMaps, valuePeriodItems } from '../ims/reports/periodCost'
import { findUncountedItems, UNCOUNTED_NAME_LIMIT } from '../../shared/uncountedItems'
import { computeOrderAmounts, computeCategoryAmounts } from '../../utils/posBillingMath'
import { computeMenuEngineeringSection } from './computeMenuEngineeringSection'
import { computeLaborAnalyticsSection } from './computeLaborAnalyticsSection'
import { computeVendorPurchasingSection } from './computeVendorPurchasingSection'
import { computeInventoryDepthSection } from './computeInventoryDepthSection'

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
// Single-period input only: the fallback bill key carries no period.
export function netPurchaseFigures(purchases, returns) {
  const allocated = allocateBillDiscounts(purchases || [])
  const returnTotal = (returns || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
  let cashNet = 0, creditNet = 0
  allocated.forEach(p => {
    if (p.payment_method === 'Credit') creditNet += p.lineNet; else cashNet += p.lineNet
  })
  cashNet -= returnTotal
  const purchaseTotal = allocated.reduce((s, p) => s + p.lineNet, 0) - returnTotal
  return { purchaseTotal, cashNet, creditNet }
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
    fetchAllRows(() => supabase.from('purchase_entries').select('id, item_id, qty, rate, payment_method, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day').eq('period_id', period.id).order('id')),
    // Paged with a unique tiebreaker, like every per-item-per-period read below (S756). Six reads
    // in this batch were bare while purchase_entries/wastages/sales_entries beside them were paged,
    // so past PostgREST's silent 1000-row cap the FROZEN snapshot lost returns, items, pars and
    // stock rows with no error for throwFirstError to see — and nothing ever recomputes it. A
    // missing items row values its stock at rate 0; a missing closing row reads as a zero count.
    fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', period.id).order('id')),
    // ONE sales read answers both questions, because the comp filter runs in JS. REVENUE excludes
    // comps (a comped dish collected nothing; periodRevenue drops them), CONSUMPTION includes them
    // (its ingredients were still used). Until S792 revenue had its own read with a server-side
    // `.neq('source', 'pos_comp')` — and `source` is nullable, so `NULL <> 'pos_comp'` dropped every
    // legacy row: a Regenerate Snapshot froze a revenue LOWER than Monthly Summary's, the
    // denominator of Food Cost %, Labour %, Prime % and Net Margin % (FIGURES-8, ims-figures.md
    // S699). bs_day + source also feed the shared depletion rule in buildStockRows (S696), and
    // ingredient_deltas a customized plate's option stock lines (S758).
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, bs_day, source, ingredient_deltas').eq('period_id', period.id).order('id')),
    scopedFrom('recipes', clientId, 'id, selling_price'),
    supabase.from('overheads').select('amount').eq('period_id', period.id).eq('bucket', 'overhead'),
    fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', period.id).order('id')),
    // EVERY item, active or not, since S792: the two uses below want different sets.
    //   - Opening/Closing Stock and Wastage Value keep the active-only set, which matches Stock.js's
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
  ])
  // A failed read must THROW so runSection() records it as a section error the page names —
  // otherwise it flows through `|| []` and freezes zeros into the immutable snapshot (S612).
  throwFirstError(results)
  const [
    { data: purchases }, { data: returns }, { data: salesData }, { data: recipes },
    { data: overheadsData }, { data: wastagesData }, { data: allItems }, { data: parLevels },
    { data: opening }, { data: closing }, { data: payablePayments }, { data: staffMealsData },
  ] = results
  // `is_active === true`, not truthy-ness: the old read was `.eq('is_active', true)`, which a NULL
  // never passed either.
  const items = (allItems || []).filter(i => i.is_active === true)

  // Net of bill discounts since schema v6 — v1–v5 snapshots summed a raw qty × rate here.
  const { purchaseTotal, cashNet, creditNet } = netPurchaseFigures(purchases, returns)

  // Monthly Summary's own revenue arithmetic (periodCost.js): the price charged at the time of sale,
  // net of the row's discount, comps excluded in JS.
  const revenueTotal = periodRevenue(salesData, recipes)

  const overheadTotal = (overheadsData || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)

  const itemRateMap = {}; items.forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
  const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)
  // Same qty × per_uom_rate valuation MonthlySummary.js/Stock.js use for their own Opening/
  // Closing Stock figures — an owner reading this report needs to see what stock the period
  // started and ended with, same as every other IMS report already shows.
  const openingStockValueTotal = (opening || []).reduce((s, o) => s + parseFloat(o.qty || 0) * (itemRateMap[o.item_id] || 0), 0)
  const closingStockValueTotal = (closing || []).reduce((s, c) => s + parseFloat(c.physical_qty || 0) * (itemRateMap[c.item_id] || 0), 0)

  const paidMap = {}
  ;(payablePayments || []).forEach(p => { paidMap[p.purchase_entry_id] = (paidMap[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })
  let payablesUnpaidTotal = 0, payablesUnpaidCount = 0
  ;(purchases || []).forEach(p => {
    if (p.payment_method !== 'Credit') return
    const value = parseFloat(p.qty || 0) * parseFloat(p.rate || 0)
    const remaining = Math.max(0, value - (paidMap[p.id] || 0))
    if (remaining > 0) { payablesUnpaidTotal += remaining; payablesUnpaidCount += 1 }
  })

  const recipeIds = (recipes || []).map(r => r.id)
  // Both walks throw on a failed read, so runSection records the IMS section as failed rather
  // than freezing zero usage; the delta walk adds customized plates' option stock lines (S758).
  const [ingredientBreakdown, deltaExplosion] = await Promise.all([
    recipeIds.length > 0 ? explodeRecipeIngredients(supabase, recipeIds) : {},
    loadDeltaExplosion(supabase, (salesData || []).map(s => s.ingredient_deltas)),
  ])
  // Every sales row, comps included — comps consumed ingredients even though they earned nothing.
  // The on-hand / below-par figures come from the ONE calculation the live Reorder Report and
  // both dashboards use (S696, schema v4); v3 snapshots carried this section's own copy, which
  // deducted neither wastage nor staff meals and summed sales raw. Active, non-sub-recipe items:
  // "on the shelf at close" is a question about the items still in use.
  const stockRows = buildStockRows({
    items: items.filter(i => !i.is_sub_recipe),
    opening, closing, purchases, returns, wastages: wastagesData, staffMeals: staffMealsData,
    sales: salesData, breakdown: ingredientBreakdown, pars: parLevels, explosion: deltaExplosion,
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
  const stockMaps = periodStockMaps({ opening, closing, purchases, returns, wastages: wastagesData, staffMeals: staffMealsData })
  const cogs = valuePeriodItems(cogsItems, stockMaps)
  const cogsTotal = cogs.cogsVal
  const foodCostPct = revenueTotal > 0 ? (cogsTotal / revenueTotal) * 100 : null

  // The count COGS rests on (S756, D6): an item with stock and NO closing count is counted as all
  // used. The totals stand — they must tie to Monthly Summary — but the gap is frozen with them,
  // and while it is material the report withholds the food-cost verdict, as Monthly Summary does.
  // Counted = a row whose physical_qty is not null; a count of 0 is a count (S695).
  const countedIds = new Set((closing || []).filter(r => r.physical_qty != null).map(r => r.item_id))
  const purchaseQty = {}; const purchaseValue = {}
  Object.entries(stockMaps.purchases).forEach(([id, v]) => { purchaseQty[id] = v.qty; purchaseValue[id] = v.value })
  const gap = findUncountedItems({ items: cogsItems, openingQty: stockMaps.opening, purchaseQty, purchaseValue, countedIds, cogs: cogsTotal })

  return {
    revenueTotal, purchaseTotal, overheadTotal, wastageValueTotal, openingStockValueTotal, closingStockValueTotal, cashNet, creditNet, foodCostPct,
    // New in schema v9 (D30). Absent on an older snapshot, whose foodCostPct is purchases ÷ revenue.
    foodCostBasis: 'cogs', cogsTotal, staffMealsValueTotal: cogs.staffMealsVal,
    countGap: {
      presentCount: gap.presentCount, uncountedCount: gap.uncountedCount, uncountedValue: gap.uncountedValue,
      material: gap.material,
      // Names resolved at generation, like everything else in a frozen snapshot (S435).
      names: gap.uncounted.slice(0, UNCOUNTED_NAME_LIMIT).map(u => u.name),
    },
    reorder: { count: reorderCount, estValueTotal: reorderEstValueTotal },
    payables: { unpaidTotal: payablesUnpaidTotal, unpaidCount: payablesUnpaidCount },
  }
}

// ── Payroll estimate (pure) ──────────────────────────────────────────────────
// The fallback used when a closed period has no finalized payroll run: each active/probation
// employee (or one whose end_date falls inside the period) accrues monthly-equivalent gross for
// the days between join and end date, plus employer SSF on the capped base. `employees` must
// carry `ssf_no` as well as `ssf_enrolled` (isSsfContributor needs both).
export function estimatePayrollAccrual({ employees, components, period }) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const periodStartAd = bsToAd(period.bs_year, period.bs_month, 1)
  const periodEndAd   = bsToAd(period.bs_year, period.bs_month, monthDays)
  let accruedGross = 0, accruedSsfEmployer = 0
  ;(employees || []).forEach(emp => {
    const isActiveish = emp.status === 'active' || emp.status === 'probation'
    const endAd = emp.end_date ? new Date(emp.end_date) : null
    const terminatedThisPeriod = !isActiveish && endAd && endAd >= periodStartAd && endAd <= periodEndAd
    if (!isActiveish && !terminatedThisPeriod) return
    const joinAd = emp.join_date ? new Date(emp.join_date) : null
    if (joinAd && joinAd > periodEndAd) return

    const empStart = joinAd && joinAd > periodStartAd ? joinAd : periodStartAd
    const empEnd    = endAd && endAd < periodEndAd ? endAd : periodEndAd
    const daysWorked = Math.max(0, Math.floor((empEnd - empStart) / 86400000) + 1)
    if (daysWorked <= 0) return

    const basic = parseFloat(emp.basic_salary) || 0
    const basis = emp.pay_basis || 'monthly'
    const allowances = basis === 'monthly'
      ? (components || []).filter(c => c.employee_id === emp.id && c.type === 'earning')
          .reduce((s, c) => s + calcAmount(c, basic), 0)
      : 0
    const monthlyEquivGross =
      basis === 'daily'  ? basic * monthDays :
      basis === 'hourly' ? basic * STANDARD_HOURS_PER_DAY * monthDays :
      basic + allowances
    const perDay = monthDays > 0 ? monthlyEquivGross / monthDays : 0
    accruedGross += perDay * daysWorked

    // Employer SSF only for a real contributor — enrolled AND carrying an SSF number — the gate
    // computePayslip applies (isSsfContributor). The flag alone added 20% for staff payroll
    // never contributes for, so an estimated snapshot ran above the finalized run it stands in for.
    if (isSsfContributor(emp)) {
      const ssfBase = Math.min(monthlyEquivGross, SSF_CAP) * (monthDays > 0 ? daysWorked / monthDays : 0)
      accruedSsfEmployer += ssfBase * SSF_EMPLOYER_PCT
    }
  })
  return { gross: accruedGross, ssfEmployer: accruedSsfEmployer }
}

// ── HR section ──────────────────────────────────────────────────────────────
// Starts from OwnerDashboard.jsx's loadLaborCost (already period-parameterized), but returns the
// gross/OT/SSF breakdown instead of only a pre-summed total, and adds headcount/leave/attendance.
// A CLOSED period is by construction fully elapsed, so (unlike Owner Dashboard's live MTD view of
// the still-open period) there is no "days elapsed so far" proration — every employee accrues for
// the whole month, subject to the same join/end-date bounding Owner Dashboard already applies.
async function computeHrSection(clientId, period) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const periodStartAd = bsToAd(period.bs_year, period.bs_month, 1)
  const periodEndAd   = bsToAd(period.bs_year, period.bs_month, monthDays)

  const results = await Promise.all([
    // `ssf_no` is load-bearing: the estimate's employer SSF gates on isSsfContributor().
    scopedFrom('hr_employees', clientId, 'id, status, basic_salary, pay_basis, ssf_enrolled, ssf_no, join_date, end_date'),
    scopedFrom('hr_salary_components', clientId, 'employee_id, type, calc_type, value'),
    scopedFrom('hr_overtime_entries', clientId, 'employee_id, ot_hours, ot_type, status, bs_year, bs_month')
      .eq('status', 'approved').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
    scopedFrom('hr_leave_requests', clientId, 'leave_type_id, status, start_date, end_date, days'),
    // Paged — one row per employee per day, past the 1000-row cap at ~34 staff. This feeds the
    // frozen snapshot's labor figures, so a truncated read would be preserved permanently (S529).
    fetchAllRows(() => scopedFrom('hr_attendance', clientId, 'status, hours_worked, ot_hours').eq('period_id', period.id).order('id')),
    scopedFrom('hr_leave_types', clientId, 'id, name'),
    scopedFrom('hr_payroll_runs', clientId, 'id').eq('period_id', period.id).eq('status', 'finalized').maybeSingle(),
  ])
  throwFirstError(results)
  const [
    { data: employees }, { data: components }, { data: otEntries }, { data: leaveRequests },
    { data: attendanceRows }, { data: leaveTypes }, { data: finalizedRun },
  ] = results
  const leaveTypeNameMap = Object.fromEntries((leaveTypes || []).map(lt => [lt.id, lt.name]))
  const empMap = Object.fromEntries((employees || []).map(e => [e.id, e]))

  // Headcount is a lifecycle fact (who joined/left this period), independent of which payroll
  // figures get used below — always computed from join_date/end_date regardless of source.
  let activeCount = 0, newHiresCount = 0, terminationsCount = 0
  ;(employees || []).forEach(emp => {
    const isActiveish = emp.status === 'active' || emp.status === 'probation'
    const endAd = emp.end_date ? new Date(emp.end_date) : null
    const terminatedThisPeriod = !isActiveish && endAd && endAd >= periodStartAd && endAd <= periodEndAd
    if (!isActiveish && !terminatedThisPeriod) return
    const joinAd = emp.join_date ? new Date(emp.join_date) : null
    if (joinAd && joinAd > periodEndAd) return
    if (isActiveish) activeCount += 1
    if (terminatedThisPeriod) terminationsCount += 1
    if (joinAd && joinAd >= periodStartAd && joinAd <= periodEndAd) newHiresCount += 1
  })

  // ── Payroll figures: prefer the actual finalized payroll run over a re-derived estimate ──
  // A finalized hr_payroll_runs/hr_payslips is the exact, authoritative Nepal-payroll-engine
  // computation (payrollCompute.js — real OT from BOTH attendance and approved claims, real
  // TDS/absence-based deductions) — reusing it is both more accurate and simpler than
  // re-deriving an approximation. Found live: the estimate path below only reads
  // hr_overtime_entries (approved OT *claims*), completely missing attendance-based OT
  // (hr_attendance.ot_hours, tallied inside computePayslip), so a client whose OT comes from
  // daily attendance rather than separate claims saw NPR 0 overtime in the report despite a
  // finalized payroll clearly showing otherwise. Only fall back to the estimate below when this
  // period's payroll was genuinely never finalized (client doesn't use Payroll Run, or hasn't
  // finalized yet) — matches Owner Dashboard's live MTD estimate for the still-open case.
  let payroll, payrollSource
  if (finalizedRun?.id) {
    const payslipRes = await scopedFrom('hr_payslips', clientId, 'gross, ot_hours, ot_amount, ssf_employer')
      .eq('run_id', finalizedRun.id)
    // A finalized run whose payslips cannot be read must fail the section, not freeze a payroll
    // of NPR 0 under payrollSource:'finalized' — the label would vouch for the wrong figure.
    throwFirstError([payslipRes])
    const { data: payslips } = payslipRes
    const gross = (payslips || []).reduce((s, p) => s + (parseFloat(p.gross) || 0), 0)
    const otHours = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_hours) || 0), 0)
    const otAmount = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_amount) || 0), 0)
    const ssfEmployer = (payslips || []).reduce((s, p) => s + (parseFloat(p.ssf_employer) || 0), 0)
    payroll = { gross, ot: { hours: otHours, amount: otAmount }, ssfEmployer, total: gross + otAmount + ssfEmployer }
    payrollSource = 'finalized'
  } else {
    const { gross: accruedGross, ssfEmployer: accruedSsfEmployer } = estimatePayrollAccrual({ employees, components, period })

    let otTotal = 0, otHoursTotal = 0
    ;(otEntries || []).forEach(e => {
      const emp = empMap[e.employee_id]
      if (!emp) return
      const hr = hourlyRateOf(emp.pay_basis || 'monthly', parseFloat(emp.basic_salary) || 0, monthDays)
      const mult = e.ot_type === 'holiday' ? OT_HOLIDAY_MULTIPLIER : OT_MULTIPLIER
      const hours = parseFloat(e.ot_hours) || 0
      otTotal += hours * hr * mult
      otHoursTotal += hours
    })

    payroll = { gross: accruedGross, ot: { hours: otHoursTotal, amount: otTotal }, ssfEmployer: accruedSsfEmployer, total: accruedGross + otTotal + accruedSsfEmployer }
    payrollSource = 'estimated'
  }

  // Leave taken — hr_leave_requests has no period_id, only AD start_date/end_date, so an approved
  // request counts toward this period if its date range overlaps the period at all (a leave
  // spanning a period boundary is credited to every period it touches, not split).
  const leaveByType = {}
  ;(leaveRequests || []).forEach(lr => {
    if (lr.status !== 'approved') return
    const start = new Date(lr.start_date), end = new Date(lr.end_date)
    if (end < periodStartAd || start > periodEndAd) return
    const key = lr.leave_type_id || 'unspecified'
    if (!leaveByType[key]) {
      // Resolved to a name AT GENERATION TIME, same as everything else in a frozen snapshot —
      // if the leave type is later renamed or deleted, this report must keep showing what was
      // true when it was generated, not silently go blank or fall back to the raw id.
      const name = lr.leave_type_id ? (leaveTypeNameMap[lr.leave_type_id] || 'Unknown Leave Type') : 'Unspecified'
      leaveByType[key] = { leaveTypeName: name, days: 0, requestCount: 0 }
    }
    leaveByType[key].days += parseFloat(lr.days) || 0
    leaveByType[key].requestCount += 1
  })

  // Attendance rate — best-effort/nullable; not every client uses the daily Attendance Sheet.
  let attendance = null
  if ((attendanceRows || []).length > 0) {
    const t = tallyAttendance(attendanceRows)
    const totalTrackedDays = attendanceRows.length
    const presentDays = t.present + t.half_day * 0.5 + t.paid_leave + t.half_paid_leave * 0.5
    const absentDays = t.absent + t.unpaid_leave + t.half_unpaid_leave * 0.5
    attendance = {
      presentDays, absentDays, totalTrackedDays,
      rate: totalTrackedDays > 0 ? (presentDays / totalTrackedDays) * 100 : null,
    }
  }

  return {
    payroll, payrollSource,
    headcount: { active: activeCount, newHires: newHiresCount, terminations: terminationsCount },
    leave: Object.values(leaveByType),
    attendance,
  }
}

// ── POS section ─────────────────────────────────────────────────────────────
// pos_orders has no period_id/BS columns — only AD closed_at/opened_at — so the BS period must
// be converted to an AD range first. Filters/exclusions mirror SalesReport.jsx exactly
// (close_type='paid' at fetch time, credit-noted orders excluded from rollups at aggregation
// time, comped items split out) so this section's totals reconcile with that report's own tabs
// for the same range. This is a summary artifact — aggregated rollups only, not a bill ledger.
async function computePosSection(clientId, period) {
  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const fromDate = bsToAd(period.bs_year, period.bs_month, 1)
  const toDate = bsToAd(period.bs_year, period.bs_month, monthDays)
  toDate.setHours(23, 59, 59, 999)
  const fromTs = fromDate.toISOString()
  const toTs = toDate.toISOString()

  const posResults = await Promise.all([
    supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
    scopedFrom('pos_orders', clientId, 'id, discount_amount, closed_at, credit_note_id, payment_method, covers')
      .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs),
  ])
  throwFirstError(posResults)
  const [{ data: settings }, { data: orderData }] = posResults
  const vatReg = settings?.is_vat_registered ?? true
  const orders = (orderData || []).filter(o => !o.credit_note_id)

  const orderIds = orders.map(o => o.id)
  const itemRowsRes = orderIds.length > 0
    // Paged: a month of bill lines runs to thousands. This one is written into a FROZEN snapshot,
    // so a truncated read wouldn't just be wrong once — it would be preserved as the permanent
    // record of that period, with no later recompute to correct it (S529).
    ? await fetchAllRows(() => scopedFrom('pos_order_items', clientId, 'order_id, recipe_id, name, category, qty, unit_price, vat_rate, comped, comp_no').in('order_id', orderIds).order('id'))
    : { data: [] }
  throwFirstError([itemRowsRes])
  const { data: itemRows } = itemRowsRes

  const byOrder = {}
  const compedItems = []
  ;(itemRows || []).forEach(i => {
    if (i.comped) { compedItems.push(i); return }
    ;(byOrder[i.order_id] = byOrder[i.order_id] || []).push(i)
  })

  let totalNetSales = 0, totalGross = 0, totalDiscount = 0, totalVat = 0, totalQty = 0, totalCovers = 0
  const categoryTotals = {}
  const paymentTotals = {}
  orders.forEach(o => {
    const items = byOrder[o.id] || []
    const amounts = computeOrderAmounts(o, items, vatReg)
    totalNetSales += amounts.net; totalGross += amounts.grossAmt; totalDiscount += amounts.discount
    totalVat += amounts.vatAmt; totalQty += amounts.totalQty; totalCovers += parseInt(o.covers || 0, 10)

    const byCat = computeCategoryAmounts(o, items, vatReg)
    Object.entries(byCat).forEach(([cat, v]) => {
      const c = categoryTotals[cat] = categoryTotals[cat] || { category: cat, qty: 0, net: 0 }
      c.qty += v.qty
      c.net += v.gross - v.discount + v.vat
    })

    const method = o.payment_method || 'Cash'
    const p = paymentTotals[method] = paymentTotals[method] || { method, net: 0 }
    p.net += amounts.net
  })
  const paymentMix = Object.values(paymentTotals).map(p => ({ ...p, pctOfNet: totalNetSales > 0 ? (p.net / totalNetSales) * 100 : 0 }))

  let compedCount = 0, compedFoodCost = 0, compedPotentialValue = 0
  if (compedItems.length > 0) {
    const recipeIds = [...new Set(compedItems.map(i => i.recipe_id).filter(Boolean))]
    const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
    const compGroups = new Set()
    compedItems.forEach(i => {
      compGroups.add(`${i.order_id}:${i.comp_no}`)
      compedFoodCost += i.qty * (costMap[i.recipe_id] || 0)
      compedPotentialValue += i.qty * i.unit_price * (1 + (i.vat_rate ?? 0))
    })
    compedCount = compGroups.size
  }

  const voidRowsRes = await scopedFrom('pos_orders', clientId, 'id')
    .in('close_type', ['void', 'writeoff']).gte('closed_at', fromTs).lte('closed_at', toTs)
  throwFirstError([voidRowsRes])
  const voidOrderIds = (voidRowsRes.data || []).map(o => o.id)
  let voidsAmount = 0
  if (voidOrderIds.length > 0) {
    const voidItemsRes = await fetchAllRows(() => scopedFrom('pos_order_items', clientId, 'order_id, qty, unit_price').in('order_id', voidOrderIds).order('id'))
    throwFirstError([voidItemsRes])
    voidsAmount = (voidItemsRes.data || []).reduce((s, i) => s + i.qty * i.unit_price, 0)
  }

  return {
    totalNetSales, totalGross, totalDiscount, totalVat, billCount: orders.length, totalQty,
    categoryBreakdown: Object.values(categoryTotals).sort((a, b) => b.net - a.net),
    paymentMix,
    compedBillsTotal: { count: compedCount, foodCost: compedFoodCost, potentialValue: compedPotentialValue },
    voidsWriteoffsTotal: { count: voidOrderIds.length, amount: voidsAmount },
    covers: {
      totalCovers,
      avgCheckPerCover: totalCovers > 0 ? totalNetSales / totalCovers : null,
      avgBillValue: orders.length > 0 ? totalNetSales / orders.length : null,
    },
  }
}

// Prime Cost % / True Net Margin %. Always computed when inputs exist; True Net Margin's *display*
// is gated behind hasFeature('overheads') by the report page, not here (mirrors Owner Dashboard's
// own canOverheads pattern).
//
// Since schema v9 (S792, D30) the food cost in all three is COGS — what was used — because the
// report is always of a closed month. Net margin takes COGS too: revenue − food cost − labour −
// overheads only adds up to 100% with Food Cost % beside it if both mean the same food cost, and
// Consolidated P&L's Net Profit subtracts COGS for the same month. `foodCostBasis` names the basis
// so a reader, and the Trend section comparing against older snapshots, can tell.
export function computeCombinedMetrics({ ims, hr }) {
  if (!ims) return { revenueTotal: null, foodCostPct: null, laborCostPct: null, primeCostPct: null, netMarginPct: null }
  const revenueTotal = ims.revenueTotal || 0
  const foodCostPct = ims.foodCostPct
  const laborCostPct = hr && revenueTotal > 0 ? (hr.payroll.total / revenueTotal) * 100 : null
  const primeCostPct = foodCostPct != null && laborCostPct != null ? foodCostPct + laborCostPct : null
  const netMarginPct = hr && revenueTotal > 0
    ? ((revenueTotal - ims.cogsTotal - hr.payroll.total - ims.overheadTotal) / revenueTotal) * 100
    : null
  return { revenueTotal, foodCostPct, laborCostPct, primeCostPct, netMarginPct, foodCostBasis: ims.foodCostBasis }
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
  return {
    foodCostBasisChanged: !sameBasis,
    revenueTotal: moneyDelta(current.combined?.revenueTotal, prior.combined?.revenueTotal),
    foodCostPct: sameBasis ? pctDelta(current.combined?.foodCostPct, prior.combined?.foodCostPct) : null,
    laborCostPct: pctDelta(current.combined?.laborCostPct, prior.combined?.laborCostPct),
    primeCostPct: sameBasis ? pctDelta(current.combined?.primeCostPct, prior.combined?.primeCostPct) : null,
    netMarginPct: sameBasis ? pctDelta(current.combined?.netMarginPct, prior.combined?.netMarginPct) : null,
    posNetSales: moneyDelta(current.pos?.totalNetSales, prior.pos?.totalNetSales),
    otHours: moneyDelta(current.hr?.payroll?.ot?.hours, prior.hr?.payroll?.ot?.hours),
    otAmount: moneyDelta(current.hr?.payroll?.ot?.amount, prior.hr?.payroll?.ot?.amount),
  }
}

async function computeTrendSection(clientId, period, currentPartial) {
  const lastMonth = period.bs_month === 1 ? { y: period.bs_year - 1, m: 12 } : { y: period.bs_year, m: period.bs_month - 1 }
  const lastYear = { y: period.bs_year - 1, m: period.bs_month }

  const [last, sameMonthLastYear] = await Promise.all([
    lookupPriorSnapshot(clientId, lastMonth.y, lastMonth.m),
    lookupPriorSnapshot(clientId, lastYear.y, lastYear.m),
  ])

  return {
    vsLastPeriod: { ...last, deltas: buildDeltas(currentPartial, last.snapshot) },
    vsSameMonthLastYear: { ...sameMonthLastYear, deltas: buildDeltas(currentPartial, sameMonthLastYear.snapshot) },
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
export const CURRENT_SCHEMA_VERSION = 9

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

export async function computeMonthlyReport({ clientId, period, modulesIncluded }) {
  if (!period || period.status !== 'closed') {
    throw new Error('Monthly owner reports are only generated for closed periods')
  }
  const sectionErrors = {}
  const [ims, hr, pos] = await Promise.all([
    modulesIncluded.ims ? runSection('ims', () => computeImsSection(clientId, period), sectionErrors) : null,
    modulesIncluded.hr  ? runSection('hr',  () => computeHrSection(clientId, period),  sectionErrors) : null,
    modulesIncluded.pos ? runSection('pos', () => computePosSection(clientId, period), sectionErrors) : null,
  ])
  const combined = computeCombinedMetrics({ ims, hr })

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
    combined,
    sectionErrors: Object.keys(sectionErrors).length > 0 ? sectionErrors : null,
  }
}
