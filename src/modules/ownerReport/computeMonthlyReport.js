// Pure(ish) computation for the Monthly Owner/Manager Report — no React. Reuses the exact
// formulas OwnerDashboard.jsx (IMS/HR figures), SalesReport.jsx (POS figures), and
// payrollCompute.js already established, parameterized by an arbitrary CLOSED period instead of
// always "the currently open one." See CLAUDE.md's Monthly Owner/Manager Report section.
import { supabase } from '../../supabaseClient'
import { scopedFrom } from '../../shared/scopedDb'
import { bsToAd, daysInBsMonth } from '../../utils/bsCalendar'
import { calcAmount, hourlyRateOf, tallyAttendance } from '../hr/payroll/payrollCompute'
import { SSF_CAP, SSF_EMPLOYER_PCT, OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER, STANDARD_HOURS_PER_DAY } from '../hr/payrollConstants'
import { explodeRecipeIngredients, computeRecipeCosts } from '../../utils/recipeCost'
import { computeOrderAmounts, computeCategoryAmounts } from '../../utils/posBillingMath'

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
    supabase.from('purchase_entries').select('id, item_id, qty, rate, payment_method').eq('period_id', period.id),
    supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', period.id),
    supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', period.id).neq('source', 'pos_comp'),
    scopedFrom('recipes', clientId, 'id, selling_price'),
    supabase.from('overheads').select('amount').eq('period_id', period.id).eq('bucket', 'overhead'),
    supabase.from('wastages').select('item_id, qty').eq('period_id', period.id),
    // .eq('is_active', true) matches Stock.js's own Summary tab exactly (its `items` state is
    // loaded with this same filter) — omitting it here previously let a leftover opening_stock
    // row on a deactivated item inflate Opening Stock Value above what Stock Count itself shows
    // for the same period (found live, S436: NPR 179,232 here vs NPR 179,189.95 on Stock Count).
    // Sub-recipes are deliberately NOT excluded — Stock Count counts them too (its own "Sub-
    // Recipes" category row), unlike the is_sub_recipe exclusion CLAUDE.md documents for
    // Item Master/Purchases/POs/Requisitions/Reorder Report/Supplier Price Tracker.
    scopedFrom('items', clientId, 'id, per_uom_rate, yield_pct, is_active, is_sub_recipe').eq('is_active', true),
    scopedFrom('par_levels', clientId, 'item_id, par_qty'),
    supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id),
    supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id),
    scopedFrom('payable_payments', clientId, 'purchase_entry_id, amount'),
  ])
  const [
    { data: purchases }, { data: returns }, { data: salesData }, { data: recipes },
    { data: overheadsData }, { data: wastagesData }, { data: items }, { data: parLevels },
    { data: opening }, { data: closing }, { data: payablePayments },
  ] = results

  const grossTotal  = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
  const returnTotal = (returns   || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
  const purchaseTotal = grossTotal - returnTotal

  const priceMap = {}; (recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0 })
  const revenueTotal = (salesData || []).reduce((s, r) => {
    const price = r.unit_price != null ? parseFloat(r.unit_price) : (priceMap[r.recipe_id] || 0)
    return s + parseFloat(r.qty_sold || 0) * price
  }, 0)

  const overheadTotal = (overheadsData || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)

  const itemRateMap = {}; (items || []).forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
  const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)
  // Same qty × per_uom_rate valuation MonthlySummary.js/Stock.js use for their own Opening/
  // Closing Stock figures — an owner reading this report needs to see what stock the period
  // started and ended with, same as every other IMS report already shows.
  const openingStockValueTotal = (opening || []).reduce((s, o) => s + parseFloat(o.qty || 0) * (itemRateMap[o.item_id] || 0), 0)
  const closingStockValueTotal = (closing || []).reduce((s, c) => s + parseFloat(c.physical_qty || 0) * (itemRateMap[c.item_id] || 0), 0)

  let cashNet = 0, creditNet = 0
  ;(purchases || []).forEach(p => {
    const v = parseFloat(p.qty || 0) * parseFloat(p.rate || 0)
    if (p.payment_method === 'Credit') creditNet += v; else cashNet += v
  })
  ;(returns || []).forEach(r => { cashNet -= parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })

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
  const ingredientBreakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}
  const soldMap = {}; (salesData || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0) })
  const theoreticalMap = {}
  Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
    const sold = soldMap[recipeId] || 0
    if (sold <= 0) return
    rows.forEach(({ item_id, qty }) => { theoreticalMap[item_id] = (theoreticalMap[item_id] || 0) + sold * qty })
  })
  const purchMap = {}
  ;(purchases || []).forEach(p => { purchMap[p.item_id] = (purchMap[p.item_id] || 0) + parseFloat(p.qty || 0) })
  ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty || 0) })
  const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) })
  const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) })
  const parMap = {}; (parLevels || []).forEach(p => { parMap[p.item_id] = parseFloat(p.par_qty) || 0 })

  let reorderCount = 0, reorderEstValueTotal = 0
  ;(items || []).forEach(i => {
    if (i.is_sub_recipe) return // items query is already filtered to is_active=true
    const par = parMap[i.id] || 0
    if (par <= 0) return
    const hasPhysical = closeMap[i.id] !== undefined
    const currentStock = hasPhysical
      ? closeMap[i.id]
      : Math.max(0, (openMap[i.id] || 0) + (purchMap[i.id] || 0) - (theoreticalMap[i.id] || 0))
    const shortfall = par - currentStock
    if (shortfall > 0) { reorderCount += 1; reorderEstValueTotal += shortfall * parseFloat(i.per_uom_rate || 0) }
  })

  const foodCostPct = revenueTotal > 0 ? (purchaseTotal / revenueTotal) * 100 : null

  return {
    revenueTotal, purchaseTotal, overheadTotal, wastageValueTotal, openingStockValueTotal, closingStockValueTotal, cashNet, creditNet, foodCostPct,
    reorder: { count: reorderCount, estValueTotal: reorderEstValueTotal },
    payables: { unpaidTotal: payablesUnpaidTotal, unpaidCount: payablesUnpaidCount },
  }
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
    scopedFrom('hr_employees', clientId, 'id, status, basic_salary, pay_basis, ssf_enrolled, join_date, end_date'),
    scopedFrom('hr_salary_components', clientId, 'employee_id, type, calc_type, value'),
    scopedFrom('hr_overtime_entries', clientId, 'employee_id, ot_hours, ot_type, status, bs_year, bs_month')
      .eq('status', 'approved').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
    scopedFrom('hr_leave_requests', clientId, 'leave_type_id, status, start_date, end_date, days'),
    scopedFrom('hr_attendance', clientId, 'status, hours_worked, ot_hours').eq('period_id', period.id),
    scopedFrom('hr_leave_types', clientId, 'id, name'),
    scopedFrom('hr_payroll_runs', clientId, 'id').eq('period_id', period.id).eq('status', 'finalized').maybeSingle(),
  ])
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
    const { data: payslips } = await scopedFrom('hr_payslips', clientId, 'gross, ot_hours, ot_amount, ssf_employer')
      .eq('run_id', finalizedRun.id)
    const gross = (payslips || []).reduce((s, p) => s + (parseFloat(p.gross) || 0), 0)
    const otHours = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_hours) || 0), 0)
    const otAmount = (payslips || []).reduce((s, p) => s + (parseFloat(p.ot_amount) || 0), 0)
    const ssfEmployer = (payslips || []).reduce((s, p) => s + (parseFloat(p.ssf_employer) || 0), 0)
    payroll = { gross, ot: { hours: otHours, amount: otAmount }, ssfEmployer, total: gross + otAmount + ssfEmployer }
    payrollSource = 'finalized'
  } else {
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

      if (emp.ssf_enrolled) {
        const ssfBase = Math.min(monthlyEquivGross, SSF_CAP) * (monthDays > 0 ? daysWorked / monthDays : 0)
        accruedSsfEmployer += ssfBase * SSF_EMPLOYER_PCT
      }
    })

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

  const [{ data: settings }, { data: orderData }] = await Promise.all([
    supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
    scopedFrom('pos_orders', clientId, 'id, discount_amount, closed_at, credit_note_id, payment_method, covers')
      .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs),
  ])
  const vatReg = settings?.is_vat_registered ?? true
  const orders = (orderData || []).filter(o => !o.credit_note_id)

  const orderIds = orders.map(o => o.id)
  const { data: itemRows } = orderIds.length > 0
    ? await scopedFrom('pos_order_items', clientId, 'order_id, recipe_id, name, category, qty, unit_price, vat_rate, comped, comp_no').in('order_id', orderIds)
    : { data: [] }

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

  const { data: voidRows } = await scopedFrom('pos_orders', clientId, 'id')
    .in('close_type', ['void', 'writeoff']).gte('closed_at', fromTs).lte('closed_at', toTs)
  const voidOrderIds = (voidRows || []).map(o => o.id)
  let voidsAmount = 0
  if (voidOrderIds.length > 0) {
    const { data: voidItems } = await scopedFrom('pos_order_items', clientId, 'order_id, qty, unit_price').in('order_id', voidOrderIds)
    voidsAmount = (voidItems || []).reduce((s, i) => s + i.qty * i.unit_price, 0)
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

// Prime Cost % / True Net Margin % — same formulas as OwnerDashboard.jsx. Always computed when
// inputs exist; True Net Margin's *display* is gated behind hasFeature('overheads') by the
// report page, not here (mirrors Owner Dashboard's own canOverheads pattern).
function computeCombinedMetrics({ ims, hr }) {
  if (!ims) return { revenueTotal: null, foodCostPct: null, laborCostPct: null, primeCostPct: null, netMarginPct: null }
  const revenueTotal = ims.revenueTotal || 0
  const foodCostPct = ims.foodCostPct
  const laborCostPct = hr && revenueTotal > 0 ? (hr.payroll.total / revenueTotal) * 100 : null
  const primeCostPct = foodCostPct != null && laborCostPct != null ? foodCostPct + laborCostPct : null
  const netMarginPct = hr && revenueTotal > 0
    ? ((revenueTotal - ims.purchaseTotal - hr.payroll.total - ims.overheadTotal) / revenueTotal) * 100
    : null
  return { revenueTotal, foodCostPct, laborCostPct, primeCostPct, netMarginPct }
}

// Orchestrates the three section computations + combined metrics. `modulesIncluded` is resolved
// by the caller (generateMonthlyReport.js) from the client's actual module subscription, not
// guessed here.
export async function computeMonthlyReport({ clientId, period, modulesIncluded }) {
  if (!period || period.status !== 'closed') {
    throw new Error('Monthly owner reports are only generated for closed periods')
  }
  const [ims, hr, pos] = await Promise.all([
    modulesIncluded.ims ? computeImsSection(clientId, period) : null,
    modulesIncluded.hr  ? computeHrSection(clientId, period)  : null,
    modulesIncluded.pos ? computePosSection(clientId, period) : null,
  ])
  return {
    period: { id: period.id, bs_year: period.bs_year, bs_month: period.bs_month },
    modulesIncluded,
    ims, hr, pos,
    combined: computeCombinedMetrics({ ims, hr }),
  }
}
