// The offline order queue as the till reads it (S809 3f: ORDER-FLOW-6, -7, -8, -15) — the pure half.
//
// An order the till could not save online waits in the offline queue (src/utils/offlineQueue.js) and is
// uploaded later by PosOrders' uploadPosOrderQueue. Since S809 3f that happens not only when the browser
// says offline but also (owner decision Q16) when a send got no answer at all: the Wi-Fi can be up with no
// internet behind it, and the browser then still says online. Its tickets print at once either way, and
// are logged into pos_kot_log by the upload, with the ids they were queued with.

/** How long a send, an upload or a floor read that got no answer at all marks the internet as down
 *  (Q16). Meanwhile sends go straight to the queue and tables open from this till's own copy, as when
 *  the browser says offline, rather than each waiting out the same dead line. Longer than the 15 s
 *  upload retry, so a retry that fails again renews it before it runs out. */
export const LINK_DOWN_MS = 30000

/** How often what waits in the queue is tried again while the browser says online. */
export const UPLOAD_RETRY_MS = 15000

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
 *  for line. */
export function queuedRows(payload, cart) {
  return (payload || []).map((row, n) => {
    const line = cart?.[n]
    if (!row.options?.length || !line) return row
    return { ...row, option_summary: line.option_summary || null, option_snapshot: line.options || null }
  })
}

/** The rows an upload sends: the payload exactly as the till built it, without the display copy. */
export const replayRows = items => (items || []).map(({ option_summary: _s, option_snapshot: _o, ...row }) => row)

/** The order a queued entry belongs to: a ticket-only entry is keyed apart from its order. */
export const queuedOrderId = q => q?.tickets_for || q?.order_id || null

/** Whether a queued entry belongs to the outlet on screen (ORDER-FLOW-15). The store is shared by every
 *  account that uses the device; an entry queued before entries carried their outlet counts as this
 *  one's, as Stock Count treats its own untagged counts. */
export const ownQueuedEntry = (q, clientId) => !!q && (!q.client_id || q.client_id === clientId)

const STATION_WORD = { KOT: 'kitchen', BOT: 'bar' }

/** The dishes a queued entry printed at this till, per dish and station: [{ key, name, qty, station }].
 *  A changed-instruction line (qty 0, `change`) is no dish. */
export function printedWhileQueued(entry) {
  const byKey = new Map()
  for (const send of entry?.kot_sends || []) {
    for (const i of send.items || []) {
      const qty = Number(i.qty) || 0
      if (i.change || qty <= 0) continue
      const dish = i.recipe_id || `name:${i.name}`
      const k = `${dish}|${send.station}`
      const cur = byKey.get(k) || { key: dish, name: i.name || 'Item', qty: 0, station: send.station }
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
  const back = new Set((linesPutBack || []).map(l => l.recipe_id || `name:${l.name}`))
  const text = printedText(printedWhileQueued(c).filter(p => back.has(p.key)))
  if (!text) return ''
  return ` Already printed from this till while offline: ${text}. Sending prints them again, so take off any that were already made.`
}

/** Owner decision Q2 (2026-10-10): lines put back onto the SAME open order after a conflict carry, as
 *  already sent, the units of that dish this till printed while offline, so the next send does not print
 *  them again. Per dish, in line order, never more than a line's quantity; a closed bill or another
 *  party's order keeps them unsent (recoveredPrintedNote). Merge the result with mergeRecoveredLines. */
export function printedBackAsSent(c, lines) {
  const left = new Map()
  for (const p of printedWhileQueued(c)) left.set(p.key, (left.get(p.key) || 0) + p.qty)
  return (lines || []).map(l => {
    const key = l.recipe_id || `name:${l.name}`
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

/** The till's line after a send it got no answer for was kept on the till and printed (Q16). `fires`
 *  is false for a save that sends nothing to a station; `printed` false when the pop-up was blocked. */
export function queuedSendText({ fires = true, printed = true } = {}) {
  if (!fires) return 'ok:Saved on this till — the internet is down, so your changes upload by themselves once it is back.'
  if (printed) return 'ok:Ticket printed. The internet is down, so this order is kept on this till and uploads by itself once it is back.'
  return 'error:The internet is down, so this order is kept on this till and uploads by itself once it is back — but the ticket did NOT print. Allow pop-ups for this site and tell the kitchen or bar; Reprint KOT/BOT works once the order has uploaded.'
}
