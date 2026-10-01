import { adToBsSafe } from '../../../utils/bsCalendar'

// Leave balance, in one place. Pure — no React, no Supabase.
//
// Extracted from LeaveManagement.jsx's `usedFor` closure (S600) so Final Settlement can pre-fill
// the days it encashes from the same figure the Balances tab shows, rather than asking an operator
// to work it out and type it in.
//
// Three properties of this figure that are easy to get wrong, and are the reason it is documented
// here rather than re-derived per caller:
//
//   * It is bucketed by **BS calendar year** (Baisakh–Chaitra), keyed on each request's
//     `start_date`. That is NOT the Shrawan-start fiscal year that festival allowance and TDS use.
//     A page showing both must label which is which.
//   * A leave spanning a year boundary is charged **entirely to the year it starts in**. Not split.
//   * `hr_leave_types.carry_forward` is a stored column the app never applies, so this is a
//     current-year balance and nothing more. Do not present it as a lifetime entitlement.

const bsYearOf = isoDate => {
  if (!isoDate) return null
  // adToBsSafe, not adToBs: outside the verified calendar table adToBs returns a confident wrong
  // date rather than failing, and a leave request is an arbitrary stored date.
  const bs = adToBsSafe(new Date(String(isoDate).slice(0, 10) + 'T00:00:00'))
  return bs ? bs.year : null
}

const isoDay = d => (d ? String(d).slice(0, 10) : null)
const dayNumber = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000

// The share of a request's chargeable `days` that falls inside [from, until] — by calendar days, so a
// request straddling the last working day is prorated. A request with no end date is one day long.
function daysWithin(r, from, until) {
  const start = isoDay(r.start_date)
  const end = isoDay(r.end_date) || start
  const days = parseFloat(r.days) || 0
  if (!start || (!from && !until)) return days
  const lo = from && from > start ? from : start
  const hi = until && until < end ? until : end
  if (hi < lo) return 0
  if (lo === start && hi === end) return days
  const span = dayNumber(end) - dayNumber(start) + 1
  return span > 0 ? days * (dayNumber(hi) - dayNumber(lo) + 1) / span : 0
}

/** Approved days taken by one employee, for one leave type, in one BS year.
 *
 *  `from` / `until` (AD 'YYYY-MM-DD', optional) bound it to one employment (S798 ENGINE-3): Final
 *  Settlement passes the current join date and the last working day, so leave from an EARLIER spell,
 *  and approved leave booked for after the employee leaves, no longer cut what they are paid for.
 *  Five Dashain days approved for Ashwin used to come off a Bhadra leaver's encashment as "taken".
 *  The Balances tab calls it without a window. */
export function leaveUsed(requests, { employeeId, leaveTypeId, bsYear, from = null, until = null }) {
  return (requests || [])
    .filter(r => r.employee_id === employeeId
      && r.leave_type_id === leaveTypeId
      && r.status === 'approved'
      && bsYearOf(r.start_date) === bsYear)
    .reduce((a, r) => a + daysWithin(r, isoDay(from), isoDay(until)), 0)
}

/** Days already paid out on a FINALIZED settlement, for the same employee/type/year. `from` (the
 *  current join date) leaves out an earlier employment's settlement (S798 ENGINE-3): a rehire's
 *  earned leave restarts at the new join date, so what the earlier spell paid out is not theirs. */
export function leaveEncashed(settlements, { employeeId, leaveTypeId, bsYear, from = null }) {
  const since = isoDay(from)
  return (settlements || [])
    .filter(s => s.employee_id === employeeId
      && s.leave_type_id === leaveTypeId
      // A draft settlement must never move a balance: an abandoned draft would otherwise depress
      // the figure permanently, with no visible cause and no screen to find it on.
      && s.status === 'finalized'
      && bsYearOf(s.last_working_date) === bsYear
      && (!since || isoDay(s.last_working_date) >= since))
    .reduce((a, s) => a + (parseFloat(s.leave_days_encashed) || 0), 0)
}

/**
 * → { quota, used, encashed, remaining, capped }
 *
 * `capped` is false for a type with no annual quota (e.g. Unpaid), where "remaining" is meaningless
 * and only the days taken are worth showing — the distinction the Balances tab already draws.
 */
export function leaveBalance({ requests, settlements, leaveType, employeeId, bsYear }) {
  const quota    = parseFloat(leaveType?.annual_quota) || 0
  const typeId   = leaveType?.id
  const used     = leaveUsed(requests, { employeeId, leaveTypeId: typeId, bsYear })
  const encashed = leaveEncashed(settlements, { employeeId, leaveTypeId: typeId, bsYear })
  return {
    quota,
    used,
    encashed,
    // Encashed days are gone in the same sense taken days are — they have been paid for.
    remaining: quota - used - encashed,
    capped: quota > 0,
  }
}
