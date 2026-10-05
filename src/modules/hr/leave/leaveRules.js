import { adToBsSafe } from '../../../utils/bsCalendar'
import { workingDaysInRange } from './leaveConstants'
import { leaveBalance } from './leaveBalance'

// Pure rules for deciding a leave request — no React, no Supabase (S749). Each is backed by the
// database (hr_leave_requests_validate, hr_attendance_guard_finalized); these are what let the
// page say so in words before anything is attempted.

const OPEN = new Set(['pending', 'approved'])
const day = iso => String(iso || '').slice(0, 10)

/**
 * The first pending or approved request for the same employee that shares a day with this range.
 *
 * Decided with Aashish (2026-09-14): overlapping requests are refused. Both counted against the
 * balance, and cancelling one deleted attendance days the other still covered, so an approved
 * unpaid leave stopped deducting. `date` columns arrive as `YYYY-MM-DD`, which compares correctly
 * as a string — never through `new Date()`, which parses as UTC midnight (Roster.jsx's leave
 * conflict check learned that).
 */
export function findOverlappingRequest(requests, { employeeId, startDate, endDate, excludeId = null }) {
  const s = day(startDate), e = day(endDate)
  if (!employeeId || !s || !e) return null
  return (requests || []).find(r =>
    r.employee_id === employeeId
    && r.id !== excludeId
    && OPEN.has(r.status)
    && day(r.start_date) <= e && s <= day(r.end_date)) || null
}

/**
 * The BS months a request touches whose payroll is FINALIZED — approving or cancelling it would
 * rewrite attendance under issued payslips (decided 2026-09-14: a paid month is locked).
 *
 * @param {Array<{id, bs_year, bs_month}>} periods
 * @param {Set<string>} finalizedPeriodIds
 * @returns {Array<{bsYear: number, bsMonth: number}>}
 */
export function finalizedMonthsFor(req, periods, finalizedPeriodIds) {
  if (!finalizedPeriodIds || finalizedPeriodIds.size === 0) return []
  const byMonth = {}
  for (const p of periods || []) byMonth[`${p.bs_year}:${p.bs_month}`] = p
  const seen = new Map()
  for (const d of workingDaysInRange(req.start_date, req.end_date)) {
    const p = byMonth[`${d.bsYear}:${d.bsMonth}`]
    if (p && finalizedPeriodIds.has(p.id)) seen.set(`${d.bsYear}:${d.bsMonth}`, { bsYear: d.bsYear, bsMonth: d.bsMonth })
  }
  return [...seen.values()]
}

/**
 * How far approving this request takes the employee past the type's annual quota, in the BS year
 * the request starts in (the year leaveBalance charges it to). Null when the type is uncapped or
 * the approval stays within it. Decided 2026-09-14: warn and let the manager decide, never block.
 */
export function quotaOverrun({ requests, settlements, leaveType, request }) {
  const quota = parseFloat(leaveType?.annual_quota) || 0
  if (quota <= 0) return null
  const bs = adToBsSafe(new Date(day(request.start_date) + 'T00:00:00'))
  if (!bs) return null
  const bal = leaveBalance({ requests, settlements, leaveType, employeeId: request.employee_id, bsYear: bs.year })
  // A request already approved is inside `used`; a pending one is the addition being decided.
  const adding = request.status === 'approved' ? 0 : (parseFloat(request.days) || 0)
  const after = bal.used + bal.encashed + adding
  return after > quota ? { quota, after, over: after - quota, bsYear: bs.year } : null
}

// The four statuses a leave request writes on the attendance sheet. A day holding anything else —
// Present, Absent, Off, Holiday — was marked by someone or something other than the request.
export const LEAVE_MARK_STATUSES = ['paid_leave', 'unpaid_leave', 'half_paid_leave', 'half_unpaid_leave']

/**
 * A request's days grouped by the period that holds them, in day order. A day in a month with no
 * period yet is left out: nothing can have been written there.
 * @returns {Array<{ periodId: string, days: Array<{bsYear, bsMonth, bsDay}> }>}
 */
export function leaveDaysByPeriod(req, periods) {
  const byMonth = {}
  for (const p of periods || []) byMonth[`${p.bs_year}:${p.bs_month}`] = p
  const out = new Map()
  for (const d of workingDaysInRange(req.start_date, req.end_date)) {
    const p = byMonth[`${d.bsYear}:${d.bsMonth}`]
    if (!p) continue
    if (!out.has(p.id)) out.set(p.id, [])
    out.get(p.id).push(d)
  }
  return [...out].map(([periodId, days]) => ({ periodId, days }))
}

/**
 * The months a request's days fall in that `periods` has no row for, in day order (S798,
 * LEAVE-OT-HOLIDAYS-6). Non-empty means the page's list may be stale: the month can have been created
 * since the page loaded, so approval re-reads the periods before it decides those days must wait.
 * @returns {Array<{ bsYear: number, bsMonth: number }>}
 */
export function monthsWithoutPeriod(req, periods) {
  const have = new Set((periods || []).map(p => `${p.bs_year}:${p.bs_month}`))
  const out = new Map()
  for (const d of workingDaysInRange(req.start_date, req.end_date)) {
    const k = `${d.bsYear}:${d.bsMonth}`
    if (!have.has(k) && !out.has(k)) out.set(k, { bsYear: d.bsYear, bsMonth: d.bsMonth })
  }
  return [...out.values()]
}

/**
 * What cancelling or rejecting an APPROVED request does to its days (S798, LEAVE-OT-HOLIDAYS-4). Only
 * a day still marked as leave changes: it is cleared, or marked Holiday when that day is a public
 * holiday now. The old revert skipped every day on today's calendar, so a holiday added after the
 * approval kept its leave mark and a cancelled unpaid leave still docked it — and it deleted any
 * other day whatever it held, a hand re-mark included. Those keep their mark now.
 * @returns {Array<{ periodId: string, clear: number[], toHoliday: number[] }>}
 */
export function planLeaveRevert(req, periods, holidayKeys) {
  return leaveDaysByPeriod(req, periods).map(({ periodId, days }) => {
    const clear = [], toHoliday = []
    for (const d of days) (holidayKeys?.has(`${d.bsYear}:${d.bsMonth}:${d.bsDay}`) ? toHoliday : clear).push(d.bsDay)
    return { periodId, clear, toHoliday }
  })
}
