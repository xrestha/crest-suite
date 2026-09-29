/**
 * The product's cycled categorical chart palette — for a series whose members are not a fixed,
 * known set (spend by category, a vendor split, a category trend). A set that IS fixed takes its
 * own named slot map instead (`COST_BREAKDOWN_COLORS`), so one slice keeps one colour.
 *
 * Literal hex, not theme tokens, on purpose: `var()` does not resolve inside Recharts' SVG `fill`,
 * and the semantic tokens are roles, not distinguishable hues (DESIGN.md's Chart Palette Rule).
 *
 * ONE definition (S794). It lived in `ClientDashboard.jsx`, with byte-identical private copies in
 * `PeriodComparison.js` (`FALLBACK_HEX`) and `VendorReport.js` (`VENDOR_SPLIT_COLORS`), each
 * carrying a comment asking whoever changed one to change the others. That is how the first copy
 * drifted in the first place: until S689 `FALLBACK_HEX` claimed to mirror this list and did not,
 * so a category drew one colour on the Dashboard and another on Period Comparison.
 *
 * Measured, not chosen by eye: S609 replaced a blue/violet pair that sat at ΔE 0.4 under
 * deuteranopia, and S689 re-measured the set on the Modernist card grounds — worst pair ΔE 37.9
 * normal, 14.7 deuteranopia, 17.5 protanopia, against floors of 15 and 8. Re-run the dataviz
 * skill's `validate_palette.js` before changing any slot, and treat only the CVD-separation and
 * normal-vision floors as blocking (design-system.md says why the other two checks always warn).
 */
export const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#8b5cf6', '#ea580c', '#22d3ee', '#f472b6']

/**
 * Where each rupee of revenue goes — a FIXED set of cost slices, so each takes a named slot and keeps
 * it on every surface that draws the split (the Dashboard's Revenue vs Cost pie, Overheads' cost stack,
 * P&L bars and bucket bars). Lifted out of `ClientDashboard.jsx` in S796 so Overheads could stop
 * painting its buckets in the semantic tokens: Overhead was GREEN and Purchases the accent, a category
 * wearing a verdict colour on the page that also says "✓ Profitable" in green (DESIGN.md's One Signal
 * Meaning Rule). Measured S689: worst pair ΔE 56.3 normal, 12.4 deuteranopia, 30.6 protanopia.
 * Red is deliberately absent — red means over threshold here. Net Margin is the one slot that stays
 * semantic, because profit reads as good; a page that withholds the verdict greys it instead.
 */
export const COST_BREAKDOWN_COLORS = {
  'Food Cost':  '#c9a84c', // gold — the FC% line and the Owner Dashboard use the same slot
  'Labor':      '#60a5fa', // blue
  'Overheads':  '#8b5cf6', // violet
  'Tax & Fees': '#ec4899', // pink
  'Net Margin': '#34d399', // green
}
