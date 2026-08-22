// Nepal payroll legal constants. Minimum wage last revised Shrawan 1, 2082 (15 Jul 2025);
// under Labour Act 2074 s.106(2) it's reviewed every 2 years, so this figure carries forward
// unchanged through FY 2083/84 (started Shrawan 1, 2083 / 17 Jul 2026) — next review due
// Shrawan 2084 (Jul 2027). SSF rate/cap confirmed unchanged in the FY 2083/84 budget (2026-07-17
// research pass — only the income-tax slabs changed this FY, see SLABS_2083_84 in tds.js).
// Update these when the government revises rates. See memory: nepal-payroll-law.

// Shared status-badge tint per semantic color, derived from the active theme via color-mix()
// rather than a hardcoded rgba literal — EmployeeList.jsx, Overtime.jsx, and PaySetup.jsx each
// used to keep their own copy of this table with the Dark preset's exact rgb values baked in,
// so a badge kept the Dark preset's tint on all 9 other theme presets regardless of which was
// actually active. One shared source fixes all three at once and stops a 4th copy from forming.
export const STATUS_TINT = {
  green:  { color: 'var(--theme-green)',  bg: 'color-mix(in srgb, var(--theme-green) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-green) 20%, transparent)' },
  accent: { color: 'var(--theme-accent)', bg: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' },
  red:    { color: 'var(--theme-red)',    bg: 'color-mix(in srgb, var(--theme-red) 10%, transparent)',    border: 'color-mix(in srgb, var(--theme-red) 20%, transparent)' },
  gray:   { color: 'var(--theme-text2)',  bg: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-text2) 20%, transparent)' },
}

// hr_employees.status → tint. Shared by EmployeeList.jsx and PaySetup.jsx, which previously
// each defined an identical copy of this exact mapping independently.
export const EMPLOYEE_STATUS_COLORS = {
  active:     STATUS_TINT.green,
  probation:  STATUS_TINT.accent,
  resigned:   STATUS_TINT.red,
  terminated: STATUS_TINT.red,
  inactive:   STATUS_TINT.gray,
}

// SSF: 11% employee + 20% employer, computed on basic salary capped at NPR 100,000/month.
export const SSF_CAP          = 100000
export const SSF_EMPLOYEE_PCT = 0.11
export const SSF_EMPLOYER_PCT = 0.20
// The share of the employer's 20% that the SSF allocates to its gratuity fund. It matters because
// gratuity already funded through SSF is netted off the employer's own cash liability — see
// gratuityCompute.js. Lived as a bare 0.0333 inside GratuityTracker and a second copy inside
// FinalSettlement until S600; it belongs here with the other rates it moves with.
export const SSF_GRATUITY_PCT = 0.0333
// Nepal Labour Act: gratuity vests after one year of continuous service.
export const GRATUITY_VESTING_MONTHS = 12

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

// Two colour keys per status, and they are not interchangeable: `color` is the FILL (legend swatch
// background/border, status dot) and stays a base token; `textColor` is the same hue's readable
// text variant, for anywhere the status is rendered AS text (dropdown value, month-summary cell).
// A base signal token used as 13px text fails WCAG AA on the light presets, which is why the pair
// exists. Paid Leave and Holiday previously carried undocumented indigo hexes (#60a5fa/#818cf8)
// with no home in the palette — mapped here to the nearest documented tokens (accent / purple).
export const ATTENDANCE_STATUSES = [
  { key: 'present',           label: 'Present',             short: 'P',   color: 'var(--theme-green)',  textColor: 'var(--theme-green-text)' },
  { key: 'half_day',          label: 'Half-day',            short: '½',   color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)' },
  { key: 'absent',            label: 'Absent',               short: 'A',   color: 'var(--theme-red)',   textColor: 'var(--theme-red-text)' },
  { key: 'paid_leave',        label: 'Paid Leave',          short: 'PL',  color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)' },
  { key: 'unpaid_leave',      label: 'Unpaid Leave',        short: 'UL',  color: 'var(--theme-text3)',  textColor: 'var(--theme-text3)' },
  // Half-day leave — distinct from the generic 'half_day' status above so payroll can respect
  // the underlying leave type's paid/unpaid flag instead of always deducting 0.5 day's pay.
  { key: 'half_paid_leave',   label: 'Half-day Paid Leave',   short: '½PL', color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)' },
  { key: 'half_unpaid_leave', label: 'Half-day Unpaid Leave', short: '½UL', color: 'var(--theme-text3)',  textColor: 'var(--theme-text3)' },
  // Key stays 'weekly_off' (no DB migration needed — hr_attendance_status_check already allows
  // it) even though there's no more auto-computed "weekly" pattern; it's now just an explicit
  // per-employee, per-day Off marking. Label/short changed from "Weekly Off"/"W" to "Off"/"O"
  // to match — see attendanceFromRoster.js and AttendanceSheet.jsx.
  { key: 'weekly_off',        label: 'Off',                 short: 'O',   color: 'var(--theme-text2)',  textColor: 'var(--theme-text2)' },
  { key: 'holiday',           label: 'Holiday',             short: 'H',   color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)' },
]

// A roster shift type whose name suggests it marks a non-working day (e.g. "OFF DAY", "Day Off",
// "LEAVE", "Public Holiday") rather than an actual shift — matched as a substring, not an exact
// name, since clients phrase these differently. Shared by attendanceFromRoster.js (deciding
// whether a zero-hour roster row should generate a 'weekly_off' vs 'holiday' attendance row) and
// SelfServiceHome.jsx (highlighting an employee's own off days on their roster view).
export const OFF_SHIFT_KEYWORDS = ['off', 'leave', 'holiday']
export const isOffDay = name => !name || OFF_SHIFT_KEYWORDS.some(k => name.trim().toLowerCase().includes(k))

