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
    [],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })
  return ws
}

// `report` is a monthly_owner_reports row (has bs_year/bs_month/snapshot); `bizInfo` is
// { name, vat, address, vatReg } for the client, same shape the report page already loads.
export function exportMonthlyReportExcel(report, bizInfo) {
  const { snapshot, bs_year, bs_month } = report
  const periodLabel = `${BS_MONTHS[bs_month - 1]} ${bs_year}`
  const wb = XLSX.utils.book_new()

  const summaryRows = [{
    'Revenue (NPR)': round2(snapshot.combined?.revenueTotal),
    'Food Cost %': pct(snapshot.combined?.foodCostPct),
    'Labor Cost %': pct(snapshot.combined?.laborCostPct),
    'Prime Cost %': pct(snapshot.combined?.primeCostPct),
    'Net Margin %': pct(snapshot.combined?.netMarginPct),
  }]
  XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - Summary', bizInfo, periodLabel, summaryRows), 'Summary')

  if (snapshot.ims) {
    const ims = snapshot.ims
    const imsRows = [{
      'Opening Stock (NPR)': round2(ims.openingStockValueTotal),
      'Revenue (NPR)': round2(ims.revenueTotal), 'Purchases (NPR)': round2(ims.purchaseTotal),
      'Overheads (NPR)': round2(ims.overheadTotal), 'Wastage Value (NPR)': round2(ims.wastageValueTotal),
      'Closing Stock (NPR)': round2(ims.closingStockValueTotal),
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
      'Gross Payroll (NPR)': round2(hr.payroll?.gross), 'OT Hours': round2(hr.payroll?.ot?.hours),
      'OT Amount (NPR)': round2(hr.payroll?.ot?.amount), 'Employer SSF (NPR)': round2(hr.payroll?.ssfEmployer),
      'Total Payroll Cost (NPR)': round2(hr.payroll?.total),
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
      'Comped Bills': pos.compedBillsTotal?.count ?? 0, 'Comped Potential Value (NPR)': round2(pos.compedBillsTotal?.potentialValue),
      'Voids/Writeoffs': pos.voidsWriteoffsTotal?.count ?? 0, 'Voids/Writeoffs Value (NPR)': round2(pos.voidsWriteoffsTotal?.amount),
      'Total Covers': pos.covers?.totalCovers ?? 0, 'Avg Check/Cover (NPR)': round2(pos.covers?.avgCheckPerCover),
      'Avg Bill Value (NPR)': round2(pos.covers?.avgBillValue),
    }]
    XLSX.utils.book_append_sheet(wb, withLetterhead('Monthly Owner Report - POS Summary', bizInfo, periodLabel, posRows), 'POS Summary')
    const catRows = (pos.categoryBreakdown || []).map(c => ({ Category: c.category, Qty: c.qty, 'Net Sales (NPR)': round2(c.net) }))
    if (catRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'POS - Category')
    const payRows = (pos.paymentMix || []).map(p => ({ Method: p.method, 'Net Sales (NPR)': round2(p.net), '% of Net': pct(p.pctOfNet) }))
    if (payRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payRows), 'POS - Payment Mix')
  }

  if (snapshot.trend) {
    const trendRows = []
    ;['vsLastPeriod', 'vsSameMonthLastYear'].forEach(key => {
      const t = snapshot.trend[key]
      const label = key === 'vsLastPeriod' ? 'vs Last Period' : 'vs Same Month Last Year'
      if (!t?.available) { trendRows.push({ Comparison: label, Metric: '—', 'This Period': '', Prior: '', Change: t?.reason || 'unavailable' }); return }
      const priorLabel = `${BS_MONTHS[t.period.bs_month - 1]} ${t.period.bs_year}`
      const row = (metric, cur, prior, delta, isPct) => trendRows.push({
        Comparison: label, Metric: metric, 'This Period': isPct ? pct(cur) : round2(cur), Prior: `${priorLabel}: ${isPct ? pct(prior) : round2(prior)}`,
        Change: delta == null ? '' : isPct ? `${delta.toFixed(1)}pp` : `${round2(delta.absoluteChange)} (${delta.pctChange != null ? delta.pctChange.toFixed(1) + '%' : ''})`,
      })
      row('Revenue (NPR)', snapshot.combined?.revenueTotal, t.snapshot?.combined?.revenueTotal, t.deltas?.revenueTotal, false)
      if (snapshot.ims) row('Food Cost %', snapshot.combined?.foodCostPct, t.snapshot?.combined?.foodCostPct, t.deltas?.foodCostPct, true)
      if (snapshot.hr) row('Labor Cost %', snapshot.combined?.laborCostPct, t.snapshot?.combined?.laborCostPct, t.deltas?.laborCostPct, true)
      if (snapshot.ims && snapshot.hr) row('Prime Cost %', snapshot.combined?.primeCostPct, t.snapshot?.combined?.primeCostPct, t.deltas?.primeCostPct, true)
      if (snapshot.ims && snapshot.hr) row('Net Margin %', snapshot.combined?.netMarginPct, t.snapshot?.combined?.netMarginPct, t.deltas?.netMarginPct, true)
      if (snapshot.pos && t.snapshot?.pos) row('POS Net Sales (NPR)', snapshot.pos?.totalNetSales, t.snapshot?.pos?.totalNetSales, t.deltas?.posNetSales, false)
    })
    if (trendRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), 'Trend')
  }

  XLSX.writeFile(wb, `owner-report-${bs_year}-${String(bs_month).padStart(2, '0')}.xlsx`)
}
