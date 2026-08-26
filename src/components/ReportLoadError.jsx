/**
 * The "could not load" card for report surfaces — extracted from ReportPage (S612) so the ~20
 * report pages that predate the ReportPage shell can adopt the same error grammar without a
 * structural rewrite. A failed read is not an empty period: an RLS rejection, a network blip or
 * the documented auth-token stall all return `data: null, error: {...}`, and a page that drops
 * `error` renders a complete, confident report of NPR 0 — visually identical to a quiet month.
 * Pair with firstError() from shared/queryError.js, and gate the page's KPI strip on
 * `!loading && !loadError` — a number the page has not computed is not a number.
 */
export default function ReportLoadError({ error }) {
  return (
    <div className="card report-error" role="alert">
      <div className="report-error-title">Could not load this report</div>
      <p className="report-error-body">{error}</p>
      <p className="report-error-hint">
        Nothing here is a real figure — this is a failed read, not an empty period. Reload the
        page, and if it keeps happening send this message to support.
      </p>
    </div>
  )
}
