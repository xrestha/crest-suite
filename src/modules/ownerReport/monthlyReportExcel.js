// Excel export for a Monthly Owner/Manager Report snapshot — same book_new/aoa_to_sheet/
// sheet_add_json + letterhead pattern as SalesReport.jsx/CoversReport.jsx, one sheet per section
// actually present in the snapshot (report.snapshot.modulesIncluded).
import * as XLSX from 'xlsx'
import { BS_MONTHS } from '../../utils/bsCalendar'

const round2 = n => (n == null ? '' : Math.round(n * 100) / 100)
const pct    = n => (n == null ? '' : Math.round(n * 10) / 10)

function withLetterhead(title, bizInfo, periodLabel, dataRows) {
  const aoa = [
    [title],
    [`CompanyName : ${bizInfo.name}`],
    [`${bizInfo.vatReg ? 'VATNO' : 'PAN No'} : ${bizInfo.vat}`],
    [`ADDRESS : ${bizInfo.address}`],
    [],
    [`Period : ${periodLabel}`],
    // When the frozen figures were made, as the report header says it (S792, D42): a workbook
    // mailed on must still say whether it holds the month as it stood at the close or later.
    ...(bizInfo.madeLine ? [[`Made : ${bizInfo.madeLine}`]] : []),
    [],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })
  return ws
}

// `report` is a monthly_owner_reports row (has bs_year/bs_month/snapshot); `bizInfo` is
// { name, vat, address, vatReg } for the client, same shape the report page already loads, plus
// the page's `madeLine` (reportMadeLine.js) when it has one.
export function exportMonthlyReportExcel(report, bizInfo) {
  const { snapshot, bs_year, bs_month } = report
  const periodLabel = `${BS_MONTHS[bs_month - 1]} ${bs_year}`
  const wb = XLSX.utils.book_new()

  // S792 (D30, schema v9): Food Cost % is food used (COGS) ÷ revenue; an older snapshot froze net
  // purchases ÷ revenue. The sheet names which, since a figure without its basis cannot be checked.
  const cogsBasis = snapshot.combined?.foodCostBasis === 'cogs'
  const gap = cogsBasis ? snapshot.ims?.countGap : null
  const summaryRows = [{
    'Revenue (NPR)': round2(snapshot.combined?.revenueTotal),
    'Food Cost %': pct(snapshot.combined?.foodCostPct),
    'Food Cost Basis': cogsBasis ? 'Food used (COGS) ÷ revenue' : 'Net purchases ÷ revenue (the earlier rule)',
    'Labor Cost %': pct(snapshot.combined?.laborCostPct),
    'Prime Cost %': pct(snapshot.combined?.primeCostPct),
    'Net Margin %': pct(snapshot.combined?.netMarginPct),
    ...(gap ? {
      'Items Without Closing Count': gap.uncountedCount ?? 0,
      'Food Cost Judged': gap.material ? 'No: closing count incomplete' : 'Yes',
    } : {}),
  }]
  XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - Summary', bizInfo, periodLabel, summaryRows), 'Summary')

  if (snapshot.ims) {
    const ims = snapshot.ims
    const imsRows = [{
      'Opening Stock (NPR)': round2(ims.openingStockValueTotal),
      'Revenue (NPR)': round2(ims.revenueTotal), 'Purchases (NPR)': round2(ims.purchaseTotal),
      'Overheads (NPR)': round2(ims.overheadTotal),
      // v12 only (S798 2e): an older snapshot froze no Tax & Fees, and a blank there would read as zero.
      ...(ims.taxFeesTotal != null ? { 'Tax & Fees (NPR)': round2(ims.taxFeesTotal) } : {}),
      'Wastage Value (NPR)': round2(ims.wastageValueTotal),
      // v9 only: an older snapshot froze no COGS, and a blank there would read as zero.
      ...(ims.staffMealsValueTotal != null ? { 'Staff Meals (NPR)': round2(ims.staffMealsValueTotal) } : {}),
      'Closing Stock (NPR)': round2(ims.closingStockValueTotal),
      ...(ims.cogsTotal != null ? { 'Food Used / COGS (NPR)': round2(ims.cogsTotal) } : {}),
      'Cash Purchases (NPR)': round2(ims.cashNet), 'Credit Purchases (NPR)': round2(ims.creditNet),
      'Items Below Par': ims.reorder?.count ?? 0, 'Reorder Est. Value (NPR)': round2(ims.reorder?.estValueTotal),
      'Unpaid Credit — This Period (NPR)': round2(ims.payables?.unpaidTotal), 'Unpaid Credit Bills': ims.payables?.unpaidCount ?? 0,
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - IMS', bizInfo, periodLabel, imsRows), 'IMS')
  }

  if (snapshot.hr) {
    const hr = snapshot.hr
    const hrRows = [{
      'Payroll Source': hr.payrollSource === 'finalized' ? 'Finalized Payroll Run' : 'Estimated (no payroll finalized)',
      'Gross Payroll (NPR)': round2(hr.payroll?.gross),
      // v13 only (S798 3c): an older snapshot froze no unpaid-day or other-pay figure, and a blank
      // there would read as zero. An estimate has no unpaid-day figure either (null).
      ...(hr.payroll?.absenceDeduction != null ? { 'Less Unpaid Days (NPR)': round2(hr.payroll.absenceDeduction) } : {}),
      'OT Hours': round2(hr.payroll?.ot?.hours),
      'OT Amount (NPR)': round2(hr.payroll?.ot?.amount), 'Employer SSF (NPR)': round2(hr.payroll?.ssfEmployer),
      ...(hr.payroll?.other ? {
        'Festival Allowance (NPR)': round2(hr.payroll.other.festival),
        'Incentives (NPR)': round2(hr.payroll.other.incentive),
        "Leavers' Final Pay (NPR)": round2(hr.payroll.other.settlement),
        'Total Labour Cost (NPR)': round2(hr.payroll?.total),
      } : { 'Total Payroll Cost (NPR)': round2(hr.payroll?.total) }),
      'Active Employees': hr.headcount?.active ?? 0, 'New Hires': hr.headcount?.newHires ?? 0,
      'Terminations': hr.headcount?.terminations ?? 0,
      'Attendance Rate %': hr.attendance ? pct(hr.attendance.rate) : 'N/A',
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - HR', bizInfo, periodLabel, hrRows), 'HR')
    const leaveRows = (hr.leave || []).map(l => ({ 'Leave Type': l.leaveTypeName, 'Days Taken': round2(l.days), Requests: l.requestCount }))
    if (leaveRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(leaveRows), 'HR - Leave')
  }

  if (snapshot.pos) {
    const pos = snapshot.pos
    const posRows = [{
      'Net Sales (NPR)': round2(pos.totalNetSales), 'Gross (NPR)': round2(pos.totalGross),
      'Discount (NPR)': round2(pos.totalDiscount), 'VAT (NPR)': round2(pos.totalVat),
      Bills: pos.billCount, 'Qty Sold': pos.totalQty,
      // v15 (S809 3m): the credit notes issued in the month, which Net Sales is after.
      ...(pos.creditNotes ? { 'Credit Notes': pos.creditNotes.count, 'Credit Notes Value (NPR)': round2(pos.creditNotes.net) } : {}),
      'Comped Bills': pos.compedBillsTotal?.count ?? 0, 'Comped Potential Value (NPR)': round2(pos.compedBillsTotal?.potentialValue),
      'Voids/Writeoffs': pos.voidsWriteoffsTotal?.count ?? 0, 'Voids/Writeoffs Value (NPR)': round2(pos.voidsWriteoffsTotal?.amount),
      'Total Covers': pos.covers?.totalCovers ?? 0,
      // What "covers" counted in this report (owner decision 2026-10-10), so the sheet says it too.
      'Covers Counted': pos.covers?.basis === 'seated'
        ? 'Guests seated at tables'
        : 'Every bill, takeaway included; credit-noted bills left out',
      'Avg Check/Cover (NPR)': round2(pos.covers?.avgCheckPerCover),
      'Avg Bill Value (NPR)': round2(pos.covers?.avgBillValue),
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - POS Summary', bizInfo, periodLabel, posRows), 'POS Summary')
    const catRows = (pos.categoryBreakdown || []).map(c => ({ Category: c.category, Qty: c.qty, 'Net Sales (NPR)': round2(c.net) }))
    if (catRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'POS - Category')
    const payRows = (pos.paymentMix || []).map(p => ({ Method: p.method, 'Net Sales (NPR)': round2(p.net), '% of Net': pct(p.pctOfNet) }))
    if (payRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payRows), 'POS - Payment Mix')
  }

  if (snapshot.menuEngineering) {
    const me = snapshot.menuEngineering
    const meRows = (me.items || []).map(i => ({
      // `quadrant` is null for a dish with no price or no costed ingredients (schema v5) — the
      // cell says so rather than leaving a blank that reads as an export fault.
      Recipe: i.name, Category: i.category, Quadrant: i.quadrant || 'Not rated',
      // Why a dish was not rated — including build-your-own (S792, RECIPES-1, v9).
      'Why Not Rated': i.quadrant ? '' : (i.unrated || ''),
      'Selling Price (NPR)': round2(i.sellingPrice), 'Ingredient Cost (NPR)': round2(i.ingredientCost),
      'Food Cost %': i.fcPct == null ? '' : pct(i.fcPct), 'Qty Sold': i.qtySold, 'Revenue (NPR)': round2(i.revenue),
      'Contribution Margin (NPR)': round2(i.contributionMargin), 'Total Contribution (NPR)': round2(i.totalContribution),
    }))
    if (meRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meRows), 'Menu Engineering')
  }

  if (snapshot.laborAnalytics) {
    const la = snapshot.laborAnalytics
    const laRows = [{
      'Actual Hours Worked': round2(la.actualHoursWorked),
      // v12 only (S798 2e, H31): worked days with no clock times, and the hour figures withheld when
      // they are more than half.
      ...(la.workingDays != null ? { 'Worked Days Without Clock Times': `${la.workingDaysWithoutHours} of ${la.workingDays}` } : {}),
      'Scheduled Hours': round2(la.scheduledHours),
      'Schedule Variance (hrs)': la.hoursWithheld ? 'Hours not recorded' : round2(la.scheduleVarianceHours),
      'Schedule Variance %': la.hoursWithheld ? 'Hours not recorded' : la.scheduleVariancePct != null ? pct(la.scheduleVariancePct) : 'N/A',
      'Sales per Labor Hour (NPR)': la.hoursWithheld ? 'Hours not recorded' : la.salesPerLaborHour != null ? round2(la.salesPerLaborHour) : 'N/A',
      'OT Hours': la.overtime ? round2(la.overtime.hours) : '', 'OT Amount (NPR)': la.overtime ? round2(la.overtime.amount) : '',
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - Labor Analytics', bizInfo, periodLabel, laRows), 'Labor Analytics')
  }

  if (snapshot.vendorPurchasing) {
    const vp = snapshot.vendorPurchasing
    const vendorRows = (vp.vendors || []).map(v => ({
      Vendor: v.name, 'Gross (NPR)': round2(v.gross), 'Discount (NPR)': round2(v.discount), 'Returned (NPR)': round2(v.returned),
      'Net Spend (NPR)': round2(v.net), 'Cash (NPR)': round2(v.cash), 'Credit (NPR)': round2(v.credit), 'FonePay (NPR)': round2(v.fonepay), Bills: v.billCount,
    }))
    if (vendorRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vendorRows), 'Vendor Summary')
    const agingRows = (vp.agingBills || []).map(b => ({
      Vendor: b.vendorName, Invoice: b.invoiceRef || '', 'BS Day': b.bsDay, 'Remaining (NPR)': round2(b.remaining), 'Days Old (at generation)': b.daysOld, Bucket: b.bucket,
    }))
    if (agingRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(agingRows), 'Vendor Aging')
  }

  if (snapshot.inventoryDepth) {
    const inv = snapshot.inventoryDepth
    const invSummaryRows = [{
      'Turnover Ratio': inv.turnover?.turnoverRatio != null ? round2(inv.turnover.turnoverRatio) : 'N/A',
      'Days on Hand': inv.turnover?.daysOnHand != null ? round2(inv.turnover.daysOnHand) : 'N/A',
      'Avg Inventory Value (NPR)': round2(inv.turnover?.avgInventoryValue),
      'Dead Stock Items': inv.deadSlowStock?.deadCount ?? 0, 'Slow Stock Items': inv.deadSlowStock?.slowCount ?? 0,
      'Value at Risk (NPR)': round2(inv.deadSlowStock?.totalValueAtRisk),
      'Variance Flagged Items': inv.variance?.flaggedCount ?? 0, 'Total Variance Value (NPR)': round2(inv.variance?.totalVarianceValue),
      // v9 (S792): the tolerance the flags were judged at, and what could not be judged. An older
      // section was a fixed ±10% and counted uncounted items as 0.
      'Variance Tolerance': inv.variance?.tolerancePct != null ? `±${inv.variance.tolerancePct}%, NPR ${inv.variance.floorValue} floor` : '±10% (fixed, the earlier rule)',
      ...(inv.variance?.tolerancePct != null ? {
        'Variance Items Not Counted': inv.variance.uncountedCount ?? 0,
        'Variance Items In No Recipe': inv.variance.noRecipeCount ?? 0,
      } : {}),
      'Shrinkage Window (periods)': inv.shrinkageTrend?.periodsAnalyzed ?? 'N/A', 'Shrinkage Loss Value (NPR)': inv.shrinkageTrend ? round2(inv.shrinkageTrend.totalLossValue) : 'N/A',
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - Inventory Depth', bizInfo, periodLabel, invSummaryRows), 'Inventory Summary')

    // S756 (D20): a v7+ section (`rule: 'streak'`) adds the streak and the next step, plus a Rule
    // column so the sheet says what "Dead" meant. A v1–v6 section keeps its old columns — it has no
    // streak, and a blank or 0 there would read as a finding.
    const dsStreak = inv.deadSlowStock?.rule === 'streak'
    const deadAfter = inv.deadSlowStock?.deadAfterMonths || 3
    const dsRule = dsStreak
      ? `Dead = ${deadAfter}+ counted months in a row with no use; Slow = 1–2 months, or <20% used`
        + (inv.deadSlowStock?.movement === 'staff_meals_count' ? '; staff meals count as use, wastage does not' : '')
      : 'Dead = no use in this month alone (one-month rule, before S756)'
    const deadSlowRows = (inv.deadSlowStock?.items || []).map(i => ({
      Item: i.name, Status: i.status,
      ...(dsStreak ? { 'Months Without Use': `${i.stillMonths || 0}${i.atLeast ? '+' : ''}` } : {}),
      'Value at Risk (NPR)': round2(i.valueAtRisk), Used: round2(i.used),
      // v9 (S792): staff meals count as movement; absent on an older section.
      ...(i.staffMeals != null ? { 'Staff Meals': round2(i.staffMeals) } : {}),
      Closing: round2(i.closing),
      ...(dsStreak ? { 'Suggested Next Step': i.suggestion || '', 'Last Bought': i.lastBought || '', Supplier: i.supplier || '' } : {}),
      Rule: dsRule,
    }))
    if (deadSlowRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deadSlowRows), 'Inventory - Dead-Slow')

    // Over/under only (a v1–v8 section also stored 'ok' rows). A v9 no-sales row has no percentage:
    // its dishes sold nothing while the stock fell (D36), and the cell says so instead of a blank.
    const varianceRows = (inv.variance?.items || []).filter(i => i.flag === 'over' || i.flag === 'under').map(i => ({ Item: i.name, 'Actual Used': round2(i.actualUsed), 'Theoretical Used': round2(i.theoreticalUsed), 'Variance %': i.variancePct == null ? 'no sales' : pct(i.variancePct), 'Value (NPR)': round2(i.value), Flag: i.flag }))
    if (varianceRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(varianceRows), 'Inventory - Variance')

    const shrinkageRows = (inv.shrinkageTrend?.items || []).map(i => ({ Item: i.name, Status: i.status, 'Shrink Count': i.shrinkCount, 'Covered Periods': i.coveredPeriods, 'Total Shrink Value (NPR)': round2(i.totalShrinkValue) }))
    if (shrinkageRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shrinkageRows), 'Inventory - Shrinkage')
  }

  if (snapshot.trend) {
    const trendRows = []
    ;['vsLastPeriod', 'vsSameMonthLastYear'].forEach(key => {
      const t = snapshot.trend[key]
      const label = key === 'vsLastPeriod' ? 'vs Last Period' : 'vs Same Month Last Year'
      if (!t?.available) { trendRows.push({ Comparison: label, Metric: '—', 'This Period': '', Prior: '', Change: t?.reason || 'unavailable' }); return }
      const priorLabel = `${BS_MONTHS[t.period.bs_month - 1]} ${t.period.bs_year}`
      // S792 (D30): across the purchases → COGS change of Food Cost % the three ratios that contain
      // it are two formulas, so they carry no change — and the cell says why rather than going blank.
      const basisOf = s => (s?.combined?.foodCostBasis === 'cogs' ? 'cogs' : 'purchases')
      const basisDiffers = basisOf(snapshot) !== basisOf(t.snapshot)
      const row = (metric, cur, prior, delta, isPct, foodBased = false) => trendRows.push({
        Comparison: label, Metric: metric, 'This Period': isPct ? pct(cur) : round2(cur), Prior: `${priorLabel}: ${isPct ? pct(prior) : round2(prior)}`,
        Change: foodBased && basisDiffers ? 'not compared: different food-cost basis'
          : delta == null ? '' : isPct ? `${delta.toFixed(1)}pp` : `${round2(delta.absoluteChange)} (${delta.pctChange != null ? delta.pctChange.toFixed(1) + '%' : ''})`,
      })
      row('Revenue (NPR)', snapshot.combined?.revenueTotal, t.snapshot?.combined?.revenueTotal, t.deltas?.revenueTotal, false)
      if (snapshot.ims) row('Food Cost %', snapshot.combined?.foodCostPct, t.snapshot?.combined?.foodCostPct, t.deltas?.foodCostPct, true, true)
      if (snapshot.hr) row('Labor Cost %', snapshot.combined?.laborCostPct, t.snapshot?.combined?.laborCostPct, t.deltas?.laborCostPct, true)
      if (snapshot.ims && snapshot.hr) row('Prime Cost %', snapshot.combined?.primeCostPct, t.snapshot?.combined?.primeCostPct, t.deltas?.primeCostPct, true, true)
      if (snapshot.ims && snapshot.hr) row('Net Margin %', snapshot.combined?.netMarginPct, t.snapshot?.combined?.netMarginPct, t.deltas?.netMarginPct, true, true)
      if (snapshot.pos && t.snapshot?.pos) row('POS Net Sales (NPR)', snapshot.pos?.totalNetSales, t.snapshot?.pos?.totalNetSales, t.deltas?.posNetSales, false)
    })
    if (trendRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), 'Trend')
  }

  XLSX.writeFile(wb, `owner-report-${bs_year}-${String(bs_month).padStart(2, '0')}.xlsx`)
}
