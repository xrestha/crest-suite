// One stock_movements row as Stock Movements shows and totals it (S809 4e, IMS-HANDOFF-6).
//
// A sale is stored as a NEGATIVE qty (stock out) and a Credit Note put-back (pos_credit_restock) as a
// positive one (stock back). The page used to take |qty| for every row and sign it by source alone,
// so a SALE row that added stock (a choice taking off an ingredient the dish's recipe does not use,
// e.g. "No onion" on a dish with no onion: nothing is clamped, S758) read as a depletion, and its
// value was ADDED to Value Depleted when the ledger had taken it off. Book Stock (stockReportCalc)
// nets every row by its sign; this page now does too (owner decision D5): Value Depleted and Comp
// Value are net, and such a row shows with a minus and is named.

export const RESTOCK_SOURCE = 'pos_credit_restock'

/**
 * `qtyOut` is what left the shelf (−qty: positive for a depletion, negative for stock added), `value`
 * is qtyOut × the item's rate (so stock added counts against the period's depletion), `addsStock`
 * whether the row put stock back, and `unexpectedAdd` whether it did so without being a Credit Note
 * put-back, which only a sale whose choices outweigh its recipe can do. An unreadable qty or rate is
 * 0, never NaN. Pure.
 *
 * @param {{ qty: number|string, source?: string }} m - a stock_movements row.
 * @param {number|string} rate - the item's per_uom_rate.
 * @returns {{ qtyOut: number, value: number, addsStock: boolean, unexpectedAdd: boolean }}
 */
export function movementFigures(m, rate) {
  const qty = parseFloat(m?.qty)
  const qtyOut = Number.isFinite(qty) && qty !== 0 ? -qty : 0
  const r = parseFloat(rate)
  const value = qtyOut * (Number.isFinite(r) ? r : 0)
  const addsStock = qtyOut < 0
  return { qtyOut, value, addsStock, unexpectedAdd: addsStock && m?.source !== RESTOCK_SOURCE }
}
