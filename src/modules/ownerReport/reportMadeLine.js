// When a frozen Owner Report was made, in the words its header prints (S792, owner decision D42).
//
// An IMS supervisor or manager may end the month, but only the Owner's (or Crest admin's) login can
// write this report, so a month a supervisor ends has its report made the first time the Owner
// opens it (`generation_source: 'backfill'`, closePeriod.js `closerMakesReport`). Its figures are
// then the month as it stood on THAT day — a bill added after the close is in them — which is the
// opposite of what "frozen at the close" leads a reader to assume. The header used to print
// `new Date(generated_at).toLocaleString()` (the viewer's clock and calendar) and "Source: Backfill".
// It now says when, in BS and Nepal time, and says plainly when the report was not made at the close.
import { nepalBsLong, nepalDateLong, nepalTime } from '../../shared/nepalTime'

/** "12 Ashwin 2083, 09:14 AM (Nepal time)"; the AD date outside the verified BS table; null if absent. */
export function madeAtText(ts) {
  const time = ts ? nepalTime(ts) : ''
  if (!time) return null
  const day = nepalBsLong(ts) || nepalDateLong(ts)
  return `${day}, ${time} (Nepal time)`
}

/**
 * `{ line, note }` for the report header. `line` is the one fact — when, and by whom when known;
 * `note` is the plain sentence added only when the report was not made at the close.
 * `source` is `monthly_owner_reports.generation_source`; `byName` may be empty.
 */
export function reportMadeText({ generatedAt, source, byName, monthLabel }) {
  const when = madeAtText(generatedAt) || 'at a time that was not recorded'
  const by = byName ? ` by ${byName}` : ''
  const month = monthLabel || 'the month'
  switch (source) {
    case 'period_close':
      return { line: `Made when ${month} was ended: ${when}${by}.`, note: null }
    case 'backfill':
      return {
        line: `Made ${when}${by}, the first time this report was opened.`,
        note: `It was not made when ${month} was ended — for example, when a supervisor ends the month the report waits for the Owner, because a supervisor's login cannot make it. So it shows ${month} as it stood on the day it was made: a bill added to ${month} after it was ended is included.`,
      }
    case 'manual_regenerate':
      return { line: `Regenerated ${when}${by}, from ${month}'s figures as they stood then.`, note: null }
    default:
      return { line: `Made ${when}${by}.`, note: null }
  }
}
