/**
 * The three owner-altitude operating ratios that are banded — Labor Cost %, Prime Cost % and Net
 * Margin % — in one place, the way `fcBand()` in `imsFormulas.js` is the one place Food Cost % is
 * banded.
 *
 * WHY THIS FILE EXISTS (S660 / `/impeccable colorize hr`):
 *
 * Labor Cost % was banded three different ways at once, and the disagreement was visible to one
 * reader in one sitting:
 *
 *   • `MonthlyOwnerReport.jsx` — 30/37, with the ✓/△/▲ shape marks (correct, and the model here).
 *   • `OwnerDashboard.jsx`     — the same 30/37 written out inline, **colour only, no mark and no
 *     title** — sitting immediately beside a Food Cost KPI that *does* carry `fcBand`'s mark. Two
 *     KPI tiles in one row, one banded accessibly and one not.
 *   • `Roster.jsx`'s Labor Forecast — `costPct > 35 ? amber : inherit`. A different threshold, a
 *     different hue, no healthy state and no mark: a day at 34% read as fine on the roster board
 *     and as "watch" on both dashboards, and a day at 45% read the same as a day at 36%.
 *
 * Prime Cost % and Net Margin % had the same split (banded with marks in the report, inline and
 * mark-less on the dashboard), so all three moved together rather than leaving a second copy to
 * drift back.
 *
 * TWO THINGS THAT ARE DELIBERATE AND SHOULD NOT BE "FIXED" TO MATCH `fcBand`:
 *
 * 1. **The middle step is `accent-ink`, not amber.** These four metrics (with food cost) are read
 *    as one set on the owner surfaces, and that set has its own three-step language — see
 *    MonthlyOwnerReport's own note. Amber is additionally load-bearing elsewhere in HR, where it
 *    means "open, waiting on you" (see `HR_REQUEST_STATUS` in payrollConstants.js); spending it on
 *    a middle band here would put two meanings on one hue on the Roster board, which shows a
 *    labour cost, a staffing shortfall and a holiday tag in the same row.
 *
 * 2. **Thresholds are literals, not Settings-driven.** `fcBand` reads `fc_warning_pct` /
 *    `fc_critical_pct` because those exist and an admin edits them. There is no labour equivalent,
 *    and per CLAUDE.md a reader for a settings field that nothing writes is worse than no field.
 *    The numbers below are the ones the product already prints as its targets, so the band and the
 *    "Target 25–30%" line beside it can never disagree.
 *
 * `mark` exists for the same reason it exists on `fcBand` (S608): a band carried by hue alone fails
 * WCAG 1.4.1, and green/accent-ink measured close enough under deuteranopia that Healthy and Watch
 * were one colour for roughly 1 in 12 men. ✓ (clear) → △ (hollow caution) → ▲ (filled caution) are
 * distinguished by FILL rather than hue, so they survive greyscale and the monochrome print of the
 * owner report. A caller with no room for a glyph (a chart axis, a sparkline) may take colour
 * alone; a figure a person reads and acts on takes the mark too.
 */

const GOOD  = { key: 'good',  color: 'var(--theme-green-text)',  mark: '✓' }
const WATCH = { key: 'watch', color: 'var(--theme-accent-ink)',  mark: '△' }
const HIGH  = { key: 'high',  color: 'var(--theme-red-text)',    mark: '▲' }
const NONE  = { key: 'none',  color: 'var(--theme-text2)',       mark: '', label: '—' }

/** Labor Cost % band. Lower is better; the published target is 25–30% of revenue. */
export const LABOR_WARN = 30
export const LABOR_CRITICAL = 37

/** Prime Cost % (food + labor) band. The industry benchmark the product prints is 60–65%. */
export const PRIME_WARN = 60
export const PRIME_CRITICAL = 65

/** Net Margin % band — the one INVERTED metric here: higher is better. */
export const MARGIN_GOOD = 20
export const MARGIN_WATCH = 10

/**
 * The primitive: band a lower-is-better percentage against two thresholds, in this file's
 * green/accent-ink/red vocabulary. Exported because the Monthly Owner Report bands FOOD cost with
 * it too — it reads the client's own `fcThresholds()` but deliberately keeps this page's
 * accent-ink middle step rather than `fcBand`'s amber, so its four metrics read as one set.
 */
export function descendingBand(pct, warn, critical, suffix = '') {
  if (pct == null || !isFinite(pct)) return { ...NONE, warn, critical }
  if (pct <= warn)     return { ...GOOD,  label: `Healthy (≤${warn}%${suffix})`, warn, critical }
  if (pct <= critical) return { ...WATCH, label: `Watch (${warn}–${critical}%${suffix})`, warn, critical }
  return { ...HIGH, label: `Needs attention (>${critical}%${suffix})`, warn, critical }
}

/** Band a Labor Cost %. Returns `{ key, label, mark, color, warn, critical }`, like `fcBand`. */
export function lcBand(pct) {
  return descendingBand(pct, LABOR_WARN, LABOR_CRITICAL)
}

/** Band a Prime Cost % (Food Cost % + Labor Cost %). */
export function pcBand(pct) {
  return descendingBand(pct, PRIME_WARN, PRIME_CRITICAL)
}

/** Band a Net Margin %. Inverted — higher is better — so it does not go through `descending`. */
export function nmBand(pct) {
  if (pct == null || !isFinite(pct)) return { ...NONE, warn: MARGIN_GOOD, critical: MARGIN_WATCH }
  if (pct >= MARGIN_GOOD)  return { ...GOOD,  label: `Healthy (≥${MARGIN_GOOD}%)`,  warn: MARGIN_GOOD, critical: MARGIN_WATCH }
  if (pct >= MARGIN_WATCH) return { ...WATCH, label: `Watch (${MARGIN_WATCH}–${MARGIN_GOOD}%)`, warn: MARGIN_GOOD, critical: MARGIN_WATCH }
  return { ...HIGH, label: `Needs attention (<${MARGIN_WATCH}%)`, warn: MARGIN_GOOD, critical: MARGIN_WATCH }
}

/**
 * The rendered form of a banded figure: the number, its shape mark, and the band name as a
 * `title`. One place, so a new call site cannot reintroduce the colour-only version — the exact
 * role `fcFigure()` plays for food cost.
 *
 * Returns `{ style, title, text, band }` — spread `style`/`title` onto the cell and render `text`.
 * `pct` may be null; an absent figure gets a dash and no verdict.
 */
export function bandFigure(pct, bander, { decimals = 1 } = {}) {
  const b = bander(pct)
  const num = pct == null || !isFinite(pct) ? '—' : `${pct.toFixed(decimals)}%`
  return {
    style: { color: b.color },
    title: b.key === 'none' ? undefined : b.label,
    text: b.mark ? `${num} ${b.mark}` : num,
    band: b,
  }
}
