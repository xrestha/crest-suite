// Excel export for a Monthly Owner Report snapshot — same book_new/aoa_to_sheet/
// sheet_add_json + letterhead pattern as SalesReport.jsx/CoversReport.jsx, one sheet per section
// actually present in the snapshot (report.snapshot.modulesIncluded).
import * as XLSX from 'xlsx'
import { BS_MONTHS } from '../../utils/bsCalendar'
import { failedSectionKeys, sectionList, trendUnavailableText, priorFailedSections } from './sectionNames'

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

// The Vendor Summary sheet's rows (S855). A v19 section splits Net Spend itself, so its Cash, Credit
// and FonePay add up to Net Spend on every row, the no-supplier row and the TOTAL. An older section
// split the list price: its TOTAL leaves those three blank and a note row says why, since a workbook
// mailed on carries no page to explain it.
export function vendorSummaryRows(vp) {
  const splitNet = vp?.splitBasis === 'net'
  const row = (label, f, bills) => ({
    Vendor: label, 'Gross (NPR)': round2(f.gross), 'Discount (NPR)': round2(f.discount), 'Returned (NPR)': round2(f.returned),
    'Net Spend (NPR)': round2(f.net), 'Cash (NPR)': round2(f.cash), 'Credit (NPR)': round2(f.credit), 'FonePay (NPR)': round2(f.fonepay), Bills: bills,
  })
  const rows = (vp?.vendors || []).map(v => row(v.name, v, v.billCount))
  if (rows.length === 0) return rows
  if (vp.unassigned) rows.push(row('No supplier recorded', vp.unassigned, vp.unassigned.billCount))
  rows.push(row('TOTAL (every bill this month)', {
    gross: vp.grandGross, discount: vp.grandDiscount, returned: vp.grandReturn, net: vp.grandNet,
    cash: splitNet ? vp.grandCash : null, credit: splitNet ? vp.grandCredit : null, fonepay: splitNet ? vp.grandFonepay : null,
  }, ''))
  if (!splitNet) {
    rows.push({ Vendor: 'Cash, Credit and FonePay on this report are before the bill discount (the rule it was made under), so for a supplier with a discount they add up to more than its Net Spend.' })
  }
  return rows
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
  // Schema 18 (S849): what labour is, and what Net Margin takes off, said in the sheet as on the page.
  const lab = snapshot.combined?.labour
  const pnlCosts = snapshot.combined?.netMarginPnlCosts === true
  const dc = snapshot.deliveryCommission
  const missing = failedSectionKeys(snapshot)
  const labourFrom = lab ? ({
    payroll: 'Finalized payroll',
    estimate: 'HR estimate (payroll not finalized)',
    overheads: 'Overheads Labor tab',
    none: 'None entered on Overheads',
    failed: 'Could not be read when the report was made',
  })[lab.source] || lab.source : null
  const summaryRows = [{
    'Revenue (NPR)': round2(snapshot.combined?.revenueTotal),
    'Food Cost %': pct(snapshot.combined?.foodCostPct),
    'Food Cost Basis': cogsBasis ? 'Food used (COGS) ÷ revenue' : 'Net purchases ÷ revenue (the earlier rule)',
    // v18 (OWNER-REPORT-5): the thresholds the report is judged against, frozen with it.
    ...(snapshot.combined?.fcThresholds ? { 'Food Cost Target %': `≤ ${snapshot.combined.fcThresholds.warn} (critical above ${snapshot.combined.fcThresholds.critical})` } : {}),
    'Labor Cost %': pct(snapshot.combined?.laborCostPct),
    ...(labourFrom ? { 'Labour From': labourFrom } : {}),
    ...(lab?.laborTabNotCounted > 0 ? { 'Labor Tab Not Counted (NPR)': round2(lab.laborTabNotCounted) } : {}),
    ...(lab?.reason === 'nopay' ? { 'Labour Judged': `No: pay not set for ${lab.noPayCount} staff` } : lab?.reason === 'nostaff' ? { 'Labour Judged': 'No: nobody on payroll in Crest HR' } : {}),
    'Prime Cost %': pct(snapshot.combined?.primeCostPct),
    'Net Margin %': pct(snapshot.combined?.netMarginPct),
    // v18 (GAPS-1 / PNL-1): which costs Net Margin takes off.
    'Net Margin Basis': pnlCosts ? 'As Consolidated P&L' : 'Before wastage, staff meals and commission (the earlier rule)',
    ...(dc ? {
      'Delivery Commission (NPR)': round2(dc.amount),
      'Delivery Bills Not Settled': dc.unsettledBills ?? 0,
    } : {}),
    ...(gap ? {
      'Items Without Closing Count': gap.uncountedCount ?? 0,
      'Food Cost Judged': gap.material ? 'No: closing count incomplete' : 'Yes',
    } : {}),
    // OWNER-REPORT-2: a section that failed when the report was made, named in the workbook too.
    ...(missing.length > 0 ? { 'Sections Not In This Report': sectionList(missing) } : {}),
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
      // v18 (GAPS-1): the raw-item part of wastage, which Net Margin takes off.
      ...(ims.cogsWastageTotal != null ? { 'Stock Wasted, Raw Items (NPR)': round2(ims.cogsWastageTotal) } : {}),
      // v9 only: an older snapshot froze no COGS, and a blank there would read as zero.
      ...(ims.staffMealsValueTotal != null ? { 'Staff Meals (NPR)': round2(ims.staffMealsValueTotal) } : {}),
      'Closing Stock (NPR)': round2(ims.closingStockValueTotal),
      ...(ims.cogsTotal != null ? { 'Food Used / COGS (NPR)': round2(ims.cogsTotal) } : {}),
      'Cash Purchases (NPR)': round2(ims.cashNet), 'Credit Purchases (NPR)': round2(ims.creditNet),
      // v18 (PNL-8): stock received from / sent to another outlet, in Purchases but in neither half.
      ...(ims.transferIn != null ? { 'Transfers In (NPR)': round2(ims.transferIn), 'Transfers Out (NPR)': round2(ims.transferOut) } : {}),
      // v18 (OWNER-REPORT-9): the Labor tab as typed.
      ...(ims.laborTabTotal != null ? { 'Overheads Labor Tab (NPR)': round2(ims.laborTabTotal) } : {}),
      'Items Below Par': ims.reorder?.count ?? 0, 'Reorder Est. Value (NPR)': round2(ims.reorder?.estValueTotal),
      // v18 (OWNER-REPORT-8): what is still owed per bill (VAT, discount and returns in); before, a
      // line's raw qty × rate less its payments, counted per line.
      ...(ims.payables?.basis === 'owed'
        ? { 'Unpaid Credit — Still Owed (NPR)': round2(ims.payables?.unpaidTotal), 'Unpaid Credit Bills': ims.payables?.unpaidCount ?? 0 }
        : { 'Unpaid Credit — This Period (NPR)': round2(ims.payables?.unpaidTotal), 'Unpaid Credit Lines': ims.payables?.unpaidCount ?? 0 }),
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
      // v18 (OWNER-REPORT-7): everyone employed at any time in the month, by join and End Dates.
      ...(hr.headcount?.basis === 'dates'
        ? { 'Staff Employed': hr.headcount.employed ?? 0, 'Former Staff With No End Date (not counted)': hr.headcount.noEndDate ?? 0 }
        : { 'Active Employees': hr.headcount?.active ?? 0 }),
      'New Hires': hr.headcount?.newHires ?? 0,
      'Terminations': hr.headcount?.terminations ?? 0,
      'Attendance Rate %': hr.attendance ? pct(hr.attendance.rate) : 'N/A',
      // v18 (OWNER-REPORT-13): the days the rate is over.
      'Attendance Basis': hr.attendance?.basis === 'working_days' ? 'Days due to work (weekly offs and holidays left out)' : 'Every day on the sheet',
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - HR', bizInfo, periodLabel, hrRows), 'HR')
    // v18 (OWNER-REPORT-14): a leave crossing a month edge counts only its days inside this month.
    const daysCol = hr.leaveBasis === 'in_month' ? 'Days in This Month' : 'Days (whole requests)'
    const leaveRows = (hr.leave || []).map(l => ({ 'Leave Type': l.leaveTypeName, [daysCol]: round2(l.days), Requests: l.requestCount }))
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
      // v16 (S814 4d): the potential value is before VAT; an older report's was frozen with VAT.
      'Comped Bills': pos.compedBillsTotal?.count ?? 0,
      ...(pos.compedBillsTotal?.basis === 'ex_vat'
        ? { 'Comped Potential Value, ex-VAT (NPR)': round2(pos.compedBillsTotal?.potentialValue) }
        : { 'Comped Potential Value, incl. VAT (NPR)': round2(pos.compedBillsTotal?.potentialValue) }),
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
    const vendorRows = vendorSummaryRows(vp)
    if (vendorRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vendorRows), 'Vendor Summary')
    // v18 (OWNER-REPORT-8): what is still owed on each bill (VAT, discount and returns in).
    const remainingCol = vp.billAging?.basis === 'owed' ? 'Still Owed (NPR)' : 'Remaining (NPR)'
    const agingRows = (vp.agingBills || []).map(b => ({
      Vendor: b.vendorName, Invoice: b.invoiceRef || '', 'BS Day': b.bsDay, [remainingCol]: round2(b.remaining), 'Days Old (at generation)': b.daysOld, Bucket: b.bucket,
    }))
    if (agingRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(agingRows), 'Vendor Aging')
  }

  if (snapshot.inventoryDepth) {
    const inv = snapshot.inventoryDepth
    // OWNER-REPORT-1: a sub-section that failed when the report was made writes "not generated", never
    // a 0 that reads as a finding; a variance with nothing judged writes "—".
    const subFailed = key => !!inv.sectionErrors && key in inv.sectionErrors
    const NOT_GENERATED = 'not generated'
    const v = inv.variance
    const varianceNothingJudged = v?.tolerancePct != null && !(v.judgedCount > 0)
    const varianceCell = val => (subFailed('variance') ? NOT_GENERATED : !v ? 'N/A' : varianceNothingJudged ? '—' : val)
    const deadCell = val => (subFailed('deadSlowStock') ? NOT_GENERATED : !inv.deadSlowStock ? 'N/A' : val)
    const invSummaryRows = [{
      'Turnover Ratio': inv.turnover?.turnoverRatio != null ? round2(inv.turnover.turnoverRatio) : 'N/A',
      'Days on Hand': inv.turnover?.daysOnHand != null ? round2(inv.turnover.daysOnHand) : 'N/A',
      'Avg Inventory Value (NPR)': round2(inv.turnover?.avgInventoryValue),
      // v18 (OWNER-REPORT-15): turnover is COGS ÷ the average stock of the items COGS counts.
      'Turnover Basis': inv.turnover?.basis === 'cogs' ? 'Food used (COGS) ÷ average stock of the same items' : 'Stock consumed, waste included (the earlier rule)',
      'Dead Stock Items': deadCell(inv.deadSlowStock?.deadCount ?? 0), 'Slow Stock Items': deadCell(inv.deadSlowStock?.slowCount ?? 0),
      'Value at Risk (NPR)': deadCell(round2(inv.deadSlowStock?.totalValueAtRisk)),
      'Variance Flagged Items': varianceCell(v?.flaggedCount ?? 0), 'Total Variance Value (NPR)': varianceCell(round2(v?.totalVarianceValue)),
      // v9 (S792): the tolerance the flags were judged at, and what could not be judged. An older
      // section was a fixed ±10% and counted uncounted items as 0.
      'Variance Tolerance': subFailed('variance') ? NOT_GENERATED : v?.tolerancePct != null ? `±${v.tolerancePct}%, NPR ${v.floorValue} floor` : '±10% (fixed, the earlier rule)',
      ...(v?.tolerancePct != null ? {
        'Variance Items Not Counted': v.uncountedCount ?? 0,
        'Variance Items In No Recipe': v.noRecipeCount ?? 0,
      } : {}),
      'Shrinkage Window (periods)': subFailed('shrinkageTrend') ? NOT_GENERATED : inv.shrinkageTrend?.periodsAnalyzed ?? 'N/A',
      'Shrinkage Loss Value (NPR)': subFailed('shrinkageTrend') ? NOT_GENERATED : inv.shrinkageTrend ? round2(inv.shrinkageTrend.totalLossValue) : 'N/A',
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
      // S849 (OWNER-REPORT-18 / -19): the reason in words, never the raw code.
      if (!t?.available) { trendRows.push({ Comparison: label, Metric: '—', 'This Period': '', Prior: '', Change: trendUnavailableText(t) }); return }
      const priorLabel = `${BS_MONTHS[t.period.bs_month - 1]} ${t.period.bs_year}`
      // S792 (D30): across the purchases → COGS change of Food Cost % the three ratios that contain
      // it are two formulas, so they carry no change — and the cell says why rather than going blank.
      // The same for Net Margin across v12 (Tax & Fees) and v18 (wastage, staff meals and delivery
      // commission), and for the three labour ratios across v13 (labour as pay earned) — S849.
      const basisOf = s => (s?.combined?.foodCostBasis === 'cogs' ? 'cogs' : 'purchases')
      const basisDiffers = basisOf(snapshot) !== basisOf(t.snapshot)
      const d = t.deltas || {}
      // Either stored shape of the prior's failed sections (S857, priorFailedSections).
      const priorMissing = priorFailedSections(t.snapshot)
      const whyNot = kind => {
        if (kind !== 'revenue' && kind !== 'labour' && priorMissing.includes('ims')) return `not compared: ${priorLabel}'s report is missing its Crest IMS section`
        if ((kind === 'food' || kind === 'prime' || kind === 'margin') && basisDiffers) return 'not compared: different food-cost basis'
        if ((kind === 'labour' || kind === 'prime' || kind === 'margin') && d.labourBasisChanged) return 'not compared: labour counted differently'
        if (kind === 'margin' && d.netMarginBasisChanged) return 'not compared: Tax & Fees were not subtracted then'
        if (kind === 'margin' && d.netMarginCostsChanged) return 'not compared: wastage, staff meals and delivery commission were not subtracted then'
        return null
      }
      // OWNER-REPORT-12: with either month's closing count incomplete, the change is shown without a verdict.
      const unjudged = kind => d.verdictWithheld && (kind === 'food' || kind === 'prime' || kind === 'margin')
      const row = (metric, cur, prior, delta, isPct, kind) => trendRows.push({
        Comparison: label, Metric: metric, 'This Period': isPct ? pct(cur) : round2(cur), Prior: `${priorLabel}: ${isPct ? pct(prior) : round2(prior)}`,
        Change: whyNot(kind)
          // "points", never "pp" (S857), as on the page: a change in a % figure is in percentage points.
          || (delta == null ? '' : isPct ? `${delta.toFixed(1)} points${unjudged(kind) ? ' (not judged: closing count incomplete)' : ''}` : `${round2(delta.absoluteChange)} (${delta.pctChange != null ? delta.pctChange.toFixed(1) + '%' : ''})`),
      })
      // v18: labour, Prime and Net Margin can come without Crest HR (the Labor tab), so each row
      // shows when either side has its figure.
      const has = key => snapshot.combined?.[key] != null || t.snapshot?.combined?.[key] != null
      row('Revenue (NPR)', snapshot.combined?.revenueTotal, t.snapshot?.combined?.revenueTotal, d.revenueTotal, false, 'revenue')
      if (snapshot.ims) row('Food Cost %', snapshot.combined?.foodCostPct, t.snapshot?.combined?.foodCostPct, d.foodCostPct, true, 'food')
      if (snapshot.hr || has('laborCostPct')) row('Labor Cost %', snapshot.combined?.laborCostPct, t.snapshot?.combined?.laborCostPct, d.laborCostPct, true, 'labour')
      if (snapshot.ims && (snapshot.hr || has('primeCostPct'))) row('Prime Cost %', snapshot.combined?.primeCostPct, t.snapshot?.combined?.primeCostPct, d.primeCostPct, true, 'prime')
      if (snapshot.ims && (snapshot.hr || has('netMarginPct'))) row('Net Margin %', snapshot.combined?.netMarginPct, t.snapshot?.combined?.netMarginPct, d.netMarginPct, true, 'margin')
      if (snapshot.pos && t.snapshot?.pos) row('POS Net Sales (NPR)', snapshot.pos?.totalNetSales, t.snapshot?.pos?.totalNetSales, d.posNetSales, false, 'revenue')
    })
    if (trendRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), 'Trend')
  }

  XLSX.writeFile(wb, `owner-report-${bs_year}-${String(bs_month).padStart(2, '0')}.xlsx`)
}
