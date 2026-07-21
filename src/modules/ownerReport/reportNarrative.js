// Auto-generated Executive Summary prose for the Monthly Owner/Manager Report — the "written"
// part of the hybrid report format (one narrative paragraph up top, pure data tables below).
// Pure function: no React, no Supabase — takes a computeMonthlyReport() snapshot + a period
// label, returns a short paragraph. Same threshold bands as the report page's table coloring
// (Food Cost 35/45, Labor Cost 37/45, Prime Cost 60/65) so the prose and the numbers never
// disagree about what counts as "healthy."
const fmt = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`

export function buildExecutiveSummary(snapshot, periodLabel) {
  const { combined, ims, hr } = snapshot
  if (!combined) return ''

  const clauses = []
  if (combined.revenueTotal != null) {
    clauses.push(`closed with ${fmt(combined.revenueTotal)} in revenue`)
  }
  if (ims && combined.foodCostPct != null) {
    const fc = combined.foodCostPct
    const note = fc > 45 ? ' — well above the healthy 28–35% range'
      : fc > 35 ? ' — above the healthy 28–35% range'
      : ' — within the healthy 28–35% range'
    clauses.push(`a Food Cost of ${fc.toFixed(1)}%${note}`)
  }
  if (ims && hr && combined.primeCostPct != null) {
    const pc = combined.primeCostPct
    const note = pc > 65 ? ', well outside the 60–65% benchmark'
      : pc > 60 ? ', at the edge of the 60–65% benchmark'
      : ', within the 60–65% benchmark'
    clauses.push(`a Prime Cost of ${pc.toFixed(1)}%${note}`)
  }

  const headline = clauses.length > 0 ? `${periodLabel} ${clauses.join(', ')}.` : ''

  let marginSentence = ''
  if (ims && hr && combined.netMarginPct != null) {
    const nm = combined.netMarginPct
    const overhead = ims.overheadTotal || 0
    const overheadNote = nm < 0 && overhead > 0 ? `, driven in part by ${fmt(overhead)} in recorded overhead expenses` : ''
    marginSentence = ` Net Margin was ${nm.toFixed(1)}%${overheadNote}.`
  }

  return (headline + marginSentence).trim()
}
