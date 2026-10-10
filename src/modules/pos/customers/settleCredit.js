import { noAnswer } from '../orders/sendAttempt'
import { errorText } from '../../../shared/errorText'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { npr } from '../../../shared/nepalMoney'
import { nepalBsLong, nepalDateAd, nepalTime } from '../../../shared/nepalTime'
import { randomUUID } from '../../../utils/uuid'

// Settling a Credit bill on Customers → Outstanding Credit, and the cash it puts in the drawer: the
// half that can be tested without the page (S809 CUSTOMERS-PARKING-6, SHIFTS-4).
//
// The settle is one conditional write (`.is('credit_settled_at', null)`), so a bill is settled once
// however often it is pressed. Before S809 a lost answer read "the bill was not marked as settled",
// the press after it matched nothing and read "this bill had already been settled — no cash was
// added", and the Collected list named nobody. The cashier took it for a colleague's settlement: the
// cash went back to the guest (the debt lost) or stayed in the drawer with no Cash In (the shift
// closed over).
//
// Now a press with no answer, or one that matched nothing, reads the bill back. `credit_settled_by`
// is the guard's `auth.uid()`, so "who" is a fact. Settled from this login, with the method pressed,
// while this page holds an unanswered press of that method for the bill: it is that press, so carry
// on to the Cash In. Settled by anyone else: say who and when. Unreadable: say it is not known, and
// that this cash is not on the drawer record yet. A press is remembered in page memory only (like a
// till's close marks), for SETTLE_TRY_MS.
//
// The Cash In carries an id minted here. A lost answer is sent again once with the same id, and a
// duplicate-key answer means the first landed, so the drawer is never paid in twice.

/** How long the settle write, and the Cash In insert, wait for an answer. */
export const SETTLE_WRITE_MS = 20000
/** The reads around them: the bill read back, the open shift, the bill's cash entry. */
export const SETTLE_READ_MS = 8000
/** How long an unanswered press on this page still counts as "this settlement": long enough to get
 *  back online and press again, short enough that cash taken on an earlier shift is never added to
 *  a later one by itself. */
export const SETTLE_TRY_MS = 15 * 60 * 1000

/** "9 Kartik 2083 at 7:42 PM". The settling tablet's own clock: the guard stamps who, not when. */
export function settledWhen(ts) {
  const day = nepalBsLong(ts) || nepalDateAd(ts)
  const time = nepalTime(ts)
  return time ? `${day} at ${time}` : day
}

/**
 * What a bill read back after a settle with no answer, or one that matched nothing, says.
 *  'open'    not settled (yet)
 *  'mine'    settled from this login with the method pressed, while this page holds an unanswered
 *            press of that method for the bill: it is that press
 *  'yours'   settled from this login some other way (another screen, an earlier visit, another method)
 *  'other'   settled by another login
 *  'unknown' the bill was not found
 */
export function judgeSettled(stored, { profileId = null, method, tries = [], now = Date.now() } = {}) {
  if (!stored) return 'unknown'
  if (!stored.credit_settled_at) return 'open'
  if (!profileId || stored.credit_settled_by !== profileId) return 'other'
  const pressedHere = tries.some(t => t.method === method && now - t.at < SETTLE_TRY_MS)
  return stored.credit_settled_method === method && pressedHere ? 'mine' : 'yours'
}

const SHIFT_GONE_RE = /pos_cash_movement_(shift_closed|no_shift)/i
const shiftGone = e => SHIFT_GONE_RE.test(`${e?.hint || ''} ${e?.message || ''}`)
const isDuplicate = e => e?.code === '23505'
// The server's own refusal, as fine print. Nothing for no answer: the sentence already says it.
const whyNot = res => (res?.error && !noAnswer(res) ? ` ${errorText(res.error, 'operator')}` : '')

// SHIFTS-4: the next shift's float is counted from the drawer, so cash no shift recorded is either
// kept out of that count and then recorded, or counted in it and not recorded. Both (what the page
// used to ask) put it into Expected Cash twice, and the close read short on that shift's cashier.
const NO_SHIFT_STEPS = 'Keep it out of the float you count when the next shift opens, then record it as a Cash In on that shift. If it stays in the drawer and is counted in the float, record nothing.'
const lookFor = who => `look in Shifts for a "Credit settled" entry for ${who}, and add it as a Cash In only if there is none`
const ADDED = { warn: false, text: " Added to the open shift's cash count." }

/**
 * A Cash settlement's drawer entry. The bill's payment_method stays 'Credit' forever, so without it
 * the shift's cash bucket never saw this money and the drawer read "over" with nothing to explain it
 * (S573). Best-effort: a failed entry must not undo a settlement the customer has paid, so it warns.
 * `checkFirst` (a settlement found by reading the bill back) looks for the bill's entry before adding
 * one. Returns { warn, text }: text follows the settle sentence.
 */
export async function postSettlementCash({ db, order, amount, profileId = null, checkFirst = false, newId = randomUUID }) {
  const who = order.buyer_name || 'customer'
  const amt = npr(amount)
  if (checkFirst) {
    const had = await settleWithin(db.cashFor(order.id), SETTLE_READ_MS, 'Checking the drawer record')
    if (had.error) return { warn: true, text: ` Could not check whether this ${amt} is already on the drawer record, so nothing was added — ${lookFor(who)}.${whyNot(had)}` }
    if (had.data?.length) return { warn: false, text: ' Its cash was already on the drawer record, so it was not added again.' }
  }
  const shift = await settleWithin(db.openShift(), SETTLE_READ_MS, 'Checking for an open shift')
  // A failed read is not "no shift is open" (S682): nothing was added, whichever it is.
  if (shift.error) return { warn: true, text: ` Could not check whether a shift is open, so this ${amt} was not added to any drawer count. If a shift is open, add it there as a Cash In. If none is open, ${NO_SHIFT_STEPS.charAt(0).toLowerCase()}${NO_SHIFT_STEPS.slice(1)}${whyNot(shift)}` }
  if (!shift.data) return { warn: true, text: ` No shift is open, so this ${amt} is not on any drawer count. ${NO_SHIFT_STEPS}` }
  const row = {
    id: newId(),
    shift_id: shift.data.id,
    direction: 'in',
    kind: 'credit_settlement',
    amount,
    reason: `Credit bill settled — ${who}`,
    order_id: order.id,
    created_by: profileId,
  }
  const first = await settleWithin(db.addCash(row), SETTLE_WRITE_MS, 'Adding the cash to the shift')
  if (!first.error) return ADDED
  if (!noAnswer(first)) {
    // The server refused it, so nothing landed (a BEFORE trigger raised).
    if (shiftGone(first.error)) return { warn: true, text: ` The shift closed before this ${amt} could be added, so it is not on any drawer count. ${NO_SHIFT_STEPS}` }
    // The cash is in the drawer and not in Expected Cash, so the close reads OVER (it used to say short).
    return { warn: true, text: ` It could not be added to the open shift's cash count, so the drawer will read ${amt} over — add it as a Cash In on that shift.${whyNot(first)}` }
  }
  // No answer: the same row again. Its id makes a second copy impossible, and a duplicate key means
  // the first one landed.
  const again = await settleWithin(db.addCash(row), SETTLE_WRITE_MS, 'Adding the cash to the shift')
  if (!again.error || isDuplicate(again.error)) return ADDED
  return { warn: true, text: ` It is not known whether this ${amt} reached the open shift's cash count: the answer was lost. Before adding anything, ${lookFor(who)}.` }
}

// `amount` is what actually reached us: a delivery partner remits the bill LESS its commission, so a
// Cash settlement puts paid − commission in the drawer (posting the gross left every such shift short
// by the commission, S754). A direct customer has no commission and pays the whole bill.
async function collected({ db, order, method, amount, profileId, readBack, newId }) {
  const head = `${npr(amount)} collected from ${order.buyer_name || 'customer'} via ${method}` +
    (readBack ? ' (checked by reading the bill back: it is settled once)' : '') + '.'
  if (method !== 'Cash') return { msg: 'ok:' + head, closePanel: true, reload: true }
  const cash = await postSettlementCash({ db, order, amount, profileId, checkFirst: readBack, newId })
  return { msg: (cash.warn ? 'warn:' : 'ok:') + head + cash.text, closePanel: true, reload: true }
}

/**
 * One press of a settle method. `db` is the page's five calls (settle, readBill, openShift, cashFor,
 * addCash); `tries` is the page's memory of unanswered presses (order id → [{ method, at }]), kept
 * across presses and list reloads and lost with the page; `names` maps a login id to its name.
 * Returns { msg, closePanel, reload }, msg prefixed ok:, warn: or error: as the page renders it.
 */
export async function settleCreditBill({
  db, order, method, commission = null, profileId = null, tries, names = null,
  newId = randomUUID, now = Date.now,
}) {
  const who = order.buyer_name || 'customer'
  const at = now()
  const patch = {
    credit_settled_at: new Date(at).toISOString(),
    credit_settled_by: profileId,
    credit_settled_method: method,
  }
  if (commission != null) patch.commission_amount = commission
  const attempt = { method, at }
  tries.set(order.id, [...(tries.get(order.id) || []), attempt])
  const forget = () => tries.set(order.id, (tries.get(order.id) || []).filter(t => t !== attempt))

  const ctrl = new AbortController()
  const res = await settleWithin(db.settle(order.id, patch, ctrl.signal), SETTLE_WRITE_MS, 'Settling the bill')
  // What was never sent is never sent; what the server already had finishes inside its own limits.
  if (isTimeout(res.error)) ctrl.abort()

  if (!res.error && res.data?.length) {
    tries.delete(order.id)
    const amount = (Number(order.paid_amount) || 0) - (patch.commission_amount || 0)
    return collected({ db, order, method, amount, profileId, readBack: false, newId })
  }
  const lost = !!res.error && noAnswer(res)
  if (res.error && !lost) {
    // The server's refusal: the statement rolled back, so "not settled" is true.
    forget()
    return { msg: 'error:The bill was not marked as settled. ' + errorText(res.error, 'operator'), closePanel: false, reload: false }
  }
  // Zero rows is an answer: this press wrote nothing. An earlier unanswered press may have.
  if (!lost) forget()

  const back = await settleWithin(db.readBill(order.id), SETTLE_READ_MS, 'Reading the bill back')
  const stored = back.error ? null : back.data
  const verdict = back.error ? 'unread' : judgeSettled(stored, { profileId, method, tries: tries.get(order.id) || [], now: now() })
  const cashHint = m => (m === 'Cash' ? ` If that cash is in the drawer, ${lookFor(who)}.` : '')

  if (verdict === 'mine') {
    tries.delete(order.id)
    const amount = (Number(stored.paid_amount) || 0) - (Number(stored.commission_amount) || 0)
    return collected({ db, order, method, amount, profileId, readBack: true, newId })
  }
  if (verdict === 'yours' || verdict === 'other') {
    tries.delete(order.id)
    const when = settledWhen(stored.credit_settled_at)
    const how = stored.credit_settled_method || 'an unrecorded method'
    if (verdict === 'yours') {
      const changed = stored.credit_settled_method && stored.credit_settled_method !== method
        ? ` A settlement's method cannot be changed afterwards.` : ''
      return {
        msg: `error:This bill was already settled from your login on ${when}, by ${how}.${changed} Nothing was changed by this press and no cash was added to the drawer.${cashHint(stored.credit_settled_method)}`,
        closePanel: true, reload: true,
      }
    }
    const name = (names && stored.credit_settled_by && names[stored.credit_settled_by]) || null
    const by = name || 'another login'
    const ask = name ? `check with ${name}` : 'find out who settled it'
    return {
      msg: `error:This bill was already settled by ${by} on ${when}, by ${how}. Nothing was changed by this press and no cash was added to the drawer. If the customer is paying you now, ${ask} before taking or handing back any money — it may already have been paid.`,
      closePanel: true, reload: true,
    }
  }
  if (verdict === 'open' && !lost) {
    return { msg: 'error:Nothing was recorded: the bill still shows as not settled. Reload the page and settle it again.', closePanel: true, reload: true }
  }
  const holdCash = method === 'Cash' ? ' Keep the cash aside until then: it is not on the drawer record yet.' : ''
  if (verdict === 'open') {
    return {
      msg: `warn:No answer came back, and the bill still shows as not settled — the settlement may still arrive. Wait half a minute, then press ${method} again: a bill can never be settled twice, and if the first press went through, this page finishes it then.${holdCash}`,
      closePanel: false, reload: false,
    }
  }
  if (!lost) {
    // Matched nothing, so it is settled or gone, and the read that would say by whom failed.
    return {
      msg: `error:This press changed nothing — the bill looks already settled, but it could not be read back to see by whom. No cash was added to the drawer. Reload the page: its row under Collected says who settled it and how.${whyNot(back)}`,
      closePanel: true, reload: true,
    }
  }
  const reloadHint = method === 'Cash'
    ? ` If you reload instead and the bill shows under Collected with your name, ${lookFor(who)}.` : ''
  return {
    msg: `warn:It is not known whether this bill was settled: the answer was lost and the bill could not be read back. Do not hand any money back. When the connection is back, press ${method} again on this bill — a bill can never be settled twice, and if the first press went through, this page finishes it then.${holdCash}${reloadHint}${whyNot(back)}`,
    closePanel: false, reload: false,
  }
}
