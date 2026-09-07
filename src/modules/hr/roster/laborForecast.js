// Pure functions for the Roster board's demand-forecast labor overlay — no React, no Supabase.
// calcHours/rKey/computeEmpHours/computeDayHours are extracted verbatim (same logic) from what
// used to be Roster.jsx's local calcHours/empHrs/dayHrs, so the board's existing Total hrs/day
// footer keeps behaving identically after the extraction.
import { hourlyRateOf, calcAmount } from '../payroll/payrollCompute'
import { isOffDay, SSF_CAP, SSF_EMPLOYER_PCT, STANDARD_HOURS_PER_DAY, OT_MULTIPLIER } from '../payrollConstants'

export function calcHours(start, end) {
  if (!start || !end) return null
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60 // overnight shift
  return parseFloat((mins / 60).toFixed(1))
}

export function rKey(year, month, day, empId) {
  return `${year}:${month}:${day}:${empId}`
}

export function shiftHours(shift) {
  if (!shift) return 0
  return shift.hours ?? calcHours(shift.start_time, shift.end_time) ?? 0
}

// A roster row is a person ON DUTY only if its shift is a working one. The Help page tells
// managers to mark a rest day by assigning the zero-hour "Day Off" shift (so the day still shows
// on the board, in Attendance and in Self-Service), which means a roster row is NOT evidence that
// somebody is working — six people on Day Off used to read as "Scheduled 6, Covered" (S692).
// Two tests, both needed: an off-type NAME (the same OFF_SHIFT_KEYWORDS Attendance's Generate
// from Roster keys on), or an explicit zero-hour shift under any name. A shift whose hours are
// simply unknown (`hours: null`, no times — the default "Split") is still a working shift; see
// hasUnknownHours for how that case is surfaced instead of miscounted.
export function isOnDutyShift(shift) {
  if (!shift) return false
  if (isOffDay(shift.name)) return false
  if (shift.hours === 0) return false
  return true
}

// A working shift nobody has given a length to. It contributes 0 to Scheduled Hours and 0 to
// Planned Labor Cost while still putting a head on the floor — so the row under-reports, and the
// tab must say so rather than let the shortfall pass as a real figure.
export function hasUnknownHours(shift) {
  return isOnDutyShift(shift) && shiftHours(shift) === 0
}

export function computeEmpHours(columns, roster, shiftMap, empId) {
  return columns.reduce((sum, col) => {
    const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, empId)]
    return sum + shiftHours(e ? shiftMap[e.shift_type_id] : null)
  }, 0)
}

export function computeDayHours(col, employees, roster, shiftMap) {
  return employees.reduce((sum, emp) => {
    const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]
    return sum + shiftHours(e ? shiftMap[e.shift_type_id] : null)
  }, 0)
}

// Heads on duty for one roster day — see isOnDutyShift for what "on duty" excludes.
export function computeScheduledCount(col, employees, roster, shiftMap) {
  return employees.reduce((n, emp) => {
    const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]
    return n + (isOnDutyShift(e ? shiftMap[e.shift_type_id] : null) ? 1 : 0)
  }, 0)
}

// Working shifts on this day whose length is unset (see hasUnknownHours).
export function computeUnpricedCount(col, employees, roster, shiftMap) {
  return employees.reduce((n, emp) => {
    const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]
    return n + (hasUnknownHours(e ? shiftMap[e.shift_type_id] : null) ? 1 : 0)
  }, 0)
}

// What the employer pays for ONE scheduled hour of this employee — the loaded rate, not the
// basic one. Owner Dashboard and the Monthly Owner Report define labour cost as gross (basic +
// allowances) + overtime + the employer's SSF share (computeMonthlyReport.js's estimate path),
// and the Labor Forecast tab bands its Cost % on the same LABOR_WARN/LABOR_CRITICAL thresholds.
// Pricing hours at basic alone put a systematically smaller numerator under the same band: an
// SSF-enrolled employee costs at least 1.2x basic before any allowance, so a day the roster showed
// at 30% (healthy) was 36% (watch) on the dashboard (S692). Same arithmetic as that estimate, per
// hour:
//   monthly  -> (basic + earning components) / (monthDays x 8)
//   daily    -> basic / 8
//   hourly   -> basic
// plus, when enrolled, min(monthly-equivalent gross, SSF_CAP) x 20% spread over the same hours.
// SSF needs BOTH the enrolment flag and a registration number — the payroll engine's rule
// (decision 2026-08-18), which the Owner Report's estimate does not yet apply; this follows the
// engine. With no components and no SSF the result equals hourlyRateOf exactly, so the change is
// additive: every difference from the old figure is a cost the old figure left out.
export function loadedHourlyRateOf(emp, monthDays, components = []) {
  const basic = parseFloat(emp.basic_salary) || 0
  const basis = emp.pay_basis || 'monthly'
  const hoursInMonth = (monthDays || 0) * STANDARD_HOURS_PER_DAY
  const allowances = basis === 'monthly'
    ? components.filter(c => c.type === 'earning').reduce((s, c) => s + calcAmount(c, basic), 0)
    : 0
  const monthlyEquivGross =
    basis === 'daily'  ? basic * monthDays :
    basis === 'hourly' ? basic * STANDARD_HOURS_PER_DAY * monthDays :
    basic + allowances
  const grossPerHour = hoursInMonth > 0 ? monthlyEquivGross / hoursInMonth : 0
  const enrolled = !!(emp.ssf_enrolled && String(emp.ssf_no || '').trim())
  const ssfPerHour = enrolled && hoursInMonth > 0
    ? Math.min(monthlyEquivGross, SSF_CAP) * SSF_EMPLOYER_PCT / hoursInMonth
    : 0
  return {
    rate: grossPerHour + ssfPerHour,
    basicRate: hourlyRateOf(basis, basic, monthDays),
    grossPerHour,
    ssfPerHour,
  }
}

// Total planned labor cost for one roster day: every employee scheduled that day x hours
// scheduled x their loaded hourly rate (see loadedHourlyRateOf). `monthDays` only matters for
// monthly-basis employees; pass daysInBsMonth for the BS month the column falls in (a roster week
// can straddle two BS months). `componentsByEmp` is { [employee_id]: hr_salary_components rows };
// an employee with none is priced at basic + SSF.
export function computePlannedLaborCost(col, employees, roster, shiftMap, monthDays, componentsByEmp = {}) {
  return employees.reduce((sum, emp) => {
    const e = roster[rKey(col.bsYear, col.bsMonth, col.bsDay, emp.id)]
    const s = e ? shiftMap[e.shift_type_id] : null
    const hrs = shiftHours(s)
    if (hrs === 0) return sum
    return sum + hrs * loadedHourlyRateOf(emp, monthDays, componentsByEmp[emp.id] || []).rate
  }, 0)
}

// Suggests a headcount for a forecasted covers count against a target covers-per-staff ratio
// (settings.covers_per_staff_target, default 20). Ceil — better slightly over-staffed than short
// on a busy forecasted day.
export function computeRecommendedHeadcount(forecastCovers, coversPerStaffTarget = 20) {
  if (forecastCovers == null || !coversPerStaffTarget) return null
  return Math.ceil(forecastCovers / coversPerStaffTarget)
}

// ── Actuals for days already past ──────────────────────────────────────────────────────────────
// Demand Forecast only ever writes tomorrow onward and each run deletes the last one, so a past
// day on the Labor Forecast tab had no forecast row and showed the same "—" as a day nobody had
// forecast yet. The day's real figures exist elsewhere — Sales Entries for revenue (which is also
// what the Owner Dashboard's Labour Cost % divides by, so the band is finally measured against
// its own denominator), closed POS bills for covers, Attendance for hours — and showing them is
// the only way to learn whether the Covers/Staff target is right (S692).

// Attendance statuses under which the person was on the floor for some part of the day.
export const ON_DUTY_ATTENDANCE = new Set(['present', 'half_day', 'half_paid_leave', 'half_unpaid_leave'])

// Revenue for one day's sales_entries rows — the Owner Dashboard's formula (qty × unit_price,
// falling back to the recipe's current selling price for rows written before unit_price existed,
// minus the row discount), with POS comps left out the same way it leaves them out.
export function computeDayRevenue(salesRows, priceByRecipe = {}) {
  let revenue = 0
  for (const r of salesRows || []) {
    if (r.source === 'pos_comp') continue
    const price = r.unit_price != null ? parseFloat(r.unit_price) : (priceByRecipe[r.recipe_id] || 0)
    revenue += (parseFloat(r.qty_sold) || 0) * price - (parseFloat(r.discount) || 0)
  }
  return revenue
}

// What one day's attendance actually cost, for the employees given (the Department filter's
// list, so it lines up with the scheduled figure beside it). Attendance's `ot_hours` is derived
// as hours worked BEYOND the rostered shift, so it sits INSIDE `hours_worked`: regular hours
// (worked − OT) are priced at the loaded rate like a planned hour, and the OT hours at the payroll
// engine's premium — basic hourly × OT_MULTIPLIER — which is the extra the payroll run will
// actually pay. `recorded` is false when the day has no attendance rows at all for these
// employees; that is "not entered yet", which must never render as 0 hours — the caller falls
// back to the rostered figures for such a day and labels them "as rostered".
export function computeActualLabor(attendanceRows, employees, monthDays, componentsByEmp = {}) {
  const empById = Object.fromEntries(employees.map(e => [e.id, e]))
  let hours = 0, otHours = 0, cost = 0, rows = 0
  for (const a of attendanceRows || []) {
    const emp = empById[a.employee_id]
    if (!emp) continue
    rows += 1
    const worked = parseFloat(a.hours_worked) || 0
    const ot = Math.min(worked, parseFloat(a.ot_hours) || 0)
    const rate = loadedHourlyRateOf(emp, monthDays, componentsByEmp[emp.id] || [])
    hours += worked
    otHours += ot
    cost += (worked - ot) * rate.rate + ot * rate.basicRate * OT_MULTIPLIER
  }
  return { recorded: rows > 0, hours: parseFloat(hours.toFixed(1)), otHours: parseFloat(otHours.toFixed(1)), cost }
}

// Heads actually on the floor that day — whole outlet, to sit against Recommended Staff the same
// way computeScheduledCount does. Only employees in `employees` count, so a row for someone who
// has since left (not in the active/probation list) is ignored like the roster ignores them.
export function computeActualStaff(attendanceRows, employees) {
  const ids = new Set(employees.map(e => e.id))
  let n = 0
  for (const a of attendanceRows || []) if (ids.has(a.employee_id) && ON_DUTY_ATTENDANCE.has(a.status)) n += 1
  return n
}

// Period totals for the Labor Forecast tab's footer. The band is a MONTHLY benchmark applied to
// single days, so a quiet Tuesday reads "too high" while the week is fine; the figure a manager
// acts on is the period's Cost %, and the table had no row for it (S692).
//
// Each row contributes its EFFECTIVE figures: a past day contributes what actually happened
// (`row.actual`, when its parts are known), a coming day contributes what is scheduled and
// forecast. Cost % is taken over the days that have a revenue figure AND a cost figure — a
// scheduled day with no forecast, or a past day with no attendance entered, would otherwise put
// a numerator under the ratio with no denominator (or the reverse) — and the day counts let the
// footer say how much of the period is actual, forecast, or neither.
export function summarizeLaborForecastRows(rows) {
  // `revenue` is the period's whole revenue figure for the footer; `costPct` divides only over the
  // days that carry BOTH a cost and a revenue (`costOnMeasuredDays` / `revenueOnMeasuredDays`),
  // so a past day with sales but no attendance entered cannot drag the ratio toward 0%.
  const out = {
    hours: 0, cost: 0, revenue: 0, costOnMeasuredDays: 0, revenueOnMeasuredDays: 0,
    actualDays: 0, forecastDays: 0, noDataDays: 0, totalDays: rows.length,
    // `staffedDays` counts the days on which a staffing verdict was possible at all (a
    // recommendation AND a headcount). With none, "covered every measured day" would be vacuous.
    // `asRosteredDays` are past days whose hours/cost/heads came from the roster because no
    // attendance was entered — counted, since the roster is the day's best record until then,
    // but named, since they are not clocked figures.
    // `requiredHours` totals only the days that HAVE a requirement, and `requiredDays` says how
    // many those were — a period total that silently covered half its days would read as the whole
    // week's requirement and be short by the rest.
    shortDays: 0, staffedDays: 0, unpricedShifts: 0, asRosteredDays: 0, costPct: null,
    requiredHours: 0, requiredDays: 0,
  }
  for (const r of rows) {
    let hours, cost, revenue, rec, heads
    if (r.isPast) {
      const a = r.actual
      hours   = a ? a.hours : null
      cost    = a ? a.cost : null
      revenue = a ? a.revenue : null
      rec     = a ? a.recommended : null
      heads   = a ? a.staff : null
      if (a && a.basis === 'roster') out.asRosteredDays += 1
      if (revenue != null) out.actualDays += 1; else out.noDataDays += 1
    } else {
      hours   = r.scheduledHrs || 0
      cost    = r.plannedCost || 0
      revenue = r.forecastRevenue
      rec     = r.recommended
      heads   = r.scheduledCount
      out.unpricedShifts += r.unpricedCount || 0
      if (revenue != null) out.forecastDays += 1; else out.noDataDays += 1
    }
    const measured = rec != null && heads != null
    if (measured) out.staffedDays += 1
    const short = measured && heads < rec
    const required = r.isPast ? r.actual?.required : r.required
    if (required && required.hours != null) { out.requiredHours += required.hours; out.requiredDays += 1 }
    if (hours != null) out.hours += hours
    if (cost != null) out.cost += cost
    if (revenue != null) {
      out.revenue += revenue
      if (cost != null) { out.costOnMeasuredDays += cost; out.revenueOnMeasuredDays += revenue }
    }
    if (short) out.shortDays += 1
  }
  out.hours = parseFloat(out.hours.toFixed(1))
  out.requiredHours = parseFloat(out.requiredHours.toFixed(1))
  out.costPct = out.revenueOnMeasuredDays > 0 ? (out.costOnMeasuredDays / out.revenueOnMeasuredDays) * 100 : null
  return out
}
