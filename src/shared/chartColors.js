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
