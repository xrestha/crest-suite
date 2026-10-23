// The offline order queue as the till reads it (S809 3f: ORDER-FLOW-6, -7, -8, -15) — the pure half.
//
// An order the till could not save online waits in the offline queue (src/utils/offlineQueue.js) and is
// uploaded later by PosOrders' uploadPosOrderQueue. Since S809 3f that happens not only when the browser
// says offline but also (owner decision Q16) when a send got no answer at all: the Wi-Fi can be up with no
// internet behind it, and the browser then still says online. Its tickets print at once either way, and
// are logged into pos_kot_log by the upload, with the ids they were queued with.
import { lineKeyOf, storedLinesMatchPayload, storedLinesContainPayload } from './posOrdersConstants'
import { recentSaveOf } from './sendAttempt'

/** How long a send, an upload or a floor read that got no answer at all marks the internet as down
 *  (Q16). Meanwhile sends go straight to the queue and tables open from this till's own copy, as when
 *  the browser says offline, rather than each waiting out the same dead line. Longer than the 15 s
 *  upload retry, so a retry that fails again renews it before it runs out. */
export const LINK_DOWN_MS = 30000

/** How often what waits in the queue is tried again while the browser says online. */
export const UPLOAD_RETRY_MS = 15000

/** While the internet is marked down, how often a small read asks whether it is back (S833). Until then
 *  the till waited out the whole LINK_DOWN_MS, even when the link came back seconds after a lost answer. */
export const LINK_PROBE_MS = 5000

/** Tries in a row an entry may be kept, for a reason other than the connection, before the floor says
 *  why (S833, POS_TODO B3). Fewer, and a passing hiccup would show; the reason then stands until it goes. */
export const UPLOAD_TROUBLE_TRIES = 3

/** The floor's line for an entry kept try after try for a reason other than the connection: `where` is
 *  its table or takeaway, `text` the server's reason in the till's words. */
export function uploadTroubleText({ where, text }) {
  return `${where || 'An order'} is kept on this till and has still not uploaded — ${text} It is tried again every 15 seconds; if this message stays, tell a manager.`
}

/** The floor's refusal to open a bill for payment while the internet is down (Q16 keeps order-taking
 *  going; a bill still needs the server for its invoice number). */
export const LINK_DOWN_BILL_TEXT = 'error:The internet is down — a bill takes its invoice number from the server, so billing waits until it is back. Orders can still be taken and sent to the kitchen.'

/** The refusal to bill an order this till still holds in its queue: the bill is closed on the server, so
 *  what waits must reach it first (S809 3f, review). */
export const QUEUED_BILL_TEXT = 'error:That order has not uploaded from this till yet — a bill is closed on the server, so it waits until it has. It uploads on its own; try again in a moment.'
// A save that would go to the queue while this order's earlier offline copy is still a notice on the
// floor (review of 3f, N1): the copy holds dishes this till printed that are on no bill.
export const CONFLICT_HOLDS_TEXT = 'error:Not sent: this order has a notice on the floor about dishes this till printed while offline that are on no bill. Settle that notice first (Start new order with these, or Discard), then send again.'

/** Whether a queued entry holds an order's lines to upload. A ticket-only entry (`tickets_for`, see
 *  posTicketsKey in offlineQueue.js) holds tickets whose log insert has yet to land, for an order already
 *  on the server; so does one with no `items`, as a till before S809 3f could leave behind. */
export const queuedHasLines = q => Array.isArray(q?.items) && !q?.tickets_for

/** A save's payload as the queue keeps it: each customized row also carries the choices the cart showed
 *  (`option_summary`, `option_snapshot`), so an order reopened from the queue shows them and its tickets
 *  name them (cartLineFromStored reads them back). `cart` is the cart the payload was built from, line
 *  for line. S862 COMBOS-1: a combo dish keeps the share it was priced from (`combo_share`), so a swap
 *  on the queued copy prices as the server will; the server never reads it (replayRows drops it). */
export function queuedRows(payload, cart) {
  return (payload || []).map((row, n) => {
    const line = cart?.[n]
    if (!line) return row
    let out = row
    if (row.options?.length) out = { ...out, option_summary: line.option_summary || null, option_snapshot: line.options || null }
    if (row.combo && line.combo_share != null) out = { ...out, combo_share: line.combo_share }
    return out
  })
}

/** The rows an upload sends: the payload exactly as the till built it, without the display copy. */
export const replayRows = items => (items || []).map(({ option_summary: _s, option_snapshot: _o, combo_share: _c, ...row }) => row)

/** The order a queued entry belongs to: a ticket-only entry is keyed apart from its order. */
export const queuedOrderId = q => q?.tickets_for || q?.order_id || null

/** Whether a queued entry belongs to the outlet on screen (ORDER-FLOW-15). The store is shared by every
 *  account that uses the device; an entry queued before entries carried their outlet counts as this
 *  one's, as Stock Count treats its own untagged counts. */
export const ownQueuedEntry = (q, clientId) => !!q && (!q.client_id || q.client_id === clientId)

const STATION_WORD = { KOT: 'kitchen', BOT: 'bar' }

/** A ticket line's key: the line it was printed for, by lineKeyOf (S840) — "Momo", "Momo, extra cheese"
 *  and a combo's Momo are three lines, since a ticket line carries its full selection key, combo tail
 *  included. A ticket line from before keys (no selection_key) keys to its dish, as it always did. */
const ticketLineKey = i => lineKeyOf({ recipe_id: i.recipe_id, selection_key: i.selection_key, name: i.name })

/** A ticket line as the waiter knows it: the dish, its choices, and its combo when it is in one. */
function ticketLineName(i) {
  const choices = (i.options || []).map(o => o?.kitchen).filter(Boolean)
  return `${i.name || 'Item'}${choices.length ? `, ${choices.join(', ')}` : ''}${i.combo_name ? ` in ${i.combo_name}` : ''}`
}

/** The dishes a queued entry printed at this till, per line and station: [{ key, name, qty, station }].
 *  A changed-instruction line (qty 0, `change`) is no dish. */
export function printedWhileQueued(entry) {
  const byKey = new Map()
  for (const send of entry?.kot_sends || []) {
    for (const i of send.items || []) {
      const qty = Number(i.qty) || 0
      if (i.change || qty <= 0) continue
      const line = ticketLineKey(i)
      const k = `${line}|${send.station}`
      const cur = byKey.get(k) || { key: line, name: ticketLineName(i), qty: 0, station: send.station }
      cur.qty += qty
      byKey.set(k, cur)
    }
  }
  return [...byKey.values()]
}

/** "2 × Tuborg (bar), 3 × Buff Momo (kitchen)", or '' when nothing printed. */
export function printedText(printed) {
  return (printed || []).map(p => `${p.qty} × ${p.name} (${STATION_WORD[p.station] || 'kitchen'})`).join(', ')
}

/** The conflict banner's sentence about what an entry the server would not take had already printed
 *  (ORDER-FLOW-8): those dishes went to the kitchen or bar, so Discard must not look like "nothing
 *  happened". Starts with a space; '' when nothing printed. */
export function conflictPrintedNote(c) {
  const text = printedText(printedWhileQueued(c))
  if (!text) return ''
  const where = c?.reason === 'closed' ? ' — they are not on the bill that was closed'
    : c?.reason === 'table_taken' ? ' — they are on no bill yet'
    : ''
  return ` Already printed from this till: ${text}${where}.`
}

/** After "Start new order with these": which of the lines put back had already printed, so the waiter
 *  takes off any the kitchen already made before sending again. Starts with a space; '' for none. */
export function recoveredPrintedNote(c, linesPutBack) {
  const back = new Set((linesPutBack || []).map(lineKeyOf))
  const text = printedText(printedWhileQueued(c).filter(p => back.has(p.key)))
  if (!text) return ''
  return ` Already printed from this till while offline: ${text}. Sending prints them again, so take off any that were already made.`
}

/** Owner decision Q2 (2026-10-10): lines put back onto the SAME open order after a conflict carry, as
 *  already sent, the units of that line this till printed while offline, so the next send does not print
 *  them again. Per line (S840: the exact line — a plain Momo printed is not a combo's Momo, nor "Momo,
 *  extra cheese"), in line order, never more than a line's quantity; a closed bill or another party's
 *  order keeps them unsent (recoveredPrintedNote). Merge the result with mergeRecoveredLines. */
export function printedBackAsSent(c, lines) {
  const left = new Map()
  for (const p of printedWhileQueued(c)) left.set(p.key, (left.get(p.key) || 0) + p.qty)
  return (lines || []).map(l => {
    const key = lineKeyOf(l)
    const qty = Number(l.qty) || 0
    const sent = Math.min(qty, left.get(key) || 0)
    if (sent <= 0) return { ...l, sent_to_kot: false, sent_qty: 0 }
    left.set(key, left.get(key) - sent)
    return { ...l, sent_to_kot: sent >= qty, sent_qty: sent }
  })
}

/** The sentence for printedBackAsSent's lines: which came back as already sent. Starts with a space;
 *  '' when none did. */
export function recoveredSentNote(lines) {
  const sent = (lines || []).filter(l => (Number(l.sent_qty) || 0) > 0).map(l => `${l.sent_qty} × ${l.name || 'Item'}`)
  if (sent.length === 0) return ''
  return ` Already printed from this till while offline, so back as already sent and not printed again: ${sent.join(', ')}.`
}

/** The floor notice's words for an upload whose dishes another tablet had already sent (S840, owner
 *  decision 2026-10-15 "Ask staff to check"), after the table's name. */
export const SENT_ELSEWHERE_TEXT = 'another tablet sent these dishes while this one was offline, and this till had already printed them — check with the kitchen that they are not made twice.'

/** What an upload refused as stale makes of the order as read back (S840). `q` is the queued entry,
 *  `order` the OPEN_ORDER_SELECT row (open). Returns { verdict, version, saveId }:
 *   - 'landed'         this entry's lines are on the order — at `version`, the one its own save left when
 *                      the order lists it (`saveId`, the id they landed under), else the order's;
 *   - 'replay'         its FIRST queued save landed (a send whose answer was lost) and nothing was saved on
 *                      top: the rest goes again, at `version`;
 *   - 'stale'          another device changed the order: a conflict;
 *   - 'sent_elsewhere' nothing of this till's landed, yet the order holds these dishes and this till
 *                      printed them: another tablet sent them too. A conflict, never a silent landed.
 *  By id when the order lists its saves and the entry carries ids (`save_id`, and `first_save_id` beside
 *  any `first_items`); an entry queued before ids, or a server without the list, keeps the content test. */
export function judgeQueuedReadBack(q, order) {
  const stored = order?.pos_order_items || []
  const current = Number.isInteger(order?.items_version) ? order.items_version : null
  const saves = Array.isArray(order?.recent_saves) ? order.recent_saves : null
  const out = (verdict, version = null, saveId = null) => ({ verdict, version, saveId })
  const holdsAll = () => storedLinesMatchPayload(stored, q?.items)
  // Every line of this entry on the order at its count or more, and the entry takes nothing off (S835).
  const contains = () => !q?.removal_reason && storedLinesContainPayload(stored, q?.items, q?.first_items)
  if (saves && q?.save_id && (q.first_save_id || !Array.isArray(q.first_items))) {
    const own = recentSaveOf(saves, q.save_id)
    if (own) return out('landed', Number.isInteger(own.v) ? own.v : current, own.id)
    const first = q.first_save_id ? recentSaveOf(saves, q.first_save_id) : null
    if (first && first.v === current) {
      // Nothing saved on top of the first: what is left goes again — unless it is that save itself.
      const asFirst = holdsAll() || JSON.stringify(q.items || null) === JSON.stringify(q.first_items || null)
      return asFirst ? out('landed', current, first.id) : out('replay', current)
    }
    if (first) return contains() ? out('landed', current) : out('stale')
    // None of this till's saves is on the order. Lines that match anyway are another tablet's: had this
    // till printed them, the kitchen may have them twice, so staff are asked to check.
    if (holdsAll() || contains()) return printedWhileQueued(q).length > 0 ? out('sent_elsewhere') : out('landed', current)
    return out('stale')
  }
  // The content test (S809 3f, S835): exactly these lines stored → landed; exactly the FIRST queued save's
  // → that one landed, so the rest goes again on top; every line here on the order → landed, another
  // tablet saved on top; anything else is another device's change.
  if (holdsAll()) return out('landed', current)
  if (Array.isArray(q?.first_items) && storedLinesMatchPayload(stored, q.first_items)) return out('replay', current)
  if (contains()) return out('landed', current)
  return out('stale')
}

/** The till's line after a send it got no answer for was kept on the till and printed (Q16). `fires`
 *  is false for a save that sends nothing to a station; `printed` false when the pop-up was blocked. */
export function queuedSendText({ fires = true, printed = true } = {}) {
  if (!fires) return 'ok:Saved on this till — the internet is down, so your changes upload by themselves once it is back.'
  if (printed) return 'ok:Ticket printed. The internet is down, so this order is kept on this till and uploads by itself once it is back.'
  return 'error:The internet is down, so this order is kept on this till and uploads by itself once it is back — but the ticket did NOT print. Allow pop-ups for this site and tell the kitchen or bar; Reprint KOT/BOT works once the order has uploaded.'
}
