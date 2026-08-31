import NoPeriodState from './NoPeriodState'
import ReportLoadError from './ReportLoadError'

/**
 * The shell every IMS/Suite report page renders inside — header, KPI strip, and the six states a
 * report can be in: no period, loading, could-not-load, empty, filtered-to-nothing, and content.
 *
 * WHY (S594 `/impeccable critique`): three report pages shipped in three days and each invented
 * its own answer to two questions the design system does not govern. Empty result was
 * `.empty-state` + icon on one page and a bare `<p>` on the other two. The totals row was an
 * inline `fontWeight: 700` on two and a 2px border on the third. Two of the three had no error
 * branch at all, so a failed read rendered as a finished report of zeros. The token layer is
 * enforced rigorously and this product consists almost entirely of report grammar, which nothing
 * enforced at all.
 *
 * The one rule worth stating, because it is the defect this shell exists to make unrepeatable:
 * **the KPI strip does not render while loading or after a failure.** Both pages painted four
 * confident stat cards above their `loading` guard, so a multi-second fiscal-year read showed
 * "Capital in 90+ Day Stock: NPR 0" in green until the real number arrived — and on a failed read
 * it stayed there. A number a page has not computed yet is not a number.
 *
 * Slots, in render order: `banners` (provisional/warning callouts — shown in every state EXCEPT
 * error, see below), `stats`, `note` (the page's own basis/caveat prose), `filters`, body,
 * `footnote`. `children` is the content body and is reached only when the page has loaded, has
 * not failed, and is not empty.
 */
export default function ReportPage({
  title,
  subtitle,
  scope = null,
  actions,
  noPeriod = false,
  noPeriodWhat = 'this report',
  loading = false,
  error = null,
  empty = false,
  emptyIcon = '◷',
  emptyText = 'Nothing to show for this selection.',
  loadingText = 'Building report…',
  banners = null,
  stats = null,
  note = null,
  filters = null,
  footnote = null,
  children,
}) {
  if (noPeriod) return <NoPeriodState what={noPeriodWhat} />

  // A number the page has not computed — or could not compute — is not shown as a number.
  const figuresAreReal = !loading && !error

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
          {/* `scope` — normally a <PeriodScope>. Deliberately NOT gated on `figuresAreReal` the
              way `stats`/`note`/`filters` are: those are figures, and a figure the page has not
              computed must not be shown. Which period the reader ASKED for is true regardless of
              whether the read succeeded, and on the error card it is the single most useful thing
              on screen — "this failed" is far less actionable than "this failed for Bhadra 2082". */}
          {scope && <div className="page-scope-row">{scope}</div>}
        </div>
        {actions && (
          <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {actions}
          </div>
        )}
      </div>

      {/* Banners qualify the whole page, so they survive loading and the empty state — but NOT a
          failed read. A banner is derived from data state the caller set BEFORE the read (e.g.
          ConsolidatedPnl's "Provisional — this period is still open… the statement is reliable
          once the period is closed"), and rendering that directly above this component's own
          "Nothing here is a real figure — this is a failed read" card puts two contradictory
          sentences on screen, one of which asserts a statement exists. */}
      {!error && banners}

      {figuresAreReal && stats}
      {figuresAreReal && note}
      {figuresAreReal && filters}

      {loading ? (
        <p role="status" aria-live="polite" style={{ color: 'var(--theme-text2)', fontSize: 13, padding: '16px 0' }}>
          {loadingText}
        </p>
      ) : error ? (
        <ReportLoadError error={error} />
      ) : empty ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="empty-state" style={{ padding: 32 }}>
            <div className="empty-state-icon">{emptyIcon}</div>
            <p className="empty-state-text">{emptyText}</p>
          </div>
        </div>
      ) : (
        children
      )}

      {figuresAreReal && footnote}
    </div>
  )
}
