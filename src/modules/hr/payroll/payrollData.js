// Shared data-fetch helpers used by both the Payroll Run generator and the read-only Calculation
// page — kept in one place so both compute from identical YTD/advance/TADA inputs. Duplicating
// this logic across two files would risk them silently drifting apart, defeating the whole point
// of the Calculation page (it exists to always match what Payroll actually computes).
import { adToBsSafe, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { computeMonthlyTdsBreakdown, fiscalYearOf } from './tds'
import { bonusFiscalYear, fetchFinalizedBonuses, fetchFinalizedSettlements, settlementFiscalYear, settlementLump } from './bonusTax'
import { computePayslip, earnedPay, employedInPeriod, isSsfContributor, roundPaisa, toPaisa } from './payrollCompute'

// Year-to-date taxable per employee: sum of (gross − SSF) and tds from PRIOR finalized payslips
// in the same fiscal year (months before the current one) — PLUS every finalized Festival Allowance
// and Incentive paid in an earlier month of that fiscal year (S751). Those are taxable income with
// tax already withheld on them, and monthly TDS never learned about either: the year's projection
// understated income by every bonus paid. A bonus adds to `gross` and `withheld` but not to
// `count`, which is the number of paid MONTHS the tax is spread over. Final Settlement's lump-sum
// base reads this same map, so a leaver's gratuity is taxed above the bonuses they were paid too.
// S798 ENGINE-5: and every finalized Final Settlement from an earlier month of the year — a leaver
// rehired in the same fiscal year was taxed as if their first spell's last month and exit pay never
// happened. `includeSameMonthBonuses` is Final Settlement's (BONUS-LEDGERS-4), see ytdFromPayslips.
// Returns `{ data, error }`, not a bare map — see the `if (error)` note below.
export async function fetchYtdMap(scopedFrom, period, { includeSameMonthBonuses = false } = {}) {
  // Paged. The fiscal-year narrowing below happens in JS, so this read is EVERY finalized payslip
  // the client has ever had — one row per employee per month, for as long as they have run payroll.
  // Unpaged that silently stops at PostgREST's 1000-row cap (~20 staff x 4 years), and a truncated
  // YTD map understates prior taxable income, which under-withholds TDS and under-remits to the IRD.
  // `.order('id')` is the unique tiebreaker fetchAllRows requires: paging a non-uniquely-ordered
  // query repeats rows on one page and skips them on the next, trading truncation for a worse bug.
  const [{ data, error }, bonuses, settlements] = await Promise.all([
    fetchAllRows(() =>
      // retirement_contribution (S748) is the CIT / provident-fund part of other_deductions; it needs
      // migration 20260914150000 applied before this deploys, or every payroll read fails loudly.
      scopedFrom('hr_payslips', 'employee_id, gross, ot_amount, absence_deduction, ssf_employee, retirement_contribution, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
        .eq('hr_payroll_runs.status', 'finalized')
        .order('id')),
    fetchFinalizedBonuses(scopedFrom),
    fetchFinalizedSettlements(scopedFrom),
  ])
  // A failed read must NOT degrade to an empty YTD map. Empty means "no prior finalized months
  // this FY", which is a real and ordinary state — the first month of the year — so computeMonthlyTds
  // would treat a mid-year employee as a fresh starter, spread their remaining tax over twelve
  // months instead of the months actually left, and under-withhold. Same money consequence as the
  // truncation above, reachable with no row cap at all. Returned in `{ data, error }` shape so it
  // composes with firstError() at the call sites.
  if (error) return { data: null, error }
  if (bonuses.error) return { data: null, error: bonuses.error }
  if (settlements.error) return { data: null, error: settlements.error }
  return { data: ytdFromPayslips(data, bonuses.data, period, { settlements: settlements.data, includeSameMonthBonuses }), error: null }
}

// The pure half of fetchYtdMap, so the arithmetic is tested without a database. `payslips` are
// hr_payslips rows with their run's status and period embedded; `bonuses` come from
// fetchFinalizedBonuses, `settlements` from fetchFinalizedSettlements.
//
// `includeSameMonthBonuses` (S798 BONUS-LEDGERS-4) is for Final Settlement only. Leaving out a bonus
// paid in the current month is right for a monthly payslip — that bonus carried its own marginal tax.
// A settlement trues the year up to actual income and is the leaver's last chance, so a Dashain paid
// in their last month must be in it, or the year and the lump sum on top of it are taxed short.
// Settlements always count from earlier months only: the one being worked out is in this month.
export function ytdFromPayslips(payslips, bonuses, period, { settlements = [], includeSameMonthBonuses = false } = {}) {
  const cur = fiscalYearOf(period.bs_year, period.bs_month)
  const map = {}
  const entry = id => (map[id] = map[id] || { gross: 0, ssf: 0, retirement: 0, withheld: 0, count: 0, bonus: 0, bonusWithheld: 0 })
  // `count` is paid MONTHS. A rehire settled and re-paid in one month is one month, not two.
  const seen = {}
  const countMonth = (id, m) => {
    const s = seen[id] || (seen[id] = new Set())
    if (s.has(m)) return 0
    s.add(m)
    return 1
  }
  ;(payslips || []).forEach(r => {
    if (r.hr_payroll_runs?.status !== 'finalized') return
    const mp = r.hr_payroll_runs?.monthly_periods
    if (!mp) return
    const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
    if (fy.fyStart !== cur.fyStart || fy.monthInFy >= cur.monthInFy) return
    const e = entry(r.employee_id)
    // Pay actually earned — the same earnedPay() buildPayrollRows taxes the current month on. This
    // was gross + OT, which overstated every earlier month for anyone with unpaid days or a part
    // month, so the year's projection ran high and TDS was over-withheld.
    e.gross += earnedPay(r)
    e.ssf   += r.ssf_employee || 0
    e.retirement += parseFloat(r.retirement_contribution) || 0
    e.withheld += r.tds || 0
    e.count += countMonth(r.employee_id, fy.monthInFy) // prior finalized months this FY — feeds tds.js's ytdMonths (mid-year-joiner fix)
  })
  // S798 ENGINE-5: an earlier finalized settlement is a paid month (its last month's pay, SSF, CIT and
  // tax) plus exit lump sums. The lump sums and their tax go in the bonus fields as well, because they
  // were taxed at source the way a bonus is — tds.js takes that tax off before spreading the rest.
  ;(settlements || []).forEach(s => {
    const fy = settlementFiscalYear(s)
    if (!fy || fy.fyStart !== cur.fyStart || fy.monthInFy >= cur.monthInFy) return
    const e = entry(s.employee_id)
    const lump = settlementLump(s)
    const lumpTds = parseFloat(s.lump_tds) || 0
    e.gross += (parseFloat(s.partial_salary) || 0) + lump
    e.ssf += parseFloat(s.month_ssf_employee) || 0
    e.retirement += parseFloat(s.month_retirement_contribution) || 0
    e.withheld += (parseFloat(s.month_tds) || 0) + lumpTds
    e.bonus += lump; e.bonusWithheld += lumpTds
    e.count += countMonth(s.employee_id, fy.monthInFy)
  })
  ;(bonuses || []).forEach(b => {
    const fy = bonusFiscalYear(b)
    if (fy.fyStart !== cur.fyStart || fy.monthInFy > cur.monthInFy) return
    if (fy.monthInFy === cur.monthInFy && !includeSameMonthBonuses) return
    const e = entry(b.employee_id)
    const amount = parseFloat(b.amount) || 0
    const tds = parseFloat(b.tds) || 0
    e.gross += amount; e.withheld += tds
    e.bonus += amount; e.bonusWithheld += tds
  })
  return map
}

// TADA claims a payroll run pays, per employee (S751, decided with Aashish): every claim that is
// APPROVED and whose trip is over by the end of the payroll month. So a claim is paid by the first
// payroll after it is approved and the trip has finished — and by exactly one, because Finalize
// marks it Paid and a Paid claim is no longer Approved.
//
// It used to be "any claim whose trip dates OVERLAP the month, approved or paid-by-payroll". A trip
// from 30 Bhadra to 2 Ashwin overlapped both months: Bhadra paid it, Ashwin put the same claim in
// again (the Paid half of the filter existed only to keep Payroll Calculation's comparison quiet on
// a finalized month), and Ashwin's Finalize could not notice because it only closes Approved
// claims. A claim approved after its month was finalized overlapped no open month and was never
// paid. The Calculation page now shows a finalized month as it was paid, so nothing needs the Paid
// half any more.
export async function fetchApprovedTadaMap(scopedFrom, period) {
  const { end: periodEnd } = periodAdBounds(period)
  // Paged: every approved, still-unpaid claim across the client's history.
  const { data, error } = await fetchAllRows(() =>
    scopedFrom('hr_tada_claims', 'id, employee_id, total_amount, start_date, end_date, status')
      .eq('status', 'approved')
      .lte('end_date', periodEnd)
      .order('id'))
  // As above: an empty map is indistinguishable from "nobody claimed TADA this month", so a
  // failed read would silently drop a real reimbursement out of net pay.
  if (error) return { data: null, error }
  const map = {}
  ;(data || []).forEach(c => {
    const e = map[c.employee_id] || { total: 0, ids: [] }
    e.total += parseFloat(c.total_amount) || 0
    e.ids.push(c.id)
    map[c.employee_id] = e
  })
  return { data: map, error: null }
}

// The AD dates a BS payroll month covers, as 'YYYY-MM-DD'.
export function periodAdBounds(period) {
  return {
    start: formatAd(bsToAd(period.bs_year, period.bs_month, 1)),
    end:   formatAd(bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month))),
  }
}

// ── Draft-vs-live drift, shared by Payroll Run's Finalize gate and the Calculation page's
// Stale badge ────────────────────────────────────────────────────────────────────────────────
// Both used to compare `net_pay` alone. TDS and TADA are deliberately hand-editable while a run
// is a draft, and each edit writes a recomputed net_pay — so overriding one TDS registered as
// staleness. On Payroll Run that was a deadlock, not merely a false alarm: finalize() refuses
// while stale and offers no override, and the only escape — Regenerate — resets the very edit
// that caused it, so a legitimate override could never be finalized. On the Calculation page the
// same comparison raised a permanent red ⚠ Stale against a payslip that was correct.
//
// The fix is to compare what no one can type into. `FRESHNESS_INPUT_FIELDS` are all computed, so
// a difference in any of them is always genuine upstream movement (attendance, overtime, salary
// setup, an advance instalment). TADA is caught by its CLAIM IDS instead of its amount, which
// preserves exactly what the amount comparison used to detect — approving or withdrawing a claim
// after Generate changes the id set, while a typed correction leaves it identical.
//
// Lives here rather than in either page because this module exists so those two cannot drift; a
// third copy of the comparison is precisely the failure it was written to prevent.
// `retirement_contribution` (S748): ticking "reduces taxable income" on an existing CIT deduction
// moves no amount above, only the TDS — which would otherwise read as a hand override.
export const FRESHNESS_INPUT_FIELDS = [
  'gross', 'ot_amount', 'absence_deduction', 'ssf_employee', 'other_deductions', 'advance_deduction',
  'retirement_contribution',
]

// How far a payslip's stored net pay is from its own parts: gross + overtime − unpaid days − SSF −
// other deductions − advance − TDS + TADA. The engine rounds net once to the paisa, so a true payslip
// is within half a paisa. The same identity is the database's hr_payslips_guard_net and the check in
// finalize_payroll_run (migration 20261001140000); the three change together.
export const NET_TOLERANCE = 0.01
export function payslipNetGap(s) {
  const n = v => parseFloat(v) || 0
  const parts = n(s.gross) + n(s.ot_amount) - n(s.absence_deduction) - n(s.ssf_employee) - n(s.other_deductions)
    - n(s.advance_deduction) - n(s.tds) + n(s.tada_amount)
  return n(s.net_pay) - parts
}

// Order-independent identity for a payslip's TADA claim set.
const claimKey = ids => (Array.isArray(ids) ? [...ids].sort().join(',') : '')

const near = (a, b) => Math.round(a || 0) === Math.round(b || 0)
// The advance is recovered to the paisa (S791), so a whole-rupee comparison would call a draft that
// cuts 2,499.50 where 2,500 is now due "unchanged" and let Finalize book the wrong split.
const nearField = (f, a, b) => (f === 'advance_deduction' ? toPaisa(a) === toPaisa(b) : near(a, b))

// → 'moved'      the underlying data changed since Generate; the draft is genuinely out of date
//   'overridden' inputs agree, so the only difference is a TDS a person typed in
//   null         stored and live agree, or there is nothing stored to compare against
//
// S751: a TDS difference is an override only when the payslip SAYS it was typed
// (`tds_overridden`). Everything else that moves TDS — a prior month finalized after this draft was
// generated, an insurance premium entered, a bonus paid — used to read as "manually adjusted" and
// was locked in by Finalize as though someone had chosen it. TADA is no longer hand-editable on the
// payslip (it always equals its approved claims), so any TADA difference is movement.
//
// S798 PAYROLL-4: a stored net pay that is not its own parts is 'moved' too. Comparing the inputs never
// looked at net_pay, so a net edited over REST passed this check, Finalize, Mark paid and the bank sheet
// with every input intact. Every writer keeps the identity (a typed TDS rewrites net with it), so this
// does not bring back the S620/S751 deadlock.
export function payslipDrift(stored, live) {
  if (!stored) return null
  if (Math.abs(payslipNetGap(stored)) > NET_TOLERANCE) return 'moved'
  if (FRESHNESS_INPUT_FIELDS.some(f => !nearField(f, stored[f], live[f]))) return 'moved'
  if (claimKey(stored.tada_claim_ids) !== claimKey(live.tada_claim_ids)) return 'moved'
  if (!near(stored.tada_amount, live.tada_amount)) return 'moved'
  if (!near(stored.tds, live.tds)) return stored.tds_overridden ? 'overridden' : 'moved'
  return null
}

// Index a flat result set by employee_id, once, instead of re-filtering it per employee.
//
// Both Payroll Run and Payroll Calculation build one payslip per employee and each needed that
// employee's slice of three arrays — `components`, `attendance`, `otEntries`. Written as a
// `.filter()` inside the `employees.map()`, that is a full scan of each array per employee, and
// `attendance` is one row per employee per DAY: at 40 staff on a 30-day month it is ~1,200 rows
// scanned 40 times over, per render, for a partition that could be computed in one pass.
//
// `.filter()` preserves source order and so does appending in source order, so the slices are
// byte-identical to what the filters produced — which matters, because both callers feed these
// straight into computePayslip on a path that WRITES payslips.
//
// Lives here for the same reason the fetch helpers do: these two pages must not drift.
export function groupByEmployee(rows, key = 'employee_id') {
  const m = new Map()
  for (const r of rows || []) {
    const k = r[key]
    const bucket = m.get(k)
    if (bucket) bucket.push(r)
    else m.set(k, [r])
  }
  return m
}

const EMPTY = []
// Reads a bucket without allocating a new array per miss — an employee with no attendance rows is
// ordinary (a mid-month joiner), not an edge case.
export const sliceFor = (index, empId) => index.get(empId) || EMPTY

// ── When recovery of an advance starts ─────────────────────────────────────────────────────────
// The payroll of the BS month AFTER the one the advance was issued in (owner's decision,
// 2026-09-11 — the same rule hss-suite adopted; see docs/CROSS-REPO.md). The day inside the month
// never matters: an advance handed over on 1 Bhadra and one handed over on 28 Bhadra both see
// their first cut on the Ashwin payslip. Chaitra (12) rolls into Baisakh (1) of the next BS year.
// The question is asked in BS because payroll periods are BS months; `issued_date` is stored AD.
//
// Until this existed, buildAdvanceMap() looked at `status` alone, so an advance issued in Bhadra
// was deducted from a Shrawan run that was still open — a repayment dated a month before the
// money was handed over — and Finalize then allocated that deduction onto the employee's oldest
// active advance, which could be one not yet due.
//
// The AD string is parsed as a LOCAL date (`T00:00:00`, no zone): `new Date('YYYY-MM-DD')` is UTC
// midnight, which adToBs's local getters read as the previous day for any viewer west of UTC.
export function firstRecoveryMonth(issuedDate) {
  const bs = issuedDate ? adToBsSafe(new Date(String(issuedDate).slice(0, 10) + 'T00:00:00')) : null
  if (!bs) return null
  return bs.month === 12 ? { bs_year: bs.year + 1, bs_month: 1 } : { bs_year: bs.year, bs_month: bs.month + 1 }
}

const monthIndex = p => p.bs_year * 12 + (p.bs_month - 1)

// Is this advance due for a cut in the given payroll period? An issued date the calendar cannot
// convert (missing, or outside the verified BS table — impossible from the picker, but a raw import
// could) answers `false`: it is excluded from the run and stays visibly outstanding in Advances &
// Loans, rather than being deducted from a month nobody chose. Errs on the employee's side, in the
// open.
export function advanceDueIn(adv, period) {
  const first = firstRecoveryMonth(adv?.issued_date)
  if (!first || !period || !period.bs_year || !period.bs_month) return false
  return monthIndex(period) >= monthIndex(first)
}

// The advances a payroll run may touch: still open, and already past their first recovery month.
// Every place that reads advances FOR A PERIOD — the deduction (buildAdvanceMap), Finalize's
// allocation of it back onto individual advances, and the Calculation breakdown panel's count —
// goes through this ONE filter so the three cannot disagree about which advances a month recovers.
//
// Deliberately NOT used by Final Settlement: an exit settlement recovers every outstanding advance
// regardless of when it was issued, because there is no later payroll to recover it from.
export function dueAdvances(advances, period) {
  return (advances || []).filter(a => a.status === 'active' && advanceDueIn(a, period))
}

// Per-employee scheduled advance deduction for this period.
// For each active advance already in recovery (dueAdvances): deduct min(installment, outstanding).
// If no installment set, deduct full outstanding (treated as one-time advance).
//
// `period` is REQUIRED and the function throws without it: a caller that forgot it would otherwise
// get an empty map, and an empty map is "nobody owes anything this month" — the quietest possible
// way to stop recovering the company's money (or, before this rule, to recover it early).
//
// Summed in whole paisa (S791): a balance of Rs. 500.50 asks for exactly 500.50, never a float that
// rounds to 501 on one page and 500.49 on another.
export function buildAdvanceMap(advances, repayments, period) {
  if (!period || !period.bs_year || !period.bs_month) throw new Error('buildAdvanceMap needs the payroll period (bs_year, bs_month)')
  const repaid = {}
  ;(repayments || []).forEach(r => {
    repaid[r.advance_id] = (repaid[r.advance_id] || 0) + toPaisa(r.amount)
  })
  const duePaisa = {}
  dueAdvances(advances, period).forEach(adv => {
    const outstanding = Math.max(0, toPaisa(adv.amount) - (repaid[adv.id] || 0))
    if (outstanding <= 0) return
    const deduction = Math.min(toPaisa(adv.installment_amount) || outstanding, outstanding)
    duePaisa[adv.employee_id] = (duePaisa[adv.employee_id] || 0) + deduction
  })
  const advMap = {}
  Object.keys(duePaisa).forEach(id => { advMap[id] = duePaisa[id] / 100 })
  return advMap
}

// The advance a payslip can actually cut: what is due, capped at what is left of the take-home
// after TDS, floored to the paisa and never rounded up, so the cut can never exceed the pay it
// comes out of by a fraction (S791, from hss-suite). The rest stays owed and later cuts take it.
export function recoverableAdvance(requested, netBeforeAdvance) {
  const want = Math.max(0, toPaisa(requested))
  const available = Math.max(0, Math.floor((parseFloat(netBeforeAdvance) || 0) * 100 + 1e-6))
  return Math.min(want, available) / 100
}

// Finalize's half of the advance ledger: turn each payslip's advance_deduction back into repayment
// rows against individual advances, oldest first, through the same dueAdvances() filter the
// deduction came from. Repayments this run already wrote (a re-finalize after Reopen) are left out
// of "already repaid", because the caller deletes and re-inserts them. Pure, so Payroll Run can run
// it over data it has just re-read rather than over what was on screen when the page opened.
//
// Worked in whole paisa (S791). An advance settles only at EXACT coverage: the old test settled
// anything within Rs. 0.01, so a one-paisa remainder was marked repaid and never recovered.
// `settleIds` is informational; the status itself is set by the database trigger on the rows.
export function allocateAdvanceRepayments({ payslips, advances, repayments, period, runId, repaidDate, note }) {
  const repaid = {}
  ;(repayments || []).filter(r => r.payroll_run_id !== runId).forEach(r => {
    repaid[r.advance_id] = (repaid[r.advance_id] || 0) + toPaisa(r.amount)
  })
  const dueNow = dueAdvances(advances, period)
  const repayRows = []
  const settleIds = []
  for (const slip of payslips || []) {
    let remaining = Math.max(0, toPaisa(slip.advance_deduction))
    for (const adv of dueNow.filter(a => a.employee_id === slip.employee_id)) {
      if (remaining <= 0) break
      const outstanding = Math.max(0, toPaisa(adv.amount) - (repaid[adv.id] || 0))
      if (outstanding <= 0) continue
      const take = Math.min(toPaisa(adv.installment_amount) || outstanding, outstanding, remaining)
      if (take <= 0) continue
      repayRows.push({
        advance_id: adv.id, employee_id: slip.employee_id, repaid_date: repaidDate,
        amount: take / 100, notes: note, payroll_run_id: runId,
      })
      repaid[adv.id] = (repaid[adv.id] || 0) + take
      if (take >= outstanding) settleIds.push(adv.id)
      remaining -= take
    }
  }
  return { repayRows, settleIds }
}

// Advances this run recovered money from that have since been WRITTEN OFF (S791). Reopen deletes the
// run's repayment rows, and on a written-off advance that silently grows the write-off by what the run
// recovered: nobody decided to forgive that money. So Reopen refuses while one stands, in the
// database (reopen_payroll_run) and first here, naming each advance and what the run took from it.
// The way out is Advances & Loans → Reactivate, which puts the advance back into recovery.
export function writtenOffAdvancesForRun(advances, repayments, runId) {
  const recovered = {}
  ;(repayments || []).forEach(r => {
    if (r.payroll_run_id === runId) recovered[r.advance_id] = (recovered[r.advance_id] || 0) + toPaisa(r.amount)
  })
  return (advances || [])
    .filter(a => recovered[a.id] > 0 && a.status === 'written_off')
    .map(a => ({ advance: a, recoveredHere: recovered[a.id] / 100 }))
}

// What a month's payroll costs the business (S753, from hss-suite's Cost to Company tile): pay
// actually earned — gross less unpaid days plus overtime — plus the employer's 20% SSF. Net Payable is
// not that figure: it leaves out the employee SSF, CIT and income tax the business withholds and pays
// on the staff's behalf, and it includes travel reimbursements, which are not pay. Paisa-rounded.
export function payrollCashCost(payslips) {
  const n = v => parseFloat(v) || 0
  let earned = 0, employerSsf = 0, tada = 0
  for (const s of payslips || []) {
    earned += n(s.gross) - n(s.absence_deduction) + n(s.ot_amount)
    employerSsf += n(s.ssf_employer)
    tada += n(s.tada_amount)
  }
  const r2 = v => Math.round(v * 100) / 100
  return { total: r2(earned + employerSsf), earned: r2(earned), employerSsf: r2(employerSsf), tada: r2(tada) }
}

// ── Who a month's payroll covers (S751) ────────────────────────────────────────────────────────
// `email` is read for Payroll Run's own-payslip test (useIsOwnEmployee, S798 3a), not by the engine.
export const PAYROLL_EMPLOYEE_COLUMNS = 'id, full_name, employee_code, pay_basis, basic_salary, ssf_no, ssf_enrolled, life_insurance_premium, health_insurance_premium, marital_status, department, status, join_date, end_date, email'

// Every employee who is employed on at least one day of the month — active and probation staff,
// AND anyone whose last working day falls inside it or later, whatever their status says — less
// anyone whose FINALIZED Final Settlement already paid that month.
//
// Decided with Aashish (2026-09-14). It used to be `status IN ('active','probation')` alone, so a
// waiter who resigned on 18 Bhadra and was marked Resigned before payroll ran had no payslip and no
// warning, and those 18 days were paid by nothing. The settlement exclusion is the other half: a
// settlement pays the final month's part-salary itself, so a draft payslip for the same person
// used to be finalized on top of it and the month was paid twice.
//
// Returns { data: { employees, settled, unended, paidLastMonth }, error } — `settled` lists who was
// left out for a settlement, so the page can say so by name.
//
// S798 3e (PAYROLL-1, decision H9 (a)): `unended` is everyone set Inactive, Resigned or Terminated with
// NO End Date who joined by the month's end and is not settled. They are not on the list — nothing says
// how far to pay them — and before S798 they dropped out without a word, so a waiter who walked out on
// 18 Bhadra and was set Resigned was paid nothing for those 18 days. unendedLeavers() picks out the ones
// with evidence they worked the month; Payroll names them and holds Finalize until a last working day is
// entered or they are settled. `paidLastMonth` (employee ids with a payslip in the previous BS month's
// run) is that evidence for monthly staff, whose blank days are paid without a mark; it is read only
// with { heldEvidence: true }, so the HR Dashboard's month strip does not pay for a read it never uses.
//
// S791: a settlement leaves someone out of their last month AND every later month, in the CURRENT
// employment only — the same rule as the database's refusal (hr_run_settled_employee_names). It
// used to match only a last working day inside this month, so a leaver set back to Active with the
// end date cleared was rebuilt into every later payslip and Finalize refused it with no way out. A
// rehire (a join date after the settled last day) is a new employment and is paid.
const ON_PAYROLL_STATUSES = new Set(['active', 'probation'])

export async function fetchPayrollEmployees(scopedFrom, period, { heldEvidence = false } = {}) {
  const { start, end } = periodAdBounds(period)
  const prev = period.bs_month === 1 ? { y: period.bs_year - 1, m: 12 } : { y: period.bs_year, m: period.bs_month - 1 }
  const [emps, settlements, lastMonth] = await Promise.all([
    // `end_date.is.null` brings in the off-payroll staff with no End Date (S798 3e), split off below.
    scopedFrom('hr_employees', PAYROLL_EMPLOYEE_COLUMNS)
      .or(`status.in.(active,probation),end_date.gte.${start},end_date.is.null`)
      .order('full_name'),
    scopedFrom('hr_final_settlements', 'employee_id, last_working_date')
      .eq('status', 'finalized')
      .lte('last_working_date', end),
    // One run per month, its payslips embedded: one per employee, well under any row cap.
    heldEvidence
      ? scopedFrom('hr_payroll_runs', 'id, monthly_periods!inner(bs_year, bs_month), hr_payslips(employee_id)')
        .eq('monthly_periods.bs_year', prev.y).eq('monthly_periods.bs_month', prev.m)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (emps.error) return { data: null, error: emps.error }
  if (settlements.error) return { data: null, error: settlements.error }
  if (lastMonth.error) return { data: null, error: lastMonth.error }
  const joinOf = new Map((emps.data || []).map(e => [e.id, e.join_date ? String(e.join_date).slice(0, 10) : null]))
  const settledIds = new Set((settlements.data || [])
    .filter(s => { const j = joinOf.get(s.employee_id); return !j || String(s.last_working_date).slice(0, 10) >= j })
    .map(s => s.employee_id))
  const onList = e => ON_PAYROLL_STATUSES.has(e.status) || !!e.end_date
  const inMonth = (emps.data || []).filter(e => onList(e) && employedInPeriod(e, start, end))
  return {
    data: {
      employees: inMonth.filter(e => !settledIds.has(e.id)),
      settled:   inMonth.filter(e => settledIds.has(e.id)),
      unended:   (emps.data || []).filter(e => !onList(e) && employedInPeriod(e, start, end) && !settledIds.has(e.id)),
      paidLastMonth: [...new Set((lastMonth.data || []).flatMap(r => (r.hr_payslips || []).map(p => p.employee_id)))],
    },
    error: null,
  }
}

// Who, of fetchPayrollEmployees' `unended`, worked this month (S798 3e, PAYROLL-1, H9 (a)): any day
// marked on the attendance sheet, any approved overtime, a payslip in this month's run (set off payroll
// after Generate), or a payslip last month (a monthly worker's blank days are paid, so an outlet that
// marks only absences leaves no mark at all). Nothing is guessed: Payroll names each one and holds
// Finalize until an End Date is entered, which puts them on the list paid to that day, or they are
// settled. Someone off payroll for months has none of this and is never named.
export function unendedLeavers({ unended, attendance, otEntries, payslips, paidLastMonth }) {
  const marks = groupByEmployee(attendance)
  const ot = groupByEmployee(otEntries)
  const inRun = new Set((payslips || []).map(s => s.employee_id))
  const last = new Set(paidLastMonth || [])
  return (unended || [])
    .map(employee => ({
      employee,
      markedDays: new Set((marks.get(employee.id) || []).map(r => r.bs_day)).size,
      otDays: new Set((ot.get(employee.id) || []).map(r => r.bs_day)).size,
      inRun: inRun.has(employee.id),
      paidLastMonth: last.has(employee.id),
    }))
    .filter(r => r.markedDays > 0 || r.otDays > 0 || r.inRun || r.paidLastMonth)
}

// Names for employees a stored run mentions but the payroll list no longer carries (a leaver since
// settled, an employee since deactivated) — so a historical payslip never prints "Unknown".
export async function fetchEmployeesByIds(scopedFrom, ids) {
  const want = [...new Set((ids || []).filter(Boolean))]
  if (want.length === 0) return { data: [], error: null }
  return scopedFrom('hr_employees', PAYROLL_EMPLOYEE_COLUMNS).in('id', want)
}

// ── One payslip per employee, the ONE way (S751) ─────────────────────────────────────────────
// Payroll Run's buildRows and Payroll Calculation's rows were two copies of this, kept identical by
// comments saying "must stay identical". This is both of them.
//
// Order of the money, and the two floors (decided with Aashish, 2026-09-14):
//   1. computePayslip — gross, overtime, absence, SSF, fixed deductions (never below zero, see there)
//   2. TDS on that month's actual income, capped at what is left to withhold it from
//   3. the advance cut: what is due, but never more than what is left after TDS. The rest stays
//      owed and is recovered by later cuts. A NPR 5,000 instalment against a NPR 3,000 month takes
//      3,000 — it used to take 5,000, print a negative net pay, and book 5,000 as repaid.
//   4. TADA added on top — a reimbursement, never consumed by a deduction.
//
// Returns [{ payslip, detail }]. `payslip` has exactly the hr_payslips columns; `detail` carries the
// working the Calculation page shows (engine breakdown, TDS breakdown, the advance that was due).
export function buildPayrollRows({ runId = null, period, employees, components, attendance, otEntries, advances, repayments, ytdMap, tadaMap }) {
  const advMap  = buildAdvanceMap(advances, repayments, period)
  const compsBy = groupByEmployee(components)
  const attBy   = groupByEmployee(attendance)
  const otBy    = groupByEmployee(otEntries)
  return (employees || []).map(emp => {
    const comps = sliceFor(compsBy, emp.id)
    const { breakdown, ...slip } = computePayslip(emp, comps, sliceFor(attBy, emp.id), period, 0, sliceFor(otBy, emp.id), 0)
    const ytd = ytdMap[emp.id] || { gross: 0, ssf: 0, withheld: 0, count: 0 }
    const tdsBreakdown = computeMonthlyTdsBreakdown({
      period,
      // Actual income earned this month, not contractual gross — Nepal's Income Tax Act withholds
      // TDS on remuneration actually paid (S365). OT pay is taxable remuneration too. The same
      // earnedPay() fetchYtdMap sums the earlier months with, so the year adds up on one definition.
      monthlyGross:          earnedPay(slip),
      monthlySsf:            slip.ssf_employee,
      ytdGross:              ytd.gross,
      ytdSsf:                ytd.ssf,
      // CIT / provident fund shares SSF's deduction cap (S748).
      monthlyRetirement:     slip.retirement_contribution,
      ytdRetirement:         ytd.retirement || 0,
      ytdWithheld:           ytd.withheld,
      // The bonus-tax part of ytd.withheld, settled at source — see computeMonthlyTdsBreakdown.
      ytdBonusWithheld:      ytd.bonusWithheld || 0,
      // Actual count of prior finalized months this FY — lets a mid-year joiner's tax spread over the
      // months they'll actually work instead of being front-loaded (see tds.js).
      ytdMonths:             ytd.count,
      // No registration number means no SSF contribution, so no 1% first-slab waiver either.
      isSsf:                 isSsfContributor(emp),
      isMarried:             emp.marital_status === 'married',
      annualLifeInsurance:   parseFloat(emp.life_insurance_premium) || 0,
      annualHealthInsurance: parseFloat(emp.health_insurance_premium) || 0,
    })
    const available = Math.max(0, slip.net_pay)
    const tds = Math.min(tdsBreakdown.tds, available)
    // Paisa, not rupees (S751 review): rounding to the rupee docked a 0.5 the allocation never booked,
    // and rounded an outstanding balance under 0.5 to a due of 0 — an advance stuck Active for ever.
    // S791: buildAdvanceMap already sums in paisa, and the cut is floored to the paisa of what is left.
    const advanceDue = advMap[emp.id] || 0
    const advance = recoverableAdvance(advanceDue, available - tds)
    const tada = tadaMap[emp.id] || { total: 0, ids: [] }
    const tadaAmount = Math.round(tada.total * 100) / 100   // paisa: the claims are marked paid in full
    const payslip = {
      run_id: runId, employee_id: emp.id, ...slip,
      advance_deduction: advance,
      tds, tds_overridden: false,
      // The premiums this month's tax was computed with (S753), so a certificate for a past year is
      // not recomputed from whatever the employee record says today.
      life_insurance_premium:   parseFloat(emp.life_insurance_premium) || 0,
      health_insurance_premium: parseFloat(emp.health_insurance_premium) || 0,
      tada_amount: tadaAmount, tada_claim_ids: tada.ids,
      net_pay: roundPaisa(slip.net_pay - tds - advance + tadaAmount),
    }
    return {
      payslip,
      detail: { emp, comps, breakdown, tdsBreakdown, tdsCapped: tdsBreakdown.tds - tds, advanceDue, tada },
    }
  })
}
