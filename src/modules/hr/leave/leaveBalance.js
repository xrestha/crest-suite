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

/** Approved days taken by one employee, for one leave type, in one BS year. */
export function leaveUsed(requests, { employeeId, leaveTypeId, bsYear }) {
  return (requests || [])
    .filter(r => r.employee_id === employeeId
      && r.leave_type_id === leaveTypeId
      && r.status === 'approved'
      && bsYearOf(r.start_date) === bsYear)
    .reduce((a, r) => a + (parseFloat(r.days) || 0), 0)
}

/** Days already paid out on a FINALIZED settlement, for the same employee/type/year. */
export function leaveEncashed(settlements, { employeeId, leaveTypeId, bsYear }) {
  return (settlements || [])
    .filter(s => s.employee_id === employeeId
      && s.leave_type_id === leaveTypeId
      // A draft settlement must never move a balance: an abandoned draft would otherwise depress
      // the figure permanently, with no visible cause and no screen to find it on.
      && s.status === 'finalized'
      && bsYearOf(s.last_working_date) === bsYear)
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
