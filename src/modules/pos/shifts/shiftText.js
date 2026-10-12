import { formatBsDay } from '../../../utils/bsCalendar'
import { nepalBs, nepalDateAd, nepalTime } from '../../../shared/nepalTime'
import { errorInfo, isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'

/**
 * The Shifts page's wording and dates (S809 slice 4a: SHIFTS-8 to SHIFTS-11), kept out of the page so
 * each sentence can be tested. Nothing here reads the database or the clock except through the
 * timestamps it is handed.
 *
 * Two rules every sentence below follows (errorText.js): a request that got no answer may still have
 * landed, so nothing says "not opened" / "not closed" after a timeout or a dropped connection; and a
 * sentence that sends the reader somewhere names the place (Shift History → Reprint closing report).
 */

// The day a timestamp fell on in Nepal, the way an operator says it: "5th Bhadra 2083". Past the
// verified BS table it prints the AD date rather than a confidently wrong BS one (nepalBs is the
// safe form and returns null there).
export function bsDayLabel(ts) {
  const bs = nepalBs(ts)
  if (bs) return `${formatBsDay(bs.day, bs.month)} ${bs.year}`
  return nepalDateAd(ts)
}

function sameNepalDay(a, b) {
  const x = nepalBs(a), y = nepalBs(b)
  if (x && y) return x.year === y.year && x.month === y.month && x.day === y.day
  return nepalDateAd(a) === nepalDateAd(b)
}

/**
 * A History row's dates (SHIFTS-8). `opened` is the day the shift opened. `closed` is empty when it
 * closed the same day, and otherwise that day with its clock time, because a shift that ran past
 * midnight is two days and "6h 5m" alone does not say which.
 */
export function shiftDates(openedAt, closedAt) {
  const opened = openedAt ? bsDayLabel(openedAt) : ''
  if (!openedAt || !closedAt || sameNepalDay(openedAt, closedAt)) return { opened, closed: '' }
  return { opened, closed: `${bsDayLabel(closedAt)}, ${nepalTime(closedAt)}` }
}

// The History row's expand button, read aloud: "Closing report for Evening, 5th Bhadra 2083".
export function historyRowLabel(shift) {
  const { opened, closed } = shiftDates(shift?.opened_at, shift?.closed_at)
  const name = shift?.label || 'shift'
  if (!opened) return `Closing report for ${name}`
  return closed ? `Closing report for ${name}, ${opened} to ${closed}` : `Closing report for ${name}, ${opened}`
}

// "as of 7:42 PM" beside Current Shift's totals (SHIFTS-10): when they were read, since they do not
// update by themselves.
export function asOfLabel(ts) {
  const t = nepalTime(ts)
  return t ? `as of ${t}` : ''
}

// Why a write got no answer. Both mean the same thing to the reader: it may have landed.
export function noAnswerLead(err) {
  return isTimeout(err) ? 'The server took too long to answer' : 'The connection dropped'
}

// The technical detail alone, in brackets, for a sentence that already says what happened: errorLine
// would add errorText's own "took too long, so it isn't known…" a second time. Never dropped (S619).
export function detailSuffix(err) {
  const { detail } = errorInfo(err, 'operator')
  return detail ? ` (${detail})` : ''
}

/** True when a write got no answer at all, so whether it landed is not known. */
export function isNoAnswer(err) {
  return isTimeout(err) || isNetworkError(err)
}

// SHIFTS-9: Open Shift got no answer, and the page then read the server again. `found` is what that
// read returned: the open shift's row, null (the server shows none open) or undefined (the read failed
// too). Only the first is a definite answer, and even then the shift may be another device's.
export function openUnknownText(err, found) {
  const lead = noAnswerLead(err)
  if (found) {
    return `${lead}, so it was not known whether the shift opened. The page read the server again and now shows what it holds: a shift is open. If it is the one you just opened, its opening slip did not print.`
  }
  const server = found === null
    ? 'The server shows no open shift right now.'
    : 'The page could not read the server to check either.'
  return `${lead}, so it is not known whether the shift opened. ${server} Your count is still here: press Open Shift to try again, and if a shift did open you will be told and shown it.`
}

// A second Open Shift refused because a shift is already open (the one-open-shift index, 23505). A
// definite answer, so the page shows that shift. It may be the one an earlier unanswered press opened.
export const SHIFT_ALREADY_OPEN_TEXT =
  'A shift is already open, so a second one was not opened. The page now shows it. If it is the shift you just opened, its opening slip did not print.'

// Close Shift got no answer (S754's wording, now for a timeout too).
export function closeUnknownText(err) {
  return `${noAnswerLead(err)}, so it is not known whether the shift closed. Reload the page before trying again — if it shows as closed, its slip is in Shift History.`
}

// SHIFTS-10/11: the shift was closed somewhere else, so this count was not saved. Shown on the page,
// never inside the dialog that is closing, and it names where the signed count is.
export const SHIFT_ALREADY_CLOSED_TEXT =
  'This shift was already closed elsewhere, so the count you entered was not saved. The signed count and its closing report are in Shift History.'

// SHIFTS-9: printHtml returned false (the browser blocked the print window).
export function slipNotPrintedText(kind) {
  if (kind === 'open') return 'The shift is open, but its opening slip did not print: the browser blocked the print window. Allow pop-ups for this site so the next slip prints.'
  if (kind === 'close') return 'The shift is closed, but its closing slip did not print: the browser blocked the print window. Print it from Shift History → Reprint closing report.'
  return 'The closing report did not print: the browser blocked the print window. Allow pop-ups for this site, then press Reprint closing report again.'
}

// SHIFTS-11: the open-shift read failed. On the first read there is no last state to show.
export function shiftReadFailLead(firstRead) {
  return firstRead
    ? 'Could not check whether a shift is open.'
    : 'Could not check whether a shift is open, so the page shows the last state it read.'
}

// A failed cash entry with no answer (S754's wording, now for a timeout too).
export function cashUnknownText(err) {
  return `${noAnswerLead(err)}, so it is not known whether this was recorded. Reopen Cash In / Out and check the list before recording it again.`
}
