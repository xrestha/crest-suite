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
 */
export function fcBand(pct, settings) {
  const { warn, critical } = fcThresholds(settings)
  if (pct == null || !isFinite(pct)) {
    return { key: 'none', label: '—', color: 'var(--theme-text2)', warn, critical }
  }
  if (pct <= warn) return { key: 'good', label: `Healthy (≤${warn}%)`, color: 'var(--theme-green-text)', warn, critical }
  if (pct <= critical) return { key: 'watch', label: `Watch (${warn}–${critical}%)`, color: 'var(--theme-amber-text)', warn, critical }
  return { key: 'high', label: `Too high (>${critical}%)`, color: 'var(--theme-red-text)', warn, critical }
}

/** Variance % beyond which the Variance Report flags an item. Admin-editable in Settings. */
export function varianceFlagPct(settings) {
  return parseFloat(settings?.variance_flag_pct) || 10
}
