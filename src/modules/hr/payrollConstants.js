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
export const WEEKLY_OFF_WEEKDAY     = 6     // Saturday (JS Date.getDay(): 0=Sun … 6=Sat)

export const ATTENDANCE_STATUSES = [
  { key: 'present',      label: 'Present',      short: 'P',  color: '#34d399' },
  { key: 'half_day',     label: 'Half-day',     short: '½',  color: '#c9a84c' },
  { key: 'absent',       label: 'Absent',       short: 'A',  color: '#f87171' },
  { key: 'paid_leave',   label: 'Paid Leave',   short: 'PL', color: '#60a5fa' },
  { key: 'unpaid_leave', label: 'Unpaid Leave', short: 'UL', color: '#9ca3af' },
  { key: 'weekly_off',   label: 'Weekly Off',   short: 'W',  color: '#4b5563' },
  { key: 'holiday',      label: 'Holiday',      short: 'H',  color: '#818cf8' },
]

