// Leave Management constants & helpers — Crest HR (S116).
// See memory: nepal-payroll-law (Labour Act 2074 leave entitlements).
import { adToBs } from '../../../utils/bsCalendar'
import { HR_REQUEST_STATUS } from '../payrollConstants'

// Nepal Labour Act 2074 default leave types. Seeded once per client (when they
// have none). annual_quota 0 = uncapped (e.g. unpaid). Maternity/paternity are
// per-event statutory entitlements, not annually recurring — shown for tracking.
//
// `color` is a CATEGORICAL hue per leave type, seeded into `hr_leave_types` and editable per
// client — the same class of value as a shift colour, and exempt from the design system's token
// rule for the same reason: these have to stay distinguishable from one another, which is a job
// a four-token semantic palette cannot do. detect.mjs flags #60a5fa / #f472b6 / #22d3ee here as
// undocumented colours; that is expected and should stay. What matters is that no consumer
// renders one of them as raw text — LeaveManagement passes every one through typeTint() for a
// fill and typeText() for a label, which is what keeps them legible on the light presets.
export const DEFAULT_LEAVE_TYPES = [
  { code: 'home',        name: 'Home / Annual Leave',  paid: true,  annual_quota: 18, carry_forward: true,  color: 'var(--theme-green)', sort_order: 1 },
  { code: 'sick',        name: 'Sick Leave',           paid: true,  annual_quota: 12, carry_forward: true,  color: '#60a5fa', sort_order: 2 },
  { code: 'bereavement', name: 'Bereavement (Kiriya)', paid: true,  annual_quota: 13, carry_forward: false, color: '#a78bfa', sort_order: 3 },
  { code: 'maternity',   name: 'Maternity Leave',      paid: true,  annual_quota: 98, carry_forward: false, color: '#f472b6', sort_order: 4 },
  { code: 'paternity',   name: 'Paternity Leave',      paid: true,  annual_quota: 15, carry_forward: false, color: '#22d3ee', sort_order: 5 },
  { code: 'unpaid',      name: 'Unpaid Leave',         paid: false, annual_quota: 0,  carry_forward: false, color: 'var(--theme-text3)', sort_order: 6 },
]

// Half-day only applies to a single-day request (start_date === end_date) — enforced in the UI.
// First vs second half is purely a record-keeping distinction; payroll only cares about full
// vs half (see hr_attendance's half_paid_leave/half_unpaid_leave statuses).
export const DAY_TYPES = [
  { value: 'full',        label: 'Full Day' },
  { value: 'first_half',  label: 'First Half' },
  { value: 'second_half', label: 'Second Half' },
]

// Status ladder, not a categorical palette — and its only consumer (LeaveManagement's Status
// column) renders `color` as TEXT, never as a fill, so these carry the contrast-safe `*-text`
// variants. Unlike DEFAULT_LEAVE_TYPES above, nothing here is written to the DB.
//
// The colours are HR_REQUEST_STATUS's, not a local set: Pending used to be brass here and on
// Overtime, grey on TADA and amber in the employee app — three colours for one word across pages a
// manager reads in one sitting (S660). Only the `.tint.color` is taken, since this ladder is text.
export const LEAVE_STATUSES = {
  pending:   { label: 'Pending',   color: HR_REQUEST_STATUS.pending.tint.color },
  approved:  { label: 'Approved',  color: HR_REQUEST_STATUS.approved.tint.color },
  rejected:  { label: 'Rejected',  color: HR_REQUEST_STATUS.rejected.tint.color },
  cancelled: { label: 'Cancelled', color: HR_REQUEST_STATUS.cancelled.tint.color },
}

// Every day in an inclusive AD date range — no day is assumed off automatically (there's no
// single company-wide off weekday; off days are marked explicitly per employee in Attendance).
// Returns [{ ad: Date, bsYear, bsMonth, bsDay }]. Used both for the day count and for
// writing/reverting the matching hr_attendance rows.
export function workingDaysInRange(startIso, endIso) {
  if (!startIso || !endIso) return []
  const start = new Date(startIso)
  const end   = new Date(endIso)
  if (isNaN(start) || isNaN(end) || end < start) return []
  const out = []
  // Normalise to local midnight to avoid TZ drift on day stepping.
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  let guard = 0
  while (cur <= last && guard < 800) {
    guard += 1
    const bs = adToBs(new Date(cur))
    out.push({ ad: new Date(cur), bsYear: bs.year, bsMonth: bs.month, bsDay: bs.day })
    cur.setDate(cur.getDate() + 1)
  }
  return out
}
