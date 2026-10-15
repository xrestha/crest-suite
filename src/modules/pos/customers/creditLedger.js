import { normalizePhone } from '../../../utils/phone'
import { nepalCivilDate } from '../../../shared/nepalTime'
import { invoiceCodeOf } from '../../../shared/invoiceCode'
import { billVatRegistered } from '../../../utils/posBillingMath'

// Customer credit (udharo) that takes part payments (S843): the arithmetic Customers → Credit, the
// money receipt, the statement and the ageing view share, with no React and no Supabase in it.
//
// The database is the authority on what is owed: pos_credit_open_bills (migration 20261015120000)
// answers each unpaid Credit bill's `owed` = paid − Σ(amount + commission) of its receipt lines whose
// receipt is not cancelled. Nothing here recomputes owed from paid_amount; it only proposes how a
// payment is spread over those figures, and record_credit_receipt re-checks every line under the
// bills' row locks (no line above what its bill owes, Σ amount = the amount received).
//
// Money is worked in whole paisa (integers) and handed back in rupees with two decimals, so a split
// never leaves a float's 0.30000000000000004 on a receipt line the server would refuse.

// ── Who a Credit bill belongs to ─────────────────────────────────────────────────────────────────

// SQL's btrim(text) with no second argument strips SPACES only, so a tab or a no-break space stays,
// and the two keys must agree on the same typed text.
const btrim = s => String(s ?? '').replace(/^ +| +$/g, '')

/**
 * The JS twin of pos_credit_party_key(delivery_partner, buyer_phone, buyer_name) (S843): the partner's
 * name, else the number the phone is (pos_phone_canonical's twin, normalizePhone, 7+ digits), else the
 * name, each lower-cased and space-trimmed behind a prefix saying which kind it is. The till's
 * credit-limit warning and this page group by it; creditLedger.test.js holds it to the SQL CASE.
 */
export function creditPartyKey({ delivery_partner, buyer_phone, buyer_name } = {}) {
  const partner = btrim(delivery_partner)
  if (partner) return `partner:${partner.toLowerCase()}`
  const phone = normalizePhone(buyer_phone)
  if (phone) return `phone:${phone}`
  const name = btrim(buyer_name)
  if (name) return `name:${name.toLowerCase()}`
  return 'unknown'
}

/** 'partner' for a delivery partner's key, 'customer' for a phone or name key, null otherwise. */
export function partyKindOf(key) {
  const k = String(key || '')
  if (k.startsWith('partner:')) return 'partner'
  if (k.startsWith('phone:') || k.startsWith('name:')) return 'customer'
  return null
}

// ── Money in paisa ───────────────────────────────────────────────────────────────────────────────

/** Rupees to whole paisa, half up. toFixed(6) first, so 1.005 (stored as 1.00499…) is 101, not 100. */
export function toPaisa(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  const p = Math.round(Number((Math.abs(x) * 100).toFixed(6)))
  return x < 0 ? -p : p
}

/** Whole paisa back to rupees, exact to two decimals. */
export function fromPaisa(p) {
  return Math.round(Number(p) || 0) / 100
}

/**
 * What the cashier typed in an amount box, as paisa. '' (nothing typed) is `{ paisa: null }`; a figure
 * with more than two decimals, a negative or text is `{ error }` in plain words. Commas and spaces
 * (12,48,650) are allowed, because that is how the figure reads everywhere else on the page.
 */
export function parseAmount(text) {
  const raw = String(text ?? '').replace(/[\s,]/g, '')
  if (raw === '') return { paisa: null, error: null }
  if (!/^\d*(\.\d*)?$/.test(raw) || raw === '.') return { paisa: null, error: 'Type the amount as a number, like 1500 or 1500.50.' }
  if (/\.\d{3,}$/.test(raw)) return { paisa: null, error: 'Rupees and paisa only: at most two figures after the point.' }
  return { paisa: toPaisa(raw), error: null }
}

// ── A bill's label and age ───────────────────────────────────────────────────────────────────────

/** The bill number as the bill printed it: TI or PB from its own stamp, the outlet code it was issued under. */
export function creditBillLabel(bill, vatReg, currentPrefix) {
  if (bill?.invoice_no == null) return `#${bill?.order_no ?? ''}`
  const prefix = invoiceCodeOf(bill, currentPrefix)
  return `${billVatRegistered(bill, vatReg) ? 'TI' : 'PB'}${bill.invoice_no}-${prefix}${prefix ? '-' : ''}${bill.invoice_fy || ''}`
}

/**
 * Whole days between two moments as Nepal's calendar counts them: a bill closed at 23:55 in Kathmandu
 * is one day old at 00:05, and one closed at 00:05 is 0 days old all that day, wherever the viewer
 * sits. Both sides go through nepalCivilDate (local midnight of the Nepal day), and the difference is
 * rounded, so a daylight-saving runtime's 23- or 25-hour day still counts as one. null when either
 * moment is missing.
 */
export function nepalDaysBetween(fromTs, toTs = new Date()) {
  const a = nepalCivilDate(fromTs)
  const b = nepalCivilDate(toTs)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

/** The four age bands, by Nepal days since the bill was closed. */
export const AGE_BUCKETS = [
  { key: 'd30', label: '0–30 days', max: 30 },
  { key: 'd60', label: '31–60 days', max: 60 },
  { key: 'd90', label: '61–90 days', max: 90 },
  { key: 'over90', label: 'Over 90 days', max: Infinity },
]

/** The band a bill of `days` falls in; a bill with no date is counted as the oldest, never hidden. */
export function ageBucketOf(days) {
  if (days == null || !Number.isFinite(days)) return 'over90'
  const d = Math.max(0, days)
  return AGE_BUCKETS.find(b => d <= b.max).key
}

const emptyBuckets = () => Object.fromEntries(AGE_BUCKETS.map(b => [b.key, 0]))

// ── Grouping the unpaid bills by who owes them ───────────────────────────────────────────────────

/**
 * pos_credit_open_bills' rows (oldest first) grouped by party, each party's bills oldest first. A
 * party's name and phone are its most recent bill's (the receipt's rule), a partner's name as typed.
 * `limits` maps a party key to its credit limit in rupees (pos_customers.credit_limit, phone parties
 * only); `overLimit` is true only when a limit is set and the owed figure is above it.
 * Sorted by what is owed, most first, then by name.
 */
export function groupByParty(bills, { limits = null, now = new Date() } = {}) {
  const map = new Map()
  for (const b of bills || []) {
    const key = b.party_key || creditPartyKey(b)
    let g = map.get(key)
    if (!g) {
      g = { key, kind: partyKindOf(key), name: '', phone: '', partner: null, bills: [], owedPaisa: 0, latestAt: null, oldestAt: null }
      map.set(key, g)
    }
    g.bills.push(b)
    g.owedPaisa += toPaisa(b.owed)
    const at = b.closed_at ? Date.parse(b.closed_at) : NaN
    if (Number.isFinite(at)) {
      if (g.oldestAt == null || at < Date.parse(g.oldestAt)) g.oldestAt = b.closed_at
      if (g.latestAt == null || at >= Date.parse(g.latestAt)) {
        g.latestAt = b.closed_at
        g.partner = btrim(b.delivery_partner) || null
        g.name = g.partner || btrim(b.buyer_name) || ''
        if (b.buyer_phone) g.phone = b.buyer_phone
      }
    }
    if (!g.name) g.name = btrim(b.delivery_partner) || btrim(b.buyer_name) || ''
    if (!g.phone && b.buyer_phone) g.phone = b.buyer_phone
  }
  const parties = [...map.values()].map(g => {
    const limit = limits && Object.prototype.hasOwnProperty.call(limits, g.key) ? limits[g.key] : null
    const owed = fromPaisa(g.owedPaisa)
    return {
      key: g.key, kind: g.kind, name: g.name || 'Customer', phone: g.phone, partner: g.partner,
      bills: g.bills, billCount: g.bills.length, owed, oldestAt: g.oldestAt,
      oldestDays: g.oldestAt ? nepalDaysBetween(g.oldestAt, now) : null,
      limit: limit == null ? null : Number(limit),
      overLimit: limit != null && g.owedPaisa > toPaisa(limit),
    }
  })
  return parties.sort((a, b) => (b.owed - a.owed) || a.name.localeCompare(b.name))
}

/**
 * Who owes what, by age: each party's owed split into the four bands, plus the column totals. Every
 * figure is summed from the same rows, so a row's total and the grand total tie to the paisa.
 */
export function ageingByParty(bills, { now = new Date() } = {}) {
  const parties = groupByParty(bills, { now })
  const totals = emptyBuckets()
  let grand = 0
  const rows = parties.map(p => {
    const b = emptyBuckets()
    for (const bill of p.bills) {
      const key = ageBucketOf(nepalDaysBetween(bill.closed_at, now))
      const owed = toPaisa(bill.owed)
      b[key] += owed
      totals[key] += owed
      grand += owed
    }
    return {
      key: p.key, kind: p.kind, name: p.name, phone: p.phone, billCount: p.billCount,
      buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, fromPaisa(v)])),
      total: p.owed,
    }
  })
  return {
    rows,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, fromPaisa(v)])),
    total: fromPaisa(grand),
  }
}

/** One party's owed split into the bands (the statement's footer). */
export function ageingOf(bills, { now = new Date() } = {}) {
  const b = emptyBuckets()
  let total = 0
  for (const bill of bills || []) {
    const owed = toPaisa(bill.owed)
    b[ageBucketOf(nepalDaysBetween(bill.closed_at, now))] += owed
    total += owed
  }
  return { buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, fromPaisa(v)])), total: fromPaisa(total) }
}

// ── Spreading a payment over the bills ───────────────────────────────────────────────────────────

/**
 * The commission a delivery partner keeps on a bill, suggested from the settle flow's rule (S596): the
 * agreed rate on the bill's ex-VAT, post-discount, non-comped base, rounded to the rupee, less what was
 * already kept on it by earlier receipts, never below 0 nor above what the bill still owes. null when
 * the base or the rate is unknown (the box is then left for the cashier to fill from the statement).
 */
export function suggestedCommission({ base, pct, alreadyKept = 0, owed }) {
  const b = Number(base)
  const r = Number(pct)
  if (base == null || pct == null || pct === '' || !Number.isFinite(b) || !Number.isFinite(r)) return null
  const full = Math.round(b * r / 100)
  const rest = toPaisa(full) - toPaisa(alreadyKept)
  return fromPaisa(Math.min(Math.max(0, rest), Math.max(0, toPaisa(owed))))
}

/**
 * How one payment is spread over a party's unpaid bills (S843, owner decision: oldest first, never
 * more than is owed). Inputs, all money in paisa:
 *   bills       the party's open bills, oldest first (pos_credit_open_bills' order), each { order_id, owed }
 *   total       the amount received as typed, or null when the box is empty
 *   excluded    order ids the cashier unticked: never filled automatically
 *   pinned      { order_id: paisa } amounts the cashier set on a bill (a tick pins the bill's whole room)
 *   commission  { order_id: paisa } kept by a delivery partner; counted only on a bill taking part
 * Pinned amounts are placed first; whatever of the total is left fills the other ticked bills oldest
 * first, each up to its room (owed − commission). With nothing typed in the total, the total is what
 * the pinned bills add up to. Returns the rows, the effective total, the RPC's lines (rupees, two
 * decimals, only bills taking part) and the problems that stop the payment, in plain words.
 */
export function allocatePayment({ bills, total = null, excluded = [], pinned = {}, commission = {} }) {
  const skip = new Set(excluded)
  const pins = pinned || {}
  const comm = commission || {}
  const rows = (bills || []).map(b => {
    const owed = toPaisa(b.owed)
    const kept = Math.max(0, Math.round(Number(comm[b.order_id]) || 0))
    return { orderId: b.order_id, bill: b, owed, commission: kept, room: Math.max(0, owed - kept), amount: 0, ticked: false, pinned: false, excluded: skip.has(b.order_id) }
  })
  const problems = []
  let pinnedSum = 0
  for (const r of rows) {
    if (r.excluded || !Object.prototype.hasOwnProperty.call(pins, r.orderId)) continue
    const p = Math.max(0, Math.round(Number(pins[r.orderId]) || 0))
    r.pinned = true
    r.amount = p
    pinnedSum += p
    if (p > r.room) problems.push({ orderId: r.orderId, text: `More than this bill still owes (${moneyText(r.room)} after commission).` })
  }
  const effTotal = total == null ? pinnedSum : Math.max(0, Math.round(Number(total) || 0))
  let left = effTotal - pinnedSum
  if (left < 0) {
    problems.push({ text: `The bills you set add up to ${moneyText(pinnedSum)}, more than the ${moneyText(effTotal)} received. Raise the amount received or untick a bill.` })
  }
  for (const r of rows) {
    if (left <= 0) break
    if (r.excluded || r.pinned || r.room <= 0) continue
    const take = Math.min(r.room, left)
    r.amount = take
    left -= take
  }
  for (const r of rows) {
    r.ticked = !r.excluded && (r.pinned || r.amount > 0)
    if (!r.ticked) r.amount = 0
    if (r.commission > r.owed) problems.push({ orderId: r.orderId, text: `The commission is more than this bill still owes (${moneyText(r.owed)}).` })
    r.owedAfter = Math.max(0, r.owed - (r.ticked ? r.amount + r.commission : 0))
  }
  const placed = rows.reduce((s, r) => s + (r.ticked ? r.amount : 0), 0)
  if (left > 0) {
    const room = rows.reduce((s, r) => s + (r.excluded ? 0 : r.room), 0)
    const unticked = rows.reduce((s, r) => s + (r.excluded ? r.room : 0), 0)
    problems.push({
      over: true,
      text: unticked > 0
        ? `${moneyText(effTotal)} is more than the ${moneyText(room)} the ticked bills still owe. Tick more bills, or lower the amount received.`
        : `${moneyText(effTotal)} is more than the ${moneyText(room)} still owed. A customer can never pay more than they owe, so the extra cannot be taken as an advance.`,
    })
  }
  if (effTotal <= 0 && !problems.length) problems.push({ empty: true, text: 'Type the amount received, or tick the bills being paid.' })
  const lines = rows
    .filter(r => r.ticked && (r.amount + r.commission) > 0)
    .map(r => ({ order_id: r.orderId, amount: fromPaisa(r.amount), commission: fromPaisa(r.commission) }))
  if (effTotal > 0 && !lines.length && !problems.length) problems.push({ text: 'No bill takes any of this payment. Tick a bill.' })
  const commissionTotal = rows.reduce((s, r) => s + (r.ticked ? r.commission : 0), 0)
  return {
    rows, total: effTotal, placed, left: Math.max(0, left), commissionTotal, lines,
    problems, ok: problems.length === 0 && effTotal > 0 && placed === effTotal && lines.length > 0,
  }
}

// `NPR 1,500` or `NPR 1,500.50`, for the sentences above. Kept local so this file stays free of Intl
// set-up; the page formats its own figures through nepalMoney.
function moneyText(paisa) {
  const r = fromPaisa(paisa)
  const whole = Math.trunc(r)
  const grouped = String(whole).replace(/(\d)(?=(\d\d)+\d$)/g, '$1,')
  const pa = Math.abs(Math.round(paisa)) % 100
  return `NPR ${grouped}${pa ? `.${String(pa).padStart(2, '0')}` : ''}`
}

// ── The statement and a receipt as at its own moment ─────────────────────────────────────────────

const atMs = ts => {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? t : NaN
}

/** debit − credit of one pos_credit_party_events row, in paisa. */
const eventNet = e => toPaisa(e.debit) - toPaisa(e.credit)

/** A party's balance from every event strictly before `ts`, in rupees. */
export function balanceBefore(events, ts) {
  const cut = atMs(ts)
  let p = 0
  for (const e of events || []) {
    const t = atMs(e.event_at)
    if (Number.isFinite(t) && t < cut) p += eventNet(e)
  }
  return fromPaisa(p)
}

/**
 * A statement over [fromTs, toTs] (Nepal day boundaries, as instants): the balance brought forward,
 * each event in range with the running balance after it, and the balance carried at the end.
 * pos_credit_party_events answers oldest first; sorted again here (time, then the RPC's own kind
 * order) so a page that pages the read cannot reorder it.
 */
export function statementOf(events, { fromTs, toTs }) {
  const from = atMs(fromTs)
  const to = atMs(toTs)
  const sorted = [...(events || [])].sort((a, b) => (atMs(a.event_at) - atMs(b.event_at)) || String(a.kind).localeCompare(String(b.kind)))
  let bal = 0
  let debit = 0
  let credit = 0
  const rows = []
  for (const e of sorted) {
    const t = atMs(e.event_at)
    if (Number.isFinite(to) && t > to) continue
    if (Number.isFinite(from) && t < from) { bal += eventNet(e); continue }
    rows.push({ ...e, opening: false })
  }
  const opening = bal
  for (const r of rows) {
    bal += eventNet(r)
    debit += toPaisa(r.debit)
    credit += toPaisa(r.credit)
    r.balance = fromPaisa(bal)
  }
  return { opening: fromPaisa(opening), rows, closing: fromPaisa(bal), totalDebit: fromPaisa(debit), totalCredit: fromPaisa(credit) }
}

/**
 * What a bill still owed straight after `receipt` was recorded: its total, less every receipt line on
 * it whose receipt was recorded by then and not yet cancelled at that moment (the receipt itself
 * included, even if cancelled later). A reprint therefore says what the original said.
 * `lines` are every receipt line on the bill; `receiptsById` maps a receipt id to { received_at, cancelled_at }.
 */
export function owedAfterReceipt({ paid, lines, receiptsById, receipt }) {
  const t = atMs(receipt.received_at)
  let cleared = 0
  for (const l of lines || []) {
    const r = l.receipt_id === receipt.id ? receipt : receiptsById?.[l.receipt_id]
    if (!r) continue
    const rt = atMs(r.received_at)
    const active = l.receipt_id === receipt.id
      || (rt < t && (!r.cancelled_at || atMs(r.cancelled_at) > t))
    if (active) cleared += toPaisa(l.amount) + toPaisa(l.commission)
  }
  return fromPaisa(Math.max(0, toPaisa(paid) - cleared))
}

/** The previous and new balance a receipt prints: every event before it, then less what it cleared. */
export function receiptBalances(events, receipt, cleared) {
  const before = toPaisa(balanceBefore(events, receipt.received_at))
  return { previous: fromPaisa(before), next: fromPaisa(before - toPaisa(cleared)) }
}

// ── The Collected list ───────────────────────────────────────────────────────────────────────────

/** "RC-12": a money receipt's number on screen and paper (its fiscal year is printed beside it). */
export function receiptNoLabel(r) {
  return `RC-${r?.receipt_no ?? ''}`
}

/**
 * Bills settled whole before receipts existed (credit_settled_at in range) that have NO receipt line:
 * a bill cleared by receipts is stamped settled too, and those are listed through their receipts.
 */
export function legacySettlements(bills, orderIdsWithLines) {
  const has = orderIdsWithLines instanceof Set ? orderIdsWithLines : new Set(orderIdsWithLines || [])
  return (bills || []).filter(b => b.credit_settled_at && !has.has(b.id))
}

/**
 * The Collected list: receipts and old whole-bill settlements in one list, newest first, each row
 * `{ type: 'receipt' | 'settled', at, row }`.
 */
export function collectedRows(receipts, legacy) {
  const out = [
    ...(receipts || []).map(r => ({ type: 'receipt', at: r.received_at, id: `r:${r.id}`, row: r })),
    ...(legacy || []).map(b => ({ type: 'settled', at: b.credit_settled_at, id: `b:${b.id}`, row: b })),
  ]
  return out.sort((a, b) => (atMs(b.at) - atMs(a.at)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A cancel reason as the server takes it: trimmed, 3 to 300 characters. Returns the sentence when it is not. */
export function cancelReasonProblem(text) {
  const n = String(text ?? '').trim().length
  if (n < 3) return 'Say why the payment is being cancelled (at least 3 characters).'
  if (n > 300) return `Keep the reason to 300 characters (it is ${n}).`
  return null
}
