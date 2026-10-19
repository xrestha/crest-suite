// Inventory turnover ratio / days-on-hand — no existing precedent anywhere in this codebase
// (confirmed by research pass), but built entirely from figures computeImsSection already
// computes. Pure function, no queries.
//
// Since schema 18 (S849, OWNER-REPORT-15) "used" is the report's own COGS (food used: what Food
// Cost % divides by revenue) and the average stock is the opening and closing value of the SAME
// items COGS counts (every non-sub-recipe item with a row, hidden ones included; prep left out).
// Until v17 it was opening + net purchases − closing over the displayed stock rows, which include
// prep and leave hidden items out, and took wastage as "used" — a second, different figure for the
// food a month used, on the same page as COGS. `basis: 'cogs'` marks it; an older turnover has none.
export function computeInventoryTurnover({ usedValue, openingValue, closingValue, monthDays }) {
  const opening = openingValue || 0
  const closing = closingValue || 0
  const cogsUsedValue = usedValue || 0
  const avgInventoryValue = (opening + closing) / 2
  const turnoverRatio = avgInventoryValue > 0 ? cogsUsedValue / avgInventoryValue : null
  const daysOnHand = turnoverRatio != null && turnoverRatio > 0 ? monthDays / turnoverRatio : null
  return { cogsUsedValue, avgInventoryValue, turnoverRatio, daysOnHand, basis: 'cogs' }
}
