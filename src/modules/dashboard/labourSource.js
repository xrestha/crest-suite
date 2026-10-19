/**
 * Which labour figure a page counts for one outlet and one BS month, and what it must say about it.
 *
 * THE ONE RULE (S849, GAPS-4, owner decision SU11 (a); `resolveOutletLabour` below). Every Suite page
 * that subtracts labour calls it: the Owner Dashboard, the Inventory Dashboard / Home, Overheads, the
 * frozen Owner Report, Consolidated P&L and the Group Console.
 *
 *   1. An outlet WITHOUT Crest HR: labour is the Overheads Labor tab (the whole-month typed amount,
 *      scaled to the days counted in a running month). An empty tab is `none`: 0, still judged.
 *   2. An outlet WITH Crest HR, viewer can read payroll: the FINALIZED payroll run, else the HR wage
 *      estimate (labourEstimate.js), plus the month's other labour (festival, incentive, settlement).
 *      A typed Labor tab is NEVER added and never stands in: it is named "not counted" (`ignoredBucket`).
 *      Staff on payroll with no pay set, or nobody on payroll, keep the figure and withhold the verdict
 *      (SU17). Any failed read is `failed`: no figure.
 *   3. An outlet WITH Crest HR, viewer fenced from payroll (an IMS login; RLS returns `[]`): `unreadable`,
 *      no figure. The Labor tab is not substituted: that would be a second labour figure for the month,
 *      the very disagreement GAPS-4 found (the dashboard's Labor tab against the report's estimate).
 *
 * Before S849 the dashboards used "finalized run, else the Labor tab" (S756, D22) while the Owner
 * Dashboard and Owner Report used "finalized run, else an estimate", so the same month carried two
 * labour figures depending on the page.
 *
 * Pure: no Supabase client, no React. The reads are `loadOutletLabour.js` (one outlet) and the group RPC
 * `get_group_labour_inputs` (`loadGroupLabourInputs`); the other-labour read is `loadOtherLabourPay.js`.
 */

import { npr } from '../../shared/nepalMoney'
import { estimateLabour, estimatedEmployerSsf } from './labourEstimate'

// Kept under its old name for the readers that import it from here (the Owner Report until CROSS-2).
export { estimatedEmployerSsf }

/**
 * Whether payroll is fenced from this login.
 *
 * `hr_payroll_runs` and `hr_payslips` carry the RESTRICTIVE `no_ims_staff` policy, which is
 * rank-blind: any account with an `ims_role` (an IMS manager included) reads both tables as `[]`
 * with NO error. That empty result is indistinguishable from "no finalized run", so the honest move
 * is not to ask at all and say so. Admin and the Owner are never fenced.
 */
export function isPayrollFenced({ hrOn, isAdmin, isOwner, imsRole }) {
  return !!hrOn && !isAdmin && !isOwner && !!imsRole
}

/**
 * A finalized run's labour cost: pay EARNED (gross less the absence deduction) + OVERTIME + employer
 * SSF, summed over its payslips — the definition every labour-cost reader shares (Overheads.js,
 * ClientDashboard, ConsolidatedPnl, the Owner Dashboard, the Monthly Owner Report, HR Dashboard's
 * labour panel, and `get_group_pnl` since migration 20261003120000), so no page disagrees about what
 * labour costs. It is the payroll sheet's own "Cost to business" (`payrollCashCost().total`,
 * payrollData.js; labourSource.test.js pins the two together).
 *
 * `hr_payslips.gross` is basic + allowances only; overtime lives in `ot_amount` (S756, owner decision
 * 2026-09-15: before it, a busy month's labour read low exactly when overtime was highest). Until S798
 * stage 3c the absence deduction was NOT subtracted, so a waiter who joined on the 16th counted a whole
 * month here and half a month on the payroll sheet the Owner signs; unpaid days counted for monthly
 * staff and not for daily staff, whose gross is already days paid (LABOUR-FIGURES-3, owner decision
 * H19 (A): only what was earned). The deduction also carries the days before joining and after leaving.
 *
 * Returns null when there are no payslips to sum, which the caller should only pass when no finalized
 * run exists (a run with zero payslips is still a real zero — pass `[]` for that). Every payslip read
 * feeding it must select `absence_deduction`.
 */
export const PAYSLIP_LABOUR_COLUMNS = 'gross, absence_deduction, ot_amount, ssf_employer'

export function payrollLabourTotal(slips) {
  if (slips == null) return null
  return slips.reduce((s, ps) =>
    s + (parseFloat(ps.gross) || 0) - (parseFloat(ps.absence_deduction) || 0)
      + (parseFloat(ps.ot_amount) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
}

/**
 * Labour paid in a month OUTSIDE the monthly payroll run (S798 stage 3c, LABOUR-FIGURES-1, owner
 * decision H18 (A)): finalized festival allowance and incentives, by the month they are paid in
 * (`bs_year`, `bs_month`), and finalized Final Settlements, by the month they were settled in
 * (`settle_bs_year`, `settle_bs_month`). Before it, a 12-staff cafe's Ashwin read NPR 2,90,000 (24%,
 * green) on every labour figure when the month cost NPR 4,97,600 with the Dashain allowance (41%, red).
 *
 * A settlement is the leaver's final month, which payroll leaves them out of (S751), plus the lump
 * sum: part-month salary (`partial_salary` is already gross − unpaid days + overtime), employer SSF,
 * leave encashment, festival share, notice pay and gratuity (H18: in the month paid), less the notice
 * deduction the business keeps. Travel claims are reimbursement, outside labour as on every page.
 * A settlement saved before S752 has no settle month and is counted in no month.
 *
 * It rides WITH payroll (or the Owner Dashboard's / Owner Report's HR estimate), never on top of the
 * Overheads Labor tab: the owner may have typed the same bonus there. `resolveOutletLabour` names it as not
 * counted when the Labor tab is the source.
 */
export const FESTIVAL_LABOUR_COLUMNS = 'id, festival_name, amount'
export const INCENTIVE_LABOUR_COLUMNS = 'id, amount'
export const SETTLEMENT_LABOUR_COLUMNS = 'id, partial_salary, month_ssf_employer, leave_encashment, festival_pro, notice_pay, gratuity, notice_deduction'

const num = v => parseFloat(v) || 0
const paisa = v => Math.round(v * 100) / 100

/** One Final Settlement's labour cost. */
export function settlementLabourCost(s) {
  if (!s) return 0
  return num(s.partial_salary) + num(s.month_ssf_employer) + num(s.leave_encashment) + num(s.festival_pro)
    + num(s.notice_pay) + num(s.gratuity) - num(s.notice_deduction)
}

/**
 * A month's other labour, from its finalized rows. `festivalName` is the one festival every row
 * names (for "includes Dashain allowance"), or null when there are none or several.
 */
export function otherLabourTotals({ festival, incentives, settlements } = {}) {
  const fest = festival || [], inc = incentives || [], set = settlements || []
  const names = [...new Set(fest.map(r => String(r.festival_name || '').trim()).filter(Boolean))]
  const f = paisa(fest.reduce((t, r) => t + num(r.amount), 0))
  const i = paisa(inc.reduce((t, r) => t + num(r.amount), 0))
  const s = paisa(set.reduce((t, r) => t + settlementLabourCost(r), 0))
  return {
    festival: f, festivalName: names.length === 1 ? names[0] : null,
    incentive: i, settlement: s, settlementCount: set.length,
    total: paisa(f + i + s),
  }
}

export const NO_OTHER_LABOUR = Object.freeze(otherLabourTotals())

/** The same shape from a `get_group_pnl` row's three columns (migration 20261003120000). */
export function otherLabourFromGroupRow(row) {
  const f = paisa(num(row?.labour_festival)), i = paisa(num(row?.labour_incentive)), s = paisa(num(row?.labour_settlement))
  return { festival: f, festivalName: null, incentive: i, settlement: s, settlementCount: null, total: paisa(f + i + s) }
}

/** "Dashain allowance", or "festival allowance" when no single name. A name that says what it is stays. */
function festivalLabel(name) {
  if (!name) return 'festival allowance'
  return /allowance|bonus/i.test(name) ? name : `${name} allowance`
}

/**
 * The parts of other labour, in words: "Dashain allowance NPR 2,07,600 · incentives NPR 12,000 ·
 * final pay of leavers NPR 23,705". '' when there is none.
 */
export function otherLabourParts(other) {
  if (!other || !(other.total > 0 || other.total < 0)) return ''
  const parts = []
  if (other.festival) parts.push(`${festivalLabel(other.festivalName)} ${npr(other.festival)}`)
  if (other.incentive) parts.push(`incentives ${npr(other.incentive)}`)
  if (other.settlement) parts.push(`final pay of leavers ${npr(other.settlement)}`)
  return parts.join(' · ')
}

/**
 * The line a labour figure carries about other labour (H18: name it on the tile). Counted: "includes
 * Dashain allowance NPR 2,07,600". Paid through HR but not counted because the Labor tab is the
 * labour figure: "Not included: Dashain allowance NPR 2,07,600 paid through HR". '' otherwise.
 */
export function otherLabourLine({ other, otherNotCounted } = {}) {
  if (other) {
    const parts = otherLabourParts(other)
    return parts ? `includes ${parts}` : ''
  }
  if (otherNotCounted) {
    const parts = otherLabourParts(otherNotCounted)
    return parts ? `Not included: ${parts} paid through HR` : ''
  }
  return ''
}

/**
 * The sources `resolveOutletLabour` returns. `payroll` / `estimate` / `overheads` / `none` carry a figure
 * (`none` is 0 for an outlet without HR); `unreadable` and `failed` carry null.
 */
export const LABOUR_SOURCES = ['payroll', 'estimate', 'overheads', 'none', 'unreadable', 'failed']

const finiteOr = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d)

/**
 * THE labour rule for one outlet and one BS month (S849, SU11 (a)). See the file header.
 *
 * @param {object}  a
 * @param {boolean} a.hrOn               clients.hr_enabled for THIS outlet
 * @param {boolean} [a.fenced]           isPayrollFenced(...) for the viewer (group RPC callers pass false)
 * @param {?number} [a.payroll]          payrollLabourTotal() of the finalized run(s), or null when none
 * @param {boolean} [a.payrollReadFailed] the run, payslip or other-labour read errored
 * @param {?object} [a.estimate]         estimateLabour(...)'s object (a bare number is accepted), or null
 * @param {boolean} [a.estimateReadFailed] an input to the estimate errored
 * @param {number}  [a.labourBucket]     Σ overheads.amount where bucket = 'labor' for the period, as typed
 * @param {?object} [a.otherPay]         otherLabourTotals() of the month, or null
 * @param {number}  [a.scale]            the share of a WHOLE-MONTH amount counted (mtdClock.fraction for the
 *                                       running month): applied to the Labor tab and to a finalized run,
 *                                       never to the estimate (already accrued to its throughDay) nor to
 *                                       other labour (a lump paid on one day)
 * @returns {{ source: string, amount: ?number, verdictWithheld: boolean,
 *             reason: ''|'unreadable'|'failed'|'nopay'|'nostaff', ignoredBucket: number, other: ?object,
 *             otherNotCounted: ?object, estimate: ?object, scaled: boolean }}
 */
export function resolveOutletLabour({
  hrOn, fenced = false, payroll = null, payrollReadFailed = false, estimate = null, estimateReadFailed = false,
  labourBucket = 0, otherPay = null, scale = 1,
} = {}) {
  const bucket = finiteOr(labourBucket, 0)
  const s = Math.min(1, Math.max(0, finiteOr(scale, 1)))
  const other = otherPay && otherPay.total ? otherPay : null
  const base = { verdictWithheld: false, reason: '', ignoredBucket: 0, other: null, otherNotCounted: null, estimate: null, scaled: false }

  if (!hrOn) {
    // An outlet without Crest HR: the Labor tab is the labour figure. Other labour cannot come from HR
    // here, but a row left from before HR was switched off is named rather than added.
    return {
      ...base, source: bucket > 0 ? 'overheads' : 'none', amount: bucket * s,
      otherNotCounted: other, scaled: bucket > 0 && s < 1,
    }
  }

  // Crest HR: the Labor tab is named on every branch, never counted.
  const ignoredBucket = bucket > 0 ? bucket : 0
  const noFigure = (source, reason) => ({ ...base, source, amount: null, verdictWithheld: true, reason, ignoredBucket })
  if (fenced) return noFigure('unreadable', 'unreadable')
  if (payrollReadFailed) return noFigure('failed', 'failed')
  if (payroll != null && Number.isFinite(Number(payroll))) {
    return {
      ...base, source: 'payroll', amount: Number(payroll) * s + (other ? other.total : 0),
      ignoredBucket, other, scaled: s < 1,
    }
  }
  const est = typeof estimate === 'number' ? { amount: estimate } : estimate
  if (estimateReadFailed || !est || !Number.isFinite(Number(est.amount))) return noFigure('failed', 'failed')
  const reason = (est.noPay?.length || 0) > 0 ? 'nopay' : est.onPayroll === 0 ? 'nostaff' : ''
  return {
    ...base, source: 'estimate', amount: Number(est.amount) + (other ? other.total : 0),
    verdictWithheld: reason !== '', reason, ignoredBucket, other, estimate: est,
  }
}

const plural = (n, one, many) => (n === 1 ? one : many)

/**
 * Every sentence a page owes the reader about a `resolveOutletLabour` result.
 *
 * @returns {{ short: string, long: string[] }}
 *   short: the tile subtext ('labour from finalized payroll', 'labour estimate — payroll not finalized',
 *          'labour from Overheads', 'no labour entered on Overheads', 'labour not readable on this login',
 *          'labour could not be loaded'); '' for a null result.
 *   long:  the notes in order, never an empty string: the Labor tab not counted; pay not set / nobody on
 *          payroll; other labour; leavers with no End Date; calendar days for daily and hourly staff;
 *          sheet overtime.
 */
export function outletLabourNotes(labour, { money = npr } = {}) {
  if (!labour) return { short: '', long: [] }
  const short = {
    payroll: 'labour from finalized payroll',
    estimate: 'labour estimate — payroll not finalized',
    overheads: 'labour from Overheads',
    none: 'no labour entered on Overheads',
    unreadable: 'labour not readable on this login',
    failed: 'labour could not be loaded',
  }[labour.source] || ''
  const long = []
  if (labour.ignoredBucket > 0) long.push(`Labour tab ${money(labour.ignoredBucket)} not counted — Crest HR is the labour figure`)
  const est = labour.estimate
  if (labour.reason === 'nopay') {
    const n = est?.noPay?.length || 0
    long.push(`Pay not set for ${n} staff — not counted, so labour is not judged · Pay Setup →`)
  }
  if (labour.reason === 'nostaff') long.push('No staff on payroll in Crest HR — labour is not judged')
  const otherLine = otherLabourLine(labour)
  if (otherLine) long.push(otherLine)
  if (est) {
    const u = est.unended?.length || 0
    if (u > 0) long.push(`${u} ${plural(u, 'leaver', 'leavers')} with no End Date ${plural(u, 'is', 'are')} not counted · Employees →`)
    if (est.calendarStaff > 0) long.push('Daily and hourly staff: attendance where entered, every day otherwise')
    if (est.sheetOt?.amount > 0) long.push(`Overtime from the attendance sheet included (${money(est.sheetOt.amount)})`)
  }
  return { short, long }
}

/**
 * Whether a result has a labour FIGURE a statement column may print, and its short marker. `none` has
 * no figure (an HR outlet cannot be `none`; for an outlet without HR an empty Labor tab is "none
 * entered", and a group column must not print NPR 0 for it: S798 2e's "0.0% ✓" on every outlet).
 * A withheld estimate (no pay set, nobody on payroll) HAS a figure: print it, without a verdict colour.
 */
export function labourFigure(labour) {
  const hasFigure = !!labour && labour.amount != null && labour.source !== 'none'
  const note = !labour ? 'not loaded'
    : labour.source === 'payroll' ? 'payroll'
    : labour.source === 'estimate' ? 'estimate'
    : labour.source === 'overheads' ? 'Labor tab'
    : labour.source === 'none' ? 'none entered'
    : labour.source === 'unreadable' ? 'not readable'
    : 'not loaded'
  return { hasFigure, note }
}

/**
 * Why a withheld verdict was withheld, in the words a tile or a callout prints. One definition,
 * because the three reasons need three different next steps and "not judged on this login" is
 * false for the two that are not about the login. Returns '' when the verdict is not withheld.
 */
export function labourNotJudgedText({ source, verdictWithheld, reason = '' }) {
  if (!verdictWithheld) return ''
  if (reason === 'nopay') return 'Not judged — pay not set for some staff'
  if (reason === 'nostaff') return 'Not judged — no staff on payroll'
  switch (source) {
    case 'unreadable': return 'Not judged on this login'
    case 'failed':     return 'Not judged — labour could not be loaded'
    case 'none':       return 'Not judged until payroll is finalized'
    default:           return 'Not judged'
  }
}

/**
 * The Overheads rows a page that subtracts labour SEPARATELY may read: every bucket except `labor`.
 * For `.or()` on an `overheads` read, so the server never sends a Labor-tab row to a page that would
 * count it beside payroll (the S526 double count).
 *
 * The Owner Dashboard and the Monthly Owner Report read `.eq('bucket', 'overhead')` until S798
 * stage 2e. S384 added that filter to keep the Labor tab out, and it dropped Tax & Fees (card and
 * bank fees, the accountant, licences) as a side effect, so their net margins read higher than
 * Overheads, the Dashboard and Consolidated P&L for the same month (LABOUR-FIGURES-4). It also
 * dropped rows with no bucket, which `get_group_pnl` counts as overhead. `bucket` is nullable.
 */
export const NON_LABOUR_OVERHEADS = 'bucket.is.null,bucket.in.(overhead,tax_fees)'

/**
 * Those rows split the way Consolidated P&L shows them: Overheads (the `overhead` bucket, and a row
 * with none) and Tax & Fees. A `labor` row that reaches here anyway is left out of both.
 */
export function splitNonLabourOverheads(rows) {
  let overhead = 0, taxFees = 0
  for (const r of rows || []) {
    const amount = parseFloat(r.amount) || 0
    if (r.bucket == null || r.bucket === 'overhead') overhead += amount
    else if (r.bucket === 'tax_fees') taxFees += amount
  }
  return { overhead, taxFees }
}

/**
 * Every bucket of the period's Overheads rows (S849, GAPS-4): Overheads (`overhead` and a row with none),
 * Tax & Fees, and the Labor tab. A page that takes labour from `resolveOutletLabour` reads all three in one
 * read, so the Labor tab can be NAMED as not counted on an HR outlet (or counted on an outlet without HR).
 */
export function splitOverheadBuckets(rows) {
  let overhead = 0, taxFees = 0, labor = 0
  for (const r of rows || []) {
    const amount = parseFloat(r.amount) || 0
    if (r.bucket == null || r.bucket === 'overhead') overhead += amount
    else if (r.bucket === 'tax_fees') taxFees += amount
    else if (r.bucket === 'labor') labor += amount
  }
  return { overhead, taxFees, labor }
}

/**
 * One outlet's labour on the group screens, from its `get_group_pnl` row and (S849) its
 * `get_group_labour_inputs` row (`loadGroupLabourInputs(...).byClient.get(client_id)?.inputs`).
 *
 * The one rule (`resolveOutletLabour`): payroll from `labour_payroll` (+ the row's other labour,
 * migration 20261003120000), else, for an HR outlet, the HR wage estimate from `inputs`; an outlet
 * without HR takes `labour_bucket`. `inputs === null` for an HR outlet with no payroll means the inputs
 * read failed or was not made: `failed`, "not loaded" — never the Labor tab. Owner and operator only
 * reach the group RPCs, so nothing is fenced.
 *
 * @param {object} pnlRow   a get_group_pnl row
 * @param {boolean} hrOn    clients.hr_enabled for the outlet
 * @param {object} [opts]   { inputs, period: { bs_year, bs_month }, throughDay, scale } — the running month
 *                          passes mtdClock's countedDays / fraction (GAPS-5); a closed month the defaults
 * @returns resolveOutletLabour's shape + { hasFigure, note, otherText }; `amount` is null without a figure.
 */
export function groupOutletLabour(pnlRow, hrOn, { inputs = null, period = null, throughDay = null, scale = 1 } = {}) {
  const payroll = pnlRow?.labour_payroll != null ? parseFloat(pnlRow.labour_payroll) : null
  let estimate = null
  if (hrOn && payroll == null && inputs && period) {
    estimate = estimateLabour({ ...inputs, period, throughDay: throughDay ?? undefined })
  }
  const r = resolveOutletLabour({
    hrOn: !!hrOn, fenced: false, payroll, estimate, estimateReadFailed: !!hrOn && payroll == null && !estimate,
    labourBucket: parseFloat(pnlRow?.labour_bucket) || 0, otherPay: otherLabourFromGroupRow(pnlRow), scale,
  })
  const { hasFigure, note } = labourFigure(r)
  // The whole sentence, for a hover or a footnote beside the short note.
  return { ...r, amount: hasFigure ? r.amount : null, hasFigure, note, otherText: otherLabourLine(r) }
}

/**
 * The group's Labour %: total labour ÷ total revenue, only when EVERY outlet in scope has a figure,
 * the way `groupCostRatio` (foodCostBasis.js) handles food cost. Otherwise null, with the outlets
 * missing one named, so the card can say why instead of halving the group figure (one outlet's
 * NPR 3 lakh over two outlets' revenue read 15.0% ✓ before S798 stage 2e).
 *
 * `outlets`: [{ name, revenue, labour: groupOutletLabour(…) }], already in scope (included, with a
 * period).
 */
export function groupLabourRatio(outlets) {
  const list = outlets || []
  const missing = list.filter(o => !o.labour?.hasFigure).map(o => o.name)
  const revenue = list.reduce((s, o) => s + (Number(o.revenue) || 0), 0)
  const labour = list.reduce((s, o) => s + (o.labour?.hasFigure ? o.labour.amount : 0), 0)
  if (list.length === 0 || missing.length > 0 || !(revenue > 0)) return { pct: null, labour: missing.length > 0 ? null : labour, missing }
  return { pct: (labour / revenue) * 100, labour, missing }
}

/** A short on-tile label for the source, or '' when there is nothing useful to say. */
export function labourSourceLabel({ source }, hrOn) {
  switch (source) {
    case 'payroll':    return 'Labour: finalized payroll'
    case 'estimate':   return 'Labour: HR wage estimate (payroll not finalized)'
    case 'overheads':  return 'Labour: Overheads Labor tab'
    case 'unreadable': return 'Labour: payroll not readable on this login'
    case 'failed':     return 'Labour: could not be loaded'
    case 'none':       return hrOn ? 'Labour: none yet (no finalized payroll, Labor tab empty)' : 'Labour: Labor tab empty'
    default:           return ''
  }
}
