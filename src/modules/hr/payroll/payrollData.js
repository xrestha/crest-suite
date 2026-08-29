// Shared data-fetch helpers used by both the Payroll Run generator and the read-only Calculation
// page — kept in one place so both compute from identical YTD/advance/TADA inputs. Duplicating
// this logic across two files would risk them silently drifting apart, defeating the whole point
// of the Calculation page (it exists to always match what Payroll actually computes).
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { fiscalYearOf } from './tds'

// Year-to-date taxable per employee: sum of (gross − SSF) and tds from PRIOR finalized payslips
// in the same fiscal year (months before the current one).
// Returns `{ data, error }`, not a bare map — see the `if (error)` note below.
export async function fetchYtdMap(scopedFrom, period) {
  const cur = fiscalYearOf(period.bs_year, period.bs_month)
  // Paged. The fiscal-year narrowing below happens in JS, so this read is EVERY finalized payslip
  // the client has ever had — one row per employee per month, for as long as they have run payroll.
  // Unpaged that silently stops at PostgREST's 1000-row cap (~20 staff x 4 years), and a truncated
  // YTD map understates prior taxable income, which under-withholds TDS and under-remits to the IRD.
  // `.order('id')` is the unique tiebreaker fetchAllRows requires: paging a non-uniquely-ordered
  // query repeats rows on one page and skips them on the next, trading truncation for a worse bug.
  const { data, error } = await fetchAllRows(() =>
    scopedFrom('hr_payslips', 'employee_id, gross, ot_amount, ssf_employee, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
      .eq('hr_payroll_runs.status', 'finalized')
      .order('id'))
  // A failed read must NOT degrade to an empty YTD map. Empty means "no prior finalized months
  // this FY", which is a real and ordinary state — the first month of the year — so computeMonthlyTds
  // would treat a mid-year employee as a fresh starter, spread their remaining tax over twelve
  // months instead of the months actually left, and under-withhold. Same money consequence as the
  // truncation above, reachable with no row cap at all. Returned in `{ data, error }` shape so it
  // composes with firstError() at the call sites.
  if (error) return { data: null, error }
  const map = {}
  ;(data || []).forEach(r => {
    if (r.hr_payroll_runs?.status !== 'finalized') return
    const mp = r.hr_payroll_runs?.monthly_periods
    if (!mp) return
    const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
    if (fy.fyStart !== cur.fyStart || fy.monthInFy >= cur.monthInFy) return
    const e = map[r.employee_id] || { gross: 0, ssf: 0, withheld: 0, count: 0 }
    // OT pay is taxable income too — must stay in sync with monthlyGross below (S365 + OT fix).
    e.gross += (r.gross || 0) + (r.ot_amount || 0)
    e.ssf   += r.ssf_employee || 0
    e.withheld += r.tds || 0
    e.count += 1 // prior finalized months this FY — feeds tds.js's ytdMonths (mid-year-joiner fix)
    map[r.employee_id] = e
  })
  return { data: map, error: null }
}

// TADA claims (from the TADA Claims ledger) whose trip dates fall inside this BS period, per
// employee — Approved claims still awaiting payroll, PLUS claims already marked Paid BY payroll
// (paid_method:'Payroll') for this same period. The latter half matters because Finalize marks a
// claim's status 'paid' the moment it locks in — an 'approved'-only filter would make this map go
// empty for an already-finalized period, understating live TADA by the paid amount on both the
// draft auto-fill (harmless, run's locked) and the Calculation page's live-vs-stored comparison
// (not harmless — it manufactured a false "Stale" flag on every employee with paid TADA, S565).
// A claim marked paid by some OTHER method (cash, bank — TadaClaims.jsx's manual "mark paid") is
// deliberately excluded even if its trip date falls in this window; it was never part of payroll.
export async function fetchApprovedTadaMap(scopedFrom, period) {
  const periodStart = formatAd(bsToAd(period.bs_year, period.bs_month, 1))
  const periodEnd   = formatAd(bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month)))
  // Paged, for the same reason as fetchYtdMap: the period window is applied in JS below, so this
  // reads every approved-or-paid claim in the client's history, not just this month's.
  const { data, error } = await fetchAllRows(() =>
    scopedFrom('hr_tada_claims', 'id, employee_id, total_amount, start_date, end_date, status, paid_method')
      .in('status', ['approved', 'paid'])
      .order('id'))
  // As above: an empty map is indistinguishable from "nobody claimed TADA this month", so a
  // failed read would silently drop a real reimbursement out of net pay.
  if (error) return { data: null, error }
  const map = {}
  ;(data || []).forEach(c => {
    if (c.status === 'paid' && c.paid_method !== 'Payroll') return
    if (c.start_date > periodEnd || c.end_date < periodStart) return
    const e = map[c.employee_id] || { total: 0, ids: [] }
    e.total += parseFloat(c.total_amount) || 0
    e.ids.push(c.id)
    map[c.employee_id] = e
  })
  return { data: map, error: null }
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
export const FRESHNESS_INPUT_FIELDS = [
  'gross', 'ot_amount', 'absence_deduction', 'ssf_employee', 'other_deductions', 'advance_deduction',
]

// Order-independent identity for a payslip's TADA claim set.
const claimKey = ids => (Array.isArray(ids) ? [...ids].sort().join(',') : '')

const near = (a, b) => Math.round(a || 0) === Math.round(b || 0)

// → 'moved'      the underlying data changed since Generate; the draft is genuinely out of date
//   'overridden' inputs agree, so the only difference is a figure a human set by hand
//   null         stored and live agree, or there is nothing stored to compare against
export function payslipDrift(stored, live) {
  if (!stored) return null
  if (FRESHNESS_INPUT_FIELDS.some(f => !near(stored[f], live[f]))) return 'moved'
  if (claimKey(stored.tada_claim_ids) !== claimKey(live.tada_claim_ids)) return 'moved'
  if (!near(stored.tds, live.tds) || !near(stored.tada_amount, live.tada_amount)) return 'overridden'
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

// Per-employee scheduled advance deduction for this period.
// For each active advance: deduct min(installment, outstanding).
// If no installment set, deduct full outstanding (treated as one-time advance).
export function buildAdvanceMap(advances, repayments) {
  const repaidMap = {}
  repayments.forEach(r => {
    repaidMap[r.advance_id] = (repaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
  })
  const advMap = {}
  advances.filter(a => a.status === 'active').forEach(adv => {
    const repaid = repaidMap[adv.id] || 0
    const outstanding = Math.max(0, parseFloat(adv.amount) - repaid)
    if (outstanding <= 0) return
    const installment = parseFloat(adv.installment_amount) || outstanding
    const deduction = Math.min(installment, outstanding)
    advMap[adv.employee_id] = (advMap[adv.employee_id] || 0) + deduction
  })
  return advMap
}
