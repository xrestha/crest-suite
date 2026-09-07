// The labour STANDARD: how many staff-hours this outlet needs per rupee of business, learned from
// its own history. Pure — no React, no Supabase, and deliberately no import of
// `demandForecastData.js` (which imports supabaseClient and so cannot be unit-tested).
//
// WHY THIS EXISTS (S693)
//
// The Labor Forecast tab could say what a roster COSTS against forecast revenue. It could not say
// what the day actually NEEDS. The only labour standard in the product was
// `settings.covers_per_staff_target` — one hand-typed number, default 20, that nothing ever
// learned, that needed covers (so a non-POS outlet got no staffing guidance at all), and that was
// one figure for a whole outlet. Everything required to derive a real one was already stored:
// revenue in `sales_entries`, hours in `hr_attendance` and `hr_roster`, covers in `pos_orders`.
//
// THE MODEL, AND WHY IT IS THIS SIMPLE
//
//   salesPerLaborHour = Σ revenue / Σ hours      (over the window, per weekday)
//   requiredHours(day) = forecastRevenue(day) / salesPerLaborHour(weekday)
//   requiredStaff      = ceil(requiredHours / typicalShiftHours)
//
// A RATIO OF TOTALS, never a mean of per-day ratios: that is this repo's existing rule for group
// figures (a small outlet must not swing the number as hard as a large one), and here it correctly
// weights busy days, which is where a staffing error costs the most.
//
// LINEAR THROUGH THE ORIGIN, deliberately — no fixed-crew intercept. Real F&B has an opening crew
// that a strict proportion under-serves at low revenue, but the per-weekday split absorbs most of
// what an intercept would do: a quiet Monday is calibrated against its own quiet Mondays, which
// carry their own fixed crew. A two-parameter regression would produce a number nobody can check by
// hand, against this repo's stated preference for auditable arithmetic over a fitted model
// (`demandForecastData.js` says the same about its weekday moving average). This is a choice, not
// an oversight.
//
// IT IS A PLANNING AID, NOT AN OPTIMISER. The standard learns what this outlet normally uses per
// rupee. If the outlet is chronically overstaffed, the standard learns that too. This is equally
// true of an attendance-trained and a roster-trained model, so it is not an argument for either
// basis — it is something the UI must say out loud.
import { ON_DUTY_ATTENDANCE } from './laborForecast'

// Four BS months. Longer than demandForecastData's 84-day LOOKBACK_DAYS on purpose: attendance is
// commonly entered in one batch at month end (for payroll), so the current month is usually empty
// and a shorter window holds too few COMPLETE months to measure the roster bias below.
export const LABOR_STANDARD_LOOKBACK_DAYS = 120
// A 3-sample ratio swings 30%+ on one bad day, and a figure that unstable contradicts itself the
// following week. Below this a weekday falls back to the all-days figure and SAYS so.
export const MIN_SAMPLES_PER_WEEKDAY = 4
// ~3 complete weeks — the least an owner would accept as "you have seen my business".
export const MIN_SAMPLE_DAYS = 20
// Overlap days needed before the measured roster bias is trusted enough to apply.
export const MIN_BIAS_OVERLAP_DAYS = 10
// Robust-trim threshold in scaled MADs.
export const OUTLIER_MAD_K = 3
// MAD is meaningless on a handful of points; below this nothing is trimmed at all.
export const MIN_SAMPLES_FOR_TRIM = 5
export const UNASSIGNED_DEPT = '(unassigned)'

const round1 = n => parseFloat(n.toFixed(1))

export function median(values) {
  const v = (values || []).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// Median absolute deviation, scaled by 1.4826 so it estimates a standard deviation for normal data.
// Null below MIN_SAMPLES_FOR_TRIM, and null when every point is identical (MAD 0 would make the
// trim reject everything that is not exactly the median).
export function madOf(values, med) {
  const v = (values || []).filter(x => typeof x === 'number' && isFinite(x))
  if (v.length < MIN_SAMPLES_FOR_TRIM) return null
  const m = med == null ? median(v) : med
  const mad = median(v.map(x => Math.abs(x - m)))
  return mad == null || mad === 0 ? null : mad * 1.4826
}

// A day may TRAIN the model only if it is evidence of a day that happened, not a plan for one.
//
//   `recorded`     — attendance rows, or (weaker basis) rostered shifts, genuinely exist
//   `periodExists` — no monthly_period means sales had nowhere to be recorded, so zero revenue
//                    here is "not entered", not "a closure"
//   `bulkMonth`    — a BS month whose sales were entered as one bs_day=0 lump: real revenue with
//                    no day to attach it to, so every day of that month is understated and would
//                    deflate sales-per-labour-hour, INFLATING required hours everywhere
//   hours/revenue  — a day with either at zero teaches nothing and divides by nothing
export function isTrainingSample(day) {
  if (!day || !day.recorded || !day.periodExists || day.bulkMonth) return false
  return (day.hours || 0) > 0 && (day.headCount || 0) > 0 && (day.revenue || 0) > 0
}

// Robust outlier trim on the POOLED window's per-day sales-per-labour-hour. Pooled, never per
// weekday: a weekday bucket holds at most ~17 days in this window and a MAD computed on that is
// noise. One rule catches a festival, a closure, a half-entered attendance day and a bulk-sales
// artefact — a holiday-table join would be a second mechanism doing the same job.
export function trimOutlierDays(samples, { k = OUTLIER_MAD_K } = {}) {
  const rows = (samples || []).filter(s => (s.hours || 0) > 0)
  const ratios = rows.map(s => s.revenue / s.hours)
  const med = median(ratios)
  const mad = madOf(ratios, med)
  // A trim you cannot justify is a guess: too few points (or no spread) means keep everything.
  if (mad == null) return { kept: rows, dropped: [], median: med, mad: null }
  const kept = [], dropped = []
  rows.forEach((s, i) => (Math.abs(ratios[i] - med) > k * mad ? dropped : kept).push(s))
  return { kept, dropped, median: med, mad }
}

// The client's OWN deviation between what they roster and what their staff actually work, measured
// rather than assumed, from the days that carry both. Returned as a multiplier on rostered hours
// (below 1 when attendance runs short of the roster, above 1 when overtime pushes past it) — the
// direction is never assumed. `applies` is false until MIN_BIAS_OVERLAP_DAYS, and the caller must
// then say the roster days are unadjusted rather than silently using 1.
export function measureRosterBias(days) {
  let attHours = 0, rosHours = 0, overlapDays = 0
  for (const d of days || []) {
    if (!(d.attendanceHours > 0) || !(d.rosteredHours > 0)) continue
    attHours += d.attendanceHours
    rosHours += d.rosteredHours
    overlapDays += 1
  }
  const ratio = rosHours > 0 ? attHours / rosHours : null
  return {
    ratio,
    applies: overlapDays >= MIN_BIAS_OVERLAP_DAYS && ratio != null,
    overlapDays,
    attendanceHours: round1(attHours),
    rosteredHours: round1(rosHours),
  }
}

function accumulate(target, s) {
  target.hours += s.hours
  target.revenue += s.revenue
  target.days += 1
  target.headDays += s.headCount || 0
  if (s.covers != null) { target.covers = (target.covers || 0) + s.covers; target.coverDays += 1 }
}

function finalise(t) {
  if (t.days === 0 || t.hours <= 0) return null
  return {
    salesPerLaborHour: t.revenue / t.hours,
    // Only over the days that HAD covers — a non-POS outlet contributes none, and averaging its
    // days in as zero would halve the figure for a group that has some POS days and some not.
    coversPerLaborHour: t.coverDays > 0 && t.hours > 0 ? t.covers / t.hours : null,
    hours: round1(t.hours),
    revenue: t.revenue,
    covers: t.coverDays > 0 ? t.covers : null,
    days: t.days,
  }
}

const emptyBucket = () => ({ hours: 0, revenue: 0, covers: 0, coverDays: 0, days: 0, headDays: 0 })

/**
 * Build the standard from a window of per-day samples.
 *
 * Each sample: { key, weekday, hours, hoursBasis: 'attendance'|'roster', headCount, revenue,
 *                covers, hoursByDept, recorded, periodExists, bulkMonth,
 *                attendanceHours, rosteredHours }
 *
 * `hours` on a 'roster'-basis sample is the RAW rostered figure; this function applies the measured
 * bias to it, so the caller never has to.
 */
export function buildLaborStandard(samples, opts = {}) {
  const all = samples || []
  const bias = measureRosterBias(all)

  // Scale roster-basis samples by the measured bias before anything else reads their hours.
  const candidates = []
  for (const s of all) {
    if (!isTrainingSample(s)) continue
    const scale = s.hoursBasis === 'roster' && bias.applies ? bias.ratio : 1
    candidates.push(scale === 1 ? s : {
      ...s,
      hours: s.hours * scale,
      hoursByDept: Object.fromEntries(Object.entries(s.hoursByDept || {}).map(([d, h]) => [d, h * scale])),
    })
  }

  const { kept, dropped } = trimOutlierDays(candidates, opts)
  const excluded = all.filter(s => s && s.bulkMonth).length
  const missingPeriod = all.filter(s => s && s.periodExists === false).length

  const base = {
    windowDays: all.length,
    candidateDays: candidates.length,
    sampleDays: kept.length,
    trimmedDays: dropped.length,
    bulkMonthDays: excluded,
    missingPeriodDays: missingPeriod,
    attendanceDays: kept.filter(s => s.hoursBasis === 'attendance').length,
    rosterDays: kept.filter(s => s.hoursBasis === 'roster').length,
    latestSampleKey: kept.reduce((latest, s) => (!latest || (s.key || '') > latest ? s.key : latest), null),
    rosterBias: bias,
  }

  if (kept.length < MIN_SAMPLE_DAYS) {
    return {
      ...base, ok: false,
      reason: kept.length === 0 ? 'no_samples' : 'too_few_days',
      overall: null, byWeekday: Array(7).fill(null), byDepartment: {},
      hasUnassignedDeptHours: false, typicalShiftHours: null, learnedCoversPerStaffShift: null,
    }
  }

  const overallBucket = emptyBucket()
  const weekdayBuckets = Array.from({ length: 7 }, emptyBucket)
  const deptHours = {}
  for (const s of kept) {
    accumulate(overallBucket, s)
    if (s.weekday >= 0 && s.weekday <= 6) accumulate(weekdayBuckets[s.weekday], s)
    for (const [dept, h] of Object.entries(s.hoursByDept || {})) deptHours[dept] = (deptHours[dept] || 0) + h
  }

  const overall = finalise(overallBucket)
  const byWeekday = weekdayBuckets.map(b => (b.days >= MIN_SAMPLES_PER_WEEKDAY ? finalise(b) : null))

  // A department's share of the window's hours. Revenue is outlet-wide and cannot be attributed to
  // a department, so a department's requirement is the outlet's requirement times this share.
  const totalDeptHours = Object.values(deptHours).reduce((a, b) => a + b, 0)
  const byDepartment = {}
  for (const [dept, h] of Object.entries(deptHours)) {
    byDepartment[dept] = {
      hours: round1(h),
      shareOfHours: totalDeptHours > 0 ? h / totalDeptHours : null,
      salesPerLaborHour: h > 0 ? overallBucket.revenue / h : null,
    }
  }

  // What a shift at THIS outlet actually runs, from the same evidence, as a ratio of totals. Never
  // STANDARD_HOURS_PER_DAY — that is a payroll constant (the statutory day), not a rostering fact.
  const typicalShiftHours = overallBucket.headDays > 0 ? overallBucket.hours / overallBucket.headDays : null

  return {
    ...base, ok: true, reason: null,
    overall, byWeekday, byDepartment,
    hasUnassignedDeptHours: (deptHours[UNASSIGNED_DEPT] || 0) > 0,
    typicalShiftHours,
    learnedCoversPerStaffShift: overall?.coversPerLaborHour != null && typicalShiftHours
      ? overall.coversPerLaborHour * typicalShiftHours
      : null,
  }
}

/**
 * Resolve which figure applies to one day, and SAY which — a weekday with 6 samples and one falling
 * back to all-days are different bases in the same view, so the scope travels with the number
 * rather than sitting in a single footnote that could only describe one of them.
 */
export function standardFor(std, weekday, department = null) {
  if (!std || !std.ok) return null
  const wd = std.byWeekday[weekday] || null
  const base = wd || std.overall
  if (!base || !(base.salesPerLaborHour > 0)) return null

  let splh = base.salesPerLaborHour
  let share = null
  if (department) {
    const d = std.byDepartment[department]
    // A department with no hours in the window gets no figure — never the outlet's, scaled by a guess.
    if (!d || !(d.shareOfHours > 0)) return null
    share = d.shareOfHours
  }
  return {
    salesPerLaborHour: splh,
    scope: wd ? 'weekday' : 'all_days',
    weekday,
    department: department || null,
    departmentShare: share,
    sampleDays: base.days,
  }
}

export function requiredHoursFor(revenue, std, weekday, department = null) {
  // Required hours is a function of expected demand. With no revenue figure there is no answer, and
  // substituting an average to keep the cell full would be inventing one.
  if (revenue == null || !(revenue > 0)) return null
  const basis = standardFor(std, weekday, department)
  if (!basis) return null
  const outletHours = revenue / basis.salesPerLaborHour
  const hours = basis.departmentShare != null ? outletHours * basis.departmentShare : outletHours
  return { hours: round1(hours), basis }
}

export function requiredStaffFor(requiredHours, typicalShiftHours) {
  if (requiredHours == null || !(typicalShiftHours > 0)) return null
  return Math.ceil(requiredHours / typicalShiftHours)
}

// Short human label for where a figure came from, for the row's secondary line.
const WEEKDAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
export function describeBasis(basis) {
  if (!basis) return ''
  const where = basis.scope === 'weekday'
    ? `${basis.sampleDays} ${WEEKDAY_PLURALS[basis.weekday] || 'days'}`
    : `all ${basis.sampleDays} days`
  return basis.department ? `${basis.department}, from ${where}` : `from ${where}`
}

// Per-day hours from raw attendance rows, for the TRAINING window only.
//
// Deliberately NOT computeActualLabor: that one takes the page's employee list, which Roster loads
// as status IN ('active','probation'), and silently skips any row whose employee is not in it. Over
// a four-month window that discards every hour worked by anyone who has since left — window hours
// come out low, sales-per-labour-hour comes out high, and REQUIRED HOURS COMES OUT LOW, so the
// model would tell the owner to roster fewer people than his own history says he needed. A history
// outlives the people in it (S633). This function filters by nothing.
//
// `departmentByEmp` maps employee_id → department for EVERY employee, whatever their status.
export function tallyWindowAttendance(attendanceRows, departmentByEmp = {}) {
  let hours = 0, headCount = 0
  const hoursByDept = {}
  for (const a of attendanceRows || []) {
    const worked = parseFloat(a.hours_worked) || 0
    hours += worked
    if (ON_DUTY_ATTENDANCE.has(a.status)) headCount += 1
    if (worked > 0) {
      const dept = departmentByEmp[a.employee_id] || UNASSIGNED_DEPT
      hoursByDept[dept] = (hoursByDept[dept] || 0) + worked
    }
  }
  return { recorded: (attendanceRows || []).length > 0, hours: round1(hours), headCount, hoursByDept }
}

// The same tally from rostered shifts, for a day attendance has not reached yet. `shiftHoursOf` is
// injected (the caller passes laborForecast's shiftHours bound to its shift map) so this module
// stays free of the shift-type shape.
export function tallyWindowRoster(rosterRows, shiftHoursOf, departmentByEmp = {}) {
  let hours = 0, headCount = 0
  const hoursByDept = {}
  for (const r of rosterRows || []) {
    const h = shiftHoursOf(r) || 0
    if (h <= 0) continue // a Day Off row is not a person on the floor
    hours += h
    headCount += 1
    const dept = departmentByEmp[r.employee_id] || UNASSIGNED_DEPT
    hoursByDept[dept] = (hoursByDept[dept] || 0) + h
  }
  return { recorded: hours > 0, hours: round1(hours), headCount, hoursByDept }
}
