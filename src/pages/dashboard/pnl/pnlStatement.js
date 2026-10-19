// The Profit & Loss statement's pure parts (S849): the one list of lines, the one derivation from raw
// aggregates, the sums (a fiscal year, the consolidated column), what each figure may be coloured, and
// every sentence the page and its Excel export owe the reader. ConsolidatedPnl.jsx keeps the reads and
// the render; nothing here touches Supabase or React, so the screen and the workbook cannot disagree.
//
// It still computes nothing of its own (dashboards.md "/pnl is a statement"): revenue and COGS inputs
// come from periodCost.js (single outlet) or get_group_pnl (group, the SQL copy); labour from the one
// labour rule (labourSource.js: finalized payroll, else the HR estimate for an HR outlet, else the Labor
// tab for an outlet without HR); delivery commission from deliveryCommission.js (or its SQL copy).
import { computeUsed, COGS_FORMULA } from '../../../shared/imsFormulas'
import { npr } from '../../../shared/nepalMoney'
import { gapHeadline, isMaterialGap, mergeGaps } from '../../../shared/uncountedItems'
import { outletLabourNotes } from '../../../modules/dashboard/labourSource'

export const pctOf = (part, whole) => (whole > 0 && part != null ? `${((part / whole) * 100).toFixed(1)}%` : '—')

// One definition of the statement's lines, shared by the single-outlet table, the group matrix and the
// Excel export (dashboards.md: never a second label or tip list).
export const LINES = [
  { key: 'revenue', label: 'Revenue',
    tip: 'All sales for the period at the price actually charged (manual Sales Entry and POS together, counted once), net of discounts. Complimentary items are excluded — they were never paid for.' },
  { key: 'cogs', label: 'Cost of Goods Sold', cost: true,
    tip: `${COGS_FORMULA}. Valued at each item's per-unit rate. Sub-recipes are excluded (their raw ingredients are already counted) — same convention as Monthly Summary, so the two pages tie. Stock moved between your outlets counts like a purchase when it arrives and like a supplier return when it is sent. Stock is valued at today's item prices, so a closed month's figure moves when a price changes.` },
  { key: 'grossProfit', label: 'Gross Profit', strong: true },
  { key: 'wastageVal', label: 'Wastage', cost: true,
    tip: 'Recorded wastage of raw items, valued at cost, broken out of COGS so spoiled stock is visible. Wasted prep is already inside COGS through its ingredients, so the Wastage Report and the dashboards\' Wastage Value can be higher.' },
  { key: 'staffMealsVal', label: 'Staff Meals', cost: true,
    tip: 'Food consumed by staff, valued at cost — spent stock that earned no revenue, shown as its own line.' },
  { key: 'deliveryCommission', label: 'Delivery commission', cost: true,
    tip: 'What Foodmandu, Pathao or another delivery partner kept from bills sold this month, as recorded when you took their payment in Customers → Credit. A bill not settled yet has no commission in it.' },
  { key: 'labour', label: 'Labour', cost: true,
    tip: "On an outlet that runs Crest HR: the finalized payroll (pay earned + overtime + employer SSF, plus the month's festival allowance, incentives and final settlements); until it is finalized, the HR estimate from the staff list, marked as an estimate. A Labor tab entry is then shown as not counted. On an outlet without HR: the Overheads Labor tab. Never both." },
  { key: 'overheads', label: 'Overheads', cost: true,
    tip: "The Overheads page's 'overhead' bucket — rent, utilities, and other fixed costs. Labour and Tax & Fees buckets are their own lines." },
  { key: 'taxFees', label: 'Tax & Fees', cost: true,
    tip: "The Overheads page's 'tax & fees' bucket." },
  { key: 'netProfit', label: 'Net Profit', strong: true,
    tip: 'What is left after every cost on the statement below, before depreciation, interest and income tax. This is the bottom line of the same table, not a second calculation.' },
]

const num = v => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
const plural = (n, one, many) => (n === 1 ? one : many)

/**
 * Raw aggregates for ONE outlet and ONE month → the statement. The one place the lines are derived,
 * whether the raw figures came from the browser reads (single outlet) or get_group_pnl (a group column).
 *
 * `purchasesVal` is net purchases before returns (gross − bill discounts + transfers in) and `returnsVal`
 * is supplier returns + transfers out: computeUsed() takes them that way. `labour` is the labour rule's
 * result with `hasFigure` (labourFigure / groupOutletLabour). `gap` is periodGap / the SQL gap.
 */
export function buildStatement(raw = {}) {
  const revenue = num(raw.revenue)
  const wastageVal = num(raw.wastageVal)
  const staffMealsVal = num(raw.staffMealsVal)
  const cogs = computeUsed({
    opening: num(raw.openingVal), purchases: num(raw.purchasesVal), returns: num(raw.returnsVal),
    wastage: wastageVal, staffMeals: staffMealsVal, closing: num(raw.closingVal),
  })
  const lab = raw.labour || null
  const labourHasFigure = !!lab?.hasFigure
  const labour = labourHasFigure ? num(lab.amount) : null
  const deliveryCommission = num(raw.deliveryCommission)
  const overheads = num(raw.overheads)
  const taxFees = num(raw.taxFees)
  const grossProfit = revenue - cogs
  const netProfit = grossProfit - wastageVal - staffMealsVal - deliveryCommission - (labour || 0) - overheads - taxFees
  const open = !!raw.open
  const hasClosing = !!raw.hasClosing
  const gap = raw.gap || null
  const gapMaterial = !!gap?.material
  return {
    revenue, cogs, grossProfit, wastageVal, staffMealsVal, deliveryCommission, labour, overheads, taxFees, netProfit,
    labourInfo: lab,
    labourHasFigure,
    labourMissing: labourHasFigure ? 0 : 1,
    labourVerdictWithheld: !!lab?.verdictWithheld,
    ignoredLabourBucket: num(lab?.ignoredBucket),
    open,
    hasClosing,
    closedWithoutCount: !open && !hasClosing,
    gap,
    gapMaterial,
    // What each verdict colour depends on (PNL-2, PNL-7, PNL-10): an open month's COGS is a whole
    // shelf; a material uncounted gap overstates COGS; a missing (or withheld) wage bill flatters Net.
    grossWithheld: open || gapMaterial,
    netWithheld: open || gapMaterial || !labourHasFigure || !!lab?.verdictWithheld,
    transferInVal: num(raw.transferInVal),
    transferOutVal: num(raw.transferOutVal),
    onTheWayVal: num(raw.onTheWayVal),
    deliveryUnsettled: num(raw.deliveryUnsettled),
    depreciation: raw.depreciation || null,
    tillWaiting: { bills: num(raw.tillWaiting?.bills), notes: num(raw.tillWaiting?.notes) },
    months: 1,
  }
}

/**
 * Several statements added line by line: a fiscal year (`stock: 'last'`, the default: on-the-way value
 * is a stock figure, so the year shows its last month's) or the consolidated column (`stock: 'sum'`:
 * every sender's stock on the way). Every line is linear, so summing lines equals deriving from summed
 * inputs; labour was resolved per month and per outlet before this. Unjudged when any part is.
 */
export function sumStatements(stmts, { stock = 'last' } = {}) {
  const list = (stmts || []).filter(Boolean)
  if (list.length === 0) return null
  const sum = k => list.reduce((s, x) => s + num(x[k]), 0)
  const out = {}
  for (const l of LINES) out[l.key] = sum(l.key)
  const withFigure = list.filter(s => s.labourHasFigure)
  out.labour = withFigure.length ? withFigure.reduce((s, x) => s + num(x.labour), 0) : null
  // Net Profit takes off the labour that exists; the missing months / outlets are named and the
  // verdict is withheld.
  out.netProfit = out.grossProfit - out.wastageVal - out.staffMealsVal - out.deliveryCommission
    - (out.labour || 0) - out.overheads - out.taxFees
  const gaps = list.map(s => s.gap).filter(Boolean)
  const gap = gaps.length ? mergeGaps(gaps) : null
  const deps = list.map(s => s.depreciation).filter(Boolean)
  const depError = deps.find(d => d.error)
  const last = list[list.length - 1]
  return {
    ...out,
    labourInfo: null,
    labourHasFigure: withFigure.length === list.length,
    labourMissing: list.reduce((s, x) => s + num(x.labourMissing), 0),
    labourVerdictWithheld: list.some(s => s.labourVerdictWithheld),
    ignoredLabourBucket: sum('ignoredLabourBucket'),
    open: list.some(s => s.open),
    hasClosing: list.every(s => s.hasClosing),
    closedWithoutCount: list.some(s => s.closedWithoutCount),
    gap,
    gapMaterial: list.some(s => s.gapMaterial),
    grossWithheld: list.some(s => s.grossWithheld),
    netWithheld: list.some(s => s.netWithheld),
    transferInVal: sum('transferInVal'),
    transferOutVal: sum('transferOutVal'),
    onTheWayVal: stock === 'sum' ? sum('onTheWayVal') : num(last.onTheWayVal),
    deliveryUnsettled: sum('deliveryUnsettled'),
    depreciation: depError
      ? { error: depError.error }
      : deps.length
        ? { amount: deps.reduce((s, d) => s + num(d.amount), 0), count: deps.reduce((s, d) => s + num(d.count), 0), prorated: deps.some(d => d.prorated) }
        : null,
    tillWaiting: {
      bills: list.reduce((s, x) => s + num(x.tillWaiting?.bills), 0),
      notes: list.reduce((s, x) => s + num(x.tillWaiting?.notes), 0),
    },
    months: list.reduce((s, x) => s + (x.months || 1), 0),
  }
}

/** Whether a line's verdict colour is withheld on this statement. */
export function lineWithheld(line, stmt) {
  if (!stmt) return false
  if (line.key === 'grossProfit') return !!stmt.grossWithheld
  if (line.key === 'netProfit') return !!stmt.netWithheld
  return false
}

/**
 * The colour of a figure. Tests `strong && amount > 0` BEFORE `line.cost`, so never pass
 * `{ ...l, strong: true }` to add weight (S594: every positive consolidated cost painted green).
 * A withheld verdict prints in the text colour, no green or red.
 */
export const lineColor = (line, amount, withheld = false) =>
  withheld && line.strong ? 'var(--theme-text1)'
  : amount == null ? 'var(--theme-text3)'
  : line.strong && amount < 0 ? 'var(--theme-red-text)'
  : line.strong && amount > 0 ? 'var(--theme-green-text)'
  : line.cost ? 'var(--theme-text2)' : 'var(--theme-text1)'

/** A figure as the statement prints it: costs in brackets, a missing figure as a dash. */
export const fmtLine = (line, amount) => (amount == null ? '—' : line.cost && amount !== 0 ? `(${npr(amount)})` : npr(amount))

/** The value an Excel cell takes: costs negative, a missing figure blank. */
export const sheetValue = (line, amount) => (amount == null ? '' : Math.round((line.cost ? -1 : 1) * amount))

/** The labour marker a column wears (empty for finalized payroll and a typed Labor tab). */
export function labourMarker(stmt) {
  const lab = stmt?.labourInfo
  if (!lab) return stmt && !stmt.labourHasFigure ? 'labour missing' : ''
  if (lab.source === 'estimate') return 'estimate — payroll not finalized'
  if (!stmt.labourHasFigure) {
    return lab.source === 'none' ? 'none entered'
      : lab.source === 'unreadable' ? 'labour not readable'
      : 'labour not loaded'
  }
  return ''
}

/** The markers under a group column's header, most important first. */
export function columnMarkers(col) {
  if (!col?.hasPeriod) return [{ text: 'no period', tone: 'muted' }]
  const s = col.stmt
  const out = []
  if (s.open) out.push({ text: 'open', tone: 'warn' })
  else if (s.closedWithoutCount) out.push({ text: 'no count', tone: 'warn' })
  if (s.gapMaterial) out.push({ text: 'count incomplete', tone: 'warn' })
  const lm = labourMarker(s)
  if (lm) out.push({ text: lm, tone: 'warn' })
  return out
}

/** A get_group_pnl row's uncounted gap in periodGap's shape, judged against the column's COGS. */
export function groupRowGap(row, cogs) {
  const presentCount = Number(row?.stock_items) || 0
  const uncountedCount = Number(row?.uncounted_count) || 0
  const uncountedValue = num(row?.uncounted_val)
  if (!uncountedCount) return { presentCount, uncountedCount: 0, uncountedValue: 0, cogs: num(cogs), uncounted: [], material: false }
  const gap = { presentCount, uncountedCount, uncountedValue, cogs: num(cogs), uncounted: [] }
  gap.material = isMaterialGap(gap)
  return gap
}

/**
 * One get_group_pnl row (+ its labour from groupOutletLabour) → a group column. purchases_val and
 * returns_val already carry the transfers (mig S849 §2); transfer_in_val / transfer_out_val repeat them
 * for display only.
 */
export function groupColumn(row, labour) {
  const base = {
    revenue: num(row.revenue),
    openingVal: num(row.opening_val),
    purchasesVal: num(row.purchases_val),
    returnsVal: num(row.returns_val),
    wastageVal: num(row.wastage_val),
    staffMealsVal: num(row.staff_meals_val),
    closingVal: num(row.closing_val),
    overheads: num(row.overheads_val),
    taxFees: num(row.tax_fees_val),
    deliveryCommission: num(row.delivery_commission),
    deliveryUnsettled: num(row.delivery_unsettled),
    transferInVal: num(row.transfer_in_val),
    transferOutVal: num(row.transfer_out_val),
    onTheWayVal: num(row.on_the_way_val),
    hasClosing: !!row.has_closing,
    open: row.period_status === 'open',
    labour,
    depreciation: row.depreciation_memo != null ? { amount: num(row.depreciation_memo), count: 0, prorated: false } : null,
    tillWaiting: { bills: num(row.till_waiting_bills), notes: num(row.till_waiting_notes) },
  }
  // The gap is judged against the column's own COGS, so build once to learn it.
  const first = buildStatement(base)
  const stmt = buildStatement({ ...base, gap: groupRowGap(row, first.cogs) })
  return {
    clientId: row.client_id,
    name: row.client_name,
    status: row.period_status,
    hasPeriod: !!row.has_period,
    labour,
    stmt,
  }
}

const tidy = s => String(s || '').replace(/ · [^·]*→$/, '').trim()
const sentence = s => {
  const t = tidy(s)
  return t ? (/[.!?]$/.test(t) ? t : `${t}.`) : ''
}

// The labour sentences one statement owes, with an outlet prefix in a group.
function labourNotes(stmt, { scope, name, hrOn }) {
  const out = []
  const lab = stmt?.labourInfo
  const at = name ? `${name}: ` : ''
  if (!lab) return out
  if (lab.source === 'estimate') {
    out.push({ key: `lab-est-${name || ''}`, tone: 'warn', text: `${at}Labour is the HR wage estimate from the staff list — payroll for ${scope} is not finalized.` })
  } else if (!stmt.labourHasFigure) {
    const why = lab.source === 'none'
      ? (hrOn === false || name ? 'no labour entered — Crest HR is off and the Overheads Labor tab is empty' : 'no labour entered')
      : lab.source === 'unreadable' ? 'labour is not readable on this login'
      : 'labour could not be loaded'
    out.push({ key: `lab-none-${name || ''}`, tone: 'warn', text: `${at}${why[0].toUpperCase()}${why.slice(1)}, so Net Profit has no wage bill in it and carries no colour.` })
  } else if (lab.source === 'overheads' && !name && hrOn === false) {
    out.push({ key: 'lab-tab', tone: 'info', text: 'Crest HR is not on, so labour is the Overheads Labor tab.' })
  }
  for (const line of outletLabourNotes(lab).long) {
    const t = sentence(line)
    if (t) out.push({ key: `lab-${name || ''}-${t.slice(0, 24)}`, tone: /not counted|not judged|No staff/.test(t) ? 'warn' : 'info', text: `${at}${t}` })
  }
  return out
}

/**
 * Every footnote sentence, built once (PNL-6): the page renders them and the Excel export gets the same
 * texts in its notes. Returns `[{ key, text, tone: 'warn' | 'info' }]`.
 *
 * state: {
 *   scope        'Bhadra 2083' | 'Fiscal year 2082/83'
 *   scopeEnd     the month a stock figure is at (the month, or the year's last month)
 *   grouped, fy, runningMonth, hrOn, posEnabled
 *   stmt         the statement shown (single, or the consolidated column)
 *   cols         group columns [{ name, hasPeriod, stmt, monthsWithoutPeriod? }]
 *   excludedNames  outlets not in the column (no Suite)
 *   monthsWithoutPeriod  single fiscal year: labels of the year's months with no Inventory period
 *   openMonths   single fiscal year: labels of the open months
 *   senders      group: [{ name, value }] stock on the way at scopeEnd, by sender
 * }
 */
export function pnlNotes(state = {}) {
  const {
    scope = '', scopeEnd = scope, grouped = false, fy = false, runningMonth = false, hrOn,
    stmt = null, cols = [], excludedNames = [], monthsWithoutPeriod = [], openMonths = [], senders = [],
  } = state
  const notes = []
  const add = (key, text, tone = 'info') => { if (text) notes.push({ key, text, tone }) }
  const withPeriod = cols.filter(c => c.hasPeriod)

  // What the column covers.
  if (grouped) {
    const none = cols.filter(c => !c.hasPeriod).map(c => c.name)
    if (none.length) add('no-period', `No ${scope} in Inventory for: ${none.join(', ')} — the consolidated column is the other outlets only.`, 'warn')
    for (const c of withPeriod) {
      if (c.monthsWithoutPeriod?.length) add(`fy-missing-${c.name}`, `${c.name} has no Inventory month for ${c.monthsWithoutPeriod.join(', ')}; its year adds up the months it has.`, 'warn')
    }
    if (excludedNames.length) {
      add('excluded', `Not included (no Crest Suite Pro): ${excludedNames.join(', ')}. Suite Pro is per outlet — the consolidated column is the total of the outlets shown, not of your whole group.`)
    }
  } else if (fy && monthsWithoutPeriod.length) {
    add('fy-missing', `No Inventory month for ${monthsWithoutPeriod.join(', ')} — the year adds up the months that exist.`, 'warn')
  }
  if (fy) add('fy', `${scope}: Shrawan to Ashadh added up, month by month.`)

  // Open months and counts.
  if (grouped) {
    const open = withPeriod.filter(c => c.stmt.open).map(c => c.name)
    if (open.length) add('open', `Still open at ${open.join(', ')}: closing stock is not counted yet, so COGS there treats it as zero and overstates the true figure. Gross and Net Profit there, and in the consolidated column, carry no colour until the month is closed.`, 'warn')
    const noCount = withPeriod.filter(c => !c.stmt.open && c.stmt.closedWithoutCount).map(c => c.name)
    if (noCount.length) add('no-count', `Closed without a closing stock count: ${noCount.join(', ')} — COGS there treats closing stock as zero and is overstated by whatever was actually on hand.`, 'warn')
    for (const c of withPeriod) {
      const g = c.stmt.gap
      if (!g?.uncountedCount) continue
      add(`gap-${c.name}`, `${c.name}: ${g.uncountedCount} of ${g.presentCount} ${plural(g.presentCount, 'item', 'items')} with stock ${plural(g.uncountedCount, 'has', 'have')} no closing count (${npr(g.uncountedValue)})${g.material ? ' — its Gross and Net Profit, and the consolidated ones, carry no colour until the count is finished' : ''}. The names are on that outlet's Monthly Summary.`, g.material ? 'warn' : 'info')
    }
  } else if (stmt) {
    if (stmt.open) {
      add('open', fy
        ? `${openMonths.length ? `${openMonths.join(', ')} ${plural(openMonths.length, 'is', 'are')}` : 'A month is'} still open, so the year is provisional: COGS there treats closing stock as zero and overstates the true figure, and the year's Gross and Net Profit carry no colour.`
        : `${scope} is still open: closing stock is not counted yet, so COGS treats it as zero and overstates the true figure. Gross and Net Profit are shown without a colour until the month is closed.`, 'warn')
      if (runningMonth) add('open-labour', 'While the month runs, labour counts the days so far; Overheads and Tax & Fees are the whole month as entered.')
    } else if (stmt.closedWithoutCount) {
      add('no-count', `${fy ? 'A month of the year was' : 'This month was'} closed without a closing stock count — COGS treats closing stock as zero and is overstated by whatever was actually on hand.`, 'warn')
    }
    const g = stmt.gap
    if (g?.uncountedCount) {
      add('gap', `${gapHeadline(g, scope)}.${g.material ? ' Gross and Net Profit are shown without a colour until the count is finished.' : ''}`, g.material ? 'warn' : 'info')
    }
  }

  // Labour.
  if (grouped) {
    for (const c of withPeriod) for (const n of labourNotes(c.stmt, { scope, name: c.name })) add(n.key, n.text, n.tone)
    const missing = withPeriod.filter(c => !c.stmt.labourHasFigure).map(c => c.name)
    if (missing.length) add('lab-missing-all', `The consolidated Net Profit has no wage bill for ${missing.join(', ')}, so it carries no colour.`, 'warn')
  } else if (stmt) {
    if (fy) {
      if (stmt.labourMissing > 0) add('lab-fy', `${stmt.labourMissing} ${plural(stmt.labourMissing, 'month has', 'months have')} no labour figure, so the year's labour leaves ${plural(stmt.labourMissing, 'it', 'them')} out and Net Profit carries no colour.`, 'warn')
      if (stmt.ignoredLabourBucket > 0) add('lab-fy-tab', `Labour tab entries of ${npr(stmt.ignoredLabourBucket)} across the year were not counted — Crest HR is the labour figure.`, 'warn')
    } else {
      for (const n of labourNotes(stmt, { scope, hrOn })) add(n.key, n.text, n.tone)
    }
  }

  // Revenue completeness.
  const tillFor = (s, name) => {
    const at = name ? ` at ${name}` : ''
    const b = s?.tillWaiting?.bills || 0
    const n = s?.tillWaiting?.notes || 0
    if (b > 0) add(`till-${name || ''}`, `${b} till ${plural(b, 'bill', 'bills')} from ${scope}${at} ${plural(b, 'is', 'are')} not in Inventory yet, so revenue is short until they are posted (Periods → post waiting till bills).`, 'warn')
    if (n > 0) add(`notes-${name || ''}`, `${n} credit ${plural(n, 'note', 'notes')} from ${scope}${at} ${plural(n, 'is', 'are')} not in Inventory yet, so revenue is overstated until they are posted.`, 'warn')
  }
  const deliveryFor = (s, name) => {
    const at = name ? ` at ${name}` : ''
    const u = s?.deliveryUnsettled || 0
    if (u > 0) add(`deliv-${name || ''}`, `${u} delivery ${plural(u, 'bill', 'bills')} from ${scope}${at} ${plural(u, 'is', 'are')} not settled yet, so the commission the partner keeps on them is not in this figure. A closed month's P&L moves when they are settled.`, 'warn')
  }
  if (grouped) {
    for (const c of withPeriod) { tillFor(c.stmt, c.name); deliveryFor(c.stmt, c.name) }
  } else if (stmt) {
    tillFor(stmt, null); deliveryFor(stmt, null)
  }
  if (stmt && stmt.deliveryCommission > 0) {
    add('deliv-twice', 'If you also typed delivery commission into Overheads → Tax & Fees, it is counted twice — remove that entry.')
  }

  // Stock moved between outlets.
  if (grouped) {
    if (withPeriod.some(c => c.stmt.transferInVal > 0 || c.stmt.transferOutVal > 0)) {
      add('transfers', 'Stock moved between your outlets counts at each outlet like a purchase or a supplier return, at the sending outlet\'s price, and cancels out in the consolidated column.')
    }
    const way = (senders || []).filter(s => s.value > 0)
    const total = way.reduce((s, x) => s + x.value, 0)
    if (total > 0) {
      add('on-the-way', `${npr(total)} of stock was on the way between your outlets at the end of ${scopeEnd} — sent by ${way.map(s => `${s.name} (${npr(s.value)})`).join(', ')}, not yet received. It is in neither outlet's closing stock and does not change profit; it counts at the receiving outlet in the month it is received.`)
    }
  } else if (stmt && (stmt.transferInVal > 0 || stmt.transferOutVal > 0)) {
    add('transfers', `Stock moved between outlets: ${npr(stmt.transferInVal)} received or returned, ${npr(stmt.transferOutVal)} sent — counted like purchases and supplier returns, at the sending outlet's price on the day it was sent.`)
  }

  // Depreciation memo.
  const dep = stmt?.depreciation
  if (dep?.error) {
    add('depr', 'Depreciation from Fixed Assets could not be read, so its memo line is missing. Net Profit is before depreciation, interest and income tax either way.', 'warn')
  } else if (dep && dep.amount > 0) {
    add('depr', `Depreciation (not subtracted): ${npr(dep.amount)} — posted Fixed Asset runs for ${scope}${dep.prorated ? ' (pro-rated from runs longer than the month)' : ''}. Net Profit above is before depreciation, interest and income tax.`)
  } else {
    add('depr', 'Net Profit is before depreciation, interest and income tax.')
  }

  add('prices', 'Stock is valued at today\'s item prices, so a closed month\'s figure moves when a price changes (stock transfers keep the price they were sent at).')
  add('sources', 'Revenue and COGS tie to Monthly Summary, labour to Payroll, overheads to the Overheads page. Stock Count\'s Summary includes prep in its COGS; this statement, like Monthly Summary, counts its raw ingredients instead — the two differ by exactly the prep amount.')
  return notes
}

/**
 * The Excel rows (PNL-6): the same lines, a no-period column blank (not 0) on every line, a marker row
 * under the outlet headers, and the depreciation memo row labelled "memo, not subtracted".
 *
 * single: `{ stmt, monthCols? }` — monthCols [{ label, stmt }] adds a column per month (fiscal year).
 * group:  `{ grouped: true, cols, consolidated }`.
 */
export function statementRows({ grouped = false, cols = [], consolidated = null, stmt = null, monthCols = null } = {}) {
  const memoLabel = 'Depreciation (memo, not subtracted)'
  const depOf = s => (s?.depreciation && !s.depreciation.error ? Math.round(num(s.depreciation.amount)) : '')
  if (grouped) {
    const seen = {}
    const headers = cols.map(c => {
      seen[c.name] = (seen[c.name] || 0) + 1
      return seen[c.name] === 1 ? c.name : `${c.name} (${seen[c.name]})`
    })
    const markerRow = { Line: 'Status' }
    cols.forEach((c, i) => { markerRow[headers[i]] = columnMarkers(c).map(m => m.text).join(', ') })
    markerRow.Consolidated = ''
    markerRow['% of Revenue'] = ''
    const rows = [markerRow]
    for (const l of LINES) {
      const row = { Line: l.label }
      cols.forEach((c, i) => { row[headers[i]] = c.hasPeriod ? sheetValue(l, c.stmt[l.key]) : '' })
      row.Consolidated = consolidated ? sheetValue(l, consolidated[l.key]) : ''
      row['% of Revenue'] = !consolidated ? '' : l.key === 'revenue' ? '100.0%' : pctOf(consolidated[l.key], consolidated.revenue)
      rows.push(row)
    }
    const memo = { Line: memoLabel }
    cols.forEach((c, i) => { memo[headers[i]] = c.hasPeriod ? depOf(c.stmt) : '' })
    memo.Consolidated = depOf(consolidated)
    memo['% of Revenue'] = ''
    rows.push(memo)
    return rows
  }
  if (!stmt) return []
  const rows = LINES.map(l => {
    const row = { Line: l.label }
    for (const m of monthCols || []) row[m.label] = m.stmt ? sheetValue(l, m.stmt[l.key]) : ''
    row[monthCols ? 'Year (NPR)' : 'Amount (NPR)'] = sheetValue(l, stmt[l.key])
    row['% of Revenue'] = l.key === 'revenue' ? '100.0%' : pctOf(stmt[l.key], stmt.revenue)
    return row
  })
  const memo = { Line: memoLabel }
  for (const m of monthCols || []) memo[m.label] = depOf(m.stmt)
  memo[monthCols ? 'Year (NPR)' : 'Amount (NPR)'] = depOf(stmt)
  memo['% of Revenue'] = ''
  rows.push(memo)
  return rows
}
