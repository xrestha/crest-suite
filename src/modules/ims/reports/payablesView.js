// What Outstanding Payables shows for a bill, in one place for the screen, the print and the Excel
// export (S885), so the workbook cannot disagree with the table it was taken from. Pure: no React,
// no Supabase.
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { EPS } from './payablesAllocation'
import { payWithinDays, isOverdue, DEFAULT_PAY_WITHIN_DAYS } from '../vendors/payTerms'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const money = n => Number((Number(n) || 0).toFixed(2))

/**
 * What a bill still owes, as the Remaining column shows it: positive when owed, negative when the
 * supplier owes money back (a Credit bill, money only), and 0 for a bill owing nothing. A bill left
 * a few paisa below zero by a return after a cleared leftover owes nothing either way (S885).
 */
export function billBalance(bill) {
  if (bill?.isCredit) return -(Number(bill.credit) || 0)
  return Math.max(0, Number(bill?.remaining) || 0)
}

/**
 * Where an unpaid bill stands against its supplier's payment days (S885, owner decision 2).
 * `vendor` carries `pay_within_days` (NULL = the 60-day default, 0 = due on delivery).
 *
 * Returns { key, label, late?, dueIn?, days }: `credit` and `nothing` for a bill owing nothing,
 * `overdue` once the bill is older than its days (late = days past them), `partial` for a part-paid
 * bill not yet overdue, else `due` (dueIn = days left, 0 on the last day). Overdue wins over
 * partial: a part payment does not make a late bill on time.
 */
export function billStatus(bill, vendor) {
  const days = payWithinDays(vendor)
  if (bill?.isCredit) return { key: 'credit', label: 'Credit', days }
  if (!(Number(bill?.remaining) > EPS)) return { key: 'nothing', label: 'Nothing owed', days }
  const daysOld = Number(bill.daysOld) || 0
  if (isOverdue(daysOld, vendor)) {
    const late = daysOld - days
    return { key: 'overdue', label: `${plural(late, 'day')} overdue`, late, days }
  }
  const dueIn = days - daysOld
  if (bill.isPartial) return { key: 'partial', label: 'Partial', dueIn, days }
  return { key: 'due', label: dueIn === 0 ? 'Due today' : `Due in ${plural(dueIn, 'day')}`, dueIn, days }
}

/** The Overdue cell of the export: "Yes, 4 days late" / "No, due in 12 days" / blank. */
export function overdueText(status) {
  if (!status) return ''
  if (status.key === 'overdue') return `Yes, ${plural(status.late, 'day')} late`
  if (status.key === 'due' || status.key === 'partial') {
    return status.dueIn === 0 ? 'No, due today' : `No, due in ${plural(status.dueIn, 'day')}`
  }
  return ''
}

/**
 * The bills grouped by supplier in the order the page draws them: the supplier owed most first,
 * then on Outstanding the oldest bill first, on Paid History the latest settled first.
 * Returns [{ vName, bills }].
 */
export function vendorGroups(bills, tab) {
  const by = new Map()
  ;(bills || []).forEach(b => {
    if (!by.has(b.vendorName)) by.set(b.vendorName, [])
    by.get(b.vendorName).push(b)
  })
  const owed = list => list.reduce((s, b) => s + billBalance(b), 0)
  return [...by.entries()]
    .sort(([, a], [, b]) => owed(b) - owed(a))
    .map(([vName, list]) => ({
      vName,
      bills: tab === 'outstanding'
        ? [...list].sort((a, b) => b.daysOld - a.daysOld)
        : [...list].sort((a, b) => (b.settledOn || '').localeCompare(a.settledOn || '')),
    }))
}

/**
 * The one line saying what a printed or exported copy covers, every filter on the page stated
 * (vendor-payables.md S725: an export that ignores the filters on screen is a different report).
 */
export function payablesScopeLine({ tab, vendor = 'all', aging = 'all', monthLabel = null, asOf }) {
  return [
    tab === 'outstanding' ? 'Unpaid credit bills' : 'Settled credit bills',
    vendor === 'all' ? 'All suppliers' : `Supplier: ${vendor}`,
    tab === 'outstanding' ? (aging === 'all' ? 'All ages' : `Age: ${aging}`) : null,
    monthLabel ? `Bill month: ${monthLabel}` : 'All months',
    asOf ? `as at ${asOf}` : null,
  ].filter(Boolean).join(' · ')
}

/**
 * The workbook rows for the bills on screen (`groups` from vendorGroups over the filtered bills),
 * money as numbers to the paisa, and a TOTAL row. `vendorOf(vendorId)` gives the supplier's terms
 * row; `settledLabel(iso)` words a settled date. The Written Off column appears only when a bill
 * on the sheet has one, as the screen shows it only then.
 */
export function payablesSheetRows(groups, { tab, vendorOf = () => null, settledLabel = iso => iso || '' }) {
  const bills = (groups || []).flatMap(g => g.bills.map(b => ({ vName: g.vName, b })))
  const anyWrittenOff = bills.some(({ b }) => (Number(b.writtenOff) || 0) > EPS)
  const monthOf = b => (b.period ? `${BS_MONTHS[(b.period.bs_month || 1) - 1]} ${b.period.bs_year}` : '')
  const total = { items: 0, bill: 0, paid: 0, writtenOff: 0, owed: 0, credit: 0 }
  const rows = bills.map(({ vName, b }) => {
    const vendor = vendorOf(b.vendorId)
    total.items += b.entries?.length || 0
    total.bill += Number(b.total) || 0
    total.paid += Number(b.paid) || 0
    total.writtenOff += Number(b.writtenOff) || 0
    const row = {
      'Supplier': vName,
      'Invoice': b.invoice_ref || '',
      'Bill Month': monthOf(b),
      'Items': b.entries?.length || 0,
      'Bill Total (NPR)': money(b.total),
      'Paid (NPR)': money(b.paid),
    }
    if (anyWrittenOff) row['Of Which Written Off (NPR)'] = money(b.writtenOff)
    if (tab === 'outstanding') {
      const status = billStatus(b, vendor)
      const owed = billBalance(b)
      total.owed += owed
      row['Remaining (NPR)'] = money(owed)
      row['Days Old'] = Number(b.daysOld) || 0
      row['Age'] = b.aging?.label || ''
      row['Pay Within (days)'] = payWithinDays(vendor)
      row['Status'] = status.label
      row['Overdue'] = overdueText(status)
    } else {
      total.credit += Number(b.credit) || 0
      row['Credit Owed Back (NPR)'] = money(b.credit)
      row['Settled On'] = settledLabel(b.settledOn) || ''
      row['Pay Within (days)'] = payWithinDays(vendor)
    }
    return row
  })
  if (rows.length === 0) return rows
  const foot = {
    'Supplier': 'TOTAL', 'Invoice': '', 'Bill Month': '', 'Items': total.items,
    'Bill Total (NPR)': money(total.bill), 'Paid (NPR)': money(total.paid),
  }
  if (anyWrittenOff) foot['Of Which Written Off (NPR)'] = money(total.writtenOff)
  if (tab === 'outstanding') {
    Object.assign(foot, { 'Remaining (NPR)': money(total.owed), 'Days Old': '', 'Age': '', 'Pay Within (days)': '', 'Status': '', 'Overdue': '' })
  } else {
    Object.assign(foot, { 'Credit Owed Back (NPR)': money(total.credit), 'Settled On': '', 'Pay Within (days)': '' })
  }
  return [...rows, foot]
}

/** The notes under the workbook scope line: what each figure means, in plain words. */
export function payablesSheetNotes(tab) {
  return [
    'Bill Total is what the supplier invoiced: less the bill discount, less goods returned at the discounted price, plus 13% VAT on VAT lines.',
    'Paid includes any small leftover cleared without paying (written off, at most NPR 10 a bill). A written off amount is not money paid.',
    tab === 'outstanding'
      ? `Pay Within is the number of days each supplier gives to pay; a supplier with none set is given ${DEFAULT_PAY_WITHIN_DAYS} days, and 0 means due on delivery. A bill is overdue once it is older than that. Days Old and Age count from the bill date.`
      : `Pay Within is the number of days each supplier gives to pay; a supplier with none set is given ${DEFAULT_PAY_WITHIN_DAYS} days.`,
  ]
}
