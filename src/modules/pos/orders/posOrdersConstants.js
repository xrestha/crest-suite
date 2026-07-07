// Pure constants and tiny pure helpers for PosOrders.jsx — no React, no Supabase, no closures.
// Split out so the main component file is just state + data flow.

export const vatOf  = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
export const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

// Shared shape for a pos_order_items row, whether it's about to go straight to Supabase or into
// the offline queue (enqueuePosOrder) — keeps the two write paths from drifting apart.
export const toItemPayload = i => ({
  recipe_id:   i.recipe_id || null,
  name:        i.name,
  category:    i.category   || 'Other',
  qty:         i.qty,
  unit_price:  i.unit_price,
  vat_rate:    i.vat_rate   ?? 0,
  sent_to_kot: i.sent_to_kot || false,
  notes:       i.notes || null,
})

// Only these payment methods are scanned by the customer — Cash/Card/Credit already have their
// own settlement path, so a "scan to pay" QR on the bill would be irrelevant or misleading there.
export const QR_PAY_METHODS = ['eSewa', 'Khalti', 'FonePay']

export const STATUS_BADGE = { available: 'badge-green', occupied: 'badge-red', reserved: 'badge-amber', inactive: 'badge-gray' }
export const STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', inactive: 'Inactive' }

export const PAYMENT_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay']
// Delivery partners (Foodmandu, Pathao, etc.) are NOT payment methods — they don't pay the
// restaurant at the counter (they remit later, minus commission), so their orders close as Credit
// like any other unpaid balance, same as a real customer. The list of platforms itself is
// client-editable (Table Management → Delivery Partners → settings.pos_delivery_partners), not a
// fixed constant here, since aggregators come and go — PosOrders.jsx reads it from
// billingSettings.delivery_partners for the Credit quick-select chips, and commission is only
// entered later, at settlement (PosCustomers.jsx), against the platform's actual remittance.
export const VOID_REASONS    = ['Wrong table', 'Duplicate order', 'Test order', 'Order entry mistake', 'Other']
export const COMP_REASONS    = ['Walkout / unpaid', 'Customer goodwill', 'Customer complaint', 'Staff error', 'Owners', 'Company Guest', 'Other']
export const DEFAULT_DISCOUNT_REASONS = ['Loyalty customer', 'Promo / coupon code', 'Manager goodwill', 'Bulk / corporate order', 'Price match', 'Other']
export const COPY_LABEL = n => n <= 1 ? 'ORIGINAL-COPY' : n === 2 ? 'SECOND-COPY' : n === 3 ? 'THIRD-COPY' : `REPRINT #${n}`

export const btnSm = {
  width: 26, height: 26, borderRadius: 4,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)',
  color: 'var(--theme-text1)',
  cursor: 'pointer', fontSize: 16, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}

export const billInput = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text1)', outline: 'none',
}
