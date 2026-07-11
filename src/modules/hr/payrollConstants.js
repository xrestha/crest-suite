// Nepal payroll legal constants — FY 2082/83 (effective Shrawan 1, 2082 / 15 Jul 2025).
// Update these when the government revises rates. See memory: nepal-payroll-law.

// SSF: 11% employee + 20% employer, computed on basic salary capped at NPR 100,000/month.
export const SSF_CAP          = 100000
export const SSF_EMPLOYEE_PCT = 0.11
export const SSF_EMPLOYER_PCT = 0.20

// Minimum wage (full-time monthly): NPR 19,550 = 12,170 basic + 7,380 dearness allowance.
export const MIN_WAGE_MONTHLY  = 19550
export const MIN_BASIC_MONTHLY = 12170

// Minimum wage (non-monthly).
export const MIN_DAILY          = 754
export const MIN_HOURLY         = 101  // standard hourly worker
export const MIN_HOURLY_PARTTIME = 107 // part-time hourly worker

// Labour Act: basic salary must be at least 60% of gross pay.
export const MIN_BASIC_PCT_OF_GROSS = 0.6

// Pay basis options for an employee.
export const PAY_BASES = [
  { key: 'monthly', label: 'Monthly',  unit: 'month' },
  { key: 'daily',   label: 'Daily',    unit: 'day'   },
  { key: 'hourly',  label: 'Hourly',   unit: 'hour'  },
]

// The minimum rate for a given pay basis (and employment type, for hourly part-time).
export function minRateFor(payBasis, employmentType) {
  if (payBasis === 'daily')  return MIN_DAILY
  if (payBasis === 'hourly') return employmentType === 'part_time' ? MIN_HOURLY_PARTTIME : MIN_HOURLY
  return MIN_BASIC_MONTHLY
}

// ── Attendance ────────────────────────────────────────────────────────────────
export const STANDARD_HOURS_PER_DAY = 8     // Nepal Labour Act standard working day
export const OT_MULTIPLIER          = 1.5   // overtime paid at 1.5× normal hourly rate (weekday)
export const OT_HOLIDAY_MULTIPLIER  = 2.0   // overtime on a gazetted public holiday (Nepal Labour Act)

export const ATTENDANCE_STATUSES = [
  { key: 'present',           label: 'Present',             short: 'P',   color: 'var(--theme-green)' },
  { key: 'half_day',          label: 'Half-day',            short: '½',   color: 'var(--theme-accent)' },
  { key: 'absent',            label: 'Absent',               short: 'A',   color: 'var(--theme-red)' },
  { key: 'paid_leave',        label: 'Paid Leave',          short: 'PL',  color: '#60a5fa' },
  { key: 'unpaid_leave',      label: 'Unpaid Leave',        short: 'UL',  color: 'var(--theme-text3)' },
  // Half-day leave — distinct from the generic 'half_day' status above so payroll can respect
  // the underlying leave type's paid/unpaid flag instead of always deducting 0.5 day's pay.
  { key: 'half_paid_leave',   label: 'Half-day Paid Leave',   short: '½PL', color: '#60a5fa' },
  { key: 'half_unpaid_leave', label: 'Half-day Unpaid Leave', short: '½UL', color: 'var(--theme-text3)' },
  // Key stays 'weekly_off' (no DB migration needed — hr_attendance_status_check already allows
  // it) even though there's no more auto-computed "weekly" pattern; it's now just an explicit
  // per-employee, per-day Off marking. Label/short changed from "Weekly Off"/"W" to "Off"/"O"
  // to match — see attendanceFromRoster.js and AttendanceSheet.jsx.
  { key: 'weekly_off',        label: 'Off',                 short: 'O',   color: 'var(--theme-text2)' },
  { key: 'holiday',           label: 'Holiday',             short: 'H',   color: '#818cf8' },
]

// A roster shift type whose name suggests it marks a non-working day (e.g. "OFF DAY", "Day Off",
// "LEAVE", "Public Holiday") rather than an actual shift — matched as a substring, not an exact
// name, since clients phrase these differently. Shared by attendanceFromRoster.js (deciding
// whether a zero-hour roster row should generate a 'weekly_off' vs 'holiday' attendance row) and
// SelfServiceHome.jsx (highlighting an employee's own off days on their roster view).
export const OFF_SHIFT_KEYWORDS = ['off', 'leave', 'holiday']
export const isOffDay = name => !name || OFF_SHIFT_KEYWORDS.some(k => name.trim().toLowerCase().includes(k))

