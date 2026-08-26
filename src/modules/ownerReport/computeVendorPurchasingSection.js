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
import { fetchAllRows } from '../../shared/fetchAllRows'
import { bsToAd } from '../../utils/bsCalendar'

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
      .select('id, vendor_id, qty, rate, payment_method, discount_amount, purchase_group_id, invoice_ref, bs_day')
      .eq('period_id', period.id)
      .order('id')),
    supabase.from('vendor_returns').select('vendor_id, qty, rate, purchase_entry_id').eq('period_id', period.id),
    scopedFrom('vendors', clientId, 'id, name').eq('is_active', true),
  ])
  // Throw on a failed read so runSection() names this section as failed instead of freezing a
  // vendor ledger of zeros into the immutable snapshot (S612).
  throwFirstError(results)
  const [{ data: purchases }, { data: returns }, { data: vendors }] = results

  const creditIds = (purchases || []).filter(p => p.payment_method === 'Credit').map(p => p.id)
  const paymentsRes = creditIds.length > 0
    ? await scopedFrom('payable_payments', clientId, 'purchase_entry_id, amount').in('purchase_entry_id', creditIds)
    : { data: [] }
  throwFirstError([paymentsRes])
  const { data: payments } = paymentsRes
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

  const vendorNameMap = Object.fromEntries((vendors || []).map(v => [v.id, v.name]))
  const byMethod = (rows, method) => rows.filter(r => (r.payment_method || 'Cash') === method).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)

  const vendorIdsWithActivity = [...new Set((purchases || []).map(p => p.vendor_id).filter(Boolean))]
  const vendorRows = vendorIdsWithActivity.map(vendorId => {
    const vPurchases = (purchases || []).filter(p => p.vendor_id === vendorId)
    const vReturns = (returns || []).filter(r => r.vendor_id === vendorId)
    const gross = vPurchases.reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const discount = vendorDiscountMap[vendorId] || 0
    const returned = vReturns.reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
    return {
      vendorId, name: vendorNameMap[vendorId] || 'Unknown Vendor',
      gross, discount, returned, net: gross - discount - returned,
      billCount: new Set(vPurchases.map(billKey)).size,
      cash: byMethod(vPurchases, 'Cash') - byMethod(vReturns, 'Cash'),
      credit: byMethod(vPurchases, 'Credit') - byMethod(vReturns, 'Credit'),
      fonepay: byMethod(vPurchases, 'FonePay') - byMethod(vReturns, 'FonePay'),
    }
  }).sort((a, b) => b.net - a.net)

  const unassignedTotal = (purchases || []).filter(p => !p.vendor_id).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
  const grandGross = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
  const grandDiscount = Object.values(vendorDiscountMap).reduce((s, d) => s + d, 0)
  const grandReturn = (returns || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)

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
