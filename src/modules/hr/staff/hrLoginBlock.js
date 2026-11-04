import { isReadableServerMessage } from '../../../shared/edgeFunctionError'

// S875 (owner decision 2026-11-04, "Block, keep the name"): the HR login of someone who left is
// BLOCKED, not deleted, the way POS Staff removes a till login (S809 3i). A blocked login cannot sign
// in, loses its HR rank at once (the server's rank tests read the stamp), and stays, so its name stays
// on every leave decision, salary payment, travel claim and roster it recorded. Delete is only for a
// login that recorded nothing, and admin-user-ops decides that (staff_login_has_records), never the page.
//
// Kept out of HrStaff.jsx so the wording and the decisions can be tested without rendering the page.
// No apostrophes in the copy here: "the login of {name}", never the possessive (S851).

// 'settlement': a Final Settlement blocked it (HR undoes that by Reopen or a rehire, never this page).
// 'here': blocked from HR Staff (staff_blocked_at, get_hr_role_staff_list). null: not blocked.
export function blockStateOf(p) {
  if (p?.settlement_blocked === true) return 'settlement'
  if (p?.staff_blocked_at) return 'here'
  return null
}

export const nameOf = p => p?.full_name || p?.email || 'this person'

// Why Reset Password is not offered on a blocked row: a banned login does not sign in whatever its
// password, so a new one would only look like access given back (the POS Staff S754 rule).
export function resetLockReason(p) {
  const state = blockStateOf(p)
  if (state === 'settlement') return 'Blocked at Final Settlement: a new password would not let them sign in.'
  if (state === 'here') return 'This login is blocked. Unblock it first: a new password would not let them sign in.'
  return ''
}

// An admin-user-ops answer, read ONCE (a Response body reads once): the body, the HTTP status, and
// whether the function answered at all. A refusal arrives in a 2xx body or on a non-2xx whose body
// supabase-js leaves on error.context; a dropped connection has neither.
export async function readEdgeAnswer(data, error) {
  const status = typeof error?.context?.status === 'number' ? error.context.status : null
  let body = data && typeof data === 'object' ? data : null
  if (!body?.error) {
    try {
      const b = await error?.context?.json()
      if (b && typeof b === 'object') body = b
    } catch (_) { /* no JSON body */ }
  }
  return { body, status, answered: !!data?.error || status !== null, errorMessage: error?.message || '' }
}

const endSentence = s => s.trim().replace(/([^.!?])$/, '$1.')

// The message for a Delete, Block or Unblock that did not go through. The function writes its
// refusals as sentences, shown as written. A 4xx with no sentence was refused, so "was not" is true;
// a 5xx with no sentence, or no answer at all, proves nothing either way, so it says so and the page
// reads the list again (`reload`). Never claim a write did not land when nobody knows.
export function staffActionFailure(answer, { name, verbed }) {
  const { body, status, answered, errorMessage } = answer || {}
  const server = typeof body?.error === 'string' ? body.error : ''
  const said = isReadableServerMessage(server)
  const detail = [status && `HTTP ${status}`, body?.code, !said && server, !server && errorMessage]
    .filter(Boolean).join(' · ')
  if (said) return { text: endSentence(server), detail, reload: !answered || (status !== null && status >= 500) }
  if (answered && (status === null || status < 500)) {
    return { text: `The login of ${name} was not ${verbed}.`, detail, reload: false }
  }
  return {
    text: `It is not known whether the login of ${name} was ${verbed}: the answer did not come back. Reload the page to see where it stands.`,
    detail,
    reload: true,
  }
}

// A Delete refused because the login recorded something. null for any other answer.
//   { offerBlock: true, why }  : not blocked yet, so the page offers Block with the server sentence.
//   { text }                   : already blocked (here or by a settlement): nothing more to do.
export function deleteRefusal(answer, p) {
  if (answer?.body?.code !== 'staff_login_has_records') return null
  const name = nameOf(p)
  if (blockStateOf(p)) {
    return {
      text: `The login of ${name} stays: it has recorded work in HR, so deleting it would take their name off those records. It is already blocked, so it cannot sign in.`,
    }
  }
  const why = typeof answer.body.error === 'string' && answer.body.error.trim()
    ? endSentence(answer.body.error)
    : `${name} has recorded work in HR, so the login cannot be deleted.`
  return { offerBlock: true, why }
}

// The line under the header once a Block or Unblock answered. `outcome` is the function's own word.
export function blockNotice(outcome, name, blocking) {
  switch (outcome) {
    case 'blocked':
      return `The login of ${name} is blocked: it can no longer sign in, and their name stays on everything they recorded.`
    case 'already_blocked':
      return `The login of ${name} was already blocked, so nothing changed.`
    case 'unblocked':
      return `The login of ${name} is unblocked and signs in again, with the role it had before.`
    case 'not_blocked':
      return `The login of ${name} was not blocked, so nothing changed.`
    default:
      return blocking
        ? `The login of ${name} is blocked: it can no longer sign in.`
        : `The login of ${name} is unblocked and signs in again.`
  }
}
