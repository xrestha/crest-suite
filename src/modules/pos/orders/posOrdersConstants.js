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
// A delivery-aggregator order (Foodmandu/Pathao) is its own top-level payment_method, not a
// Split-payment leg — the platform handles the whole transaction, so "half Foodmandu half Cash"
// doesn't correspond to anything real. Kept separate from PAYMENT_METHODS so the split-tender-leg
// picker (which reuses PAYMENT_METHODS) never offers them; only the main Pay-tab selector does.
export const DELIVERY_PARTNER_METHODS = ['Foodmandu', 'Pathao']
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
