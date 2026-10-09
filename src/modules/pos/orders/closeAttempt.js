import { fmtNpr } from './posOrdersConstants'
import { computeOrderAmounts, billVatRegistered } from '../../../utils/posBillingMath'
import { phoneForRecord } from '../../../utils/phone'

// A bill close whose answer was lost (S776) — the pure half of S809 CHECKOUT-7.
//
// When Confirm Payment times out, the till reads the bill back: closed by this login means the first
// try landed, open means it has not landed YET. Before S809 the till treated the second reading as
// final the moment the cashier pressed Cancel, and finished a later landing from whatever the screen
// showed by then (another method, a comp, a changed discount). These helpers decide when "open" is
// final, and describe and finish a closed bill from what the server STORED rather than the screen.

// How long after a close write stops waiting without an answer before a read that finds the bill still
// open is taken as final. The till cancels the request when it stops waiting, so nothing more is sent;
// a request the server had already received finishes inside the server's own limits (a signed-in
// login's statements and lock waits are cut off at 8 s, live `authenticated`/`authenticator`
// rolconfig, 2026-10-09), well within this.
export const CLOSE_LAND_GRACE_MS = 30000

// Counts a close write as in flight until it finishes, and records from when an "open" read is final.
// `Promise.resolve` runs the query builder exactly once: a supabase builder sends its request again each
// time it is awaited, so the caller awaits the promise returned here, never the builder itself.
// supabase-js answers a dropped connection or a cancelled request with `status: 0`. A 2xx or 4xx is the
// database's own answer (closed, or refused), after which nothing of that write can still land. A 5xx
// may come from the gateway in front of it while the database is still working, so it counts as none.
export function trackCloseWrite(attempt, builder, now = Date.now) {
  attempt.writesInFlight = (attempt.writesInFlight || 0) + 1
  const write = Promise.resolve(builder)
  const done = answered => {
    attempt.writesInFlight -= 1
    const at = now() + (answered ? 0 : CLOSE_LAND_GRACE_MS)
    attempt.finalAfter = Math.max(attempt.finalAfter ?? 0, at)
  }
  write.then(res => { const s = Number(res?.status) || 0; done(s >= 100 && s < 500) }, () => done(false))
  return write
}

// Whether a read that found the bill still open settles the attempt as "did not close": only once no
// write of it is still travelling, and the read began after the last one could have landed.
export function openReadIsFinal(attempt, readStartedAt) {
  if (!attempt || (attempt.writesInFlight || 0) > 0 || attempt.finalAfter == null) return false
  return readStartedAt >= attempt.finalAfter
}

// The payment a closed bill carries, in the till's own words: "Cash NPR 3,400", "Split NPR 2,400".
export function describeStoredPayment(row) {
  if (!row) return ''
  if (row.close_type === 'writeoff') return 'Complimentary'
  if (row.close_type === 'void') return 'Void'
  return `${row.payment_method || 'paid'} ${fmtNpr(Number(row.paid_amount) || 0)}`
}

// Whether the bill a first try closed differs from the payment on screen now: another method, or an
// amount more than the rupee rounding apart. `screen` is { method, amount } ('Split' for split tenders).
export function storedPaymentDiffers(row, screen) {
  if (!row || !screen || row.close_type !== 'paid') return false
  if ((row.payment_method || '') !== (screen.method || '')) return true
  return Math.abs((Number(row.paid_amount) || 0) - (Number(screen.amount) || 0)) >= 0.5
}

// The sentence the floor shows when they differ, or null. Says what was stored, what the screen said,
// and the one thing the cashier can still do about it.
export function paymentDifferenceNote(where, row, screen) {
  if (!storedPaymentDiffers(row, screen)) return null
  return `The first try closed ${where} as ${describeStoredPayment(row)}, not ${screen.method} ${fmtNpr(Number(screen.amount) || 0)} as the screen showed — the bill printed and posted is the stored one. If the guest paid another way, tell a manager before the drawer is counted.`
}

// Whether a stored paid bill's own charged lines come to what it was paid, within the rupee rounding.
// They can disagree when a second press's save replaced the lines (comps included) after the first
// try went out and before it landed. The printed Net Amount is computed from the lines, so the paper
// would then disagree with the money taken — the till cannot correct a closed bill, but it must say so.
// The bill's own tax status decides, as it does on the paper (S809 2c); `vatReg` only for a row with none.
export function storedLinesMatchPaid(row, items, vatReg) {
  if (!row || row.close_type !== 'paid' || !items) return true
  const { net } = computeOrderAmounts(row, items.filter(i => !i.comped), billVatRegistered(row, vatReg))
  return Math.abs(net - (Number(row.paid_amount) || 0)) < 1
}

// The bill-level discount as a share of what was charged before it, from the STORED lines with the
// comped ones left out — the same base the till's own discRatio uses (paySubEx).
export function storedDiscountRatio(items, discountAmount) {
  const base = (items || []).filter(i => !i.comped)
    .reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0)
  const d = Number(discountAmount) || 0
  return base > 0 && d > 0 ? Math.min(1, d / base) : 0
}

// The Split legs a settled close may still record: that try's own tenders, never the screen's, and none
// once any leg is already on the bill. The Loyalty leg is the redemption's own and never sent from here.
// `existing` null means the legs could not be read: the insert is tried, and the server (which refuses
// legs beyond the bill) decides.
export function legsToRecord(sentTenders, existing) {
  if (existing && existing.some(l => l.payment_method !== 'Loyalty')) return []
  return (sentTenders || []).filter(t => t.method !== 'Loyalty')
}

// The customer-book row a closed bill names, taken from the bill rather than the screen. Null unless it
// carries both a name and a phone, as the till's own buyerCustomerRow requires. The phone is stored as
// the number (S809 3k), so a bill typed "+977 …" by an older till still updates the regular's one row.
export function customerRowFromBill(row, nowIso) {
  const name = String(row?.buyer_name || '').trim()
  const phone = phoneForRecord(row?.buyer_phone)
  if (!name || !phone) return null
  const address = String(row.buyer_address || '').trim()
  const pan = String(row.buyer_pan || '').trim()
  return { name, phone, updated_at: nowIso, ...(address ? { address } : {}), ...(pan ? { pan } : {}) }
}

// The comped lines of the latest comp on a stored bill: the slip a settled close prints. A comp an
// earlier failed try reserved carries a lower number, so only the highest is this close's.
export function latestCompRows(items) {
  const comped = (items || []).filter(i => i.comp_no != null)
  if (comped.length === 0) return { compNo: null, rows: [] }
  const compNo = Math.max(...comped.map(i => Number(i.comp_no)))
  return { compNo, rows: comped.filter(i => Number(i.comp_no) === compNo) }
}
