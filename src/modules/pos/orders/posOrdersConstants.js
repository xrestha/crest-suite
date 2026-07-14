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
// Same stage-color-strip treatment as KitchenDisplay.jsx's TicketCard, applied to a floor-plan
// tile — a small badge chip alone doesn't read from across a room; a full-width color band does.
// The badge stays too, so status is never conveyed by color alone.
export const STATUS_COLOR = { available: 'var(--theme-green)', occupied: 'var(--theme-red)', reserved: 'var(--theme-amber)', inactive: 'var(--theme-border)' }

// Kitchen/bar status pulled from pos_kot_log for the floor-view table badge — same 3 stages as
// KitchenDisplay.jsx's board, worded from the wait staff's point of view rather than the kitchen's
// (they don't "start" or "ready" a ticket, they see it get Sent/Started/Ready).
export const KOT_STATUS_BADGE = { new: 'badge-red', in_progress: 'badge-amber', ready: 'badge-green' }
export const KOT_STATUS_LABEL = { new: 'Sent', in_progress: 'Started', ready: 'Ready' }
// Lower = less done. When a table has multiple open tickets at different stages, the floor badge
// shows the least-advanced one — that's the one still needing attention.
export const KOT_STATUS_RANK  = { new: 0, in_progress: 1, ready: 2 }

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
// The 1st print (n=1) carries no label at all — it IS the original, nothing to distinguish it
// from. Every print after that is "COPY OF ORIGINAL - (n)" where n counts the copy/reprint
// itself, not the total print count — e.g. the 2nd print overall is copy 1, the 5th print
// overall is copy 4. Matches Nepal e-billing reprint-labeling convention (sequential "Copy of
// Original" count), not the earlier ORIGINAL-COPY/SECOND-COPY/THIRD-COPY/REPRINT#n scheme,
// which borrowed Rule 17(2)'s triplicate (3 simultaneous distribution copies) wording for a
// different concept (sequential reprints over time) — the two don't actually map cleanly.
export const COPY_LABEL = n => n <= 1 ? '' : `COPY OF ORIGINAL - (${n - 1})`

// 40x40 rather than the 44px touch-target ideal — the largest that comfortably fits the 320px
// cart column and 52px top bar without reflowing either layout; still a large jump from the
// 26x26 it replaced, on the single most-tapped control on the busiest screen in the app.
export const btnSm = {
  width: 40, height: 40, borderRadius: 8,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)',
  color: 'var(--theme-text1)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}

export const billInput = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text1)', outline: 'none',
}
