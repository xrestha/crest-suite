// What the client drawer's Users tab says when a login action fails, as `{ text, detail }` for
// ActionError (S852). The tab used to print `'Could not create user: ' + err.message` and the like
// into a hand-rolled alert, so the operator read "Edge Function returned a non-2xx status code" or
// "TypeError: Failed to fetch" where the consequence belonged.
//
// Two sources, one rule. `adminOp` throws an Error carrying admin-user-ops' own words, and a
// `profiles` write returns a supabase error. Either way the consequence the caller wrote leads, the
// raw words go to the fine print unless they are already a sentence for a person, and a failure
// that got no answer from the server claims nothing about whether the action landed: a lost
// response can follow a committed write (error-messages.md).
import { errorInfo, isNetworkError } from '../../shared/errorText'
import { NO_ANSWER_TEXT, isReadableServerMessage } from '../../shared/edgeFunctionError'

const endSentence = s => s.trim().replace(/([^.!?])$/, '$1.')

// No answer at all, so nothing can be said about whether the action ran: adminOp keeps
// supabase-js' FunctionsFetchError name on what it rethrows, and a supabase write that lost its
// connection says so in its message (the shared isNetworkError predicate).
export function gotNoAnswer(err) {
  return err?.name === 'FunctionsFetchError' || isNetworkError(err)
}

// When adminOp could not read a refusal out of the response, the message it carries is still
// supabase-js' own ("Edge Function returned a non-2xx status code"): the same words as its cause.
// That passes the "is this a sentence" test and tells an operator nothing, so it is fine print.
const libraryWords = err => !!err?.cause?.message && err.message === err.cause.message

/** A refused or unanswered admin-user-ops call (adminOp threw). */
export function loginOpFailure(consequence, err) {
  const message = (err?.message || '').trim()
  if (gotNoAnswer(err)) return { text: NO_ANSWER_TEXT, detail: message }
  const said = isReadableServerMessage(message) && !libraryWords(err)
  return {
    text: said ? `${endSentence(consequence)} ${endSentence(message)}` : endSentence(consequence),
    detail: said ? '' : message,
  }
}

/** A failed `profiles` write: a refusal rolled back, so the consequence holds; no answer may have landed. */
export function loginWriteFailure(consequence, err) {
  const { detail } = errorInfo(err, 'operator')
  if (gotNoAnswer(err)) return { text: NO_ANSWER_TEXT, detail }
  return { text: endSentence(consequence), detail }
}

/** A failed read, or a sentence that already holds whatever the failure means: the words stand, the error is fine print. */
export function withDetail(text, err) {
  return { text, detail: err ? errorInfo(err, 'operator').detail : '' }
}
