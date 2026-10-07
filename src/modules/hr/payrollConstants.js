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
  amber:  { color: 'var(--theme-amber)',  bg: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-amber) 20%, transparent)' },
  gray:   { color: 'var(--theme-text2)',  bg: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-text2) 20%, transparent)' },
}

// hr_employees.status → tint. Shared by EmployeeList.jsx and PaySetup.jsx, which previously
// each defined an identical copy of this exact mapping independently.
//
// `color` is overridden to the `*-text` variant exactly as HR_REQUEST_STATUS does below, because
// both consumers paint it as 10–11px TEXT. STATUS_TINT's `color` is the base FILL token, which on
// the Light preset is #15803d — measured 3.99:1 on its own tint (S682), below AA. The tint and
// border keep the base token, which is what they are for.
export const EMPLOYEE_STATUS_COLORS = {
  active:     { ...STATUS_TINT.green,  color: 'var(--theme-green-text)' },
  // Probation is an employee on the payroll like any other (S804, owner decision), so it shares
  // Active's green and the label carries the difference. It was the accent tint, which on both
  // Modernist presets is red — a new hire's row read like a refused request.
  probation:  { ...STATUS_TINT.green,  color: 'var(--theme-green-text)' },
  // A leaver is a fact about the record, not something wrong with it (S768) — red here put every
  // former employee in the colour of a refused request. Grey is this module's "closed" state.
  resigned:   STATUS_TINT.gray,
  terminated: STATUS_TINT.gray,
  inactive:   STATUS_TINT.gray,
}

// ── The one HR request-status vocabulary ──────────────────────────────────────
//
// HR runs five parallel approval workflows — Leave, Overtime, TADA, Advances and Shift Swaps —
// and until S660 each page picked its own colours for the same four words. Measured across the
// module, "Pending" was brass on Leave and Overtime, GREY on TADA (grey being this module's
// void/cancelled colour, so the one queue actually waiting on a decision read as the most inert
// thing on the page), and amber on the HR Dashboard's queue counts and in the employee app. Worse,
// amber meant "waiting on you" on the dashboard and "already approved" on TADA — the same hue
// carrying opposite verdicts on two screens a manager works in one sitting.
//
// The employee-facing Self-Service app was already internally consistent, so its ladder is the one
// adopted here rather than a new invention; the two halves of HR now agree about the same row.
//
//   amber  = OPEN. Something is still required of someone. (Matches HrDashboard's own stated rule:
//            "`alert` means needs attention, which in this design system is AMBER — red means
//            overdue or failed.")
//   grey ◷ = DECIDED, but the money has not moved. Committed liability, not a caution.
//   green  = CLOSED, good.
//   red    = CLOSED, refused.
//   grey   = CLOSED, void — withdrawn or cancelled, never a live state.
//
// "Decided, not paid" was brass (`badge-yellow`, the accent tint) until S804. Since S689 the accent
// is red on both Modernist presets, so an approved claim sat beside a Rejected one in two reds, held
// apart only by an ink difference a colour-blind reader could not rely on. The owner chose grey
// with a ◷ mark (2026-10-07): the clock says "still to happen" and is what separates it from a
// void grey, so a chip in this slot always prints `mark` before its label.
//
// `badge` is the class; `tint` is for the few call sites that draw the chip themselves from a
// bg/border pair (Overtime's table) rather than using the class; `mark`, where present, goes
// before the label in the chip.
export const HR_REQUEST_STATUS = {
  pending:   { label: 'Pending',   badge: 'badge-amber', tint: { ...STATUS_TINT.amber,  color: 'var(--theme-amber-text)' } },
  approved:  { label: 'Approved',  badge: 'badge-green', tint: { ...STATUS_TINT.green,  color: 'var(--theme-green-text)' } },
  rejected:  { label: 'Rejected',  badge: 'badge-red',   tint: { ...STATUS_TINT.red,    color: 'var(--theme-red-text)' } },
  cancelled: { label: 'Cancelled', badge: 'badge-gray',  tint: { ...STATUS_TINT.gray,   color: 'var(--theme-text2)' } },
}

// The "decided, money not moved" slot, for any ladder that has one (TADA's Approved, an Advance
// being recovered, a Final Settlement finalized but unpaid). One definition so the three cannot
// drift apart the way the request colours once did.
export const OWED_STATUS = { badge: 'badge-gray', mark: '◷', tint: { ...STATUS_TINT.gray, color: 'var(--theme-text2)' } }

// TADA is the one ladder with a payment step after the decision, so `approved` there does NOT mean
// finished — it means the claim is owed and the cash has not left. That is the grey ◷ slot above,
// and `paid` takes the green that `approved` holds on every other queue. Keeping this derived from
// HR_REQUEST_STATUS rather than written out again is the point: only the two states that genuinely
// differ are restated.
export const TADA_REQUEST_STATUS = {
  ...HR_REQUEST_STATUS,
  approved: { label: 'Approved', ...OWED_STATUS },
  paid:     { label: 'Paid',     badge: 'badge-green',  tint: { ...STATUS_TINT.green,  color: 'var(--theme-green-text)' } },
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
// Days after the end of a payroll month by which the employer must deposit SSF. 15 under the
// Contribution-based Social Security Act 2074 s.4(4) until the Act to Amend Some Nepal Acts, 2082
// (Nepal Gazette 2082/04/14, 30 July 2025) extended it to 25. Late deposits attract 10% interest.
// Decided with Aashish 2026-09-14 (S748). BS months run 29-32 days, so the 25th always exists.
export const SSF_DEPOSIT_DAY = 25
// Nepal Labour Act: gratuity vests after one year of continuous service.
export const GRATUITY_VESTING_MONTHS = 12

// Minimum wage (full-time monthly): NPR 19,550 = 12,170 basic + 7,380 dearness allowance.
export const MIN_WAGE_MONTHLY  = 19550
export const MIN_BASIC_MONTHLY = 12170
// The dearness-allowance half of the monthly minimum. Derived, not typed: PayForm carried 7380 as
// a literal in three places beside these two constants.
export const MIN_DEARNESS_MONTHLY = MIN_WAGE_MONTHLY - MIN_BASIC_MONTHLY

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
// with no home in the palette.
// The unpaid-leave codes read in text2, not text3 (S803): on their own 13% swatch text3 measured
// 3.88:1 on Light, and text3 has no headroom on any tint (the S794 rule).
//
// The hues follow what the day IS (S804, owner decision): green = worked (a half day included —
// the ½ says how much), purple = paid but not worked (holiday, paid leave), grey = unpaid or off,
// red = absent. Half-day and both paid-leave codes were the accent until then, which on both
// Modernist presets is red: a half day sat beside Absent in the same colour.
export const ATTENDANCE_STATUSES = [
  { key: 'present',           label: 'Present',             short: 'P',   color: 'var(--theme-green)',  textColor: 'var(--theme-green-text)' },
  { key: 'half_day',          label: 'Half-day',            short: '½',   color: 'var(--theme-green)',  textColor: 'var(--theme-green-text)' },
  { key: 'absent',            label: 'Absent',               short: 'A',   color: 'var(--theme-red)',   textColor: 'var(--theme-red-text)' },
  { key: 'paid_leave',        label: 'Paid Leave',          short: 'PL',  color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)' },
  { key: 'unpaid_leave',      label: 'Unpaid Leave',        short: 'UL',  color: 'var(--theme-text3)',  textColor: 'var(--theme-text2)' },
  // Half-day leave — distinct from the generic 'half_day' status above so payroll can respect
  // the underlying leave type's paid/unpaid flag instead of always deducting 0.5 day's pay.
  { key: 'half_paid_leave',   label: 'Half-day Paid Leave',   short: '½PL', color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)' },
  { key: 'half_unpaid_leave', label: 'Half-day Unpaid Leave', short: '½UL', color: 'var(--theme-text3)',  textColor: 'var(--theme-text2)' },
  // Key stays 'weekly_off' (no DB migration needed — hr_attendance_status_check already allows
  // it) even though there's no more auto-computed "weekly" pattern; it's now just an explicit
  // per-employee, per-day Off marking. Label/short changed from "Weekly Off"/"W" to "Off"/"O"
  // to match — see attendanceFromRoster.js and AttendanceSheet.jsx.
  { key: 'weekly_off',        label: 'Off',                 short: 'O',   color: 'var(--theme-text2)',  textColor: 'var(--theme-text2)' },
  { key: 'holiday',           label: 'Holiday',             short: 'H',   color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)' },
]

// What a roster shift IS: 'off', 'leave' or 'work'. The JS copy of the database's hr_shift_kind
// (20260928130000), which request_shift_swap and approve_shift_swap decide with, so the Staff app,
// the Labor Forecast and Import from machine give the answer the swap rules give (S798, ATTENDANCE-7
// / ROSTER-5). It used to be a substring test on the name alone, so "Coffee Bar" and "Back Office"
// (they contain "off") and a 12-hour "Holiday Duty" were all days off.
// A day off is a MARKER: no hours, no start time, and a name that says off or holiday ("Day Off",
// "OFF DAY", "Public Holiday"). Leave is by name. Everything else is work, including a zero-hour type
// under any other name ("Rest"), which isOnDutyShift then keeps off the floor by its hours.
// `shift` is an hr_shift_types row ({ name, hours, start_time }); no shift type at all is 'off'.
export function shiftKind(shift) {
  if (!shift) return 'off'
  const name = String(shift.name || '').toLowerCase()
  if (name.includes('leave')) return 'leave'
  const noHours = !(Number(shift.hours) > 0)
  const noStart = !String(shift.start_time || '').trim()
  if (noHours && noStart && /off|holiday/.test(name)) return 'off'
  return 'work'
}

