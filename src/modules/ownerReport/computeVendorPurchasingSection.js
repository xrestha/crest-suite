// Vendor & Purchasing Analytics. The supplier rows are Vendor Report's figures, through the same
// shared helper (`vendorNetBasis.js`, S855), not a copy: Gross at list price on the cost basis, Net
// Spend after the allocated bill discount and returns at their discounted price, Discount derived
// as Gross − allocated net, and Cash / Credit / FonePay on that same net basis, so the three add up
// to Net Spend exactly (owner decision S855, schema 19). Until v18 this file kept its own copy: the
// split took the LIST price less returns, so a discounted bill put its whole discount into Cash or
// Credit and the three added up to more than Net Spend. `splitBasis: 'net'` marks a v19 section.
//
// One deliberate departure from VendorReport.js: its bill aging uses live `new Date()` (fine for an
// always-current interactive page); a FROZEN report must pin aging to the moment of generation
// instead, same principle computeImsSection's payables figure already uses — otherwise an
// outstanding bill's aging bucket would keep drifting after the snapshot is supposed to be frozen.
// The aging is also what is still OWED (VAT included, `billAging.basis: 'owed'`), so Unpaid Credit
// can be larger than the Credit column, which leaves VAT out. No `vendors.credit_terms`/due-date
// column exists anywhere in the schema — this is bill-age-since-purchase, not payment-terms-SLA
// compliance.
import { supabase } from '../../supabaseClient'
import { throwFirstError } from '../../shared/queryError'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { bsToAd } from '../../utils/bsCalendar'
import { vatCostFactor } from '../ims/reports/supplierAttribution'
import { returnLinesOutsidePeriod } from '../ims/reports/purchaseTaxSplit'
import { vendorNetBasis, netByMethod } from '../ims/reports/vendorNetBasis'
import { readPriorBillLines } from '../ims/reports/readPriorBillLines'
import { unpaidCreditBills, returnedByEntryOf } from './unpaidCreditBills'

const EPS = 0.001

function billAgingBucket(daysOld) {
  if (daysOld <= 30) return 'current'
  if (daysOld <= 60) return 'd31_60'
  if (daysOld <= 90) return 'd61_90'
  return 'd90plus'
}

export async function computeVendorPurchasingSection(clientId, period, generatedAt) {
  const results = await Promise.all([
    // Paged — feeds a FROZEN snapshot, so a truncated read becomes the permanent record (S529).
    fetchAllRows(() => supabase.from('purchase_entries')
      .select('id, vendor_id, qty, rate, payment_method, discount_amount, purchase_group_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost')
      .eq('period_id', period.id)
      .order('id')),
    // Paged with a unique tiebreaker (S756): it was the one bare read beside a paged one, and a
    // return that falls past the 1000-row cap is frozen out of the snapshot for good (S722's shape).
    fetchAllRows(() => supabase.from('vendor_returns')
      .select('id, vendor_id, qty, rate, purchase_entry_id, payment_method, purchase_entries(vat_inclusive, vat_is_cost)')
      .eq('period_id', period.id)
      .order('id')),
    // EVERY vendor, not only active ones (S792, TAX-7). This list only resolves NAMES for rows built
    // from this month's purchase lines and returns — a report's name map, not a picker (S708).
    // Archiving forces is_active = false, so the active-only read froze an archived supplier's
    // spend as "Unknown Vendor" and its unpaid bills as "Unassigned" — the word the product uses
    // for bills with NO supplier. Paged with a unique tiebreaker like every other read here.
    fetchAllRows(() => scopedFrom('vendors', clientId, 'id, name').order('id')),
  ])
  // Throw on a failed read so runSection() names this section as failed instead of freezing a
  // vendor ledger of zeros into the immutable snapshot (S612).
  throwFirstError(results)
  const [{ data: purchases }, { data: returns }, { data: vendors }] = results

  // S756 (owner decision D10): a return may sit in this month against a bill from an EARLIER month.
  // Read those bills whole — the shared reader VAT/Non-VAT/Vendor Report use — so the return is
  // credited at its own bill's discount. A failed read throws: a frozen section valued at list price
  // because a read dropped would be permanent and silent.
  const outsideIds = returnLinesOutsidePeriod(purchases, returns)
  const priorRes = outsideIds.length > 0 ? await readPriorBillLines(outsideIds) : { data: [], error: null }
  throwFirstError([priorRes])

  const creditIds = (purchases || []).filter(p => p.payment_method === 'Credit').map(p => p.id)
  // Chunked and paged (S723/S629): one row per LINE per settlement, and the id list rides in the URL.
  // The returns against those lines come from ANY month (S849, OWNER-REPORT-8): a return made after
  // the month still lowers what is owed on the month's bill, as Outstanding Payables counts it.
  const [paymentsRes, creditReturnsRes] = creditIds.length > 0
    ? await Promise.all([
      fetchAllRowsChunked(creditIds, ids =>
        scopedFrom('payable_payments', clientId, 'id, purchase_entry_id, amount').in('purchase_entry_id', ids).order('id')),
      fetchAllRowsChunked(creditIds, ids =>
        scopedFrom('vendor_returns', clientId, 'id, purchase_entry_id, qty, rate').in('purchase_entry_id', ids).order('id')),
    ])
    : [{ data: [], error: null }, { data: [], error: null }]
  throwFirstError([paymentsRes, creditReturnsRes])
  const { data: payments } = paymentsRes

  const paidByEntry = {}
  ;(payments || []).forEach(p => { paidByEntry[p.purchase_entry_id] = (paidByEntry[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })

  const vendorNameMap = Object.fromEntries((vendors || []).map(v => [v.id, v.name]))
  const spend = vendorSpendRows({ purchases, returns, priorBillLines: priorRes.data, vendorNameMap })

  // Bill-level aging for unpaid Credit bills — pinned to `generatedAt`, not live `new Date()`.
  // What is still OWED on each bill since schema 18 (S849, OWNER-REPORT-8): VAT added, the discount
  // taken off and returns credited at their discounted price (`unpaidCreditBills`, the Outstanding
  // Payables arithmetic), less its payments. Until v17 it was raw qty × rate less payments, so a
  // discounted bill paid in full aged its discount as unpaid and a VAT bill paid half aged too little.
  // `basis: 'owed'` marks it; an older section has none.
  const billAging = { current: 0, d31_60: 0, d61_90: 0, d90plus: 0, basis: 'owed' }
  const agingBills = []
  const creditBills = unpaidCreditBills({
    lines: purchases, returnedByEntry: returnedByEntryOf(creditReturnsRes.data), paidByEntry,
  })
  creditBills.forEach(({ firstLine: e, remaining }) => {
    if (remaining <= EPS) return
    const adDate = bsToAd(period.bs_year, period.bs_month, e.bs_day || 1)
    const daysOld = Math.max(0, Math.floor((generatedAt - adDate) / 86400000))
    const bucket = billAgingBucket(daysOld)
    billAging[bucket] += remaining
    agingBills.push({ vendorId: e.vendor_id, vendorName: vendorNameMap[e.vendor_id] || 'Unassigned', invoiceRef: e.invoice_ref, bsDay: e.bs_day, remaining, daysOld, bucket })
  })

  return {
    ...spend,
    billAging, agingBills: agingBills.sort((a, b) => b.remaining - a.remaining).slice(0, 15),
  }
}

/**
 * The supplier rows and their totals, on Vendor Report's basis exactly (pure, S855).
 *
 * Every money figure is on the cost basis (S792, D32: × 1.13 on a VAT line of a `vat_is_cost`
 * bill, a return at its line's basis). Per row and for the month:
 *   gross    list price (qty × rate)
 *   discount gross − the lines at their allocated net (Vendor Report's derivation, so a bill whose
 *            lines are all free takes no discount, where the deduped map v18 kept made a negative
 *            Net Spend out of it)
 *   returned returns at their own bill's discounted price, an earlier-month bill included (S756)
 *   net      gross − discount − returned
 *   cash / credit / fonepay   the same net, by how each bill and each return was paid; they add up
 *            to `net`. `grandCash` / `grandCredit` / `grandFonepay` add up to `grandNet`.
 * A row is a supplier with a purchase or a return this month (Vendor Report's population since
 * S728); a bill with no supplier is in the grand figures and in `unassigned`.
 */
export function vendorSpendRows({ purchases, returns, priorBillLines, vendorNameMap = {} }) {
  const P = purchases || []
  const R = returns || []
  const basis = vendorNetBasis(P, priorBillLines)
  const listCost = p => parseFloat(p.qty || 0) * parseFloat(p.rate || 0) * vatCostFactor(p)
  // The bill key for COUNTING bills, single-period by construction (vendor-payables.md); the
  // discount allocation keys bills itself (`allocationBillKey`).
  const billKey = e => e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`
  const figuresOf = (lines, rets) => {
    const gross = lines.reduce((s, p) => s + listCost(p), 0)
    const netPurch = lines.reduce((s, p) => s + basis.lineNetOf(p), 0)
    const returned = rets.reduce((s, r) => s + basis.retValueOf(r), 0)
    return {
      gross, discount: gross - netPurch, returned, net: netPurch - returned,
      billCount: new Set(lines.map(billKey)).size,
      ...netByMethod(lines, rets, basis),
    }
  }

  const vendorIds = [...new Set([...P, ...R].map(x => x.vendor_id).filter(Boolean))]
  const vendorRows = vendorIds.map(vendorId => ({
    vendorId, name: vendorNameMap[vendorId] || 'Unknown Vendor',
    ...figuresOf(P.filter(p => p.vendor_id === vendorId), R.filter(r => r.vendor_id === vendorId)),
  })).sort((a, b) => b.net - a.net)

  const noVendorLines = P.filter(p => !p.vendor_id)
  const noVendorReturns = R.filter(r => !r.vendor_id)
  const grand = figuresOf(P, R)
  return {
    vendors: vendorRows,
    // Gross of the bills with no supplier, as before; `unassigned` carries all their figures.
    unassignedTotal: noVendorLines.reduce((s, p) => s + listCost(p), 0),
    unassigned: noVendorLines.length > 0 || noVendorReturns.length > 0 ? figuresOf(noVendorLines, noVendorReturns) : null,
    grandGross: grand.gross, grandDiscount: grand.discount, grandReturn: grand.returned, grandNet: grand.net,
    grandCash: grand.cash, grandCredit: grand.credit, grandFonepay: grand.fonepay,
    splitBasis: 'net',
  }
}
