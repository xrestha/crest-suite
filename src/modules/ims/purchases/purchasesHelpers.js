// Shared by Purchases.js, PurchaseBillModal.jsx, and ReturnsTab.jsx.
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
  return n.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Bill-level totals: taxable/non-taxable base, discount, VAT, grand total. Discount is spread
// proportionally across taxable/non-taxable before VAT — VAT applies only to the taxable portion
// net of its share of the discount. Shared by PurchaseBillModal's live total and the auto-printed
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
