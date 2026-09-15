import { npr } from '../../../shared/nepalMoney'
// Pure constants and tiny pure helpers for PosOrders.jsx — no React, no Supabase, no closures.
// Split out so the main component file is just state + data flow.

export const vatOf  = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
export const fmtNpr = npr

// Shared shape for a pos_order_items row, whether it's about to go straight to Supabase or into
// the offline queue (enqueuePosOrder) — keeps the two write paths from drifting apart.
//
// sent_qty (stored since migration 20260916100000) is how much of the line the station already
// has: the whole qty when the line is flagged sent, otherwise the carried count from the last send.
// Clamped to qty — after a pull (qty cut below what was fired) the in-memory count stays at the old
// figure, and storing it would make save_pos_order_items record the same removal on every later save.
// unit_price / vat_rate / name / category ride along but are IGNORED by the server: an existing line
// keeps its stored values and a new one is priced from the recipe.
export const toItemPayload = i => {
  const qty = Number(i.qty) || 0
  const kitchenQty = i.sent_to_kot ? qty : (Number(i.sent_qty) || 0)
  return {
    recipe_id:   i.recipe_id || null,
    name:        i.name,
    category:    i.category   || 'Other',
    qty:         i.qty,
    unit_price:  i.unit_price,
    vat_rate:    i.vat_rate   ?? 0,
    sent_to_kot: i.sent_to_kot || false,
    sent_qty:    Math.max(0, Math.min(qty, Math.floor(kitchenQty))),
    notes:       i.notes || null,
    // Crest Customization (S758): the chosen option ids, only when the line has any, so a plain line's
    // payload is byte-identical to before. The server prices and snapshots them; nothing else about
    // an option rides along, because nothing else would be trusted.
    ...(lineOptionIds(i).length ? { options: lineOptionIds(i) } : {}),
  }
}

// A line's chosen option ids: the cart's own `option_ids`, else the ids in its selection key (a line
// read back from the server carries the key and its snapshot, not the array).
export const lineOptionIds = i => {
  if (Array.isArray(i.option_ids) && i.option_ids.length) return i.option_ids.filter(Boolean).map(String)
  return i.selection_key ? String(i.selection_key).split('+').filter(Boolean) : []
}

// Every read that puts an OPEN order on the order screen selects exactly this, so the three paths
// (table tile, takeaway card, offline-conflict recovery) and the stale-order reload cannot drift on
// what an order carries. items_version and sent_qty need migration 20260916100000.
export const OPEN_ORDER_SELECT =
  'id, order_no, covers, status, items_version, pos_order_items(id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty, notes, ' +
  // Crest Customization (S758, migration 20260919130000): the line's selection and its frozen choices.
  'selection_key, base_unit_price, options_delta, option_summary, ' +
  'pos_order_item_options(option_id, group_id, group_name, group_kind, option_name, kitchen_name, is_removal, price_delta, included, ingredient_deltas, sort))'

// A stored line as the cart holds it. sent_qty is the stored count, falling back to the whole qty for
// a line flagged sent before the column existed (its sent_qty defaulted to 0). The embedded options
// snapshot becomes `options` (in display order) and the selection key's ids `option_ids`, so a
// reopened customized line is the same shape the choice window builds.
export const cartLineFromStored = i => {
  const { pos_order_item_options: snap, ...line } = i
  const out = { ...line, sent_qty: i.sent_qty || (i.sent_to_kot ? i.qty : 0) }
  if (line.selection_key) {
    out.option_ids = String(line.selection_key).split('+').filter(Boolean)
    out.options = [...(snap || line.options || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  }
  return out
}

// The identity of a cart line, and the ONE place it is decided. A line is its recipe — unless it
// carries a customization (Crest Customization, `selection_key` = the chosen option ids, sorted and
// joined with '+'), in which case "Momo, extra cheese" and "Momo, no onion" are two lines of one
// recipe and must never merge. A line with no options has an empty selection_key and keys exactly
// as it always did, so every caller below is byte-identical for a client without the module.
// Mirrors the SQL in save_pos_order_items (line_key = recipe_id || '#' || selection_key).
export const lineKeyOf = i => {
  if (i.line_key) return i.line_key
  const sel = i.selection_key || (Array.isArray(i.option_ids) ? selectionKeyOf(i.option_ids) : '')
  if (i.recipe_id) return sel ? `${i.recipe_id}#${sel}` : i.recipe_id
  return `name:${i.name}`
}

// The client twin of the server's selection key: sorted option uuids joined with '+', '' for none.
// Order-independent on purpose — the same options ticked in a different order are the same line.
export const selectionKeyOf = optionIds =>
  (optionIds || []).filter(Boolean).map(String).sort().join('+')

// Lines this device had that `serverLines` does not — by recipe and by quantity difference — as
// UNSENT lines of just the difference. What a stale save (another tablet saved first) or a stale
// offline replay would otherwise lose without a word.
export function missingFromServer(localLines, serverLines) {
  const onServer = new Map()
  for (const s of serverLines || []) onServer.set(lineKeyOf(s), (onServer.get(lineKeyOf(s)) || 0) + (Number(s.qty) || 0))
  const missing = []
  for (const i of localLines || []) {
    const diff = (Number(i.qty) || 0) - (onServer.get(lineKeyOf(i)) || 0)
    if (diff > 0) {
      missing.push({
        recipe_id: i.recipe_id || null, name: i.name, category: i.category || 'Other', qty: diff,
        unit_price: i.unit_price, vat_rate: i.vat_rate, notes: i.notes || '', sent_to_kot: false, sent_qty: 0,
        ...(i.selection_key ? { selection_key: i.selection_key, option_ids: i.option_ids, options: i.options } : {}),
      })
    }
  }
  return missing
}

// Puts `incoming` on top of `base` as UNSENT: a line already on the order (same recipe, same
// customization) gains the quantity, and keeps what the station already has as its sent count, so
// only the addition goes on the next ticket.
export function mergeUnsentLines(base, incoming) {
  const merged = (base || []).map(l => ({ ...l }))
  for (const inc of incoming || []) {
    const key = lineKeyOf(inc)
    const at = inc.recipe_id ? merged.findIndex(l => lineKeyOf(l) === key) : -1
    if (at >= 0) {
      const l = merged[at]
      merged[at] = {
        ...l,
        qty: (Number(l.qty) || 0) + (Number(inc.qty) || 0),
        sent_to_kot: false,
        sent_qty: l.sent_to_kot ? l.qty : (l.sent_qty || 0),
        notes: l.notes || inc.notes || null,
      }
    } else {
      merged.push({ ...inc, sent_to_kot: false, sent_qty: 0 })
    }
  }
  return merged
}

// Whether the order's stored lines are exactly what `payload` (toItemPayload rows) would store — same
// recipes, quantities, sent flags, sent counts and notes. A save refused as stale whose stored lines
// already match is this device's OWN earlier save, whose response was lost: the retry is then a
// success, not a conflict (S754).
export function storedLinesMatchPayload(storedLines, payload) {
  const sig = rows => (rows || [])
    .map(r => [r.recipe_id || '', r.selection_key || selectionKeyOf(r.options), Number(r.qty) || 0, r.sent_to_kot ? 1 : 0, Number(r.sent_qty) || 0, (r.notes || '').trim()].join(''))
    .sort()
    .join('')
  return sig(storedLines) === sig(payload)
}

const SAME_NUMBER = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0001

// How the server's priced lines (save_pos_order_items' returned `items`) differ from the cart:
// 'price' when a unit price or VAT rate moved (the total on screen is no longer the bill), 'label'
// when only a name or category did, null when they agree or there is nothing to compare.
export function menuDrift(localLines, serverItems) {
  if (!Array.isArray(serverItems)) return null
  const byLine = new Map(serverItems.filter(s => s.recipe_id).map(s => [lineKeyOf(s), s]))
  let drift = null
  for (const i of localLines || []) {
    const s = byLine.get(lineKeyOf(i))
    if (!s) continue
    if (!SAME_NUMBER(s.unit_price, i.unit_price) || !SAME_NUMBER(s.vat_rate, i.vat_rate)) return 'price'
    if ((s.name || '') !== (i.name || '') || (s.category || 'Other') !== (i.category || 'Other')) drift = 'label'
  }
  return drift
}

// The cart with each line's price, VAT rate, name and category taken from the server's lines (by
// line key — recipe plus customization). Quantities, notes and sent flags are left alone, so a line
// tapped in while the save was in flight is not disturbed. Returns the same array when nothing changed.
export function withServerLineFields(localLines, serverItems) {
  if (!Array.isArray(serverItems) || !Array.isArray(localLines)) return localLines
  const byLine = new Map(serverItems.filter(s => s.recipe_id).map(s => [lineKeyOf(s), s]))
  let changed = false
  const next = localLines.map(i => {
    const s = byLine.get(lineKeyOf(i))
    if (!s) return i
    const category = s.category || 'Other'
    if (SAME_NUMBER(s.unit_price, i.unit_price) && SAME_NUMBER(s.vat_rate, i.vat_rate)
        && (s.name || '') === (i.name || '') && category === (i.category || 'Other')
        && (!s.selection_key || (s.option_summary || '') === (i.option_summary || ''))) return i
    changed = true
    return {
      ...i, unit_price: Number(s.unit_price) || 0, vat_rate: Number(s.vat_rate) || 0, name: s.name, category,
      // A customized line takes the server's resolved selection too — the summary and snapshot the
      // bill, the ticket and the stock deduction read (S758).
      ...(s.selection_key ? {
        base_unit_price: s.base_unit_price, options_delta: s.options_delta,
        option_summary: s.option_summary, options: s.options,
      } : {}),
    }
  })
  return changed ? next : localLines
}

// Only these payment methods are scanned by the customer — Cash/Card/Credit already have their
// own settlement path, so a "scan to pay" QR on the bill would be irrelevant or misleading there.
export const QR_PAY_METHODS = ['eSewa', 'Khalti', 'FonePay']

// Table status, kitchen/bar stage and the floor strip all live in ../posSignals.js — one colour
// vocabulary for the whole module, and the only copy (PosTableManagement.jsx used to carry a
// second one). Re-exported here so this file stays the single import for PosOrders.jsx.
export {
  TABLE_STATUS_LABEL as STATUS_LABEL,
  TABLE_STATUS_BADGE as STATUS_BADGE,
  KOT_STATUS_LABEL,
  KOT_STATUS_BADGE,
  KOT_STATUS_RANK,
  tableStripColor,
  summarizeTicketStages,
  ticketSummaryChip,
} from '../posSignals'

// Per-line-item KOT/BOT timer shown in the order cart next to the "✓ KOT/BOT" sent badge — same
// Sent/Started/Ready stages as KitchenDisplay.jsx's TicketCard, but compact (a few words, not a
// whole card) since this sits inline on a cart row. `ticket` is a pos_kot_log row (status,
// sent_at, started_at, ready_at, estimated_prep_minutes); `now` is a live-ticking epoch ms so the
// caller re-renders on a timer without this function needing to know about React.
//
// Colours follow ../posSignals.js: a dish cooking to plan is brass (working, nothing to do), not
// amber — amber here used to mean the same thing as "you have not fired this yet", two lines
// apart on the same cart row. Amber and red are kept for the one case that needs a person: past
// the kitchen's own estimate.
export function kotTimerLabel(ticket, now) {
  if (!ticket) return null
  // Finished and at the table (S754) — nothing left to watch, so it is quiet.
  if (ticket.status === 'served') return { text: 'Served', color: 'var(--theme-text3)' }
  if (ticket.status === 'ready') {
    if (ticket.started_at && ticket.ready_at) {
      const actualMin = Math.round((new Date(ticket.ready_at).getTime() - new Date(ticket.started_at).getTime()) / 60000)
      return { text: `Ready (${actualMin}m)`, color: 'var(--theme-green-text)' }
    }
    return { text: 'Ready', color: 'var(--theme-green-text)' }
  }
  if (ticket.status === 'in_progress') {
    if (ticket.started_at && ticket.estimated_prep_minutes) {
      const remainingMin = Math.round((new Date(ticket.started_at).getTime() + ticket.estimated_prep_minutes * 60000 - now) / 60000)
      const over = remainingMin < 0
      return { text: over ? `${Math.abs(remainingMin)}m over` : `~${remainingMin}m left`, color: over ? 'var(--theme-red-text)' : 'var(--theme-accent-ink)' }
    }
    return { text: 'Cooking', color: 'var(--theme-accent-ink)' }
  }
  // 'new' — sent but not yet started
  const sentMin = Math.max(0, Math.round((now - new Date(ticket.sent_at).getTime()) / 60000))
  return { text: `Sent ${sentMin}m ago`, color: 'var(--theme-text3)' }
}

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
// Asked for whenever a line is cut BELOW the quantity the kitchen or bar has already been sent —
// the food exists, so its disappearance from the bill needs a stated cause. Deliberately not the
// same list as VOID_REASONS: voiding is about a whole bill that was never fulfilled, this is about
// one dish that was. Recorded server-side in pos_kot_removals by save_pos_order_items, so the
// reason is the only part of the record the browser contributes.
export const KOT_PULL_REASONS = [
  'Kitchen 86 / out of stock',
  'Wrong item fired',
  'Customer changed their mind',
  'Moved to another table',
  'Quality issue — remade',
  'Other',
]
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
  width: 40, height: 40, borderRadius: 0,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)',
  color: 'var(--theme-text1)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}

export const billInput = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text1)', outline: 'none',
}

// Trailing delay before the Billing modal's live preview is handed to its iframe. Assigning
// `srcDoc` rebuilds the whole document (17 ms median / 22 ms p90 measured in Chromium on a
// desktop, for a 22-line bill), so without this the cashier paid a full document re-parse per
// character typed into the buyer, discount and tender fields. Chosen to sit just above a fast
// typist's inter-key interval, so a hand still moving skips the intermediate documents and a
// hand that has paused sees the bill immediately — the same 400 ms-class trade the loyalty
// lookup on the same modal already makes, tightened because this one is purely visual.
export const PREVIEW_DEBOUNCE_MS = 200
