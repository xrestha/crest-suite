import { supabase } from '../../../supabaseClient'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'

// Every line of each earlier-month bill a return points at (S756, owner decision D10).
//
// A return sits in the month the goods went back and may be against a bill from an EARLIER month.
// Its VAT half is already right — a return's embed reads the linked line's own vat_inclusive
// whatever month it is in — but its VALUE needs that bill's discount, and the bill is not among
// this month's entries. VAT Report and Non-VAT Report both hand these lines to splitPurchaseVat;
// one read, so the two halves of the filing cannot value the same return two ways.
//
// Two reads: the returned lines (for their bill key), then every line of those bills. A legacy line
// with no purchase_group_id is its own lookup on vendor + invoice + day within its own month — the
// fallback key allocateBillDiscounts uses — so its siblings are found too. Paged and chunked: the id
// lists ride in the URL (S629). Returns `{ data, error }` like a supabase read.
export async function readPriorBillLines(lineIds) {
  const cols = 'id, period_id, item_id, vendor_id, qty, rate, bs_day, invoice_ref, vat_inclusive, discount_amount, purchase_group_id'
  const first = await fetchAllRowsChunked(lineIds, ids => supabase.from('purchase_entries').select(cols).in('id', ids).order('id'))
  if (first.error) return first
  const groups = [...new Set(first.data.map(l => l.purchase_group_id).filter(Boolean))]
  const legacy = first.data.filter(l => !l.purchase_group_id)
  const reads = [
    groups.length ? fetchAllRowsChunked(groups, ids => supabase.from('purchase_entries').select(cols).in('purchase_group_id', ids).order('id')) : { data: [], error: null },
    // A fresh builder per page: a supabase-js builder is a one-shot thenable (fetchAllRows' rule).
    ...legacy.map(l => fetchAllRows(() => {
      let q = supabase.from('purchase_entries').select(cols).eq('period_id', l.period_id).is('purchase_group_id', null)
      q = l.bs_day == null ? q.is('bs_day', null) : q.eq('bs_day', l.bs_day)
      q = l.vendor_id ? q.eq('vendor_id', l.vendor_id) : q.is('vendor_id', null)
      q = l.invoice_ref ? q.eq('invoice_ref', l.invoice_ref) : q.is('invoice_ref', null)
      return q.order('id')
    })),
  ]
  const done = await Promise.all(reads)
  const failed = done.find(r => r.error)
  if (failed) return { data: null, error: failed.error }
  const byId = new Map()
  done.forEach(r => (r.data || []).forEach(l => byId.set(l.id, l)))
  return { data: [...byId.values()], error: null }
}
