/**
 * The "could not load" card for report surfaces — extracted from ReportPage (S612) so the ~20
 * report pages that predate the ReportPage shell can adopt the same error grammar without a
 * structural rewrite. A failed read is not an empty period: an RLS rejection, a network blip or
 * the documented auth-token stall all return `data: null, error: {...}`, and a page that drops
 * `error` renders a complete, confident report of NPR 0 — visually identical to a quiet month.
 * Pair with firstError() from shared/queryError.js, and gate the page's KPI strip on
 * `!loading && !loadError` — a number the page has not computed is not a number.
 *
 * WHAT `error` MAY BE (S682). Every one of the ~70 call sites hands this either a Supabase error
 * OBJECT or the raw `error.message` STRING (`firstError()` returns the latter), and until S682 the
 * card printed that verbatim — "TypeError: Failed to fetch" as the body of a report an owner is
 * trying to read. The S619 rule is that a raw message is converted at the call site because the
 * AUDIENCE is a fact about who is looking; a report is only ever read by the operator, so this is
 * the one component where converting at render is the same decision every caller would make, and
 * making it here fixes every site at once instead of the ones a grep happens to find. The
 * technical text is never destroyed: it is the fine-print line, exactly as `ActionError` does it.
 * A string that is genuinely hand-written prose (a caller's own sentence) still reaches the
 * reader in full on that line.
 */
import { errorInfo, isTimeoutError } from '../shared/errorText'

// A READ that timed out wrote nothing, so the table's timeout sentence ("it is not known whether
// this went through", worded for a save) does not fit here (S852). Same detail line either way.
const READ_TIMEOUT_TEXT = 'The server took too long to answer, so this report could not be read. Check your connection, then reload the page.'
const READ_TIMEOUT_RETRY_TEXT = 'The server took too long to answer, so this report could not be read. Check your connection, then try again.'

// `onRetry` (S863) adds a Try again button and words the hint for it. A page whose own controls
// stay on screen beside the card (a range it can shorten) passes it, so recovery is not a reload
// that throws the reader's choices away. Without it the card reads exactly as before.
export default function ReportLoadError({ error, onRetry }) {
  const info = errorInfo(error, 'operator')
  const timedOut = isTimeoutError(error)
  const text = timedOut ? (onRetry ? READ_TIMEOUT_RETRY_TEXT : READ_TIMEOUT_TEXT) : info.text
  const { detail } = info
  return (
    <div className="card report-error" role="alert">
      <div className="report-error-title">Could not load this report</div>
      <p className="report-error-body">{text}</p>
      <p className="report-error-hint">
        {onRetry
          ? 'Nothing here is a real figure — this is a failed read, not an empty period. Try again, and if it keeps happening send the detail below to support.'
          : 'Nothing here is a real figure — this is a failed read, not an empty period. Reload the page, and if it keeps happening send the detail below to support.'}
      </p>
      {detail && <p className="action-error-detail">{detail}</p>}
      {onRetry && (
        <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onRetry}>Try again</button>
      )}
    </div>
  )
}
