/**
 * One place for the two IMS figures that had drifted into several disagreeing copies.
 *
 * WHY THIS FILE EXISTS (S551 / `/impeccable critique` phase 4):
 *
 * 1. **COGS / "used" quantity.** The same figure was printed with nine different formulas across
 *    nine pages, four of which contradicted the code directly beneath them (Stock.js omitted
 *    Returns from its printed sentence while `getUsed()` subtracted it; Variance.js and
 *    TheoreticalVariance.js omitted Staff Meals the same way). Worse, it was genuinely computed
 *    two ways: AnnualSummary.js left Staff Meals out of COGS entirely while MonthlySummary.js
 *    included them — same month, same column label, two numbers, and nothing on either page said
 *    so. The decision (2026-08-13) is that **staff meals are consumed food and belong in COGS**;
 *    a restaurant that feeds its staff off the same stock has spent that stock.
 *
 *    Import `COGS_FORMULA` wherever the formula is *printed* so the sentence can never drift from
 *    the arithmetic again, and `computeUsed()` wherever it is *computed*.
 *
 * 2. **Food cost % banding.** Three different threshold systems were live at once: Recipes.js read
 *    the client's configured `fc_warning_pct`/`fc_critical_pct` (35/45) for its filter pills but
 *    coloured the very same rows against a hardcoded 30/38, so a dish at 40% was returned by the
 *    pill labelled "⚠ 35–45%" and painted red. MenuPricing printed "Nepal F&B target: 28–35%"
 *    beside a scale of 30/38. `fcBand()` is now the only source of both the colour and the label.
 *
 *    NOTE: `MenuEngineering.js`'s `FC_CUTOFF = 35` classification is deliberately NOT routed
 *    through this — its `classify()` is mirrored verbatim by the frozen Monthly Owner Report
 *    (`computeMenuEngineeringSection.js`), so changing it there would silently desync a snapshot
 *    from the live page it is supposed to agree with. Its *colours* use fcBand; its maths does not.
 */

/** The one sentence every page prints when it explains what "used" / COGS means. */
export const COGS_FORMULA =
  'Opening + Net Purchases (after returns) − Wastage − Staff Meals − Closing'

/**
 * Consumption for a period, in whatever unit the caller passes (qty or value — the arithmetic is
 * identical). `purchases` may arrive already net of returns, in which case pass `returns: 0`.
 */
export function computeUsed({ opening = 0, purchases = 0, returns = 0, wastage = 0, staffMeals = 0, closing = 0 }) {
  return opening + purchases - returns - wastage - staffMeals - closing
}

/** Client-configured food-cost thresholds, with the documented defaults. */
export function fcThresholds(settings) {
  return {
    warn: parseFloat(settings?.fc_warning_pct) || 35,
    critical: parseFloat(settings?.fc_critical_pct) || 45,
  }
}

/**
 * Band a food cost % against the client's own thresholds.
 * Returns the `*-text` contrast variants, never the base tokens — these are always used as text,
 * and the base signal tokens fail WCAG AA on all five light presets (worst 2.05:1 on Rosé Dawn).
 *
 * `mark` exists because **the band must not be carried by colour alone** (S608). Every colour call
 * site was doing `fcBand(pct, settings).color` and throwing `label` away, so which band a dish sat
 * in was a hue and nothing else — on the one figure this product is sold on. That fails WCAG 1.4.1,
 * and it is not theoretical: measured across the presets, `green`/`amber` collapsed to ΔE 2.3–4.4
 * under deuteranopia on five of the ten themes, and the surviving Light preset still collapses
 * `red`/`amber` to ΔE 3.1. Healthy and Too high rendered as the same colour for roughly 1 in 12 men.
 *
 * A `title` alone does NOT fix this — it serves hover and assistive tech, not a sighted colour-blind
 * reader, who is the entire affected population. The marks are therefore distinguished by SHAPE and
 * FILL, never by hue: ✓ (clear) → △ (hollow caution) → ▲ (filled caution). Rendered next to the
 * figure they survive greyscale, a monochrome print, and every form of colour blindness.
 *
 * Use `label` for `title`, `mark` for the visible glyph, and `color` as before. A caller with no
 * room for a glyph (a chart axis, a sparkline) may take colour alone, but a *figure a person reads
 * and acts on* takes the mark too.
 */
export function fcBand(pct, settings) {
  const { warn, critical } = fcThresholds(settings)
  if (pct == null || !isFinite(pct)) {
    return { key: 'none', label: '—', mark: '', color: 'var(--theme-text2)', warn, critical }
  }
  if (pct <= warn) return { key: 'good', label: `Healthy (≤${warn}%)`, mark: '✓', color: 'var(--theme-green-text)', warn, critical }
  if (pct <= critical) return { key: 'watch', label: `Watch (${warn}–${critical}%)`, mark: '△', color: 'var(--theme-amber-text)', warn, critical }
  return { key: 'high', label: `Too high (>${critical}%)`, mark: '▲', color: 'var(--theme-red-text)', warn, critical }
}

/**
 * The rendered form of a banded food-cost figure: the number, its shape marker, and the band name
 * as a `title`. One place, so a new call site cannot reintroduce the colour-only version.
 *
 * Returns `{ style, title, text }` — spread `style`/`title` onto the cell and render `text`.
 * `pct` may be null; the caller decides what an absent figure looks like.
 */
export function fcFigure(pct, settings, { decimals = 1 } = {}) {
  const b = fcBand(pct, settings)
  const num = pct == null || !isFinite(pct) ? '—' : `${pct.toFixed(decimals)}%`
  return {
    style: { color: b.color },
    title: b.key === 'none' ? undefined : b.label,
    text: b.mark ? `${num} ${b.mark}` : num,
    band: b,
  }
}

/** Variance % beyond which the Variance Report flags an item. Admin-editable in Settings. */
export function varianceFlagPct(settings) {
  return parseFloat(settings?.variance_flag_pct) || 10
}

/**
 * Materiality floor for a variance figure, in NPR. Below this a variance is neither good news nor
 * bad news — it is rounding on a small line, and painting it green or red is the "cries wolf"
 * failure S644 named on the dashboard tooltip: when every row earns a colour, the colour has
 * stopped saying anything.
 *
 * Deliberately a CONSTANT and not a `settings` field. A settings field with no reader is worse
 * than no field, and this one would need a DB column, an admin control and a migration to be
 * writable — none of which anyone has asked for. Callers that genuinely need a different floor
 * pass `floorValue`; the day two of them disagree is the day it earns a column.
 */
export const VARIANCE_MATERIALITY_NPR = 500

/** The two thresholds a variance figure is judged against. */
export function varianceThresholds(settings, { floorValue = VARIANCE_MATERIALITY_NPR } = {}) {
  return { tolerancePct: varianceFlagPct(settings), floorValue }
}

/**
 * Band a variance against the client's own configured tolerance — the sibling of `fcBand()`, and
 * added for the same reason it was.
 *
 * THE DRIFT THIS REPLACES (three thresholds for one concept, on two adjacent nav items):
 *   - `Variance.js` flagged rows at the client's `variance_flag_pct` (default 10) but COLOURED
 *     them at `variance > 0` — no threshold at all. So a +0.4% row was painted red while the
 *     badge in its own last column said "OK". The colour and the verdict beside it disagreed.
 *   - `TheoreticalVariance.js` hardcoded ±5 in a private `varianceColor()`, so the number the
 *     client had configured in Settings → Thresholds reached one of the two pages that measure
 *     the same thing.
 *
 * `mark` exists for the reason `fcBand`'s does: **the band must not be carried by colour alone.**
 * Light collapses `red`/`amber` to ΔE 3.1 under deuteranopia, so over-consumed and under-consumed
 * — the two states this whole report exists to tell apart — are one colour for roughly 1 in 12
 * men. The marks are distinguished by SHAPE, never hue.
 *
 * Per S634 the marks are also LITERAL about direction (▲ = more used than theoretical, ▼ = less),
 * because a glyph has to agree with the sign the reader can see; the COLOUR carries the verdict.
 * Both directions are bad here, but differently: over-consumption is waste, theft or
 * over-portioning (red), under-consumption is usually under-portioning or a data gap (amber).
 *
 * `≈` is the dead zone, in the quietest tier: inside it the direction is noise too, so the glyph
 * goes neutral rather than showing a ▲ nobody should read into. The percentage still prints —
 * showing what you are calling immaterial is more honest than hiding it.
 *
 * Order matters. Materiality is checked BEFORE tolerance so a 40% swing worth NPR 20 reads as
 * noise, while tolerance decides good-vs-bad for everything above the floor.
 */
export function varianceBand(pct, value, settings, opts = {}) {
  const { tolerancePct, floorValue } = varianceThresholds(settings, opts)
  // `measured: false` is how a caller says "there is no closing count yet". Every figure is then
  // an artefact of the missing count rather than a finding, and must not be painted as one.
  if (opts.measured === false || pct == null || !isFinite(pct)) {
    return { key: 'none', label: '—', mark: '', color: 'var(--theme-text2)', tolerancePct, floorValue }
  }
  if (value != null && isFinite(value) && Math.abs(value) < floorValue) {
    return {
      key: 'immaterial',
      label: `Immaterial (under NPR ${floorValue.toLocaleString('en-NP')})`,
      mark: '≈', color: 'var(--theme-text3)', tolerancePct, floorValue,
    }
  }
  if (Math.abs(pct) <= tolerancePct) {
    return {
      key: 'ok', label: `Within tolerance (±${tolerancePct}%)`,
      mark: '✓', color: 'var(--theme-green-text)', tolerancePct, floorValue,
    }
  }
  if (pct > 0) {
    return {
      key: 'over', label: `Over-used by more than ${tolerancePct}% — waste, theft or over-portioning`,
      mark: '▲', color: 'var(--theme-red-text)', tolerancePct, floorValue,
    }
  }
  return {
    key: 'under', label: `Under-used by more than ${tolerancePct}% — under-portioning or a data gap`,
    mark: '▼', color: 'var(--theme-amber-text)', tolerancePct, floorValue,
  }
}

/**
 * The whole presentation of one variance percentage — the sibling of `fcFigure()`.
 * Returns `{ style, title, text, band }`; spread `style`/`title` onto the cell and render `text`.
 */
export function varianceFigure(pct, value, settings, { decimals = 1, ...opts } = {}) {
  const b = varianceBand(pct, value, settings, opts)
  const num = pct == null || !isFinite(pct) ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(decimals)}%`
  return {
    style: { color: b.color },
    title: b.key === 'none' ? undefined : b.label,
    text: b.mark ? `${num} ${b.mark}` : num,
    band: b,
  }
}
