// The POS Dashboard's arithmetic (S800 stage B), pure so it can be pinned by a test.
//
// The page answers two questions a floor manager and an owner ask during service: what needs a
// person right now (the floor band), and how today is going against the same weekday last week UP
// TO THE SAME CLOCK TIME (the sales band). That comparison is the one Lightspeed and Toast put on
// their home screens; comparing a part-day against a whole prior day would read every lunchtime as
// a collapse, so the earlier day is cut off at this moment's time of day before it is summed.
import { paymentSharesOf } from '../reports/salesReportMath'
import { dineInOnly, seatedCovers } from '../reports/coversMath'
import { nepalHour } from '../../../shared/nepalTime'
import { compareFigures } from '../../../shared/compareFigures'

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/** A paid bill that still counts: the same exclusion Home's POS card and Sales Report make — a
 *  since-Credit-Noted bill's correction posts on the day the note was issued, not here. */
export const countsAsSale = o => o?.close_type === 'paid' && !o.credit_note_id

/** Bills, sales (billed, incl. VAT), covers, discounts and the two averages for a set of bills. */
export function summariseBills(orders) {
  const paid = (orders || []).filter(countsAsSale)
  const sales = paid.reduce((s, o) => s + num(o.paid_amount), 0)
  // S809 3n (REPORTS-3): covers are guests SEATED, the Covers Report's own count (seatedCovers):
  // dine-in bills only, and a since-credit-noted bill keeps its guests. A takeaway or delivery bill
  // is in Sales and Bills, never a guest, so Avg per cover divides only what the dine-in bills charged.
  const covers = seatedCovers((orders || []).filter(o => o?.close_type === 'paid'))
  const dineInSales = dineInOnly(paid).reduce((s, o) => s + num(o.paid_amount), 0)
  const discount = paid.reduce((s, o) => s + num(o.discount_amount), 0)
  const bills = paid.length
  return {
    sales, bills, covers, discount,
    avgBill: bills > 0 ? sales / bills : null,
    // Covers are entered at the table; a takeaway-only day has none, which is not an average of 0.
    avgCover: covers > 0 ? dineInSales / covers : null,
    voids: (orders || []).filter(o => o?.close_type === 'void').length,
    comps: (orders || []).filter(o => o?.close_type === 'writeoff').length,
  }
}

/** Today's figure against last week's — the shared verdict (src/shared/compareFigures.js). */
export const compareToLastWeek = compareFigures

/** Sales per Nepal hour for both days, trimmed to the hours either day traded in (plus the current
 *  hour, so "nothing since 3 PM" shows as an empty bar rather than a chart that stops). */
export function hourlySales(todayOrders, lastWeekOrders, { currentHour = null } = {}) {
  const today = new Array(24).fill(0)
  const lastWeek = new Array(24).fill(0)
  for (const o of todayOrders || []) if (countsAsSale(o)) { const h = nepalHour(o.closed_at); if (h != null) today[h] += num(o.paid_amount) }
  for (const o of lastWeekOrders || []) if (countsAsSale(o)) { const h = nepalHour(o.closed_at); if (h != null) lastWeek[h] += num(o.paid_amount) }
  const active = []
  for (let h = 0; h < 24; h++) if (today[h] > 0 || lastWeek[h] > 0) active.push(h)
  if (currentHour != null) active.push(currentHour)
  if (active.length === 0) return []
  const first = Math.min(...active), last = Math.max(...active)
  const rows = []
  for (let h = first; h <= last; h++) rows.push({ hour: h, today: Math.round(today[h]), lastWeek: Math.round(lastWeek[h]) })
  return rows
}

// How Nepal pays, in the order the tiles read: cash, then the wallets and QR, then card, then the
// bills nobody has paid yet. A Split bill is shared across its legs by amount (paymentSharesOf, the
// Sales Report's own rule), so the rows always add back to the day's sales.
const METHOD_GROUP = {
  Cash: 'Cash', eSewa: 'Wallet / QR', Khalti: 'Wallet / QR', FonePay: 'Wallet / QR',
  Card: 'Card', Credit: 'Credit (unpaid)', Loyalty: 'Loyalty points',
}
const GROUP_ORDER = ['Cash', 'Wallet / QR', 'Card', 'Credit (unpaid)', 'Loyalty points', 'Other']

export function paymentMix(orders, legsByOrder) {
  const by = new Map()
  for (const o of orders || []) {
    if (!countsAsSale(o)) continue
    const amount = num(o.paid_amount)
    for (const { method, share } of paymentSharesOf(o, legsByOrder?.get?.(o.id) || [])) {
      const group = METHOD_GROUP[method] || 'Other'
      by.set(group, (by.get(group) || 0) + amount * share)
    }
  }
  const total = [...by.values()].reduce((s, a) => s + a, 0)
  return GROUP_ORDER.filter(g => by.has(g)).map(g => ({ method: g, amount: by.get(g), share: total > 0 ? by.get(g) / total : 0 }))
}

/** Where a bill came from. There is no channel column: a delivery bill names its partner, a
 *  takeaway has no table, and everything else was served at a table (coversMath.js's isDineIn). */
export function channelOf(order) {
  if (order?.delivery_partner) return 'Delivery'
  if (order?.table_id == null) return 'Takeaway'
  return 'Dine-in'
}

export function channelMix(orders) {
  const by = new Map()
  for (const o of orders || []) {
    if (!countsAsSale(o)) continue
    const c = channelOf(o)
    const row = by.get(c) || { channel: c, bills: 0, amount: 0 }
    row.bills += 1
    row.amount += num(o.paid_amount)
    by.set(c, row)
  }
  return ['Dine-in', 'Takeaway', 'Delivery'].filter(c => by.has(c)).map(c => by.get(c))
}

/** The most-sold dishes by quantity. Comped lines are left out: they were given away, not sold. */
export function topItems(items, n = 5) {
  const by = new Map()
  for (const i of items || []) {
    if (i.comped) continue
    const key = i.recipe_id || i.name
    if (!key) continue
    const row = by.get(key) || { key, name: i.name || 'Unnamed item', qty: 0 }
    row.qty += num(i.qty)
    by.set(key, row)
  }
  return [...by.values()].filter(r => r.qty > 0).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)).slice(0, n)
}

/** The bills still running: how many, the oldest's age in minutes, and what is on them before
 *  discount and VAT (comped lines excluded). */
export function openBillsSummary(openOrders, nowMs = Date.now()) {
  const list = openOrders || []
  const oldest = list.reduce((m, o) => {
    const t = Date.parse(o.opened_at)
    return Number.isFinite(t) && (m == null || t < m) ? t : m
  }, null)
  const value = list.reduce((s, o) => s + (o.pos_order_items || [])
    .filter(i => !i.comped)
    .reduce((t, i) => t + num(i.qty) * num(i.unit_price), 0), 0)
  return { count: list.length, oldestMins: oldest == null ? null : Math.max(0, Math.floor((nowMs - oldest) / 60000)), value }
}

/** Kitchen and bar tickets still being made, and how many of them are past the KDS's late line. */
export function ticketSummary(kotRows, lateMs, nowMs = Date.now()) {
  const working = (kotRows || []).filter(r => r.status === 'new' || r.status === 'in_progress')
  const late = working.filter(r => nowMs - Date.parse(r.sent_at) > lateMs)
  return { working: working.length, late: late.length }
}

/** The AD date seven days before `adIso` (YYYY-MM-DD), computed in UTC so no runtime timezone can
 *  shift the day. */
export function sameWeekdayLastWeek(adIso) {
  const [y, m, d] = String(adIso).split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) - 7 * 86400000
  return new Date(t).toISOString().slice(0, 10)
}
