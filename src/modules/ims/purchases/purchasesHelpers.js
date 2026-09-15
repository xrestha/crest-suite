// Shared by Purchases.js, PurchaseBillForm.jsx, and ReturnsTab.jsx. Pure — no supabase import, so
// purchasesHelpers.test.js can load it.

// How a vendor bill was settled. Distinct from POS's PAYMENT_METHODS (posOrdersConstants.js) on
// purpose — that is how a GUEST pays us, this is how we pay a SUPPLIER, and the two lists have no
// reason to move together. It had been retyped identically in PurchaseBillForm.jsx and
// PurchaseOrders.js; S650 added a third reader (the Purchases payment filter), which is the point
// at which two copies become a list that can disagree with itself.
//
// 'Cash' is also the fallback everything renders for a NULL — bills written before the column
// existed, and the form's own default. Anything filtering on a method must therefore treat NULL as
// Cash, or the filter returns fewer rows than the screen it is filtering shows.
export const PURCHASE_PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']

// The one place that NULL-reads-as-Cash fallback is applied. A value DISPLAYED through a fallback
// must also be filtered, grouped and counted through it (S650) — and this had drifted back out:
// Purchases.js kept a private copy for its filter/option list/row badge while Vendor Report's
// Cash/Credit/FonePay columns tested the raw column, so every bill written before the column
// existed fell into NONE of the three and the trio could not sum to the Net Spend beside them.
export const methodOf = p => p?.payment_method || 'Cash'

// Returns the effective conversion factor (>1) for an item, or 1 if no conversion set.
export function getCf(item) {
  const cf = parseFloat(item?.conversion_factor)
  return (cf > 1 && item?.purchase_unit) ? cf : 1
}

// A sub-paisa unit rate is legitimate (a PCS item bought by the 1000), so a flat toFixed(2) would
// print "0.00" for exactly the entries these hints exist to expose. Mirrors Items.js's fmtPerUom.
export function fmtRate(v) {
  const n = parseFloat(v)
  if (!isFinite(n) || n <= 0) return '—'
  if (n < 0.01) return parseFloat(n.toFixed(6)).toString()
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Bill-level totals: taxable/non-taxable base, discount, VAT, grand total. Discount is spread
// proportionally across taxable/non-taxable before VAT — VAT applies only to the taxable portion
// net of its share of the discount. Shared by PurchaseBillForm's live total and the auto-printed
// PurchaseBillPrint voucher so the two can never drift apart.
export function calcBillTotals(lines, discountAmt) {
  const taxableBase    = lines.reduce((s, l) => l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
  const nonTaxableBase = lines.reduce((s, l) => !l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
  const subTotal  = taxableBase + nonTaxableBase
  const discount  = parseFloat(discountAmt) || 0
  const vatTaxable = subTotal > 0 ? taxableBase * (1 - discount / subTotal) : 0
  const vatTotal    = vatTaxable * 0.13
  const grandTotal  = subTotal - discount + vatTotal
  return { taxableBase, nonTaxableBase, subTotal, discount, vatTotal, grandTotal }
}

// Every bill in `entries` valued over ALL of its lines, keyed the way the Purchases list keys a
// bill (`purchase_group_id || id`). Returns Map<key, { lineCount, ...calcBillTotals }>.
//
// S756: the Purchases register grouped its FILTERED rows and valued each group as a bill, so the
// Item filter — which narrows per LINE — handed calcBillTotals one surviving line and the WHOLE
// bill's discount: a 10-line NPR 10,000 bill with a 1,000 discount, filtered to one 500 line, read
// Bill Total −500 and the footer's Total payable summed it. A filter may choose which bills and
// lines are SHOWN; it must never choose which lines a bill is valued from (vendor-payables.md,
// S723). So the page builds this from the unfiltered period and looks each shown bill up in it.
//
// The discount is the max the lines repeat, never a sum (S601) — every line carries the same one.
export function billTotalsByKey(entries) {
  const byKey = new Map()
  for (const e of entries || []) {
    const key = e.purchase_group_id || e.id
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(e)
  }
  const out = new Map()
  byKey.forEach((lines, key) => {
    const discount = Math.max(0, ...lines.map(l => parseFloat(l.discount_amount) || 0))
    const totals = calcBillTotals(lines, discount)
    // The supplier's own printed figures (S756, D13) ride along so the register can flag a bill
    // whose paper and Crest disagree without re-deriving either.
    const invoiceVat = billInvoiceAmount(lines, 'invoice_vat_amount')
    const invoiceTotal = billInvoiceAmount(lines, 'invoice_total_amount')
    out.set(key, {
      lineCount: lines.length, ...totals, invoiceVat, invoiceTotal,
      invoiceCheck: invoiceMismatch({ invoiceVat, invoiceTotal }, totals),
    })
  })
  return out
}

// ─── Invoice figures as printed on the supplier's bill (S756, owner decision D13) ─────────────
//
// Two OPTIONAL bill-level numbers — the VAT and the grand total exactly as the paper bill prints
// them — so a mis-keyed rate, a missed line or a VAT tick on the wrong row shows up the day the
// bill is entered instead of at the month's VAT filing. Blank means "not typed", never 0: a bill
// with no VAT printed on it is typed as 0, and that IS a comparison.
//
// Stored like `discount_amount`: repeated on every line of the bill (purchase_entries is per line),
// read back once per bill. Unlike the discount, NULL is meaningful, so the read is "the largest
// non-null value" rather than max-with-0.

// The one tolerance. Rounding on a paper bill (a VAT line printed to the rupee, a grand total
// rounded to the nearest 0.50 or 1) is ordinary; a difference past one rupee is a keying error.
export const INVOICE_TOLERANCE_NPR = 1

// '' / null / undefined → null (not typed). A number or numeric string → that number. Anything else
// → NaN, so the form can refuse it by name rather than saving a guess.
export function parseInvoiceAmount(v) {
  if (v == null) return null
  const raw = String(v).trim().replace(/,/g, '')
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : NaN
}

// Why an invoice figure cannot be saved, or '' when it can. `label` names the box.
export function invoiceAmountError(v, label) {
  const n = parseInvoiceAmount(v)
  if (n === null) return ''
  if (Number.isNaN(n)) return `Enter the ${label} as a number, or leave it blank.`
  if (n < 0) return `The ${label} cannot be negative. Type it exactly as the supplier's bill prints it, or leave it blank.`
  return ''
}

// One bill's stored invoice figure from its lines: the largest non-null value, or null when no line
// carries one (every bill entered before S756, and every bill where the box was left blank).
export function billInvoiceAmount(lines, column) {
  let best = null
  for (const l of lines || []) {
    const n = parseInvoiceAmount(l?.[column])
    if (n === null || Number.isNaN(n)) continue
    best = best === null ? n : Math.max(best, n)
  }
  return best
}

// Compare the supplier's printed figures with what Crest calculated (`calcBillTotals` output).
// Each side is checked only when its figure was typed. `vatDiff`/`totalDiff` are invoice − Crest,
// so a positive number means the paper bill asks for MORE than Crest worked out.
export function invoiceMismatch({ invoiceVat = null, invoiceTotal = null } = {}, totals) {
  const crestVat = Number(totals?.vatTotal) || 0
  const crestTotal = Number(totals?.grandTotal) || 0
  const has = n => n !== null && n !== undefined && !Number.isNaN(n)
  const vatDiff = has(invoiceVat) ? invoiceVat - crestVat : null
  const totalDiff = has(invoiceTotal) ? invoiceTotal - crestTotal : null
  const vatMismatch = vatDiff !== null && Math.abs(vatDiff) > INVOICE_TOLERANCE_NPR
  const totalMismatch = totalDiff !== null && Math.abs(totalDiff) > INVOICE_TOLERANCE_NPR
  return {
    checked: vatDiff !== null || totalDiff !== null,
    vatDiff, totalDiff, vatMismatch, totalMismatch,
    mismatch: vatMismatch || totalMismatch,
  }
}

// One plain sentence per side that disagrees, for a Tip or a warning line. Empty when nothing does.
export function invoiceMismatchText(check, { crestVat, crestTotal, invoiceVat, invoiceTotal } = {}) {
  if (!check?.mismatch) return ''
  const fmt = n => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const parts = []
  if (check.vatMismatch) {
    parts.push(`The supplier's bill shows VAT of NPR ${fmt(invoiceVat)}, but the lines entered work out to NPR ${fmt(crestVat)} (${check.vatDiff > 0 ? 'bill is higher' : 'bill is lower'} by NPR ${fmt(Math.abs(check.vatDiff))}).`)
  }
  if (check.totalMismatch) {
    parts.push(`The supplier's bill totals NPR ${fmt(invoiceTotal)}, but the lines entered work out to NPR ${fmt(crestTotal)} (${check.totalDiff > 0 ? 'bill is higher' : 'bill is lower'} by NPR ${fmt(Math.abs(check.totalDiff))}).`)
  }
  return parts.join(' ')
}

// ─── Late returns: a return against a bill from an earlier month (S756, owner decision D10) ────
//
// A return SITS in the month it happened (its own period_id and bs_day), and may point at a bill
// from any of the twelve months before it. Milk bought 28 Bhadra and sent back 2 Ashwin is an
// Ashwin return against a Bhadra bill.

// How many months back a bill may be picked from. A year covers every real supplier credit note;
// the limit exists so the picker is a list someone can read, not a hard rule about returns.
export const LATE_RETURN_MONTHS = 12

const periodIndex = p => (Number(p?.bs_year) || 0) * 12 + (Number(p?.bs_month) || 0)

// The periods a return entered in `period` may take its bill from: `period` itself first, then
// every EARLIER period within `months` months, newest first. Never a later one — goods cannot go
// back before they were bought.
export function returnBillPeriods(periods, period, months = LATE_RETURN_MONTHS) {
  if (!period) return []
  const here = periodIndex(period)
  const earlier = (periods || [])
    .filter(p => p.id !== period.id)
    .filter(p => { const i = periodIndex(p); return i < here && i >= here - months })
    .sort((a, b) => periodIndex(b) - periodIndex(a))
  return [period, ...earlier]
}

// How much of a purchase line (base units) is still returnable, given EVERY return already recorded
// against it — whichever month each sits in. `excludeReturnId` is the return being edited, which
// must not count against its own cap.
//
// It used to be computed from the returns of the month on screen only. Once a return can sit in a
// later month than its bill, that list no longer contains every return against the line, and the
// same 10 kg could be returned in full once in Bhadra and again in Ashwin.
export function remainingReturnableQty(lineQty, priorReturns, excludeReturnId = null) {
  const prior = (priorReturns || [])
    .filter(r => r && r.id !== excludeReturnId)
    .reduce((s, r) => s + (parseFloat(r.qty) || 0), 0)
  const total = parseFloat(lineQty) || 0
  return { total, prior, remaining: total - prior }
}

// Whether a return day is acceptable, or the reason it is not. The "not before its bill" rule only
// applies when the bill is in the SAME month as the return: two day numbers from different months
// do not compare (day 2 of Ashwin is after day 28 of Bhadra), and a bill from an earlier month is
// before every day of this one by construction.
export function returnDayProblem({ retDay, maxDay, billDay, samePeriod }) {
  const d = parseInt(retDay, 10)
  if (!d || d < 1 || d > maxDay) return 'range'
  const b = parseInt(billDay, 10)
  if (samePeriod && b && d < b) return 'before-bill'
  return ''
}

// Why a bill-level discount cannot be saved, or '' when it can (S756). The box was an
// `<input type="number" min="0">` outside any <form>, so constraint validation never ran and a
// negative discount, or one larger than the goods on the bill, saved a grand total below zero —
// a bill the vendor owes US for, on a screen meant to record what we owe them. `subTotal` is the
// ex-VAT goods value the discount comes off (calcBillTotals' subTotal). A discount equal to it is
// allowed: a bill that was given away entirely is a real, if rare, bill. The half-paisa tolerance
// absorbs float noise in a summed subtotal, never a real rupee.
export function billDiscountError(discountAmt, subTotal) {
  const raw = discountAmt == null ? '' : String(discountAmt).trim()
  if (raw === '') return ''
  const d = Number(raw)
  if (!Number.isFinite(d)) return 'Enter the discount as a number, or leave it blank.'
  if (d < 0) return 'A discount cannot be negative. Enter the amount taken off the bill, or leave it blank.'
  const goods = Number(subTotal) || 0
  if (d > goods + 0.005) {
    const fmt = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return `The discount (NPR ${fmt(d)}) is more than the goods on this bill (NPR ${fmt(goods)} before VAT), which would leave the bill below zero. Check the discount and the line rates.`
  }
  return ''
}

// One bill = one vendor's invoice on one day of one period. Prefers purchase_group_id; falls back
// to a vendor+invoice+date composite for older rows written before that column existed. Needs
// `period` (not just the row) because cross-period call sites (Outstanding Payables, Vendor
// Balance Confirmation) can't disambiguate bills across months/years from bs_day alone.
export function billKeyOf(e, period) {
  return e.purchase_group_id
    || `${e.vendor_id || e.vendors?.name || 'unknown'}|${e.invoice_ref || 'noinv'}|${period.bs_year}-${period.bs_month}-${e.bs_day || 0}`
}

// Aging bucket for a Credit bill's remaining balance, by calendar days since the bill date.
export function aging(days) {
  if (days <= 30) return { label: 'Current',    color: 'var(--theme-green-text)' }
  if (days <= 60) return { label: '31–60 days', color: 'var(--theme-accent-ink)' }
  if (days <= 90) return { label: '61–90 days', color: 'var(--theme-amber-text)' }
  return                 { label: '90+ days',   color: 'var(--theme-red-text)' }
}

// What a line row IS before it is saved (S698). Three states, because the old filter
// (`item && qty > 0 && rate > 0`) collapsed two of them into "not saved": the default empty row —
// correctly ignored — and a row with an item and a quantity but no price, which was dropped from
// the save with nothing on screen to say so. Those are different facts. A 'blank' row is ignored;
// an 'incomplete' row is refused BY NAME; and a 'complete' row with a rate of 0 or nothing in the
// box is a FREE line (buy 10 get 1 free) — stock goes up, spend does not. Decision, Aashish
// 2026-09-08: accept NPR 0 lines rather than have free goods folded into the paid quantity, which
// mispriced the rate, or left out, which the next stock count then read as a surplus.
export function lineState(l) {
  const hasItem = !!l.item_id
  const qty  = parseFloat(l.qty)
  const rate = parseFloat(l.rate)
  const touched = hasItem || (l.qty !== '' && l.qty != null) || (l.rate !== '' && l.rate != null) || !!l.expiry_date || !!l.shelf_life
  if (!touched) return 'blank'
  if (hasItem && qty > 0 && !(rate < 0)) return 'complete'
  return 'incomplete'
}
