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
 * A finalized run's labour cost: gross pay + OVERTIME + employer SSF, summed over its payslips — the
 * definition every labour-cost reader shares (Overheads.js, ClientDashboard, ConsolidatedPnl, the Owner
 * Dashboard, the Monthly Owner Report, and `get_group_summary` / `get_group_pnl` since migration
 * 20260918170000), so no page disagrees about what labour costs. `hr_payslips.gross` is basic +
 * allowances only; overtime lives in `ot_amount`. Until S756 (owner decision, 2026-09-15) the first
 * group left overtime out, so a busy month's labour read low exactly when overtime was highest.
 * Absence deductions are NOT subtracted: this is the cost of labour, not cash paid (payrollCashCost). Returns null when there are no payslips to sum, which the caller should only pass
 * when no finalized run exists (a run with zero payslips is still a real zero — pass `[]` for that).
 */
export function payrollLabourTotal(slips) {
  if (slips == null) return null
  return slips.reduce((s, ps) =>
    s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ot_amount) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
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
 *
 * `none` on an HR client withholds too (S796, owner decision after the IMS critique): payroll is
 * the wage bill there, and until a run is finalized the margin simply has no labour in it — the
 * dashboard was painting "45.8% ✓" beside its own "Labour: none yet". An IMS-only client with an
 * empty Labor tab is still judged: nothing else will ever supply its labour, and the page already
 * names the missing line.
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
  const source = bucket > 0 ? 'overheads' : 'none'
  return { source, amount: bucket, ignoredBucket: 0, verdictWithheld: source === 'none' && !!hrOn }
}

/**
 * Why a withheld verdict was withheld, in the words a tile or a callout prints. One definition,
 * because the three reasons need three different next steps and "not judged on this login" is
 * false for the two that are not about the login. Returns '' when the verdict is not withheld.
 */
export function labourNotJudgedText({ source, verdictWithheld }) {
  if (!verdictWithheld) return ''
  switch (source) {
    case 'unreadable': return 'Not judged on this login'
    case 'failed':     return 'Not judged — payroll could not be loaded'
    case 'none':       return 'Not judged until payroll is finalized'
    default:           return 'Not judged'
  }
}

/**
 * The Owner Dashboard's labour figure (S756, owner decision 2026-09-15).
 *
 * That page never reads the Overheads Labor bucket (it takes bucket='overhead' only, because it
 * subtracts labour separately), so its choice is not payroll XOR bucket but payroll XOR ESTIMATE:
 * a finalized run for the open period supersedes the prorated HR estimate, and the two are never
 * added. The Labor bucket stays out of it entirely, which is what keeps the three-bucket XOR true.
 *
 * `finalizedPayrollCost` is the same total as `payrollLabourTotal` — the Monthly Owner Report's
 * finalized-run figure. It was a separate function while the other pages left overtime out; kept as
 * a name so the Owner Dashboard reads as what it means.
 */
export const finalizedPayrollCost = payrollLabourTotal

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
 * One outlet's labour on the group screens (LABOUR-FIGURES-2), from its `get_group_pnl` row.
 *
 * `resolveLabour` decides it, as for one outlet: finalized payroll, else the Labor tab. Owner and
 * operator only reach the group RPCs, so nothing is fenced. On these screens a figure exists only
 * for `payroll` and `overheads`. A source of `none` has NO figure here, for an HR outlet ("not
 * finalized") and for an IMS-only one ("none entered") alike: `get_group_summary` returned NPR 0 for
 * "no run", and the Group Dashboard banded that 0.0% ✓ on every outlet of the running month.
 *
 * @returns {{ source, amount: ?number, hasFigure: boolean, verdictWithheld: boolean,
 *             ignoredBucket: number, note: string }}
 */
export function groupOutletLabour(pnlRow, hrOn) {
  const payroll = pnlRow?.labour_payroll != null ? parseFloat(pnlRow.labour_payroll) : null
  const r = resolveLabour({ labourBucket: parseFloat(pnlRow?.labour_bucket) || 0, payroll, hrOn: !!hrOn, fenced: false })
  const hasFigure = r.source === 'payroll' || r.source === 'overheads'
  const note = r.source === 'overheads' ? 'Labor tab'
    : r.source === 'none' ? (hrOn ? 'not finalized' : 'none entered')
    : ''
  return { ...r, amount: hasFigure ? r.amount : null, hasFigure, note }
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
    case 'overheads':  return 'Labour: Overheads Labor tab'
    case 'unreadable': return 'Labour: payroll not readable on this login'
    case 'failed':     return 'Labour: payroll could not be loaded'
    case 'none':       return hrOn ? 'Labour: none yet (no finalized payroll, Labor tab empty)' : 'Labour: Labor tab empty'
    default:           return ''
  }
}
