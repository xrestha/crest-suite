import { errorInfo, isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'

/**
 * The sentence Stock Count shows when a count figure did not save (S792, STOCK-7).
 *
 * "Re-enter it and save again" is a claim about the future (S706): it is honest only where a
 * second try can pass, which is a dropped connection or a request that timed out. Every other
 * failure here is a decision the server made — the month is closed, recount protection is on, the
 * item is outside the counter's sections — and the same figure is refused the same way every time,
 * so for those the reason leads and no retry is offered. Before this, a closed month read
 * "…Re-enter it and save again. That month is closed…", sending the counter round the loop.
 *
 * Nothing here claims the write did not land on a dead fetch: `cleared` says the server now holds
 * nothing for the item (a delete-then-insert whose insert was refused), otherwise the figure on
 * screen is only "not known to be stored".
 *
 * @param {{ label: string, name: string, cleared?: boolean, err: any, audience?: 'operator'|'staff' }} a
 * @returns {{ text: string, detail: string }}
 */
export function countSaveFailureText({ label, name, cleared = false, err, audience = 'operator' }) {
  const held = cleared
    ? `the server now holds no ${label} figure for it`
    : 'what is on screen is not known to be stored'
  const what = `The ${label} figure for ${name} was not saved — ${held}.`
  const { text, detail } = errorInfo(err, audience)
  return isNetworkError(err) || isTimeout(err)
    ? { text: `${what} Re-enter it and save again. ${text}`, detail }
    : { text: `${text} ${what}`, detail }
}
