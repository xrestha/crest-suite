// The POS Dashboard's arithmetic (S800 stage B), pure so it can be pinned by a test.
//
// The page answers two questions a floor manager and an owner ask during service: what needs a
// person right now (the floor band), and how today is going against the same weekday last week UP
// TO THE SAME CLOCK TIME (the sales band). That comparison is the one Lightspeed and Toast put on
// their home screens; comparing a part-day against a whole prior day would read every lunchtime as
// a collapse, so the earlier day is cut off at this moment's time of day before it is summed.
import { paymentSharesOf } from '../reports/salesReportMath'
import { coversTotals, isDineIn } from '../reports/coversMath'
import { nepalHour } from '../../../shared/nepalTime'
import { compareFigures } from '../../../shared/compareFigures'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/** A paid bill is a sale on the day it closed, a since-credit-noted one included (S814 4d, REPORTS-5,
 *  owner Q22 (a)). Its credit note is a minus on the day the NOTE was issued (`returnsOf`): the Sales
 *  Report's rule (salesReportMath.buildSalesEntries), which the Owner Report has followed since
 *  schema 15. So a bill sold on Saturday and credited on Monday leaves Saturday's figure as it was and
 *  takes its value off Monday. */
export const countsAsSale = o => o?.close_type === 'paid'

/**
 * Credit notes as returns: [{ order, net, at }], `net` NEGATIVE (−net_amount, the note's stored
 * figure as printed) and `at` the moment it was issued. `order` is the bill it credits, from `byId`
 * (a Map or an object of the bills the page read) or else from the bill embedded on the note row,
 * which is how a note against an earlier day's bill brings its table, method and partner.
 */
export function returnsOf(notes, byId) {
  const lookup = id => (byId?.get ? byId.get(id) : byId?.[id]) || null
  return (notes || []).map(n => ({
    order: lookup(n.order_id) || n.pos_orders || null,
    net: -num(n.net_amount),
    at: n.created_at,
  }))
}

/**
 * Bills, sales (billed, incl. VAT), covers, discounts and the two averages for a set of bills and the
 * credit notes issued over the same window.
 *
 *   Sales          Σ paid_amount of the paid bills + Σ the returns' (negative) nets.
 *   Bills          every paid bill, a credited one included: it was sold.
 *   Covers         guests seated (coversMath.seatedCovers): dine-in bills only, a credited one
 *                  keeps its guests (S809 3n, REPORTS-3).
 *   Avg per cover  the Covers Report's arithmetic (coversTotals): dine-in sales, less the notes on
 *                  dine-in bills, ÷ seated guests. Takeaway and delivery are in neither side.
 *   Avg bill       Sales ÷ Bills.
 *   Discounts      as given on the bills; a note does not give a discount back.
 */
export function summariseBills(orders, returns = []) {
  const all = orders || []
  const rets = returns || []
  const paid = all.filter(countsAsSale)
  const returnNet = rets.reduce((s, r) => s + num(r.net), 0)
  const sales = paid.reduce((s, o) => s + num(o.paid_amount), 0) + returnNet
  const ct = coversTotals(paid, o => num(o.paid_amount), rets)
  const discount = paid.reduce((s, o) => s + num(o.discount_amount), 0)
  const bills = paid.length
  return {
    sales, bills, covers: ct.covers, discount,
    dineInBills: ct.bills,
    returns: rets.length, returnNet,
    avgBill: bills > 0 ? sales / bills : null,
    // Covers are entered at the table; a takeaway-only day has none, which is not an average of 0.
    avgCover: ct.covers > 0 ? ct.revPerCover : null,
    voids: all.filter(o => o?.close_type === 'void').length,
    comps: all.filter(o => o?.close_type === 'writeoff').length,
  }
}

/** Today's figure against last week's — the shared verdict (src/shared/compareFigures.js). */
export const compareToLastWeek = compareFigures

/** Sales per Nepal hour for both days, trimmed to the hours either day traded in (plus the current
 *  hour, so "nothing since 3 PM" shows as an empty bar rather than a chart that stops). A credit note
 *  sits in the hour it was issued, as a minus (REPORTS-5), so an hour can come out below zero. */
export function hourlySales(todayOrders, lastWeekOrders, { currentHour = null, todayReturns = [], lastWeekReturns = [] } = {}) {
  const today = new Array(24).fill(0)
  const lastWeek = new Array(24).fill(0)
  const addBills = (into, orders) => {
    for (const o of orders || []) if (countsAsSale(o)) { const h = nepalHour(o.closed_at); if (h != null) into[h] += num(o.paid_amount) }
  }
  const addReturns = (into, returns) => {
    for (const r of returns || []) { const h = nepalHour(r.at); if (h != null) into[h] += num(r.net) }
  }
  addBills(today, todayOrders); addReturns(today, todayReturns)
  addBills(lastWeek, lastWeekOrders); addReturns(lastWeek, lastWeekReturns)
  const active = []
  for (let h = 0; h < 24; h++) if (today[h] !== 0 || lastWeek[h] !== 0) active.push(h)
  if (currentHour != null) active.push(currentHour)
  if (active.length === 0) return []
  const first = Math.min(...active), last = Math.max(...active)
  const rows = []
  for (let h = first; h <= last; h++) rows.push({ hour: h, today: Math.round(today[h]), lastWeek: Math.round(lastWeek[h]) })
  return rows
}

/** The busiest hour of each day in `hourlySales` rows: `{ today, lastWeek }`, each `{ hour, amount }`
 *  or null when that day sold nothing above zero in any hour. The chart's text summary (2026-10-15
 *  audit): a supervisor sees this chart but not the Sales Report's Hourly table, so the peak has to
 *  be said in words too. A tie goes to the earlier hour. */
export function hourlyPeaks(rows) {
  const peakOf = key => {
    let best = null
    for (const r of rows || []) if (r[key] > 0 && (!best || r[key] > best.amount)) best = { hour: r.hour, amount: r[key] }
    return best
  }
  return { today: peakOf('today'), lastWeek: peakOf('lastWeek') }
}

// How Nepal pays, in the order the tiles read: cash, then the wallets and QR, then card, then the
// bills nobody has paid yet. A Split bill is shared across its legs by amount (paymentSharesOf, the
// Sales Report's own rule), so the rows always add back to the day's sales.
const METHOD_GROUP = {
  Cash: 'Cash', eSewa: 'Wallet / QR', Khalti: 'Wallet / QR', FonePay: 'Wallet / QR',
  Card: 'Card', Credit: 'Credit (unpaid)', Loyalty: 'Loyalty points', Deposit: 'Booking deposits',
}
const GROUP_ORDER = ['Cash', 'Wallet / QR', 'Card', 'Credit (unpaid)', 'Loyalty points', 'Booking deposits', 'Other']

/** A credit note comes off the methods its bill was paid with, in the same shares (a Split bill's
 *  legs), the way the Sales Report's Payment Summary attributes it. `legsByOrder` must hold the legs
 *  of every credited Split bill too, today's or not. */
export function paymentMix(orders, legsByOrder, returns = []) {
  const by = new Map()
  const add = (order, amount) => {
    for (const { method, share } of paymentSharesOf(order, (order && legsByOrder?.get?.(order.id)) || [])) {
      const group = METHOD_GROUP[method] || 'Other'
      by.set(group, (by.get(group) || 0) + amount * share)
    }
  }
  for (const o of orders || []) if (countsAsSale(o)) add(o, num(o.paid_amount))
  for (const r of returns || []) add(r.order, num(r.net))
  const total = [...by.values()].reduce((s, a) => s + a, 0)
  return GROUP_ORDER.filter(g => by.has(g)).map(g => ({ method: g, amount: by.get(g), share: total > 0 ? by.get(g) / total : 0 }))
}

/** Where a bill came from. There is no channel column: a delivery bill names its partner, a bill
 *  served at a table is dine-in (coversMath.js's isDineIn: it has a table, or it is a part bill split
 *  off a table's bill, S836, which has none of its own), and everything else is takeaway. The row
 *  must carry `table_id` AND `part_of_order_id`, or a part bill reads as takeaway. */
export function channelOf(order) {
  if (order?.delivery_partner) return 'Delivery'
  if (!isDineIn(order)) return 'Takeaway'
  return 'Dine-in'
}

/** Sales by channel. A credit note comes off its bill's channel and is counted apart from the bills
 *  (`returns`): it is not a bill. */
export function channelMix(orders, returns = []) {
  const by = new Map()
  const rowOf = c => by.get(c) || { channel: c, bills: 0, returns: 0, amount: 0 }
  for (const o of orders || []) {
    if (!countsAsSale(o)) continue
    const row = rowOf(channelOf(o))
    row.bills += 1
    row.amount += num(o.paid_amount)
    by.set(row.channel, row)
  }
  for (const r of returns || []) {
    const row = rowOf(channelOf(r.order))
    row.returns += 1
    row.amount += num(r.net)
    by.set(row.channel, row)
  }
  return ['Dine-in', 'Takeaway', 'Delivery'].filter(c => by.has(c)).map(c => by.get(c))
}

/** The most-sold dishes by quantity. Comped lines are left out: they were given away, not sold. A
 *  dish on a bill credited since is still counted: the plate went out (the caller reads the lines of
 *  every paid bill, a credited one included). */
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

/** What a bill still running comes to, the way the guest will pay it (owner decision): VAT included
 *  when the outlet is VAT registered (`vatReg`), before any bill discount, to the rupee. It is the
 *  payment window's own total with no discount (computeOrderAmounts' net), so the floor tiles, the
 *  Billing list and the POS Dashboard all show the figure the bill will open on. A comped row counts
 *  (S854, owner decision: the tile matches the order screen). A comp is written only as a bill closes,
 *  so a comped row on an open order is a close in flight or one a cancelled close left behind, and the
 *  order screen folds that back into its line and charges it (foldCompedSplits); the next save hands
 *  the comp back. The free dishes of a close are taken off in the payment window, never here. */
export function openBillTotal(items, vatReg) {
  const lines = (items || [])
    .map(i => ({ ...i, comped: false, qty: num(i.qty), unit_price: num(i.unit_price), vat_rate: num(i.vat_rate) }))
  return computeOrderAmounts({ discount_amount: 0 }, lines, vatReg).net
}

/** The bills still running: how many, the oldest's age in minutes, and what is on them as the guests
 *  will pay it (openBillTotal: VAT included when `vatReg`, before discount, as the order screen). */
export function openBillsSummary(openOrders, nowMs = Date.now(), vatReg = true) {
  const list = openOrders || []
  const oldest = list.reduce((m, o) => {
    const t = Date.parse(o.opened_at)
    return Number.isFinite(t) && (m == null || t < m) ? t : m
  }, null)
  const value = list.reduce((s, o) => s + openBillTotal(o.pos_order_items, vatReg), 0)
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
