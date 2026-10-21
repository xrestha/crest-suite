// Vendor Report's one definition of "net" for a purchase line and for a return (S725), moved out of
// VendorReport.js in S855 so the Monthly Owner Report's supplier table reads the same arithmetic
// instead of a copy of it. Pure: no supabase import.
//
// A line's net is its allocated cost: `allocateBillDiscounts` spreads the bill's one discount over
// its lines in proportion to value (max, not sum, S601), and `lineCost` takes the 13% on a VAT line
// of a `vat_is_cost` bill (S792, D32). A return is credited at its own bill's DISCOUNTED rate
// (`returnBase`, S722), including a bill from an earlier month whose lines `priorBillLines` carries
// (S756, D10), on its line's cost basis (`returnCostFactor`).
//
// The per-method split takes the same two figures, so Cash + Credit + FonePay is the Net Spend
// beside it exactly: the three methods are the whole CHECK list on both tables, and NULL reads as
// Cash (`methodOf`, S650). The Owner Report split the list price and so could not add up (S855).

import { allocateBillDiscounts, mergeFactors, netFactors, returnBase, vatCostFactor, returnCostFactor } from './supplierAttribution'
import { priorBillFactors } from './purchaseTaxSplit'
import { methodOf } from '../purchases/purchasesHelpers'

/**
 * `{ lineNetOf, retValueOf }` for one month's purchase lines. `priorBillLines` are the earlier-month
 * bills this month's returns point at (`readPriorBillLines`), or empty.
 *
 * A line that is not among `purchases` falls back to qty × rate on its cost basis, as Vendor Report
 * always did; every caller passes lines from the same read.
 */
export function vendorNetBasis(purchases, priorBillLines) {
  const allocated = allocateBillDiscounts(purchases || [])
  const factors = mergeFactors(netFactors(allocated), priorBillFactors(priorBillLines))
  const netById = new Map(allocated.map(r => [r.id, r.lineCost]))
  const lineNetOf = p => {
    const v = netById.get(p.id)
    return v === undefined ? (parseFloat(p.qty) || 0) * (parseFloat(p.rate) || 0) * vatCostFactor(p) : v
  }
  const retValueOf = r => returnBase(r, factors) * returnCostFactor(r)
  return { lineNetOf, retValueOf }
}

/** Net spend paid by one method: its lines at their net, less its returns at theirs. */
export function netForMethod(purchases, returns, method, { lineNetOf, retValueOf }) {
  return (purchases || []).filter(p => methodOf(p) === method).reduce((s, p) => s + lineNetOf(p), 0)
    - (returns || []).filter(r => methodOf(r) === method).reduce((s, r) => s + retValueOf(r), 0)
}

/** `{ cash, credit, fonepay }` — adds up to the same rows' net spend. */
export function netByMethod(purchases, returns, basis) {
  return {
    cash: netForMethod(purchases, returns, 'Cash', basis),
    credit: netForMethod(purchases, returns, 'Credit', basis),
    fonepay: netForMethod(purchases, returns, 'FonePay', basis),
  }
}
