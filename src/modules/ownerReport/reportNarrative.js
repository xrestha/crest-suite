import { npr } from '../../shared/nepalMoney'
import { fcThresholds } from '../../shared/imsFormulas'
// Auto-generated Executive Summary prose for the Monthly Owner/Manager Report — the "written"
// part of the hybrid report format (one narrative paragraph up top, pure data tables below).
// Pure function: no React, no Supabase — takes a computeMonthlyReport() snapshot + a period
// label, returns a short paragraph.
//
// The words come from the same bands the report page colours its table with, so the prose and the
// numbers never disagree about what counts as healthy (S849, OWNER-REPORT-5): Food Cost against the
// client's OWN thresholds — frozen with the report since schema 18, else today's Settings passed in
// as `fcT` — and Prime Cost against the 60–65% benchmark (operatingBands.js). It used to judge Food
// Cost on a hard-coded 35/45 and call anything at or below 35% "within the healthy 28–35% range",
// a negative food cost (a missing count or bill) included.
const fmt = npr

// Below this a food cost is not called healthy: it more often means a bill or a count is missing.
const FC_SUSPICIOUSLY_LOW = 28

/** The labour basis words a summary owes the reader (OWNER-REPORT-10, -9). '' when nothing to say. */
function labourClause(snapshot) {
  const lab = snapshot.combined?.labour
  if (lab) {
    if (lab.source === 'estimate') return 'labour estimated: payroll was not finalized'
    if (lab.source === 'overheads') return 'labour from the Overheads Labor tab'
    return ''
  }
  // A report made before schema 18 names its basis on the HR section.
  return snapshot.hr?.payrollSource === 'estimated' ? 'labour estimated: payroll was not finalized' : ''
}

/**
 * @param {object} snapshot     a computeMonthlyReport() snapshot
 * @param {string} periodLabel  "Bhadra 2083"
 * @param {object} [opts]
 * @param {{warn:number, critical:number}} [opts.fcT]  today's Food Cost thresholds, used only when the
 *   snapshot froze none (a report made before schema 18)
 */
export function buildExecutiveSummary(snapshot, periodLabel, { fcT = null } = {}) {
  const { combined, ims } = snapshot || {}
  if (!combined) return ''

  // S792 (D30, schema v9): Food Cost % is food used (COGS) ÷ revenue; an older snapshot froze net
  // purchases ÷ revenue and the sentence says so. On a v9 snapshot whose closing count had a material
  // gap, the page shows no verdict on the food-cost ratios, so neither does the prose (S756, D6).
  const cogsBasis = combined.foodCostBasis === 'cogs'
  const withheld = cogsBasis && !!ims?.countGap?.material
  const t = combined.fcThresholds || fcT || fcThresholds(null)
  const lab = combined.labour
  // A labour figure with no verdict (no pay set for some staff, or nobody on payroll: SU17).
  const labourUnjudged = !!lab && (lab.reason === 'nopay' || lab.reason === 'nostaff')
  const clauses = []
  if (combined.revenueTotal != null) {
    clauses.push(`closed with ${fmt(combined.revenueTotal)} in revenue`)
  }
  if (ims && combined.foodCostPct != null) {
    const fc = combined.foodCostPct
    const basis = cogsBasis ? '' : ' (on purchases)'
    const note = fc <= 0 ? ' — not judged: a food cost at or below zero means a closing count or a purchase bill is missing'
      : withheld ? ' — not judged, because the closing count is incomplete'
      : fc > t.critical ? ` — well above your ${t.critical}% line`
      : fc > t.warn ? ` — above your ${t.warn}% target`
      : fc >= FC_SUSPICIOUSLY_LOW ? ` — within your ${t.warn}% target`
      : ''
    clauses.push(`a Food Cost${basis} of ${fc.toFixed(1)}%${note}`)
  }
  const labourWords = labourClause(snapshot)
  let labourSaid = false
  if (ims && combined.primeCostPct != null) {
    const pc = combined.primeCostPct
    const fcNotJudged = withheld || (combined.foodCostPct != null && combined.foodCostPct <= 0)
    const note = fcNotJudged || labourUnjudged ? ''
      : pc > 65 ? ', well outside the 60–65% benchmark'
      : pc > 60 ? ', at the edge of the 60–65% benchmark'
      : ', below the 60–65% benchmark'
    clauses.push(`a Prime Cost of ${pc.toFixed(1)}%${note}${labourWords ? ` (${labourWords})` : ''}`)
    labourSaid = !!labourWords
  }

  const headline = clauses.length > 0 ? `${periodLabel} ${clauses.join(', ')}.` : ''

  let marginSentence = ''
  if (ims && combined.netMarginPct != null) {
    const nm = combined.netMarginPct
    // Every recorded cost the margin takes off besides food used and labour: overheads and Tax & Fees
    // (since v12), and raw stock wasted, staff meals and delivery commission (since v18, GAPS-1).
    const v18 = combined.netMarginPnlCosts === true
    const parts = [
      ['overheads', ims.overheadTotal || 0],
      ['fees', ims.taxFeesTotal || 0],
      ...(v18 ? [
        ['wasted stock', ims.cogsWastageTotal || 0],
        ['staff meals', ims.staffMealsValueTotal || 0],
        ['delivery commission', Number(snapshot.deliveryCommission?.amount) || 0],
      ] : []),
    ].filter(([, v]) => v > 0)
    const costTotal = parts.reduce((s, [, v]) => s + v, 0)
    const names = parts.map(([n]) => n)
    const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    const costNote = nm < 0 && costTotal > 0 ? `, after ${fmt(costTotal)} of recorded ${list}` : ''
    const extra = lab?.source === 'none' ? ' (no labour entered on Overheads)'
      : !labourSaid && labourWords ? ` (${labourWords})`
      : ''
    marginSentence = ` Net Margin was ${nm.toFixed(1)}%${costNote}${extra}.`
  }

  return (headline + marginSentence).trim()
}
