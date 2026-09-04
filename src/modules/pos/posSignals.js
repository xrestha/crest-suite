// The POS signal vocabulary — one meaning per colour, module-wide.
//
// The counterpart to HR's HR_REQUEST_STATUS/TADA_REQUEST_STATUS (S660), and it exists for the
// same reason: POS paints the same handful of facts across the floor plan, the order cart, the
// kitchen board, four reports, the shift drawer and the customer ledger, and before this file
// each surface picked its own hue. Measured across the module, amber alone carried eight distinct
// meanings — "not fired yet", "cooking normally", "about to go late", "money owed", "a comped
// bill", "Foodmandu", "supervisor" and "reserved table" — three of which are categories, not
// verdicts, and two of which are the *good* outcome.
//
//   red    — wrong, and it costs money or breaks a rule.
//            a late ticket · a void · cash short · a bill that failed to reach IMS ·
//            a KOT/bill discrepancy · a missing PAN · an error.
//   amber  — OPEN: waiting on a person, right now.
//            items typed but not fired · a guest QR order not yet accepted · an order not yet
//            synced · a ticket about to go late · money owed · a slip still running · a blank reason.
//   green  — finished, and finished right.
//            a ticket Ready · a bill settled or collected · cash reconciled · a saved write.
//   brass  — the live, working, on-brand layer. NEVER a verdict.
//            an occupied table · the open shift · money totals · a rank · a close type ·
//            a discount · a credit note · the primary action.
//   grey   — inert, or a plain identity.
//            an inactive table · an auto-closed slip · a delivery partner · a payment method ·
//            nothing sent yet.
//   purple — loyalty, and the KOT station chip (see STATION_BADGE for why that one stays).
//
// Two boundaries, so a later sweep does not churn things this rule does not govern:
//
//   1. A BUTTON is an instruction, not a verdict, and keeps the product-wide control vocabulary
//      (primary = accent, destructive = red fill, caution = amber fill). So the Void button stays
//      red and the Complimentary button stays amber, while the *records* they write read as a
//      close type in brass. The action asks; the badge reports.
//   2. Loudness tracks demand for action, not importance. This is what most of the sweep actually
//      corrected: the loudest mark on a floor tile was "Occupied" (a full table — the outcome you
//      want) and on a KDS card was the ticket's stage (already the column it is sitting in), while
//      "you have not fired these three dishes" was a thin amber pill and a 20-minute-late ticket
//      was a 2px border.

// ---------------------------------------------------------------------------------------------
// Table status — a CATEGORY. Available / Occupied / Reserved are three states of a table and
// none of them is a problem, so none of them takes a signal colour. Occupied is the live one and
// takes brass; the other two recede. Previously available/occupied/reserved were green/red/amber,
// which painted an empty room green and a full one red — an inverted verdict on the busiest
// screen in the product, and a wall of red that trained the eye past the red that matters.
export const TABLE_STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', inactive: 'Inactive' }
export const TABLE_STATUS_BADGE = { available: 'badge-gray', occupied: 'badge-yellow', reserved: 'badge-yellow', inactive: 'badge-gray' }

// ---------------------------------------------------------------------------------------------
// Reservation status (S677). Booked / Confirmed / Seated are three states of a promise and none
// of them is a problem — categories, so grey and brass. Two states are waiting on a PERSON, right
// now, and take amber: a public request nobody has accepted, and a party that has arrived and is
// standing at the door. Completed is the finished-right verdict; No-show is the exception the
// Covers Report chases and the one line here with a cost, so it is the only red. Cancelled is
// inert. Labels live beside the transition table in reservations/reservationStatus.js.
export const RESERVATION_STATUS_BADGE = {
  requested: 'badge-amber',
  booked:    'badge-gray',
  confirmed: 'badge-yellow',
  arrived:   'badge-amber',
  seated:    'badge-yellow',
  completed: 'badge-green',
  no_show:   'badge-red',
  cancelled: 'badge-gray',
}

// ---------------------------------------------------------------------------------------------
// Kitchen/bar ticket stage, worded from the wait staff's side (they see a ticket get Sent /
// Started / Ready, they do not "start" or "ready" it). A monotone progression inert → working →
// done: nothing here is a fault, so nothing here is red or amber. Only Ready asks for anything —
// somebody has to run the food — and it is the one that is green.
export const KOT_STATUS_LABEL = { new: 'Sent', in_progress: 'Started', ready: 'Ready' }
export const KOT_STATUS_BADGE = { new: 'badge-gray', in_progress: 'badge-yellow', ready: 'badge-green' }
// Lower = less done. When a table has several open tickets at different stages, the floor badge
// shows the least-advanced one — that is the one still needing attention.
export const KOT_STATUS_RANK  = { new: 0, in_progress: 1, ready: 2 }

// ---------------------------------------------------------------------------------------------
// How a bill was closed. A comp and a discount are decided facts about a bill where the money did
// not (fully) move — brass, the same reading HR gives an approved-but-unpaid claim. Only a void
// is red: the bill was destroyed, and it is the one line on an exception report with real fraud
// exposure. Previously Comp was amber on five surfaces, which put a close type in the same colour
// as an unfired dish.
export const CLOSE_TYPE_BADGE = { billed: 'badge-green', void: 'badge-red', writeoff: 'badge-yellow', discount: 'badge-yellow' }

// ---------------------------------------------------------------------------------------------
// POS rank is a ladder of access, not a scale of goodness — a category, so all three take brass.
// The value is shared with IMS and HR (`src/shared/staffLevelBadge.js`): the identical decision had
// been made three times independently and two of the three had drifted, so a Supervisor was amber
// in two modules and brass in the third. Re-exported here because this file is where a reader of
// the POS module looks for what a colour means.
export { STAFF_LEVEL_BADGE as POS_LEVEL_BADGE, STAFF_LEVEL_BADGE_NONE } from '../../shared/staffLevelBadge'

// A delivery partner, a settlement method, a compliance annexure: plain identities. They used to
// wear amber, which is how "Foodmandu" came to be the same colour as an unfired dish and a bill
// nobody has been paid for — including in the same table as the outstanding amount that legitimately
// needs it.
export const IDENTITY_BADGE = 'badge-gray'

// The KOT/BOT station is the ONE identity here that keeps a hue, and it is deliberate rather than
// an oversight: S613 settled it (purple for the kitchen, brass for the bar) after that chip had
// spent success-green on a category, and it is a filterable column in a long log where the hue is
// doing real scanning work. It does mean purple carries a second meaning in this module beside
// loyalty — but the two never appear on the same screen (KOT Log versus the billing modal and the
// Loyalty tab), which is the condition the one-meaning rule is actually written against. Considered
// and kept, not missed; re-deciding a settled colour is how a module ends up with three answers.
export const STATION_BADGE = { KOT: 'badge-purple', BOT: 'badge-yellow' }

// ---------------------------------------------------------------------------------------------
// The floor tile's colour strip. It is 6px of full-tile width — the loudest thing on the tile and
// visible across a room — so it carries the one question a waiter crossing the floor cannot
// answer with their own eyes: does this table need me? Occupancy is not that question; they can
// see who is sitting down. Status keeps its labelled badge, which is where it was always read.
//
// Attention outranks state, and every colour here is also carried by a labelled chip on the same
// tile (⚠ N / 📵 / 🔔 Guest order / the Ready badge), so nothing is conveyed by colour alone.
export function tableStripColor({ status, order, kotStatus, guestPending }) {
  if (status === 'inactive')                                return 'var(--theme-border-lt)'
  if (guestPending)                                         return 'var(--theme-amber)'  // a guest is waiting on you
  if (order && (order.pending > 0 || order.offlinePending)) return 'var(--theme-amber)'  // typed, not fired / not synced
  if (kotStatus === 'ready')                                return 'var(--theme-green)'  // food in the pass, run it
  if (order || status === 'occupied')                       return 'var(--theme-accent)' // live and in hand
  return 'var(--theme-border)'                                                           // available or held: quiet
}

// The kitchen board's card strip, same reasoning one level in. The board already sorts every
// ticket into a labelled New / In Progress / Ready column and puts the next action on its own
// button, so a stage-coloured strip repeated information three other things already carried —
// while spending red and amber, the two hues lateness needs. Quiet until a cook is needed.
export function ticketStripColor({ status, isLate, isWarn }) {
  if (isLate)             return 'var(--theme-red)'
  if (isWarn)             return 'var(--theme-amber)'
  if (status === 'ready') return 'var(--theme-green)'
  return 'var(--theme-border)'
}
