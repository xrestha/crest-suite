// What one IMS Staff row offers, and the words for a Block or Unblock answer (S875, owner decision
// 2026-11-04: "Block, keep the name"). The page mirrors POS Staff (S809 3i): a leaver's login is
// blocked, not deleted, so their name stays on every count, gate pass, requisition and transfer they
// recorded. Delete is only for a login that recorded nothing, and admin-user-ops decides that
// (code staff_login_has_records), never this file.

// delete_ims_staff refused because the login recorded something: the page offers Block instead.
export const HAS_RECORDS_CODE = 'staff_login_has_records'

// Refusals admin-user-ops words as a finished sentence for this page, shown as written: a block made by
// a Final Settlement (HR undoes it), an unblock of someone HR shows as gone (rehire first), and a till
// login (POS Staff blocks those).
export const READY_REFUSAL_CODES = new Set([
  'staff_login_settlement_blocked',
  'staff_unblock_leaver',
  'staff_login_is_till',
])

// The row's blocked state and what it offers. `selfId` is the viewer's own login id.
//  - A Final Settlement block (settlement_blocked) is HR's, so neither Block nor Unblock is offered.
//  - A block made on this page (staff_blocked_at) offers Unblock.
//  - Your own login offers neither Block nor Delete, as Delete never was (the server refuses both).
//  - A blocked login cannot sign in whatever its credential, so Reset says why instead of opening:
//    a new password or PIN would only look like access restored (the POS Staff rule, S754).
export function imsRowState(p, selfId) {
  const settlementBlocked = p?.settlement_blocked === true
  const staffBlocked = !settlementBlocked && !!p?.staff_blocked_at
  const isSelf = !!selfId && p?.id === selfId
  const credential = p?.has_pin ? 'PIN' : 'password'
  return {
    isSelf,
    settlementBlocked,
    staffBlocked,
    blockAction: isSelf || settlementBlocked ? null : staffBlocked ? 'unblock' : 'block',
    resetReason: settlementBlocked
      ? `Blocked at Final Settlement, so a new ${credential} would not let them sign in.`
      : staffBlocked
        ? `This login is blocked. Unblock it first; a new ${credential} would not let them sign in.`
        : '',
  }
}

const upperFirst = s => s.charAt(0).toUpperCase() + s.slice(1)

// The notice after admin-user-ops answered a Block or Unblock with success. `outcome` is
// 'blocked' | 'already_blocked' | 'unblocked' | 'not_blocked'; anything else trusts the success.
export function blockOutcomeNotice(outcome, name, blocking) {
  const who = name || 'this person'
  switch (outcome) {
    case 'blocked':
      return `${upperFirst(who)} can no longer sign in. The login is kept, so their name stays on everything they recorded.`
    case 'already_blocked':
      return `The login of ${who} was already blocked, so nothing changed.`
    case 'unblocked':
      return `${upperFirst(who)} can sign in again, with the same role and access level as before.`
    case 'not_blocked':
      return `The login of ${who} was not blocked, so nothing changed.`
    default:
      return blocking ? `The login of ${who} is blocked.` : `The login of ${who} is unblocked.`
  }
}

// The whole answer body of an admin-user-ops call, for a refusal that carries a `code` as well as its
// sentence. A 2xx refusal is `data`; a non-2xx leaves its body on `error.context`, a Response. It is
// read from a clone where one can be made, so edgeFunctionFailure can still read the original after.
export async function readEdgeBody(error, data) {
  if (data && typeof data === 'object' && data.error) return data
  const res = error?.context
  if (!res || typeof res.json !== 'function') return null
  try {
    const body = await (typeof res.clone === 'function' ? res.clone() : res).json()
    return body && typeof body === 'object' ? body : null
  } catch (_) {
    return null
  }
}
