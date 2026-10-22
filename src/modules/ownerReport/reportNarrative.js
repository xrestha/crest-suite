import { npr } from '../../shared/nepalMoney'
import { fcThresholds } from '../../shared/imsFormulas'
import { descendingBand, lcBand, pcBand, nmBand, LABOR_WARN, LABOR_CRITICAL } from '../../shared/operatingBands'
// Auto-generated Executive Summary prose for the Monthly Owner Report — the "written" part of the
// hybrid report format (one narrative paragraph up top, pure data tables below). Pure function: no
// React, no Supabase — takes a computeMonthlyReport() snapshot + a period label, returns a short
// paragraph.
//
// S857 (the Crest Suite Pro critique): it was one comma-chained sentence, hard going for an owner
// reading English as a second language. Now at most three short sentences:
//   1. what the month made: revenue and Net Margin;
//   2. what drove it: the cost ratio furthest outside its band (else the larger of food and labour),
//      with its band in words;
//   3. "Look at: ..." naming at most two things that need attention, or "Nothing needs attention."
//
// The words come from the same bands the report page colours its table with, so the prose and the
// numbers never disagree about what counts as healthy (S849, OWNER-REPORT-5): Food Cost against the
// client's OWN thresholds — frozen with the report since schema 18, else today's Settings passed in
// as `fcT` — and Labour, Prime and Net Margin through operatingBands.js. "Needs attention" is exactly
// what the page marks △ or ▲, and the prose withholds a verdict exactly where the page does: a
// material count gap or a food cost at or below zero (food, Prime, Net Margin), labour with no
// verdict (pay not set, nobody on payroll, none entered, not read), and Net Margin without the
// Overheads feature.
const fmt = npr

// Below this a food cost is not called healthy: it more often means a bill or a count is missing.
const FC_SUSPICIOUSLY_LOW = 28
// The page's marks: ▲ before △.
const SEVERITY = { high: 2, watch: 1 }
const sev = band => (band ? SEVERITY[band.key] || 0 : 0)

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

/** "a", "a and b" — the list joins of the Look-at line and the margin costs. */
function joinAnd(list) {
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * @param {object} snapshot     a computeMonthlyReport() snapshot
 * @param {string} periodLabel  "Bhadra 2083"
 * @param {object} [opts]
 * @param {{warn:number, critical:number}} [opts.fcT]  today's Food Cost thresholds, used only when the
 *   snapshot froze none (a report made before schema 18)
 * @param {boolean} [opts.canOverheads]  whether the viewer's plan has Overheads; without it the page
 *   shows Net Margin with no verdict, and so does the prose
 */
export function buildExecutiveSummary(snapshot, periodLabel, { fcT = null, canOverheads = true } = {}) {
  const { combined, ims } = snapshot || {}
  if (!combined) return ''

  // S792 (D30, schema v9): Food Cost % is food used (COGS) ÷ revenue; an older snapshot froze net
  // purchases ÷ revenue and the words say so. On a v9 snapshot whose closing count had a material
  // gap, the page shows no verdict on the food-cost ratios, so neither does the prose (S756, D6).
  const cogsBasis = combined.foodCostBasis === 'cogs'
  const gapWithheld = cogsBasis && !!ims?.countGap?.material
  const t = combined.fcThresholds || fcT || fcThresholds(null)
  const lab = combined.labour
  const fc = ims ? combined.foodCostPct : null
  const fcNotPositive = fc != null && fc <= 0
  const foodUnjudged = gapWithheld || fcNotPositive
  // A labour figure with no verdict, as on the page (SU17, OWNER-REPORT-9).
  const labourUnjudged = !!lab && (lab.reason === 'nopay' || lab.reason === 'nostaff' || lab.source === 'failed' || lab.source === 'none')
  const hasLabour = combined.laborCostPct != null && !(lab && (lab.source === 'none' || lab.source === 'failed'))
  const pc = ims ? combined.primeCostPct : null
  const nm = ims ? combined.netMarginPct : null

  // The labour basis is said once, on the first figure that contains labour.
  const labourWords = labourClause(snapshot)
  let labourSaid = false
  const sayLabour = () => {
    if (!labourWords || labourSaid) return ''
    labourSaid = true
    return ` (${labourWords})`
  }

  const sentences = []

  // 1. What the month made.
  const made = []
  if (combined.revenueTotal != null) made.push(`revenue was ${fmt(combined.revenueTotal)}`)
  if (nm != null) {
    // A loss names every recorded cost the margin took off besides food used and labour: overheads
    // and Tax & Fees (since v12), and raw stock wasted, staff meals and delivery commission (since
    // v18, GAPS-1).
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
    const costNote = nm < 0 && costTotal > 0 ? `, after ${fmt(costTotal)} of recorded ${joinAnd(parts.map(([n]) => n))}` : ''
    const extra = lab?.source === 'none' ? ' (no labour entered on Overheads)' : sayLabour()
    made.push(`Net Margin was ${nm.toFixed(1)}%${costNote}${extra}`)
  }
  if (made.length > 0) {
    const body = made.join(' and ')
    sentences.push(periodLabel ? `In ${periodLabel}, ${body}.` : `${body[0].toUpperCase()}${body.slice(1)}.`)
  }

  // 2. What drove it: food and labour, the two parts of Prime Cost, each against its own band.
  const cands = []
  if (fc != null) {
    cands.push({
      name: cogsBasis ? 'Food Cost' : 'Food Cost (on purchases)',
      label: cogsBasis ? 'Food Cost %' : 'Food Cost % (on purchases)',
      pct: fc,
      band: foodUnjudged ? null : descendingBand(fc, t.warn, t.critical),
      over: fc - t.warn,
      verdict: fcNotPositive ? 'not judged: a food cost at or below zero means a closing count or a purchase bill is missing'
        : gapWithheld ? 'not judged, because the closing count is incomplete'
        : fc > t.critical ? `well above your ${t.critical}% line`
        : fc > t.warn ? `above your ${t.warn}% target`
        : fc >= FC_SUSPICIOUSLY_LOW ? `within your ${t.warn}% target`
        : '',
      labour: false,
    })
  }
  if (hasLabour) {
    const lc = combined.laborCostPct
    cands.push({
      name: 'Labor Cost',
      label: 'Labor Cost %',
      pct: lc,
      band: labourUnjudged ? null : lcBand(lc),
      over: lc - LABOR_WARN,
      verdict: lab?.reason === 'nopay' ? 'not judged, because pay is not set for some staff'
        : lab?.reason === 'nostaff' ? 'not judged, because nobody was on payroll'
        : lc > LABOR_CRITICAL ? `well above the ${LABOR_CRITICAL}% line`
        : lc > LABOR_WARN ? `above the ${LABOR_WARN}% target`
        : `within the ${LABOR_WARN}% target`,
      labour: true,
    })
  }
  // The one outside its band furthest (▲ before △, then the most points over its target); with
  // none outside, an unjudged food cost (its reason is the news), else the larger of the two.
  const flagged = cands.filter(c => sev(c.band) > 0).sort((a, b) => sev(b.band) - sev(a.band) || b.over - a.over)
  const driver = flagged[0]
    || (foodUnjudged && cands.find(c => !c.labour))
    || cands.slice().sort((a, b) => b.pct - a.pct)[0]
  if (driver) {
    sentences.push(`${driver.name} was ${driver.pct.toFixed(1)}% of revenue${driver.verdict ? `, ${driver.verdict}` : ''}${driver.labour ? sayLabour() : ''}.`)
  }

  // 3. Look at: what stops a verdict first (the reader can fix it), then the marked figures.
  const look = []
  if (gapWithheld) look.push('the closing count (incomplete)')
  else if (fcNotPositive) look.push('the closing count and purchase bills')
  if (lab?.reason === 'nopay') {
    look.push(`Pay Setup (pay not set for ${lab.noPayCount > 0 ? `${lab.noPayCount} staff` : 'some staff'})`)
  }
  const marked = []
  for (const c of cands) if (sev(c.band) > 0) marked.push({ label: c.label, sev: sev(c.band), labour: c.labour })
  const bothJudged = !foodUnjudged && !labourUnjudged
  if (pc != null && bothJudged) {
    const b = pcBand(pc)
    if (sev(b) > 0) marked.push({ label: 'Prime Cost %', sev: sev(b), labour: true })
  }
  if (nm != null && bothJudged && canOverheads) {
    const b = nmBand(nm)
    if (sev(b) > 0) marked.push({ label: 'Net Margin %', sev: sev(b), labour: true })
  }
  // Stable sort: same mark keeps the order Food, Labour, Prime, Net Margin.
  marked.sort((a, b) => b.sev - a.sev)
  const shown = [...look, ...marked.map(m => m.label)].slice(0, 2)
  const anyFigure = cands.length > 0 || pc != null || nm != null
  if (shown.length > 0) {
    const labourInLook = marked.some(m => m.labour && shown.includes(m.label))
    sentences.push(`Look at: ${joinAnd(shown)}${labourInLook ? sayLabour() : ''}.`)
  } else if (anyFigure) {
    const anyWithheld = foodUnjudged || labourUnjudged || (nm != null && !canOverheads)
    sentences.push(anyWithheld ? 'Nothing that could be judged needs attention.'
      // A food cost this low is not praised (FC_SUSPICIOUSLY_LOW), so the line says only what is true.
      : fc != null && fc < FC_SUSPICIOUSLY_LOW ? 'Nothing is above its target.'
      : 'Nothing needs attention.')
  }

  return sentences.join(' ')
}
