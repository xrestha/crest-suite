import { isNetworkError } from './errorText'

// An Edge Function failure (admin-user-ops on the three staff pages and Employees) arrives three
// ways: a 2xx body carrying `error`, a non-2xx whose Response body carries it (`error.context`),
// or no answer at all. Until S803 each page read them as `data?.error || error?.message || fallback`,
// so the consequence sentence the caller wrote ("The password was not changed — the old one still
// works.") was unreachable on any real failure, and the reader got "Edge Function returned a
// non-2xx status code" or "Failed to send a request to the Edge Function" instead.
//
// → { text, detail, network } for ActionError. The caller's consequence LEADS. The function's own
// message follows it when it is a sentence written for a person ("This password has appeared in a
// known data breach…"), and goes to `detail` when it is a developer's string ("Forbidden",
// "client_id required"). With no answer at all the consequence is dropped, because "was not
// created" is a claim nobody can make about a request that may have landed.

export const NO_ANSWER_TEXT =
  "Couldn't reach the server, so this may or may not have gone through. Reload the page to see where it stands."

// Three words or more, and no snake_case or camelCase identifier in it.
export function isReadableServerMessage(m) {
  return typeof m === 'string' && m.trim().split(/\s+/).length >= 3 && !/[a-z]_[a-z]|[a-z][A-Z]/.test(m)
}

const endSentence = s => s.trim().replace(/([^.!?])$/, '$1.')

export async function edgeFunctionFailure(data, error, consequence = '') {
  let server = typeof data?.error === 'string' ? data.error : ''
  const status = typeof error?.context?.status === 'number' ? error.context.status : null
  try { const body = await error?.context?.json(); if (typeof body?.error === 'string') server = body.error } catch (_) {}
  if (!server && !status && (error?.name === 'FunctionsFetchError' || isNetworkError(error))) {
    return { text: NO_ANSWER_TEXT, detail: error?.message || '', network: true, serverText: '' }
  }
  const lead = consequence || "That didn't go through."
  const said = isReadableServerMessage(server)
  return {
    text: said ? `${endSentence(lead)} ${endSentence(server)}` : lead,
    detail: [status && `HTTP ${status}`, !said && server, !server && error?.message].filter(Boolean).join(' · '),
    network: false,
    serverText: said ? endSentence(server) : '',
  }
}

// A batch of per-login level moves that did not all land (HR Staff and IMS Staff re-rank everyone
// holding a role). Each entry is `{ p, info }`, `info` from edgeFunctionFailure. A refused login
// kept the access it had; one that got no answer may have moved, so it is named apart and the
// reader is sent to reload rather than told it kept anything.
export function failedMovesMessage(failed, { prefix = '', fallback = 'Try again, or ask the account owner.' } = {}) {
  const who = list => list.map(o => o.p.full_name || o.p.email).join(', ')
  const refused = failed.filter(o => !o.info.network)
  const unsure = failed.filter(o => o.info.network)
  const parts = []
  if (refused.length) parts.push(`${refused.length} login(s) could not be moved and keep their previous access: ${who(refused)}.`)
  if (unsure.length) parts.push(`${unsure.length} login(s) got no answer from the server and may or may not have moved: ${who(unsure)}. Reload the page to see their level.`)
  const reason = refused.find(o => o.info.serverText)?.info.serverText
  return {
    text: prefix + parts.join(' ') + (refused.length ? ` ${reason || fallback}` : ''),
    detail: (refused[0] || unsure[0])?.info.detail || '',
  }
}
