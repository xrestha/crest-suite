// When an outlet's Inventory began (S831 5f-3, owner decision Q31 a, 2026-10-13, which reverses D6/D7).
//
// Inventory starts on the Nepal day it was last switched on: `clients.ims_since`, stamped by the
// database (clients_stamp_ims_since, migration 20261013190000) and read as `clientModules.imsSince`.
// A till bill closed before that stays in every POS report and is never sent to Inventory, nor a
// credit note on it; every switch-on starts it again (owner, S831). NULL means Inventory from the
// start. Its own file because both posImsWaiting.js and creditNotePosting.js need it, and the first
// already imports the second.

/**
 * Whether a till bill closed at `closedAt` belongs to Inventory at all. The server twin is
 * pos_post_bill_into's 'before_inventory': a bill with no close time counts, as it does there.
 */
export function billCountsForIms(closedAt, imsSince) {
  if (!imsSince || !closedAt) return true
  return new Date(closedAt).getTime() >= new Date(imsSince).getTime()
}
