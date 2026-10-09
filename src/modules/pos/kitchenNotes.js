// Kitchen instructions on an order line, and the CHANGE ticket that carries one to the Kitchen
// Display (S809 3a). Pure, so the rules below are pinned by kitchenNotes.test.js.
//
// GUEST-1 (owner decision Q11 a): a guest's order-wide "Note for the kitchen" goes onto EACH dish of
// that guest's order, so it prints under every dish on the KOT/BOT and shows on the Kitchen Display
// through the ordinary line-note path. A long note repeats per dish; that was accepted. The till
// holds one line per dish (lineKeyOf), so a guest's dish that is already on the table's order joins
// that line: the guest's words are then scoped to the guest's plates ("Guest ×2: …"), so they neither
// claim the food the table ordered earlier nor are dropped, and the line's own note is kept as it was.
//
// ORDER-FLOW-9: an instruction changed on a dish the kitchen already has used to reach the paper
// ticket ("CHANGE ONLY — not a new order") and never the Kitchen Display. It is now logged as its own
// ticket whose every line is `{ …, qty: 0, change: true }`, beside (never inside) the food ticket of
// the same send, so "a change ticket" is one test on `items`. The KDS shows it as a CHANGE card with
// one button, Seen (new → served). No count of tickets includes one: it is nothing to cook.

/** The PostgREST value that matches a change ticket: `.not('items', 'cs', KOT_CHANGE_ITEMS)` leaves
 *  them out of a ticket count; jsonb containment, so true when any line carries `change: true`. */
export const KOT_CHANGE_ITEMS = JSON.stringify([{ change: true }])

/** What a change line says when the instruction was taken off the dish. */
export const CHANGE_NO_NOTE = 'no special instructions'

export const isChangeLine = item => item?.change === true

/** A ticket that only tells a station an instruction changed: nothing on it is food to make. */
export function isChangeTicket(ticket) {
  const items = ticket?.items
  return Array.isArray(items) && items.length > 0 && items.every(isChangeLine)
}

/** A cart line the station already has at this quantity, unsent only because what it says changed:
 *  exactly the case the paper ticket prints as "CHANGE ONLY — not a new order" (posOrderPrintHtml). */
export function isChangeOnlyLine(line) {
  const sent = Number(line?.sent_qty) || 0
  return !line?.sent_to_kot && sent > 0 && (Number(line?.qty) || 0) === sent
}

/** The instruction a change line carries, as the kitchen reads it. */
export function changeNoteText(item) {
  const note = typeof item?.notes === 'string' ? item.notes.trim() : ''
  return note || CHANGE_NO_NOTE
}

/** One logged ticket line as a report row prints it: "Chicken Momo ×2", or for a change line
 *  "Chicken Momo — now: No peanuts" (a change line's quantity is 0 and means nothing to a reader). */
export function kotItemText(item) {
  return isChangeLine(item) ? `${item?.name} — now: ${changeNoteText(item)}` : `${item?.name} ×${item?.qty}`
}

const noteParts = s => String(s ?? '').split(',').map(p => p.trim()).filter(Boolean)

/** Adds `phrase` to a comma-separated line note, part by part, leaving out any part the note already
 *  has. Nothing new to add returns the note exactly as it was. */
export function joinNote(notes, phrase) {
  const have = noteParts(notes)
  const add = []
  for (const p of noteParts(phrase)) if (!have.includes(p) && !add.includes(p)) add.push(p)
  return add.length === 0 ? String(notes ?? '') : [...have, ...add].join(', ')
}

/** The guest's own words for one of their dishes: the dish's note and the order's note. `shared` is
 *  true when the till line it joins already holds other food, so the note says how many plates are
 *  the guest's. Empty when the guest wrote nothing. */
export function guestDishNote({ dishNote, orderNote, qty, shared = false }) {
  const text = joinNote(noteParts(dishNote).join(', '), orderNote)
  if (!text) return ''
  return shared ? `Guest ×${Number(qty) || 0}: ${text}` : `Guest: ${text}`
}
