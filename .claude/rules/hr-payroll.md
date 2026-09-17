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

> **S751 supersedes parts of the next five sections** — the TADA filter (S565), the `net_pay`/override comparison (S570/S620), the departed bucket being non-blocking (S600), and the two pages' own `buildRows`. **S752 supersedes the Final Settlement and gratuity parts of S600/S613/S620** — the partial-month salary, the SSF start-date offset, the browser-side Finalize/Reopen and its `isAdmin` Reopen gate. Read the S751 and S752 sections at the end first.

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

### Finalize and Reopen (S682, superseded)

Since S753 Finalize and Reopen are one transaction each (`finalize_payroll_run` / `reopen_payroll_run`; see "The S751/S752 open list" below), which superseded S682's per-ledger failure messages. The S682 record, the S628 row-cap sweep of `payrollData.js` and the S628 render-body fix (which names the since-deleted `PayrollCalculation`) moved word for word to `docs/rules-archive/hr-payroll.md`.

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

**(Superseded S752: Reopen is now Owner or HR manager, in the database, with a reason.)** `FinalSettlement.jsx` was deliberately still `isAdmin` and was the one place this pattern was left
alone: reopening a settlement un-blocks a departed employee's Crest Staff login and reverses their
status stamp, which is a different order of consequence from re-running a month. Decide it on its own
merits rather than sweeping it for consistency.

**Leave's `Reopen` (S740) follows the same rank, and adds the rule that makes an undo safe.** A
`rejected`/`cancelled` leave request had no action on its row at all — the CHECK constraint always
allowed `pending` back, only the UI did not — so a mis-click on the Cancel sitting beside Approve
ended the request permanently, losing its dates, the employee's reason, `created_at` and the audit
trail. Reopen returns it to **Pending, never straight to `approved`**: `approveRequest()` is the one
writer of the `hr_attendance` rows and the cancel deleted them, so a restore that skipped the queue
would show an approved leave over an attendance sheet with those days blank — and payroll reads the
sheet, so an unpaid leave stops deducting and a daily-wage paid leave goes unpaid. Generalise that
to any undo here: **restore to the state before the write, not to the state after it, unless the undo
itself performs the write.** It also re-reads the row's status first, the mirror of the decide path's
guard above — a concurrent reopen-and-approve would otherwise be silently un-approved with its days
still marked — and refuses on a FAILED read rather than falling through.

Overtime's `Undo` is the older sibling of both and is **not** aligned with them: it sits at the
page's own `supervisor` rank, with no confirmation and no freshness re-read. Left alone rather than
swept, on the same "decide it on its own merits" footing as `FinalSettlement` — an OT entry's undo
touches no attendance row — but know it is a deliberate difference, not an oversight.

## An approval is two writes, and the second one has a precondition the first does not (S741)

Approving leave stamps the request AND writes an `hr_attendance` row per day. **The second write is
the one that matters**: `payrollCompute` builds `unpaidDays` only from rows that exist, so a day
with no row is a paid day, and the Attendance Sheet reads `hr_attendance` and never looks at
`hr_leave_requests`.

Those rows hang off a `monthly_periods` row, and `monthly_periods_one_open_per_client` allows a
client ONE open period at a time. So leave approved for a month two or three ahead — which is most
leave, since staff book around Dashain and family trips — had nowhere to write. It was approved
anyway (right: recording the decision beats refusing it) under a banner reading *"Create the
period(s), then re-approve to mark those days"*, and **neither half was possible**: the index
refuses the early period, and an approved row has no Approve button. Nothing back-filled. The
request read Approved, the sheet was blank, and an approved UNPAID leave was paid in full when its
month finally came round.

`backfillApprovedLeave({ clientId, period })` runs at the one moment the write becomes possible —
`createPeriodWithCarryForward` and `performPeriodClose`'s open-next, the two places a period is
minted. Five things are load-bearing:

- **It fills only days with no attendance row.** At creation that is every day; the same helper
  backs the Leave page's catch-up button, where the month may already carry marks, and a months-old
  approval silently overwriting a hand-marked `present` is worse than the bug being fixed.
- **It reports, never throws.** Period creation must not fail on an HR read, so the result rides
  back as `leaveFill` and a failure is its own `leave_backfill` stage in `performPeriodClose`'s
  `failures` — the CLAUDE.md "two writes in one function can diverge" rule: the second write's
  silence proves nothing, so it gets its own answer.
- **One day is sent once.** Two approved requests covering the same day would send the same
  conflict key twice in one upsert, which Postgres refuses outright ("cannot affect row a second
  time") — losing the whole month's back-fill over one double-booking.
- **`findApprovedLeaveGaps()` makes an existing gap visible**, split into `waiting` (no period yet
  — nobody's to act on, say so) and `unmarked` (period exists, days missing — actionable). Months
  before the client's earliest period are ignored as imported history. Its failed read returns the
  error rather than an empty list, because "nothing is missing" is the most reassuring answer the
  function has.
- **Say what the reader can do, or say there is nothing to do.** The approval banner now states
  that the days will be marked when the month is created. A warning that asks for an impossible
  action is worse than no warning: it trains people to ignore the banner.

## The Holiday Calendar is what pays the 2× rate, and it was empty (S635)

`hr_holiday_calendar` is read by `Overtime.jsx` to decide the **holiday 2× rate** — and only on
`holiday_type = 'public'`, never `'optional'`. So a row's type is money, not a label, and a missing
holiday pays 1.5× on the biggest working days of the Nepali year.

Reported live from an FY 2083/84 calendar showing **five** holidays and no Dashain. The page was
working as built: only the seven whose BS date never moves were seedable, and the empty state told
the owner to add Dashain, Tihar and Holi "manually". Nobody transcribes thirty gazette rows by hand,
so in practice the calendar stayed empty of precisely the days it exists to flag.

**Three kinds of holiday, and only the first is derivable in code.** `holidayData.js` is organised
around this and `holidayData.test.js` pins it:

- **FIXED** — same BS date every year (Republic Day is always Jestha 15). Seedable forever. The BS
  *year* comes from `resolveYear(fyYear, bs_month)`, never a per-row field; the old list carried its
  own `yearOffset` saying the same thing, which is one rule too many for a value both sides must
  agree on.
- **MOVABLE** — lunar, plus the AD-fixed ones (Christmas, Workers' Day, Women's Day) which move in
  BS for the mirror-image reason. **Transcribed** from the Nepal Gazette once the Home Ministry
  publishes the year — usually in Falgun of the preceding year. Keyed by REAL BS year, because a
  Nepali FY spans two of them and the gazette is published per BS year.
- **SIGHTED** — the two Eids, Mohammad Jayanti, Guru Nanak Jayanti, Bhoto Jatra. No gazetted date at
  all. Named on screen so their absence reads as a known gap rather than an oversight.

**Extending the table is a transcription job, never a calculation.** Verify each date in two
independent places and against `bsCalendar.js`'s own month lengths — Fulpati on *Ashwin 31* exists
only because Ashwin 2083 has 31 days; it has 30 in 2084. A wrong date here is a wrong figure on a
real payslip.

**Report coverage rather than seeding short.** A fiscal year runs into a BS year whose gazette may
not exist yet, so the seed names the uncovered year instead of adding 39 rows and looking complete.
An owner who reads "39 added" and then finds no Buddha Jayanti cannot otherwise tell a gap in our
table from a gap in the gazette.

**The NAME is the dedupe key, which makes two things load-bearing.** Three `Dashain holiday` rows
and two `Tihar holiday` rows sharing a name meant only the first would ever insert — Kartik 5, 6 and
26 silently dropped, inside the two festivals the whole feature is about. Days with no tithi name of
their own are named by BS day. And renaming a FIXED holiday needs a `legacy` name list, or every
client who pressed the old button gets a second row on the same day: `Prithvi Narayan Shah's
Birthday` → `Prithvi Jayanti (National Unity Day)` would have done exactly that. Both are asserted
by tests, and both were caught by those tests before shipping.

**Seeding is additive and name-keyed** — a client's own entry or edit is never overruled, because
the gazette is a starting point for a movable date, not an authority over a decision the owner made.
The one exception is a FIXED holiday found on the wrong date: those are definitional, so **Martyrs'
Day at Magh 5 is corrected to Magh 16** (Sahid Diwas, the day the four martyrs were executed in 1997
BS) and the correction is named in the result rather than applied silently. That row had been wrong
since the page shipped, in both directions at once: 2× offered on an ordinary day, weekday rate on
the real holiday.

**Region-split holidays are seeded twice, named, and the operator removes one** (a `removed_at` stamp since S748, so the next Seed does not bring it back — see the S748 section below). Holi is a real day
off in both halves of the country and falls a day apart in each. Guessing the outlet's district from
nothing is worse than asking.

## Roster: Swap History is not scoped to the week on the board (S633)

The pending-approval queue and the permanent swap record both moved out of two collapsible
drop-downs above the Roster Board into a fourth tab, **Shift Swaps**. History has never been
period-scoped and was never meant to be — but sitting inside the board's period controls made a log
of Shrawan and Ashadh decisions read as news about the Bhadra week on screen.

**Moving an action queue off a screen is how an approval waits a week**, so the pending count rides
on the tab button (`pending_admin` only — a swap still awaiting the coworker's own accept is not yet
a manager action, the same filter `useHrApprovalCounts.js` uses). `Roster.jsx` fetches that count
itself with a `head: true` query rather than lifting it out of the panel, because the panel only
mounts once the tab is opened — which is exactly when the badge has stopped being useful.

**A history outlives the people in it.** `Roster.jsx` loads only `status IN ('active','probation')`
for the board, which is right for a board and wrong for a record: a resigned employee rendered as a
bare `—` beside a named coworker. Any page showing historical rows must resolve names its own list
filtered out — fetch the unknown ids once, tracked in a ref so an id that resolves to nothing does
not re-query forever. Related: `rejected_by_target` and `cancelled` never reach a manager, so
`admin_decided_by` is null on both; name the coworker who declined or the requester who withdrew
instead of printing a dash.

### A pending count of zero is the reader's good news, so a failed read must not produce one (S734)

HR runs five approval queues and both dashboards summarise them from one hook,
`useHrApprovalCounts` — four `head: true` counts, which destructured `{ count }` and discarded
`{ error }`. A refusal or a dropped connection returns `count: null`, `|| 0` turns that into a
zero, and both consumers then spent their most reassuring vocabulary on it: HrDashboard's four
tiles read **"0 · all clear" in green**, ClientDashboard's Pending Approvals headline a neutral 0.

The general rule ("a failed read is not an empty list") is everywhere in this repo. What HR adds
is the sharper case: **on a queue tile, empty is the OUTCOME THE MANAGER WANTS**, so a failed read
does not merely show a wrong number — it tells them not to open the page. A tile whose empty state
is good news needs a THIRD rendering, distinct from both the good state and the loading skeleton;
ours is an em-dash plus "count unavailable — open the page", with the section label saying so too.

Two corollaries worth holding:

- **A shared hook must RETURN the failure, never swallow it.** Only the consumer knows how its own
  tile says so, and these two say it differently.
- **The same page had it again one row down.** HrDashboard's Headcount tiles rendered "Active
  Staff 0" in green over "no probation" and "Basic Payroll / Month NPR 0" whenever the employee
  read failed — `empStats` was set from `(emps || [])` regardless, so the `?? '—'` fallback the
  cards already had could never be reached. `setEmpStats(err ? null : {…})`. When you find this
  shape, check the rest of the screen before moving on.

### One status vocabulary, and one labour band (S660)

**`HR_REQUEST_STATUS` / `TADA_REQUEST_STATUS` in `payrollConstants.js` are the module's only status
colours.** HR runs five parallel approval queues — Leave, Overtime, TADA, Advances, Shift Swaps —
and Self-Service shows the *same rows* back to the employee who filed them. Before this, "Pending"
was brass on Leave and Overtime, **grey** on TADA (grey being this module's withdrawn/void colour,
so the one queue actually awaiting a decision read as the most inert thing on screen), and amber on
the HR Dashboard and in the employee app. Amber simultaneously meant "waiting on you" on the
dashboard and "already approved" on TADA — one hue, opposite verdicts, on two screens a manager
works in one sitting. The HR module guide had already written the rule down and TADA contradicted it.

    amber = open, something is still required of someone
    brass = decided, but the money has not moved   (badge-yellow)
    green = closed, good
    red   = closed, refused
    grey  = closed, void — withdrawn or cancelled

Self-Service was the one internally consistent surface, so its ladder was adopted rather than a new
one invented. Three things follow. **Take `.badge` for a chip and `.tint` for a hand-drawn one** —
the tint already carries S549's fill-vs-text split (base token for the 10%/20% bg/border, `*-text`
variant for the label). **A ladder with a payment step extends the map, it does not restate it** —
`TADA_REQUEST_STATUS` spreads the base and overrides only `approved` (brass: owed, not yet paid) and
`paid` (green). **Two open states on one page separate by LABEL and the amber/brass split, never a
sixth hue** — an extra colour to distinguish two states of one verdict is how a five-token palette
becomes eight.

Corollary that costs nothing to hold: **a category never takes a signal colour.** Public-vs-optional
holidays and holiday-vs-weekday OT rates were amber-vs-grey, so a gazetted holiday wore the same
colour as an overdue approval. Both are brass; Holiday Calendar's table now also agrees with its own
two stat cards, which had been brass and purple for those same categories all along.

**Staff rank is that corollary's other half, and it now lives outside this module (S661).** HR settled
it first — a Supervisor is not a "warning" and a Staff account is not "healthy", so all three levels
take `badge-yellow` — but IMS and POS each held their own copy and both were still on the old
green/amber/brass ladder, so on one product a Supervisor was amber in two modules and brass here.
`HrStaff.jsx` now reads `STAFF_LEVEL_BADGE` from `src/shared/staffLevelBadge.js` along with the other
two, and `STAFF_LEVEL_BADGE_NONE` covers an account with no access to the module — the one genuinely
inert state on the axis, and previously a loose `'badge-gray'` literal at all three sites.

**Labour Cost % bands through `lcBand` in `src/shared/operatingBands.js`** — never a local
threshold. Roster's Labor Forecast had `costPct > 35 ? amber : inherit`: a different threshold from
both dashboards, no healthy state, no too-high state, and hue-only on a row already spending amber
on a staffing shortfall and a holiday tag. Use `bandFigure(pct, lcBand, { decimals: 0 })` and render
its `text`, which carries the ✓/△/▲ — see `ims-figures.md` for why the marks are not optional.

### The Labor Forecast prices the hour the way payroll pays it, and the roster stands in for a missing day (S692)

Four rules for `laborForecast.js`, each from a figure that read plausibly and was wrong:

- **A scheduled hour costs the LOADED rate, never `hourlyRateOf(basic)` alone.** `loadedHourlyRateOf`
  is the Owner Report estimate per hour — monthly `(basic + earning components) / (monthDays × 8)`,
  daily `basic / 8`, hourly `basic`, plus the 20% employer SSF share (gated on `ssf_enrolled AND
  ssf_no`, the engine's rule) spread over the same hours. The tab shares `lcBand` with the Owner
  Dashboard, and a band shared on a different definition of the numerator is a lie: an enrolled
  employee costs ≥1.2× basic before any allowance, so a day at 30% ✓ here was 36% △ there. With no
  components and no SSF it equals `hourlyRateOf` exactly — every difference is a cost that was
  left out.
- **A roster row is not a person on duty.** Help tells managers to mark rest days with the
  zero-hour "Day Off" shift, so `computeScheduledCount` uses `isOnDutyShift`: an off-type NAME
  (`isOffDay`, the same keywords Generate from Roster uses) or an explicit `hours: 0` is off duty.
  A working shift with UNKNOWN hours (the default "Split": `hours: null`, no times) is on duty and
  flagged "unpriced" — it adds a head and nothing else until someone sets its length.
- **Hours and cost follow the Department filter; Scheduled Staff never does.** Recommended Staff
  is covers ÷ target for the whole outlet, so the head it is compared with must be too, or filtering
  the Board to one department made every day read "Short". The tab shows the filter and says which
  columns it narrows.
- **A past day reads actuals, and when Attendance has none the ROSTER stands in — labelled.**
  Revenue from `sales_entries` (the Owner Dashboard's definition, hence the band's own
  denominator; POS posts there per day so it works for IMS-only clients), covers from closed paid
  `pos_orders` (only where the VIEWED client has POS — `clientModules.pos`, not `posEnabled`,
  which is true for every admin session), hours from `hr_attendance` with `ot_hours` priced at
  basic × 1.5 because it sits INSIDE `hours_worked`. A day with no attendance rows is
  `basis: 'roster'`: the rostered hours, cost and heads, with "as rostered · no attendance" under
  each — never 0h, and never a dash against a board showing three full shifts. Recommended Staff
  and Status are hidden entirely for a non-POS outlet: covers are only ever counted by POS bills,
  so the axis can never hold a value, and a footer that said "covered every measured day" over
  zero measured days was vacuous (`staffedDays` guards it).

### The labour STANDARD: what the day needs, learned from the outlet's own history (S693)

`laborStandard.js` derives sales-per-labour-hour from a trailing 120-day window and turns forecast
revenue into required hours. Five rules, each of which produces a plausible number when broken:

- **Ratio of totals, never a mean of per-day ratios**, and linear through the origin with no
  fixed-crew intercept — the per-weekday split absorbs most of what an intercept would do, and a
  two-parameter fit produces a figure nobody can check by hand. `typicalShiftHours` is
  `Σ hours / Σ heads` from the window, NEVER `STANDARD_HOURS_PER_DAY`: that is the statutory day,
  a payroll constant, not a rostering fact about this outlet.
- **Only evidence may train it.** `isTrainingSample` requires recorded hours, an existing period,
  and non-zero hours and revenue. A bulk `bs_day = 0` sales month is barred ENTIRELY — its revenue
  is understated with no day to attach it to, which deflates the standard and INFLATES required
  hours on every future day.
- **Attendance is the strong basis, the roster the weak one, and the gap between them is MEASURED.**
  Most clients enter attendance in one batch at month end, so an attendance-only model is blind to
  the current month. `measureRosterBias` computes `Σ attendanceHours / Σ rosteredHours` over the
  days carrying both and scales roster-only samples by it; below 10 overlap days they train
  unadjusted and the tab says so. Never assume a direction — overtime pushes the ratio above 1.
- **The window's hours read EVERY employee, whatever their status.** `computeActualLabor` skips any
  row whose employee is not in the list it was given, and the board's list is
  `status IN ('active','probation')` — so reusing it here would discard every hour worked by anyone
  who has since left, and required hours would come out LOW, telling the owner to roster fewer
  people than his own history says he needed. `tallyWindowAttendance` filters by nothing. S633 on a
  second surface: a history outlives the people in it.
- **Say which basis each number came from, on the row.** A weekday under 4 samples falls back to
  the all-days figure and announces it (`describeBasis`); under 20 qualifying days there is no
  standard at all rather than a thin one; a failed window read is an `ActionError` saying it is a
  failed read, not a lack of history. And say what the thing IS: it learns what this outlet
  normally uses per rupee, not what it ideally should — a chronically overstaffed outlet trains a
  chronically overstaffed standard.

`covers_per_staff_target` stays a POLICY the owner sets; the learned covers-per-shift figure is
shown beside it and never written into it. Collapsing the two would destroy the ability to say "we
are understaffing against our own standard".

## A shift's length is not its normal day (S742)

`hr_shift_types.regular_hours` ("Normal hrs") splits a shift into normal time and overtime. A shift
used to carry one number, so a rostered 12-hour day could never carry its overtime: Generate from
Roster wrote `ot_hours: 0` and a punched 8am–8pm measured 12 − 12 = 0. `shiftRegularHours` /
`shiftOvertimeHours` in `laborForecast.js` are the one definition. Four rules:

- **NULL means the whole shift is normal time**, which is the pre-column behaviour, so nothing moves
  until a manager fills it in. Never default it.
- **Normal hours are CLOCK time, lunch included** (client decision). On a shift with them, Attendance
  compares the Start-to-End span, so Break does not reduce OT. On a shift WITHOUT them the old
  net-worked formula stays, on purpose: a shift typed with a net length would otherwise gain an hour
  of OT on every day a break is entered. The "short" nudge follows the same basis.
- **OT sits INSIDE `hours_worked`**, everywhere it is written. So the hourly branch of
  `computePayslip` pays ordinary wage on `hours_worked − OT` (superseded OT included). Paying all of
  it and then 1.5× on top paid 2.5× until S742. `computeActualLabor` and
  `computePlannedLaborCost` price the OT part at basic × 1.5 on the same reading.
- **Attendance reads `hr_shift_types` with `*`, not a column list.** Naming a new column there fails
  the whole read on a database the migration has not reached, and an empty shift map makes every
  rostered day's full span overtime.

`zeroHourStatus()` (attendanceFromRoster.js) reads a zero-hour roster marker by name: unpaid first
("UNPAID LEAVE" contains "paid leave"), then paid, and a leave name that says neither is UNPAID; then
holiday; and everything else — an off name, no name, or a name that says none of these — is Off
(S749: it was Holiday, which now PAYS daily and hourly staff). `isOffDay` is deliberately unchanged, because Self-Service and the Labor Forecast
only need on/off duty.

## Clearing a month is scoped to the people on screen (S743)

Attendance's Clear Month refuses when the period's payroll run is finalized, and when that read
fails. It deletes `.in('employee_id', listed)`, never the whole period: the sheet lists
active/probation staff only, and a mid-month leaver's days are what Final Settlement reads. **A
blank attendance day is PAID for monthly staff** (`unpaidDays` comes only from rows that exist), so
the consequence of any clear is that marked absences and unpaid leave stop deducting. Never write
"a blank day is unpaid" in copy.

## Advances recover from the month AFTER issue, and SSF is one predicate (S747)

- **An advance is first deducted in the BS month after the month it was issued** (day irrelevant;
  Chaitra → Baisakh next year) — decided with Aashish, the rule hss-suite already runs.
  `firstRecoveryMonth` / `advanceDueIn` / `dueAdvances` in `payrollData.js` are the one filter every
  per-period reader uses (deduction, Finalize's allocation, Calculation's count), and
  `buildAdvanceMap(advances, repayments, period)` **throws** without a period rather than deducting
  everything. Final Settlement deliberately does not use it — a leaver repays everything outstanding.
- **`isSsfContributor(employee)` in `payrollCompute.js` is the one "enrolled AND has an SSF number"
  test.** Festival Allowance and Incentives waived the 1% slab and projected SSF relief on the flag
  alone, and the Owner Dashboard / Monthly Owner Report added employer SSF to labour the same way.
  Copies still inline in `gratuityCompute.js`, `laborForecast.js`, `HrReports.jsx`, `PayslipBody.jsx`
  agree today; move them to the helper when touched. `PaySetup.jsx` / `PayForm.jsx` previews adopted
  it in S748.

## Employees, Pay Setup and the Holiday Calendar (S748)

- **CIT / provident fund is retirement relief, in ONE cap with SSF** (decided with Aashish). A deduction
  component marked `retirement_fund` is taken off take-home pay AND off taxable income;
  `retirementRelief(annualContributions, annualGross)` in `tds.js` is the only cap (lower of NPR 5,00,000
  or a third of income) and `retirementContributionOf()` in `payrollCompute.js` the only sum. The
  payslip stores `retirement_contribution` so `fetchYtdMap` relieves real prior months, and it is a
  `FRESHNESS_INPUT_FIELDS` member — ticking the box on an existing deduction moves no amount, only TDS,
  which would otherwise read as a hand override. Monthly TDS, Final Settlement and — since S750 — Festival
  Allowance and Incentive Run use it; the two bonus pages share `projectBonusTaxableBase()` in `tds.js`
  rather than each carrying a copy of the projection (they had, and both relieved SSF alone). A marker, never a name match: the owner
  names these rows, and a guess would move real tax.
- **A form saves the fields it owns and changed, never the row it loaded.** `EmployeeForm` spread the
  loaded row (up to 10 minutes old from the page cache) into its payload, so a phone-number edit
  reverted a Pay Setup raise, a Final Settlement's status and end date, and a login block.
  `changedEmployeeFields()` (`employeeFormData.js`) is the patch. Any other edit form over a table two
  screens write needs the same shape.
- **A field that affects pay is never hidden while it holds a value.** The end-date picker showed only
  for Contract/Part-time, the value stayed saved, and `daysAfterExit` pays a monthly employee nothing
  after it. It now shows whenever set, with a warning when past on an active employee. Live check
  2026-09-14: no employee in that state.
- **Pay Setup's editor refuses Save until its component read is `ok`.** Save deletes and re-inserts
  the whole set, so an unfinished or failed read wiped every allowance. The general rule for any
  replace-the-set save: the set you send must be one you actually read.
- **An employee with pay history cannot be deleted, by anyone** (`hr_employees_guard_delete`,
  `employee_pay_history()`): finalized payslips, a finalized settlement, finalized festival
  allowances, any advance, or a Self-Service login. Deactivate is the lossless path; there is no force
  path. A whole-client deletion still cascades (the guard lets the delete through once the `clients`
  row is gone).
- **Holiday Calendar writes need HR supervisor rank** (page and a RESTRICTIVE policy per write command);
  `(client_id, bs_year, bs_month, bs_day, name)` is unique; the table is audited. Seed runs only over a
  list that loaded, because it dedupes against the screen. **An OT entry stores its own `ot_type`**, so
  editing or deleting a holiday never reprices existing overtime — copy must not say otherwise.
- **Removing a holiday is a stamp (`removed_at`), never a DELETE** (decided with Aashish). Seed is
  name-keyed, so a deleted seeded holiday came back on the next Seed. `planSeed()` (`holidayData.js`)
  counts a removed row as present and never corrects its date. **Every reader outside the page must
  filter `removed_at IS NULL`** — today Overtime.jsx and demandForecastData.js; a new reader that
  forgets suggests 2× on a day the owner took out. Delete for good exists and forgets the removal.
- **SSF is deposited by the 25th of the following month** (`SSF_DEPOSIT_DAY`, the July 2025 amendment
  to s.4(4); it was 15). Never hard-code the day in copy — read the constant.
- **Pay Setup previews are a full month before income tax**, and say so. Default tab is On payroll
  (active + probation), matching every payroll picker.

## Roster, Attendance, Leave and Overtime (S749)

Eight decisions taken with Aashish, and the rules that hold them. Migration `20260914170000`.

- **Rank is a database fence here too.** RESTRICTIVE supervisor-rank INSERT/UPDATE/DELETE policies on
  `hr_attendance`, `hr_leave_requests`, `hr_leave_types`, `hr_overtime_entries`, `hr_roster`,
  `hr_shift_types`, `hr_shift_swap_requests`, `hr_roster_publish_state` (the S748 Holiday Calendar
  shape). **A new HR table a supervisor page writes gets the same three policies.** Self-Service writes
  through SECURITY DEFINER RPCs and is unaffected.
- **A month whose payroll run is FINALIZED is read-only** — Attendance, leave approve/cancel, every
  overtime action. Pages lock and say "reopen the payroll run"; `hr_attendance_guard_finalized` /
  `hr_overtime_guard_finalized` refuse any caller that skips the page. A failed run-status read locks
  (`runStatus === 'unknown'`). **The parent-exists test that lets a client/period cascade through lives
  in the SECURITY DEFINER lookup, never in the INVOKER trigger** — an HR account's RLS view of
  `monthly_periods` is empty, so the first draft's `EXISTS` passed vacuously and a supervisor deleted a
  paid month's row on the live verification.
- **A non-working day carries no clock.** `NON_WORKING_STATUSES` in `attendance/attendanceRules.js`
  (absent, paid/unpaid leave, off, holiday — never the half-day ones). `withStatus()` clears the cell,
  the inputs switch off, `attendanceRowFor()` saves zeros, and leave approval's upsert clears a full
  day. **`tallyAttendance` adds `ot_hours` from every row whatever its status** — which is the reason.
- **Bulk marks fill blanks only** (`fillBlankCells`). An overwrite turned approved leave into Present.
- **Leave: `days` is derived by the database** (`hr_leave_requests_validate`), and two pending/approved
  requests for one employee may not share a day (operator exempt, for restore). `leaveRules.js`'s
  `findOverlappingRequest` / `finalizedMonthsFor` / `quotaOverrun` let the page say so first. Over
  quota WARNS, never blocks. `submit_my_leave_request` keeps `p_days` in its signature and ignores it.
- **One overtime entry per employee per day** (`hr_overtime_entries_employee_day_key`). An edit of an
  approved entry stays approved — decided, not an oversight. Overtime reloads the month ON SCREEN after
  a save to another month, never the saved one.
- **Shift types: unique name per client, and no delete while the roster uses one**
  (`hr_shift_types_guard_delete`). The page used to delete duplicate-named types on every load; never
  reintroduce a destructive tidy-up on a read path. A seed runs only after a successful read, and a
  23505 on the seed is a second tab, answered by re-reading.
- **A swap approval is `approve_shift_swap(p_request_id)`**, SECURITY INVOKER, one transaction, every
  UPDATE's row count asserted (a write RLS filters out is 0 rows, not an error). Same day → trade
  `shift_type_id`; different days → trade `employee_id`, refused if either already works the other day.
  The sentinel-`bs_day = -1` dance is gone.
- Attendance's period switch and Roster's board/publish loads are request-guarded; `hr_overtime_entries`,
  `hr_shift_types` and `hr_shift_swap_requests` are audited (`hr_roster` deliberately not — volume).
- **A public holiday inside a leave is not charged** (decided 2026-09-14, migration `20260914180000`).
  `days` = calendar days − public, not-removed Holiday Calendar days, derived in the trigger through
  `hr_public_holiday_count()` (SECURITY DEFINER, caller-checked) over `bs_months`; approval and
  `backfillApprovedLeave` mark those days `holiday`, and a revert leaves them. `leaveDayCount()` /
  `publicHolidayKeys()` in `leaveConstants.js` are the page's copy. Rostered days off still count.
  **A `holiday` row PAYS daily and hourly staff** (decided with Aashish, 2026-09-14 — Labour Act s.41
  gives every worker paid public holidays): `computePayslip` adds `t.holiday` to a daily employee's
  worked days and `t.holiday × 8` to an hourly employee's paid hours, like paid leave; monthly pay does
  not move. Before it, a daily-wage employee's paid leave over a holiday paid a day less. So
  `zeroHourStatus()` returns Off, not Holiday, for a zero-hour shift named like nothing — only a
  "holiday" name may create a paid day. The Labor Forecast's actual cost still prices a holiday row
  at 0 hours — deliberately: it costs hours worked on the floor, and paid leave reads 0 there too. A days-only UPDATE does not fire the trigger; a request
  decided before a holiday was added keeps the count it was decided on.
- **`request_shift_swap` refuses a past day, an unpublished day, and a shift already in an open swap**
  (`swap_day_past` / `swap_day_unpublished` / `swap_already_requested`); the Staff app's picker hides
  past days.
- Generate from Roster and the Roster board's assign-over-leave ask through `ConfirmModal`, naming
  what will be written.

## Payroll, Calculation, Festival, Incentives, Advances and TADA (S751)

Sixteen decisions taken with Aashish (2026-09-14). Migration `20260914210000`; engine tests in
`payrollS751.test.js`. Several rules ABOVE are superseded here — read this section as the current one.

- **One builder for both payroll pages: `buildPayrollRows()` in `payrollData.js`.** Payroll Run's
  `buildRows` and Calculation's `rows` were two copies held together by "must stay identical"
  comments. Order of the money: `computePayslip` → TDS (capped at what is left) → advance cut
  (capped at what is left after TDS — decision: take-home never below zero, the rest stays owed and
  later cuts take it; there are no arrears, so a shortfall lengthens the loan) → TADA on top.
  `computePayslip` itself cuts a fixed deduction (CIT) before take-home goes negative, and
  `retirement_contribution` follows the cut so tax relief follows the money.
- **Who a month's payroll covers is `fetchPayrollEmployees()`**, not `status IN (active, probation)`:
  active/probation OR `end_date` on/after the month start (a leaver is paid to their last day
  whatever their status), filtered by `employedInPeriod` (no payslip for a month not worked at all —
  a future hire used to get a zero-gross payslip with a negative net), minus anyone whose FINALIZED
  Final Settlement's `last_working_date` is inside the month (the settlement paid that month; a
  draft payslip for them used to be finalized on top). This supersedes S600's "departed" bucket being
  non-blocking: a stored payslip for someone NOT on the list must not be finalized.
- **A TADA claim is paid by exactly one payroll: `status = 'approved' AND end_date <= month end`.**
  The S565 rule above (approved OR paid-by-payroll, overlapping the month) paid a cross-month trip in
  both months. There is no paid half any more, because the Calculation page shows a finalized month as
  STORED (next bullet), so nothing compares live TADA against a locked month. The TADA amount on a
  payslip is not editable — it always equals its claims; change the claim instead.
- **Calculation shows a finalized month as it was paid**, never recomputed against today's salaries —
  every raise used to turn every past month red "Stale".
- **`payslipDrift` calls a TDS difference an override only when `hr_payslips.tds_overridden` is true**
  (set by the TDS box). This supersedes S620's "a TDS difference is an override": prior months
  finalized late, an insurance premium or a bonus all move TDS without anyone typing.
- **Bonus tax lives in `bonusTax.js`** (Festival Allowance and Incentives), and four things are
  load-bearing: the pay month (`bs_month` on both tables) decides the fiscal year; the months left are
  projected at basic + earning components (`projectedMonthlyGross`), for the employed months only;
  every OTHER finalized bonus that fiscal year raises the base (`otherBonusesForFy`, keyed by
  `runKey`); and YTD gross includes overtime. **`fetchYtdMap` adds finalized bonuses from earlier FY
  months to `gross` and `withheld` but not `count`**, so monthly TDS and Final Settlement's lump-sum
  base both know about them. A new bonus-like table must join `fetchFinalizedBonuses` or it is taxed
  as though it were never paid.
- **A bonus counts only the bonuses paid BEFORE it** (`otherBonusesForFy(rows, fyStart, runKey, pay)`,
  by fiscal-year month, then run key within a month). Counting every other finalized bonus made the tax
  depend on finalize order. And **monthly TDS treats bonus tax as settled at source**
  (`ytdBonusWithheld`): the year's tax minus bonus tax is what gets spread, or the months after a bonus
  withhold nothing. Festival/bonus Finalize re-checks each draft's stored tax against a fresh figure.
- **Festival months of service are completed BS months to the festival date** (`completedServiceMonths`,
  decision: keep the share for months worked). Several festival runs a year are allowed, with a warning.
  Daily/hourly rows are typed by hand and Finalize is blocked while any is 0.
- **Rank is a database fence on every money table** — manager for runs, payslips, components,
  settlements, advances, repayments, festival, incentives, incentive types; supervisor for TADA
  claims. **A refused RLS UPDATE returns 0 rows and no error**, so a status write that matters selects
  `id` and checks the count.
- **Locked by trigger, not by the page:** payslips of a finalized run (`hr_run_finalized`); a finalized
  run's delete; festival/incentive rows once finalized, where Reopen (status → draft, nothing else
  changed) is the only allowed update (`bonus_finalized`) — a Generate from a stale tab used to upsert
  a paid run back to draft; a period with finalized payroll (`period_has_finalized_payroll`), and a
  period delete needs admin/Owner (IMS and POS PIN logins could delete one over REST, cascading payroll).
  The operator (`is_admin()`) passes these guards so an Export/Import restore can write history.
- **Advances:** a repayment may not exceed what is owed or land on a non-active advance; an AFTER
  trigger keeps `status` in step with the balance (repaid → settled, a repayment removed → active);
  Settle is refused while owed; forgiving money is `status = 'written_off'` with a required reason, and
  the amount/who/when are stamped server-side; an advance with repayments cannot be deleted. Payroll
  and Final Settlement's own status writes still run and are now redundant-but-harmless.
- **TADA ladder, by trigger:** pending → approved/rejected (never your own claim — matched on
  `profiles.hr_employee_id` or the employee record's email; `approved_by` set server-side), approved →
  paid needs a manager and a method, paid(Payroll) → approved only for a payroll Reopen; a decided
  claim's employee, dates and total are frozen. Manager-entered claims go through `create_tada_claim`
  (one transaction); `submit_my_tada_claim` refuses an identical claim twice, NaN and reversed dates.
  **numeric accepts `'NaN'` and `NaN > 0` is true** — a CHECK needs `<> 'NaN'` spelled out.

## Final Settlement, Gratuity, HR Reports and HR Staff (S752)

Twelve decisions taken with Aashish (2026-09-14). Migration `20260914230000`; tests in
`settlementCompute.test.js` and `gratuityCompute.test.js`.

- **A leaver's final month is paid INSIDE the settlement, through the payroll engine.**
  `computeSettlement()` (`settlement/settlementCompute.js`) calls `computePayslip` with `end_date` =
  last working day and attendance/OT cut at that `bs_day`, then `computeFinalMonthTds()` (`tds.js`),
  which trues the year up to actual income. Every figure is stored (`month_*`, `calc_version = 2`)
  and **a finalized row is rendered from what it stored, never recomputed** — `statementOf(row)` is
  the one renderer. SSF challan, TDS Report and TDS Certificate read settlements; a new filing sheet
  must too, or a leaver's last month vanishes from it.
- **Finalize and Reopen are database functions, not browser sequences.** `finalize_final_settlement`
  re-reads outstanding advances, the approved TADA id set, finalized payslips for the month or later
  and an overlapping finalized settlement, and refuses (`settlement_stale*`, `settlement_month_paid`,
  `settlement_overlap`) before writing any ledger. `reopen_final_settlement` needs a reason and puts
  back only what its own `final_settlement_id` rows name. **Both take `hr_pay_lock(client)`, and so
  does payroll Finalize** (`hr_payroll_runs_guard_settled`) — two checks in two transactions paid
  Shrawan 2083 twice, 22 seconds apart. A new path that finalizes pay for a month takes the same lock.
- **`hr_final_settlements_guard`**: insert as draft only; a draft cannot become finalized by UPDATE; a
  finalized row cannot be deleted or edited, only marked paid once (`paid_amount := net_payout`).
  One finalized settlement per spell is a unique index.
- **Notice is basic ÷ 30 per calendar day, and its direction follows the reason** (`noticeDirection`):
  resignation deducts (`notice_deduction`), termination adds (`notice_pay`, taxed with the lump sum),
  mutual/retirement none. Leave encashment is EARNED to date (`earnedLeaveBalance`: quota × completed
  months this BS year ÷ 12 − taken − encashed), still ÷26. TADA: every approved unpaid claim.
- **Gratuity counts COMPLETED months** (`completedMonths`, BS anniversary walk, day clamped) and the
  SSF offset is **stored employer SSF × `SSF_GRATUITY_SHARE_OF_EMPLOYER`** (`fetchSsfContributions` /
  `ssfFundedFor`), never a start date × a rate. `calcGratuity` takes `ssfFunded = {amount, months} |
  null`; null is unknown coverage, and unknown is no offset.
- **Nobody below the Owner decides their own record**: `hr_leave_requests_guard_decision` (stamps
  `decided_by`), `hr_overtime_guard_own`, `hr_advances_guard_own` refuse `hr_own_request`;
  `hr_self_decision_exempt()` is admin OR Owner. A new approval queue gets the same trigger.
- **HR-role logins read `monthly_periods`.** The S430 `no_hr_role_staff` FOR ALL policy made every
  months join empty for them, so three settlement gates passed vacuously; it is per-command write
  policies now. **When a check reads a table an HR login cannot see, it is not a check for that login.**
- **Staff rank (all three modules):** no rankless staff login (admin-user-ops refuses, pages have no
  "No Access"); HR Manager is granted by Owner/admin only; the staff role lists in `settings` are
  Owner-or-that-module's-manager (`settings_guard_staff_roles`); **no page re-ranks on load** — a
  mismatch is a banner and a confirmed Apply. `pos_email` joins every negative Owner test.
- `RESTORE_ORDER` restores `hr_advance_repayments`/`hr_tada_claims` AFTER the payroll runs and
  settlements they reference; Danger Zone deletes repayments before runs (their FK is NO ACTION).

## The S751/S752 open list (S753)

Decisions taken with Aashish (2026-09-14). Migration `20260915090000`.

- **Payroll Finalize and Reopen are database functions** (`finalize_payroll_run(run, payslip_ids,
  repayments)` / `reopen_payroll_run(run)`), one transaction each under `hr_pay_lock`. The page still
  re-reads and runs `assessDraft` + `allocateAdvanceRepayments` (the JS engine owns the arithmetic);
  the function refuses unless the stored payslip ids are exactly the ones checked, re-validates the
  allocation (sums per payslip, advance active and owed), and writes every ledger or none. This
  supersedes S682's per-ledger failure messages and S751's post-flip payslip recount.
- **A repayment tagged `payroll_run_id` or `final_settlement_id` is written only by those functions**
  (`hr_advance_repayments_guard_ledger`; admin passes for a restore). Advances & Loans deletes Manual
  rows only, and the database now agrees.
- **A leaver's staff logins are BLOCKED at settlement Finalize, never deleted** (decided): every
  `profiles` FK from bills, KOTs, shifts and cash movements is `ON DELETE SET NULL`, so deleting a
  waiter's login blanks their name on every bill they closed. Finalize bans the auth user, revokes
  its sessions, stamps `profiles.settlement_blocked_by` and lists names in `blocked_logins`; Reopen
  unbans exactly its own. Only logins linked through `hr_employee_id` are found.
  `settlement_linked_logins(employee)` names them for the confirm. Nobody below the Owner finalizes
  or reopens their own settlement.
- **`access_blocked` ends Self-Service access** — sessions revoked by trigger, and the fourteen
  Staff-app RPCs call `hr_self_service_assert_active()` first (patched from their LIVE bodies inside
  the migration). **A new Staff-app RPC must call it too**, or a blocked employee keeps using it for
  the life of their access token.
- **Payslips and settlements store `life_insurance_premium` / `health_insurance_premium`**; the TDS
  certificate reads the latest stored pair of the year and falls back to the employee record (saying
  so) only for years paid before S753.
- **A typed or kept bonus tax is `tds_overridden`** on `hr_festival_allowances` / `hr_incentives`;
  every automatic tax write clears it.
- **Cost to Business = `payrollCashCost()`**: earned pay (gross − absence + OT) + employer SSF; travel
  claims shown apart.
- **Still with the accountant, deliberately unchanged:** leave encashment ÷26, the 12-month gratuity
  rule, and taxing exit lump sums on top of the year at slab rates.

## The HR critique fixes (S768)

Decided with Aashish (2026-09-17). No migration. Several sections above name `PayrollCalculation.jsx`,
which no longer exists — read them as history.

- **Attendance saves every unsaved cell, not the day on screen.** Unsaved work is `records` compared
  with `savedRecords` by `cellSignature()` (`attendanceRules.js`) — what a cell SAVES as, so a typed
  "0800" and a stored "08:00:00" are one cell. One `saveChanges()` upserts all of them from either
  tab. **Every reload after a write passes `{ carry: true }`** and names what it deleted with `drop`,
  or the reload replaces the grid and throws away marks left on other days — which is exactly the
  S768 defect (a blank day pays daily and hourly staff nothing). A period switch passes neither, and
  asks first when there is unsaved work. `clearCell` removes the key from the saved copy on success,
  or re-marking that day compares equal to a deleted row and never saves.
- **A correct payroll figure takes the ink; the sign carries direction.** Registers, the working
  panel, Festival/Incentive runs, Final Settlement, Gratuity, Pay Setup's preview and `PayslipBody`.
  Colour is for flags only (SSF no. missing, no bank, out of date, split month, owed by the employee —
  amber with △). `RunStatusBadge` is the one Draft (amber) / Finalized (green) chip. A resigned or
  terminated employee is grey, not red.
- **The Calculation page is Payroll's expandable row.** `/hr/calculation` redirects to `/hr/payroll`;
  the panels live in `PayslipCalculation.jsx` (`CalcDetail` for a draft, from `buildPayrollRows`'
  `detail`; `StoredDetail` for a finalized month, never recomputed). A drifted draft's working opens
  with what moved (`driftParts`), because the live working then disagrees with the stored row above
  it on purpose.
- **Where a month stands is `PayrollMonthStatus`** (`monthStatus.js` for the arithmetic): unmarked
  days for daily/hourly staff only, approvals touching the month, the run, and the SSF deposit. It
  never calls a passed deposit date missed — deposits are not recorded. On the HR Dashboard it is
  MANAGER-only: runs and payslips are manager-rank, so a supervisor's empty read would say "not
  generated" over a finalized month. HR Reports opens on `?tab=` and `?period=`.
- **One approval control for Leave, Overtime, TADA and Shift Swaps** (`src/modules/hr/ApprovalControls.jsx`).
  A batch runs each row's OWN decision one after another (`decideEach`) and names every refusal; it
  never writes a set in one statement, because a trigger refusing one row (self-approval) would fail
  them all. Leave's batch leaves out a request over quota or in a finalized month, and checks quota
  as if the batch's earlier requests were already approved — `approveCore()` is the approval without
  the page's busy flag, message or reload. Approve and Reject are both neutral small ghosts: green and
  red on a button spend verdict colours on a decision not yet made.
- **Final Settlement sits in the Payroll nav group** — it finalizes a leaver's pay. Gratuity stays in
  Reports.
