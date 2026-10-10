import { lineKeyOf, storedLinesMatchPayload } from './posOrdersConstants'
import { isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'

// A save of the order whose answer was lost (S809 ORDER-FLOW-3, -4, -5) — the pure half.
//
// Send Order, Update Order, KOT and BOT each save the order with the dishes they fire marked sent, and
// print only once that save answers (S654). Before S809 a lost answer was reported as "nothing printed —
// press again", although the save may have landed. A retry storing exactly the same lines was taken as
// that landed save; any other retry (BOT alone, Just save, one more dish first) was refused as "changed
// on another device" and reloaded the dishes ✓ sent with no ticket ever printed (ORDER-FLOW-3). And
// because EVERY such refusal was matched that way, a second tablet firing the same unsent dishes took
// the first tablet's save for its own and printed the order a second time (ORDER-FLOW-4).
//
// Now each save leaves a mark (newSendAttempt) until its answer is known. Only an order read back while
// this till holds a mark for it can be "this till's own save" (judgeSendAttempts); a refusal with no mark
// is another device's change and reloads. A mark is memory only: a till lock or reload forgets it, as
// it forgets an unsettled bill close.

/** How long one network step of a send waits for an answer (ORDER-FLOW-5: there was no limit). */
export const SEND_STEP_MS = 20000
/** The reads that settle a lost answer (the order, and its tickets) and the small writes beside a save
 *  (the cover count, the booking link, the table's status). Short, so a bill close — which saves the
 *  order first, inside its own 30 s limit — still hears the answer: 20 s for the save plus these. */
export const SEND_READ_MS = 5000
/** After a save stops waiting (its request is cancelled), how long an order found unchanged still
 *  counts as "it may yet land". Same figure and reasoning as CLOSE_LAND_GRACE_MS (closeAttempt.js):
 *  what the server had already received finishes inside its own 8 s statement and lock limits. */
export const SEND_LAND_GRACE_MS = 30000

/** True when a supabase answer is no answer at all: a timeout, a dropped connection, or a gateway error
 *  while the database may still be working. A 2xx or 4xx is the server's own answer — after it nothing
 *  of that request can still land. */
export function noAnswer(res) {
  const err = res?.error
  if (!err) return false
  if (isTimeout(err) || isNetworkError(err)) return true
  const s = Number(res?.status)
  return !(s >= 100 && s < 500)
}

/** What a save remembers until its answer is known. `kot` and `bot` are the cart lines it marks sent,
 *  as they stood before it (their sent counts are the baseline the tickets print against), routed the
 *  way the KOT and BOT buttons route them. `knownTicketIds` are the order's tickets the screen already
 *  knew, so a ticket another till fired meanwhile can be told apart. `screenToken` names the order
 *  screen it was pressed on: only that screen, never one opened later, may take what it saved. */
export function newSendAttempt({
  orderId, orderNo = null, where = '', tableName = 'Takeaway', covers = 1, expectedVersion = null,
  payload = [], snapshot = [], kot = [], bot = [], guestReqIds = [], knownTicketIds = [], screenToken = null,
}) {
  return {
    orderId, orderNo, where, tableName, covers,
    expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : null,
    payload, snapshot, kot, bot, guestReqIds, knownTicketIds, screenToken,
    finalAfter: null, // set when the till stops waiting for this save's answer (stopWaiting)
  }
}

/** The till stopped waiting for this save's answer at `at`. */
export function stopWaiting(attempt, at) {
  attempt.finalAfter = at + SEND_LAND_GRACE_MS
  return attempt
}

export const sendLinesOf = attempt => [...(attempt?.kot || []), ...(attempt?.bot || [])]
export const firesTickets = attempt => sendLinesOf(attempt).length > 0

/** The stations an attempt fires, in the till's own words: 'KOT', 'BOT', 'KOT and BOT', or '' for a
 *  save that fires nothing. */
export function stationsOf(attempt) {
  const k = (attempt?.kot || []).length > 0
  const b = (attempt?.bot || []).length > 0
  return k && b ? 'KOT and BOT' : k ? 'KOT' : b ? 'BOT' : ''
}

const sentOf = r => Math.max(Number(r.sent_qty) || 0, r.sent_to_kot ? Number(r.qty) || 0 : 0)

/** Whether the stored order holds `line` as sent at its quantity — what a save marking it sent stores.
 *  `sent_to_kot` decides it for a line whose instruction changed (its sent count already equalled its
 *  quantity before the send). */
export function heldAsSent(storedLines, line) {
  const key = lineKeyOf(line)
  const rows = (storedLines || []).filter(r => lineKeyOf(r) === key)
  return rows.some(r => r.sent_to_kot) && rows.reduce((n, r) => n + sentOf(r), 0) >= (Number(line.qty) || 0)
}

/** Whether a ticket this screen did not know of, logged by another login, carries one of the attempt's
 *  dishes: another till fired them, and printed them, while this till waited. */
export function firedElsewhere(attempt, tickets, profileId) {
  const keys = new Set(sendLinesOf(attempt).map(lineKeyOf))
  const known = new Set(attempt?.knownTicketIds || [])
  return (tickets || []).some(t => !known.has(t.id) && (t.sent_by || null) !== (profileId || null)
    && (t.items || []).some(i => !i.change && keys.has(lineKeyOf(i))))
}

/** What the order as read back says about this till's unanswered saves of it (`attempts`, oldest
 *  first). `stored` is the OPEN_ORDER_SELECT row (null when it could not be found); `tickets` its
 *  pos_kot_log rows. Returns { verdict, attempt, exact }:
 *   - 'closed'    the bill is closed (or gone): nothing more can land on it;
 *   - 'pending'   nothing landed, and an attempt may still land;
 *   - 'lost'      none landed, and none can any more;
 *   - 'landed'    `attempt` landed (`exact`: the stored lines are exactly what it saved);
 *   - 'elsewhere' its dishes are held as sent, but another till fired them meanwhile — not this one's.
 *  At most one attempt lands: they all expected the version the screen held. */
export function judgeSendAttempts(attempts, stored, { tickets = [], profileId = null, now = Date.now() } = {}) {
  const list = attempts || []
  if (list.length === 0) return { verdict: 'none', attempt: null, exact: false }
  if (!stored || stored.status !== 'open') {
    return { verdict: 'closed', attempt: [...list].reverse().find(firesTickets) || list[list.length - 1], exact: false }
  }
  const lines = stored.pos_order_items || []
  const mayStillLand = a => a.finalAfter == null || now < a.finalAfter
  const unchanged = a => a.expectedVersion !== null && stored.items_version === a.expectedVersion
  const open = list.filter(a => !unchanged(a))
  const exact = [...open].reverse().find(a => storedLinesMatchPayload(lines, a.payload))
  const held = open
    .filter(a => firesTickets(a) && sendLinesOf(a).every(l => heldAsSent(lines, l)))
    .map((a, n) => ({ a, n }))
    .sort((x, y) => sendLinesOf(y.a).length - sendLinesOf(x.a).length || y.n - x.n)[0]?.a
  const landed = exact || held
  if (landed) {
    if (firesTickets(landed) && firedElsewhere(landed, tickets, profileId)) return { verdict: 'elsewhere', attempt: landed, exact: landed === exact }
    return { verdict: 'landed', attempt: landed, exact: landed === exact }
  }
  // Nothing of theirs is on the order. One whose version still stands, or that saved without a version
  // check, can still land while its request may be travelling.
  const pending = list.find(a => (unchanged(a) || a.expectedVersion === null) && mayStillLand(a))
  if (pending) return { verdict: 'pending', attempt: pending, exact: false }
  return { verdict: 'lost', attempt: [...list].reverse().find(firesTickets) || list[list.length - 1], exact: false }
}

/** The one sentence for a send whose save got no answer. `stage` 'order' means the new order itself was
 *  not confirmed, so no line was saved; `what` names the send ("the KOT"), `press` its button, and
 *  `fires` is false for a save that sends nothing to a station (Just save). */
export function unknownSendText({ stage, what, press, fires = true }) {
  if (stage === 'order') {
    return `error:The till did not hear back while opening this order, so nothing has gone to the kitchen or bar. Press ${press} again once the signal is back.`
  }
  if (!fires) {
    return `error:The till did not hear back, so it is not known yet whether ${what} saved. Press ${press} again once the signal is back — the till checks the order first.`
  }
  return `error:The till did not hear back, so it is not known yet whether ${what} went through. Press ${press} again once the signal is back — the till checks the order first, so nothing is sent twice. If the first try went through, its ticket prints by itself.`
}
