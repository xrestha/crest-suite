---
paths:
  - "src/modules/hr/**"
---

# HR payroll engine

> Moved out of the root CLAUDE.md (2026-08-18 /doctor pass) so it loads only when working on these files. Root CLAUDE.md keeps the universal invariants.

### HR payroll engine (pure functions)

`src/modules/hr/payroll/payrollCompute.js` — no React, no Supabase. Three pay bases: `monthly`, `daily`, `hourly`.

**Monthly-basis pay is prorated for `join_date` (added S482)** — `daysNotYetJoined()` folds days-before-hire, within the period being paid, into the same `unpaidDays` figure attendance-based absence already uses, so a newly hired employee (or one who joins mid-period) is paid only from their join date onward instead of a full contractual month. This one change also correctly shrinks the SSF base and TDS (both already derive from `gross − absence_deduction`), so no other file needed touching for it to flow through. Daily/hourly staff never needed this — their pay comes straight from attendance rows, which can't exist for days before the employee's record was created. Any caller of `computePayslip()` must pass `join_date` on the `employee` object (both `PayrollRun.jsx` and `PayrollCalculation.jsx`'s employee queries include it) — found live via a smoke test: without it, Payroll Run happily paid a brand-new hire a full month's basic for a period that had already closed before they joined.

`src/modules/hr/payroll/tds.js` — Nepal income-tax TDS via YTD cumulative projection. FY 2083/84 slabs apply from Shrawan 2083 onwards. SSF contributors have the 1% first slab waived.

Constants in `src/modules/hr/payrollConstants.js`: SSF rates (11% employee / 20% employer), SSF cap (NPR 100,000 basic), OT multiplier (1.5×).

**SSF requires the enrolment flag AND a registration number (S570).** `computePayslip` gates on `ssf_enrolled && ssf_no`, not the flag alone. The flag alone deducted 11% while `HrReports.jsx`'s challan tab has always filtered on `ssf_no` too — so a flagged employee with a blank number had money withheld that no filing sheet ever claimed, with one quiet "N employees excluded" line as the only tell. The same gate is mirrored in `PayrollRun.jsx`'s and `PayrollCalculation.jsx`'s `isSsf` (the TDS 1%-waiver flag) — **all three must agree**, or an employee shows a permanent false Stale badge against a correct payslip. Payroll Run flags the state inline as `⚠ SSF no. missing`.

**Approved overtime SUPERSEDES attendance-sheet OT, per day (S570).** They used to be added together, which paid the same hours twice and was surfaced only as a `⚠ OT ×2?` warning the user had to act on. `tallyAttendance(rows, supersededOtDays)` now withholds attendance OT on any `bs_day` an approved entry covers, and reports the withheld hours as `sumOtSuperseded` so a page can explain the difference. Consequence for callers: **the OT query must select `bs_day`** — it is load-bearing, not display data, and both payroll pages had to add it. Holiday 2× remains reachable only through the Overtime module. Same shape as POS-supersedes-manual in sales depletion.

**`hr_payslips.unpaid_days` vs `absent_days` (S570, migration `20260818120000`).** `absent_days` is literal absences and must stay that way — Payroll Run's Excel export renders it under the header "Absent Days". The payslip's absence line covers absences **plus** unpaid leave, half days and pre-join days, so it prints `unpaid_days`; printing the narrow figure understated it (one absence + three unpaid-leave days read "(1.0 days)" against four days of money). Payslips finalized before the migration have no value and correctly print no count rather than a wrong one.

**Payroll Run refuses to finalize a stale draft (S570).** The draft is a snapshot from Generate time, so approving OT or editing attendance afterwards left it quietly wrong while Finalize locked whatever was on screen — and the only staleness detection lived on `/hr/calculation`, a page nobody had to visit first. `PayrollRun.jsx` now recomputes live via **`buildRows` itself** (never a second copy of the arithmetic) and compares `net_pay` per employee; mismatches and employees added after the run block Finalize outright, with a named amber banner pointing at Regenerate. Finalize's confirm is now a consequence summary — payslip count, total net pay, advance recoveries and TADA claims to be closed — because those are real writes to other ledgers. This is why `fetchYtdMap`/`fetchApprovedTadaMap` are loaded on every page load here, not just inside generate/regenerate.

**`payrollData.js`'s three fetch helpers are shared by Payroll Run and Payroll Calculation on purpose, and a filter that's correct for one can be wrong for the other (S565).** `/hr/payroll-calculation` exists solely to recompute every figure live and compare it against the stored `hr_payslips` snapshot, flagging a per-employee **⚠ Stale** badge when `Math.round(stored.net_pay) !== Math.round(netPay)`. That comparison is only meaningful if the live side sees the same *inputs* the stored side was built from — so **any helper feeding it must be robust to state the Finalize action itself changed.** `fetchApprovedTadaMap()` was not: Finalize marks the claims it paid `status='paid', paid_method='Payroll'` (the double-reimbursement guard from S324), while the helper filtered `.eq('status','approved')`, so on an already-finalized period it returned an empty map, live net pay came out short by exactly the TADA amount, and **every employee paid TADA through payroll showed a false Stale flag** — pointing at a genuinely correct payslip. It now matches `.in('status', ['approved','paid'])` and drops any `paid` row whose `paid_method` isn't `'Payroll'`, so a claim settled by hand in cash/bank is still correctly excluded. `fetchYtdMap` is immune to the same shape by construction (it deliberately reads only *prior* months' finalized runs, never this one), and `buildAdvanceMap` is a pure function over rows the caller already fetched. **Before adding a fourth helper here, ask what Finalize does to the rows it reads** — if the answer is "changes them", the Calculation page will read the post-finalize state and the Stale badge becomes noise the moment payroll locks.

### Final Settlement writes, and what that changed elsewhere (S600)

`/hr/settlement` used to compute and print, writing nothing, with an amber card listing three
follow-ups for the operator. It now records the settlement in **`hr_final_settlements`** and
Finalize performs those three itself. Five things worth knowing before touching it:

- **The write order is the design.** The row goes in as a **draft** first so every later step has an
  id to tag itself with, and only flips to `finalized` once the ledgers are written. A crash
  part-way therefore leaves a draft — which closes nothing and claims nothing — rather than a
  finalized document asserting money moved that never did. Every write checks its error and stops.
- **`hr_advance_repayments.final_settlement_id`** is the mirror of `payroll_run_id` and the only
  reason Reopen can undo the advance recovery. Both Reopens now reactivate **only the advances read
  off their own tagged rows** — payroll's used to reactivate any settled advance client-wide with a
  balance, which would have un-settled advances a settlement had closed.
- **Recovery is capped at the payout.** A settlement that nets negative has not recovered the full
  balance, so those advances stay `active`; there is no receivable ledger to move a shortfall into.
- **Finalize refuses** rather than warns on: a finalized payslip already covering the final month, a
  prior settlement overlapping the current `join_date` (which would pay gratuity twice for the same
  years on a rehire), and a concurrent finalize in another tab.
- **Identity and rate constants are frozen on the row** — name, code, basic, join date, `SSF_CAP`,
  the gratuity share, the vesting months, the ÷26 divisor. The printed statement shows its own
  workings, so re-deriving `basic` from a live employee makes a reprint contradict itself after any
  raise. Same rule as the Monthly Owner Report.

**Gratuity now lives in `src/modules/hr/gratuity/gratuityCompute.js`**, shared by Gratuity Tracker
and Final Settlement, which each carried their own copy and disagreed on four behaviours. Two of
those were money bugs:

- **The SSF gate is `ssf_enrolled && ssf_no`**, matching `computePayslip`. A flagged employee with a
  blank number had nothing contributed on their behalf, so netting an SSF-funded share off their
  gratuity underpaid them.
- **The SSF offset is capped at real enrolment.** Both copies multiplied `3.33% × capped basic`
  across the employee's *entire service* — but SSF only began in 2075/76 and most clients enrolled
  later. A ten-year employee enrolled two years ago lost eight phantom years, roughly **NPR
  320,000**. There is no enrolment date in the schema, so `ssfEnrolment.js` derives it from evidence:
  the first finalized payslip carrying an SSF deduction. **No evidence means no offset** — never a
  guess, because the wrong guess silently reduces what a leaver is paid.

**`computePayslip` now prorates for `end_date`** (`daysAfterExit`, the mirror of
`daysNotYetJoined`). Without it a leaver drew a full contractual month and the settlement added its
partial month on top — the same month paid ~1.5×. **Any query feeding `computePayslip` must select
`end_date`**, exactly as it must select `join_date`; both payroll pages do. Do not implement this by
writing `absent` rows for post-exit days — `absent_days` is a reported figure and that would
misreport a departure as absenteeism.

**Payroll Run's staleness check gained a third bucket**: a stored payslip whose employee is no
longer active. It was invisible before (the check only iterates live employees), while Regenerate
hard-deletes payslips and re-inserts only live ones — so settling someone mid-month and then
regenerating that month's draft silently destroyed their issued payslip. It deliberately does **not**
block Finalize (that would strand the run with no legal move); it gates Regenerate with a confirm.

**`hr_tada_claims` has no `bs_year`/`bs_month` and is not plumbed through `monthly_periods` at all** — it's a standalone ledger keyed on plain AD `start_date`/`end_date`, which is why `fetchApprovedTadaMap` converts the BS period to an AD range rather than filtering on period columns, and why TADA Claims' own month filter (S564) buckets client-side via `adToBs(start_date)` instead of a `.eq()`. Don't reach for `period_id` on this table; it isn't there.

### A finalize gate that drops its read error passes vacuously (S613)

Final Settlement's three refusal checks — a finalized payslip already covering the final month, an
overlapping prior settlement, a concurrent finalize in another tab — each read the database and each
**dropped the error**. So a failed `hr_payslips` read produced an empty array, which reads as "no
payroll covers this month", and the gate waved through **exactly the double-payment it exists to
block**. All three now push a refusal naming the failure instead ("Could not verify whether payroll
already covers the final month… finalizing without this check could pay that month twice").

`reopen()` had the same shape with worse consequences: it dropped the error on the read of *its own*
tagged `hr_advance_repayments` rows, so a failed read meant it deleted the repayments and reactivated
**nothing** — the advances this settlement had closed stayed closed while the settlement that closed
them was gone. It now aborts before touching anything.

**The rule for any new gate here: a check that could not run has not passed.** Refuse and name the
failure. The same reasoning applies to Payroll Run's freshness gate, which reads live data to decide
whether Finalize is safe.

## BS day labels, and the month list (S614)

Anywhere HR prints a day inside a known month — the OT list and swap column on HR Dashboard,
Overtime's date column, Attendance's clear-a-day confirm, Self-Service's swap-day picker — it uses
`formatBsDay(day, bsMonth)` ("1st Bhadra") or `bsDayOrdinal(day)` where the month is already stated
beside it. Both live in `src/utils/bsCalendar.js`. The confirm dialog is the one that matters most:
a destructive action must name the day it will wipe in the same words the roster shows.

`FinalSettlement.jsx` carried the twelve month names as its own `BS_MONTH_NAMES` — the same list as
`BS_MONTHS`, under a different name, so no name-based search would ever have paired it with the
other 30 copies. It now imports `BS_MONTHS`. **Never retype the month list**; there is exactly one.

## The payroll data path: three failures that all look like a normal month (S620)

Every one of these produced a complete, confident payroll. None of them raised anything.

**Page every read that is narrowed in JS rather than in the query.** `fetchYtdMap` and
`fetchApprovedTadaMap` in `payrollData.js` apply the fiscal-year and period windows *after* the
fetch, so each reads the client's entire history — every finalized payslip ever, every
approved-or-paid claim ever. Unpaged they stopped at 1000 rows, which for payslips is roughly 20
staff × 4 years, and a truncated YTD understates prior taxable income, under-withholds TDS and
under-remits to the IRD. `hr_advances`/`hr_advance_repayments` are worse: unfiltered lifetime
ledgers in both `PayrollRun` and `PayrollCalculation`, and `buildAdvanceMap` derives outstanding as
`amount − repaid`, so truncating the repayments side over-deducts from take-home pay. Note
`.order('issued_date')` is NOT a unique tiebreaker — several advances share a date — so paging on it
alone trades truncation for row-repeat/row-skip. Append `.order('id')`.

**An empty map is a real value here, so a dropped read error is invisible.** No prior finalized
payslips this fiscal year is a genuine state — the year's first month — so a failed `fetchYtdMap`
does not look like a failure, it looks like a fresh starter, and `computeMonthlyTds` spreads the
year's tax over twelve months instead of the months actually left. Both helpers now return
`{ data, error }` so they compose with `firstError()`. The write paths matter most: `generate()` and
`regenerate()` compute TDS from these maps and INSERT the result, so the wrong figure is *persisted*
— and `regenerate()` hard-deletes every payslip first, so its check must run before the DELETE, not
after. `FinalSettlement` had `.catch(() => ({}))`, the same fallback stated out loud; its writes are
now blocked while the read is failing, because **an error nobody can act on is not a guard**.

**Compare inputs, never `net_pay`, when asking whether a draft is stale.** TDS and TADA are
deliberately hand-editable while a run is a draft and each edit rewrites `net_pay`, so a `net_pay`
comparison could not tell an intended override from real staleness. On Payroll Run that was a
deadlock, not a false alarm: `finalize()` refuses while stale and offers no override branch, and the
only escape — Regenerate — resets the very edit that caused it, so a legitimate override could never
be finalized. `payslipDrift(stored, live)` in `payrollData.js` is the one comparison, returning
`'moved' | 'overridden' | null`. It checks the six computed fields nobody can type into, plus the
TADA **claim id set** rather than its amount — which keeps exactly what the amount comparison used to
detect, since approving or withdrawing a claim changes the ids while a typed correction does not. An
override is reported (`overridden`), never blocking: the Finalize confirmation names it, and
`PayrollCalculation` shows a neutral "Adjusted" chip where it used to show a red ⚠ Stale against a
correct payslip. It lives in `payrollData.js` because that module exists so those two pages cannot
drift; a third copy of the comparison is the failure it was written to prevent.

## Reopen is an HR-manager action, not a Crest-admin one (S620)

`isAdmin` is the **Crest platform operator**; the tenant's own owner is `isOwner`, and both resolve
`hrRole` to `'manager'`. Payroll Run, Festival Allowance and Incentive Run all gated Reopen on
`isAdmin`, so the person accountable for a run had to contact support to correct it. All three are
now `hasHrAccess('manager')`, matching the guard already on each page.

**`FinalSettlement.jsx` is deliberately still `isAdmin`** and is the one place this pattern was left
alone: reopening a settlement un-blocks a departed employee's Crest Staff login and reverses their
status stamp, which is a different order of consequence from re-running a month. Decide it on its own
merits rather than sweeping it for consistency.
