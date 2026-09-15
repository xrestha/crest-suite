/**
 * Which labour figure a one-outlet P&L-style view counts, and what it may say about it (S756, D22).
 *
 * The rule — the same one `ConsolidatedPnl` applies per outlet and `Overheads.js` applies to one:
 *
 *   1. A FINALIZED HR payroll run for the period supersedes whatever was typed on the Overheads
 *      page's Labor tab. The two are never added: they are two measurements of one cost, and summing
 *      them is the S526 double-count.
 *   2. With no finalized run, the typed Labor bucket is the labour figure.
 *   3. A login that cannot READ payroll does not get to fall back to (2) as if it were (1)'s absence.
 *
 * WHY THIS FILE EXISTS: the Dashboard's Fixed Costs % and Est. Net Margin % counted only the typed
 * bucket while the Overheads page used the finalized run, so a client paying NPR 4 lakh in wages
 * with an empty Labor tab saw a healthy margin on the Dashboard and a loss on Overheads for the same
 * month. The precedence was written inline in Overheads.js; a second inline copy is how the two
 * pages would come to disagree again, so the Dashboard reads it from here and Overheads can adopt
 * it (it computes the identical answer today — see labourSource.test.js).
 *
 * Pure: no Supabase client, no React. The caller does the reads.
 */

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
 * A finalized run's labour cost: gross pay + employer SSF, summed over its payslips — the definition
 * `get_group_summary`, `ConsolidatedPnl` and `Overheads.js` share, so no page disagrees about what
 * labour costs. Returns null when there are no payslips to sum, which the caller should only pass
 * when no finalized run exists (a run with zero payslips is still a real zero — pass `[]` for that).
 */
export function payrollLabourTotal(slips) {
  if (slips == null) return null
  return slips.reduce((s, ps) => s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
}

/**
 * Resolve the labour figure and its source.
 *
 * @param {object}  a
 * @param {number}  a.labourBucket  Σ amount of the period's Overheads rows with bucket 'labor'.
 * @param {?number} a.payroll       payrollLabourTotal() of the period's finalized run(s), or null
 *                                  when there is none (or payroll was not asked for).
 * @param {boolean} a.hrOn          The client has Crest HR.
 * @param {boolean} a.fenced        isPayrollFenced() for this viewer.
 * @param {boolean} [a.readFailed]  A payroll read was attempted and returned an error.
 *
 * @returns {{
 *   source: 'payroll'|'overheads'|'none'|'unreadable'|'failed',
 *   amount: number,           // the labour figure to put in fixed costs and net margin
 *   ignoredBucket: number,    // typed Labor rows superseded by payroll — name them, never drop silently
 *   verdictWithheld: boolean, // true when labour may be missing and the figure must not be judged
 * }}
 *
 * `unreadable` (fenced) and `failed` both keep the typed bucket in `amount` — it is real money the
 * client entered — but withhold the verdict, because the real wage bill may be absent from it. That
 * is Overheads.js' behaviour exactly: it says "net profit before payroll — not judged on this login"
 * rather than painting a green margin that the Owner, reading the same month, sees as a loss.
 */
export function resolveLabour({ labourBucket, payroll, hrOn, fenced, readFailed = false }) {
  const bucket = Number.isFinite(labourBucket) ? labourBucket : 0
  if (readFailed) {
    return { source: 'failed', amount: bucket, ignoredBucket: 0, verdictWithheld: true }
  }
  if (payroll != null && !fenced) {
    return { source: 'payroll', amount: payroll, ignoredBucket: bucket > 0 ? bucket : 0, verdictWithheld: false }
  }
  if (hrOn && fenced) {
    return { source: 'unreadable', amount: bucket, ignoredBucket: 0, verdictWithheld: true }
  }
  return { source: bucket > 0 ? 'overheads' : 'none', amount: bucket, ignoredBucket: 0, verdictWithheld: false }
}

/**
 * The Owner Dashboard's labour figure (S756, owner decision 2026-09-15).
 *
 * That page never reads the Overheads Labor bucket (it takes bucket='overhead' only, because it
 * subtracts labour separately), so its choice is not payroll XOR bucket but payroll XOR ESTIMATE:
 * a finalized run for the open period supersedes the prorated HR estimate, and the two are never
 * added. The Labor bucket stays out of it entirely, which is what keeps the three-bucket XOR true.
 *
 * WHY A SECOND TOTAL: `finalizedPayrollCost` is gross + OVERTIME + employer SSF, the Monthly Owner
 * Report's finalized-run figure (computeMonthlyReport.js), not `payrollLabourTotal`'s gross + SSF.
 * `hr_payslips.gross` excludes `ot_amount`, and this page's estimate INCLUDES overtime — so reusing
 * `payrollLabourTotal` would make Labor Cost % DROP by the month's OT the moment payroll is
 * finalized, and disagree with the frozen report the same month becomes. The page's own trend chart
 * reads those frozen reports, so the tile follows their definition.
 */
export function finalizedPayrollCost(slips) {
  if (slips == null) return null
  return slips.reduce((s, ps) =>
    s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ot_amount) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
}

/**
 * @param {object}  a
 * @param {?number} a.payroll             finalizedPayrollCost() of the period's finalized run(s), or
 *                                        null when none exists.
 * @param {boolean} [a.payrollReadFailed] The run or payslip read errored. We then do not know
 *                                        whether a run exists, so the estimate must NOT stand in.
 * @param {?number} a.estimate            The prorated estimate, or null when not computed.
 * @param {boolean} [a.estimateReadFailed] An input to the estimate errored.
 * @returns {{ source: 'payroll'|'estimate'|'failed', amount: ?number, verdictWithheld: boolean }}
 *
 * `failed` carries amount null, so every ratio built on it is null and `bandFigure` renders a dash
 * with no colour and no mark — a labour cost of 0 painted ✓ green is the most flattering possible
 * reading of "we could not read payroll".
 */
export function resolveOwnerLabour({ payroll, payrollReadFailed = false, estimate, estimateReadFailed = false }) {
  const failed = { source: 'failed', amount: null, verdictWithheld: true }
  if (payrollReadFailed) return failed
  if (payroll != null) return { source: 'payroll', amount: payroll, verdictWithheld: false }
  if (estimateReadFailed || estimate == null || !Number.isFinite(estimate)) return failed
  return { source: 'estimate', amount: estimate, verdictWithheld: false }
}

/** The Owner Dashboard's inline basis note, worded to match the Monthly Owner Report's HR header. */
export function ownerLabourNote(source) {
  switch (source) {
    case 'payroll':  return 'from finalized payroll'
    case 'estimate': return 'estimate — payroll not finalized'
    case 'failed':   return 'could not be loaded'
    default:         return ''
  }
}

/** A short on-tile label for the source, or '' when there is nothing useful to say. */
export function labourSourceLabel({ source }, hrOn) {
  switch (source) {
    case 'payroll':    return 'Labour: finalized payroll'
    case 'overheads':  return 'Labour: Overheads Labor tab'
    case 'unreadable': return 'Labour: payroll not readable on this login'
    case 'failed':     return 'Labour: payroll could not be loaded'
    case 'none':       return hrOn ? 'Labour: none yet (no finalized payroll, Labor tab empty)' : 'Labour: Labor tab empty'
    default:           return ''
  }
}
