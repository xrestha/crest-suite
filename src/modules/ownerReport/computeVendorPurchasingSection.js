// Vendor & Purchasing Analytics — mirrors VendorReport.js's per-vendor net-spend/discount-dedup/
// cash-credit-split formulas exactly. One deliberate departure: VendorReport.js's bill aging uses
// live `new Date()` (fine for an always-current interactive page); a FROZEN report must pin aging
// to the moment of generation instead, same principle computeImsSection's payables figure already
// uses — otherwise an outstanding bill's aging bucket would keep drifting after the snapshot is
// supposed to be frozen. No `vendors.credit_terms`/due-date column exists anywhere in the schema —
// this is bill-age-since-purchase, not true payment-terms-SLA compliance.
import { supabase } from '../../supabaseClient'
import { throwFirstError } from '../../shared/queryError'
import { scopedFrom } from '../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { bsToAd } from '../../utils/bsCalendar'
import { allocateBillDiscounts, netFactors, returnBase, mergeFactors, vatCostFactor, returnCostFactor } from '../ims/reports/supplierAttribution'
import { returnLinesOutsidePeriod, priorBillFactors } from '../ims/reports/purchaseTaxSplit'
import { readPriorBillLines } from '../ims/reports/readPriorBillLines'

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
    // from this month's purchase lines — it is a report's name map, not a picker (the S708 rule).
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
  const paymentsRes = creditIds.length > 0
    ? await fetchAllRowsChunked(creditIds, ids =>
      scopedFrom('payable_payments', clientId, 'id, purchase_entry_id, amount').in('purchase_entry_id', ids).order('id'))
    : { data: [], error: null }
  throwFirstError([paymentsRes])
  const { data: payments } = paymentsRes

  // Returns are credited at the price actually paid — net of their own bill's discount — as
  // VendorReport.js has since S725 (`retValueOf`). This section kept the LIST rate for every return,
  // same-month ones included, so a fully returned discounted bill froze a net spend of minus the
  // discount. The period's own factors, plus the earlier-month bills read above (own wins).
  // `returnBase` still falls back to the list rate for an UNLINKED return, which has no bill left.
  // This uses allocateBillDiscounts only for the return FACTORS; the local billKey / discount dedup
  // below stay single-period by design (vendor-payables.md).
  //
  // COST basis since schema v11 (S792, D32): on a `vat_is_cost` bill's VAT lines every figure below
  // is × 1.13 (`vatCostFactor`), and a return takes its line's basis (`returnCostFactor`), so this
  // section agrees with Vendor Report's Net Spend on a PAN-bill outlet. Factor 1 everywhere else.
  const allocated = allocateBillDiscounts(purchases || [])
  const factors = mergeFactors(netFactors(allocated), priorBillFactors(priorRes.data))
  const returnValue = r => returnBase(r, factors) * returnCostFactor(r)
  const listCost = p => parseFloat(p.qty || 0) * parseFloat(p.rate || 0) * vatCostFactor(p)
  const paidByEntry = {}
  ;(payments || []).forEach(p => { paidByEntry[p.purchase_entry_id] = (paidByEntry[p.purchase_entry_id] || 0) + parseFloat(p.amount || 0) })

  const billKey = e => e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`

  // Per-bill discount, deduped (discount_amount is stored per-line but represents a whole-bill
  // discount) — same dedup key VendorReport.js uses.
  const vendorDiscountMap = {}
  const seenBillsForDiscount = new Set()
  ;(purchases || []).forEach(e => {
    const disc = parseFloat(e.discount_amount) || 0
    if (disc <= 0) return
    const gid = billKey(e)
    if (seenBillsForDiscount.has(gid)) return
    seenBillsForDiscount.add(gid)
    const vid = e.vendor_id || '__none__'
    vendorDiscountMap[vid] = (vendorDiscountMap[vid] || 0) + disc
  })
  // A discount on a VAT line of a vat_is_cost bill also took its 13% with it, so on the cost basis
  // it is worth discount-share × 1.13. Added on top of the deduped figure (0 when no such line).
  allocated.forEach(p => {
    const f = vatCostFactor(p)
    if (f === 1) return
    const vid = p.vendor_id || '__none__'
    vendorDiscountMap[vid] = (vendorDiscountMap[vid] || 0) + (p.lineGross - p.lineNet) * (f - 1)
  })

  const vendorNameMap = Object.fromEntries((vendors || []).map(v => [v.id, v.name]))
  const byMethod = (rows, method) => rows.filter(r => (r.payment_method || 'Cash') === method).reduce((s, r) => s + listCost(r), 0)
  const returnsByMethod = (rows, method) => rows.filter(r => (r.payment_method || 'Cash') === method).reduce((s, r) => s + returnValue(r), 0)

  const vendorIdsWithActivity = [...new Set((purchases || []).map(p => p.vendor_id).filter(Boolean))]
  const vendorRows = vendorIdsWithActivity.map(vendorId => {
    const vPurchases = (purchases || []).filter(p => p.vendor_id === vendorId)
    const vReturns = (returns || []).filter(r => r.vendor_id === vendorId)
    const gross = vPurchases.reduce((s, p) => s + listCost(p), 0)
    const discount = vendorDiscountMap[vendorId] || 0
    const returned = vReturns.reduce((s, r) => s + returnValue(r), 0)
    return {
      vendorId, name: vendorNameMap[vendorId] || 'Unknown Vendor',
      gross, discount, returned, net: gross - discount - returned,
      billCount: new Set(vPurchases.map(billKey)).size,
      cash: byMethod(vPurchases, 'Cash') - returnsByMethod(vReturns, 'Cash'),
      credit: byMethod(vPurchases, 'Credit') - returnsByMethod(vReturns, 'Credit'),
      fonepay: byMethod(vPurchases, 'FonePay') - returnsByMethod(vReturns, 'FonePay'),
    }
  }).sort((a, b) => b.net - a.net)

  const unassignedTotal = (purchases || []).filter(p => !p.vendor_id).reduce((s, p) => s + listCost(p), 0)
  const grandGross = (purchases || []).reduce((s, p) => s + listCost(p), 0)
  const grandDiscount = Object.values(vendorDiscountMap).reduce((s, d) => s + d, 0)
  const grandReturn = (returns || []).reduce((s, r) => s + returnValue(r), 0)

  // Bill-level aging for unpaid Credit bills — pinned to `generatedAt`, not live `new Date()`.
  const billAging = { current: 0, d31_60: 0, d61_90: 0, d90plus: 0 }
  const agingBills = []
  const seenBillsForAging = new Set()
  ;(purchases || []).forEach(e => {
    if (e.payment_method !== 'Credit') return
    const gid = billKey(e)
    if (seenBillsForAging.has(gid)) return
    seenBillsForAging.add(gid)
    const billEntries = (purchases || []).filter(p => p.payment_method === 'Credit' && billKey(p) === gid)
    const total = billEntries.reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const paid = billEntries.reduce((s, p) => s + (paidByEntry[p.id] || 0), 0)
    const remaining = Math.max(0, total - paid)
    if (remaining <= EPS) return
    const adDate = bsToAd(period.bs_year, period.bs_month, e.bs_day || 1)
    const daysOld = Math.max(0, Math.floor((generatedAt - adDate) / 86400000))
    const bucket = billAgingBucket(daysOld)
    billAging[bucket] += remaining
    agingBills.push({ vendorId: e.vendor_id, vendorName: vendorNameMap[e.vendor_id] || 'Unassigned', invoiceRef: e.invoice_ref, bsDay: e.bs_day, remaining, daysOld, bucket })
  })

  return {
    vendors: vendorRows, unassignedTotal, grandGross, grandDiscount, grandReturn, grandNet: grandGross - grandDiscount - grandReturn,
    billAging, agingBills: agingBills.sort((a, b) => b.remaining - a.remaining).slice(0, 15),
  }
}
