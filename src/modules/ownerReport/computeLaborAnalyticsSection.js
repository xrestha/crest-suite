// Labor Analytics — Sales per Labor Hour and Scheduled vs Actual Hours, neither of which existed
// anywhere in this codebase before (confirmed by research pass — no precedent to reuse). Actual
// hours come from hr_attendance (period_id-scoped). Scheduled hours come from hr_roster, which
// has NO period_id column at all — it's keyed by bs_year/bs_month/bs_day, so it's filtered by
// the period's own bs_year/bs_month instead. Reuses shiftHours()/calcHours() from the Roster
// board's laborForecast.js verbatim rather than re-deriving the shift-hours fallback chain.
import { scopedFrom } from '../../shared/scopedDb'
import { shiftHours } from '../hr/roster/laborForecast'

export async function computeLaborAnalyticsSection(clientId, period, { hr, ims } = {}) {
  const [{ data: attendanceRows }, { data: rosterRows }, { data: shiftTypes }] = await Promise.all([
    scopedFrom('hr_attendance', clientId, 'hours_worked').eq('period_id', period.id),
    scopedFrom('hr_roster', clientId, 'shift_type_id').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
    scopedFrom('hr_shift_types', clientId, 'id, hours, start_time, end_time'),
  ])

  const actualHoursWorked = (attendanceRows || []).reduce((s, a) => s + (parseFloat(a.hours_worked) || 0), 0)

  const shiftMap = Object.fromEntries((shiftTypes || []).map(s => [s.id, s]))
  const scheduledHours = (rosterRows || []).reduce((s, r) => s + shiftHours(r.shift_type_id ? shiftMap[r.shift_type_id] : null), 0)

  const scheduleVarianceHours = actualHoursWorked - scheduledHours
  const scheduleVariancePct = scheduledHours > 0 ? (scheduleVarianceHours / scheduledHours) * 100 : null

  // Revenue numerator: ims.revenueTotal (not POS's totalNetSales) — universally available for
  // IMS+HR clients without POS enabled, and the same "Revenue" figure the Financial Summary
  // section already shows, avoiding two different revenue bases for two different metrics.
  const revenueTotal = ims?.revenueTotal ?? null
  const salesPerLaborHour = revenueTotal != null && actualHoursWorked > 0 ? revenueTotal / actualHoursWorked : null

  return {
    actualHoursWorked, scheduledHours, scheduleVarianceHours, scheduleVariancePct,
    salesPerLaborHour,
    overtime: hr?.payroll?.ot || null, // pass-through reference, not recomputed — see Financial/HR sections for the source figure
  }
}
