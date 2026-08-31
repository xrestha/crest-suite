/**
 * The period a report covers, as a chip in the page header rather than the tail of a sentence.
 *
 * WHY THIS EXISTS (2026-08-31, `/impeccable colorize ims`):
 * Across the IMS report family the scope was written into `.page-subtitle` as prose — "Stock
 * valuation & food cost report — Bhadra 2082", "Compare planned spend against actual net
 * purchases — Bhadra 2082". So the single fact an operator has to verify before trusting any
 * figure on the page (which month is this?) was the last few words of a 13px `--theme-text2`
 * sentence, styled identically to the description in front of it, and scanned past accordingly.
 * Twelve pages, one shape, no emphasis anywhere.
 *
 * WHAT IT DOES NOT DO: introduce a colour. The chip is the product's one accent at low tint,
 * the same treatment `.badge-yellow` already uses for a categorical tag — a period is exactly
 * that. Wayfinding is one of the jobs colour is FOR on an Operate surface; a second hue is not.
 *
 * OPEN IS NOT ALWAYS A WARNING, so it is opt-in. On a data-entry screen (Purchases, Stock Count)
 * an open period is the normal working state and flagging it would be noise. On a report whose
 * figures are incomplete until the month closes — anything deriving COGS or variance from a
 * closing count — it is the single most important caveat on the page, and it takes the amber
 * treatment plus a `△` mark. The mark is not decoration: Light collapses amber against the accent
 * badly enough under deuteranopia that "open" and "closed" must not differ by hue alone.
 */
export default function PeriodScope({ label, status, provisionalWhenOpen = false, title }) {
  if (!label) return null

  const isOpen = status === 'open'
  const flagged = isOpen && provisionalWhenOpen

  const defaultTitle = !status
    ? undefined
    : flagged
      ? 'This period is still open — figures here are provisional until it is closed.'
      : isOpen
        ? 'This period is still open and can still be edited.'
        : 'This period is closed. Its figures are final.'

  return (
    <span
      className={`period-scope${flagged ? ' period-scope--provisional' : ''}`}
      title={title || defaultTitle}
    >
      <span className="period-scope-label">{label}</span>
      {status && (
        <span className="period-scope-state">
          {isOpen ? 'Open' : 'Closed'}{flagged ? ' △' : ''}
        </span>
      )}
    </span>
  )
}
