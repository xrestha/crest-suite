# hr-payroll.md: archived sections

Moved word for word out of .claude/rules/hr-payroll.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 85–104:_

### Finalize and Reopen write to four ledgers, and each one names what did not move (S682)

S613 fixed Final Settlement's gates. `PayrollRun`'s own money flows were the same shape and were
not touched: **finalize ran five writes bare** — the run to `finalized`, delete then re-insert
`hr_advance_repayments`, `hr_advances` to `settled`, `hr_tada_claims` to `paid` — and then printed
"Finalized" whatever had landed. A dropped write left the run finalized with no repayment rows, or
repayments recorded and advances still active, or **TADA claims still Approved and therefore
payable a second time**. `reopen()` dropped the error on the read of its own tagged repayment rows,
so a failed read deleted them and reactivated nothing: exactly the divergence the S600 comment
above it says the code exists to prevent.

Both now stop at the first failure and say **which ledger did not move**, reloading first so the
register shows the true state rather than the intended one. Two properties make that safe to write
this way: reopen-then-finalize is idempotent by construction (the delete-then-insert above), so
"reopen and finalize again" is always a legal recovery and the message says so; and the failure
message names the state the run is in now, never the constraint that rejected the write.

The same pass gave leave approve/decide the same treatment — a failed freshness read used to skip
`revertAttendance` and reject the request while the paid-leave days stayed marked and paid.

---

_Original lines 174–212:_

## The row-cap sweep stopped at payrollData.js (S628)

S620 paged `fetchYtdMap` and `fetchApprovedTadaMap` and wrote the reasoning above. **Four reads with
the identical shape, in files one or two directories away, were left bare** — each reads every
finalized payslip the client has ever had and applies the fiscal-year window in JS afterwards, so
each stopped at 1000 rows (~20 staff × 4 years) with no error:

- **`HrReports.jsx`'s `loadYtd`** — YTD TDS on the TDS certificate and the challan sheet. The file
  it lives in already carries three S612 comments about not rendering an unverified figure; the
  figure itself was arriving truncated.
- **`FestivalAllowance.jsx` and `IncentiveRun.jsx`** — both build a YTD map that feeds
  `computeBonusTds`, so a short YTD gross under-withholds tax on the bonus.
- **`fetchSsfStartMap`** (`gratuity/ssfEnrolment.js`) — the worst of the four. It picks the
  **earliest** SSF-bearing payslip per employee, and the query had no `.order()` at all, so the
  1000 rows PostgREST returned were arbitrary: the ones dropped could be precisely the early ones
  the map exists to find. That reports a later SSF start → fewer contribution months → a smaller
  offset → a **larger** gratuity paid; or, if an employee's rows vanish entirely, `null`, which
  `calcGratuity` correctly reads as "unknown coverage" and applies no offset at all. Both wrong,
  in opposite directions, on a payment a departing employee receives once.

All four now use `fetchAllRows` with `.order('id')`.

**`hr_roster` is `hr_attendance`'s twin and was not paged.** One row per employee per rostered day,
so a 30-day month crosses the cap at ~33 staff. `AttendanceSheet.jsx` pages its `hr_attendance` read
with a comment naming that exact threshold — ten lines below an unpaged `hr_roster` read on the same
page. Consequences, in ascending order of quiet: the Roster board paints real shifts as empty cells;
Attendance's OT auto-calc loses the roster row and falls back to `STANDARD_HOURS_PER_DAY`, measuring
overtime against 8 hours instead of the employee's real shift, and **that OT is what payroll pays**;
and Copy Week reads the target week to count what its mirror will overwrite and clear — its own
comment says a failed read there "would understate what the copy is about to destroy, so it stops
the whole thing", but **truncation is not a failure**, so it did that silently.

`hr_advance_repayments` was bare in `Advances.jsx` and `HrDashboard.jsx` too. Outstanding is derived
as `amount − repaid`, so truncating that side alone **overstates** what every employee owes.

**Deliberately not paged**, so the next sweep does not churn them: `hr_overtime_entries` (logged by
exception, not per day — nowhere near the cap for one client-month), and every single-parent read —
`.eq('run_id', X)`, `.eq('employee_id', X)`, `.maybeSingle()`.

---

_Original lines 213–233:_

## Both payroll pages ran the engine in the render body (S628)

`PayrollRun`'s `freshness` was a bare render-body IIFE and `PayrollCalculation`'s `rows` a bare
`employees.map()`. Each calls `computePayslip` plus a TDS slab walk **for every employee**, and each
re-ran on state that moves none of its inputs: a status message, a busy flag, opening the Finalize
confirm, expanding one employee's detail panel. Both are `useMemo`d on the loaded data they actually
read.

**Inside them, the per-employee slicing became one pass.** Both took each employee's slice of
`components`, `attendance` and `otEntries` with a `.filter()` inside the `.map()` — and `attendance`
is one row per employee per *day*, so it was walked once per employee: 56,000 element visits where
1,400 do, at 40 staff on a 30-day month. `groupByEmployee(rows)` / `sliceFor(index, empId)` in
`payrollData.js` partition each array once.

**Those helpers live in `payrollData.js` for the same reason the fetch helpers do** — these two pages
must not drift — and `payrollData.test.js` asserts the slices are byte-identical to what the filters
produced, order included. That is not belt-and-braces: `buildRows` is what `generate()` and
`regenerate()` INSERT from, so a reordering or a dropped row here is a wrong payslip written to the
database, not a wrong number on screen. `.filter()` preserves source order and appending in source
order preserves it too, which is the property the test pins.
