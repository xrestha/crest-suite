---
paths:
  - "src/modules/hr/**"
---

# HR: payroll engine, payroll run, tax, settlement, attendance, leave, roster

Rule statements only, grouped by topic (S799). Every `History:` anchor is a heading in
`docs/rules-archive/hr-payroll.md`, where the original sections sit word for word with the story
behind each rule. Read it before reversing a rule. Where a later session superseded an earlier
rule, the bullet states what holds now; the archive keeps both.

## The engine: `computePayslip` and what it must be given

- `src/modules/hr/payroll/payrollCompute.js` is pure: no React, no Supabase. Pay bases `monthly`,
  `daily`, `hourly`. Constants live in `src/modules/hr/payrollConstants.js`: SSF 11% employee / 20%
  employer, SSF cap NPR 100,000 basic, OT 1.5×.
- **Every query feeding `computePayslip()` selects `join_date` and `end_date`**; payroll reads them
  through `fetchPayrollEmployees()` (`PAYROLL_EMPLOYEE_COLUMNS`). `daysNotYetJoined()` (S482) and
  `daysAfterExit()` (S600) return day numbers (S791); for monthly staff those days fold into
  `unpaidDays`, which also shrinks the SSF base (basic × the paid fraction) and TDS
  (`gross − absence_deduction`). Never write `absent` rows for days after exit: `absent_days` is a
  reported figure.
- **A day outside the employment is docked once** (S791): a MONTHLY employee's attendance rows on
  those days are dropped. Daily and hourly staff keep every row.
- **SSF needs the flag AND a number.** `isSsfContributor(employee)` (`payrollCompute.js`) is the one
  `ssf_enrolled && ssf_no` test (S570, S747); `computePayslip` and `buildPayrollRows` call it, and
  `PaySetup.jsx` / `PayForm.jsx` previews use it (S748). The copies still inline must agree with it;
  move them to the helper when touched: `laborForecast.js` (agrees), `PayslipBody.jsx` (does not trim
  `ssf_no`, so a whitespace number prints an SSF line; display only), and the "flag set, number
  missing" tests in `PayrollApprovalSheet.jsx` and `PayrollRun.jsx` (agree). Payroll Run flags the
  state as `⚠ SSF no. missing`.
- **Approved overtime supersedes sheet OT, per day** (S570).
  `tallyAttendance(rows, supersededOtDays)` withholds sheet OT on any `bs_day` an approved entry
  covers and reports `sumOtSuperseded`. The OT query must select `bs_day`. Holiday 2× is reachable
  only through the Overtime module.
- **OT sits INSIDE `hours_worked`** wherever it is written (S742). The hourly branch pays ordinary
  wage on `hours_worked − OT` (superseded OT included); `computeActualLabor` and
  `computePlannedLaborCost` price the OT part at basic × 1.5. `tallyAttendance` adds `ot_hours` from
  every row whatever its status.
- **A half-day leave row is a day whose other half was worked**, on every basis (S798 1a). Daily: a
  paid half pays the day, an unpaid half pays 0.5 (`workedDays`). Monthly: a paid half docks 0, an
  unpaid half 0.5. Hourly: typed hours plus 4 h for a paid half. `present_days` counts either as 0.5.
- **A `holiday` row PAYS daily and hourly staff** (Labour Act s.41, decided 2026-09-14):
  `t.holiday` adds to a daily employee's worked days and `t.holiday × 8` to hourly paid hours, like
  paid leave. Monthly pay does not move.
- `computePayslip` cuts a fixed deduction (CIT) before take-home goes negative, and
  `retirement_contribution` follows the cut so tax relief follows the money.
- **The payslip's absence line prints `hr_payslips.unpaid_days`** (absences + unpaid leave + half
  days + pre-join days, migration `20260818120000`). `absent_days` stays literal absences, which
  Payroll Run's Excel export heads "Absent Days". Older payslips have no value and print no count.
- **Every taxable-income sum over payslips is `earnedPay()`** (gross − `absence_deduction` + OT), in
  `fetchYtdMap` and `payslipYtdForFy` (S781). A query feeding either selects `absence_deduction`;
  `earnedPay` throws without it.

Why: the engine pays only what it is handed. A column left out of the query pays a full month,
and a tally line read twice pays the same hours twice.

History: #s570-engine-inputs, #s600-leaver-proration-and-departed-bucket, #s742-normal-hours,
#s747-advances-and-ssf-predicate, #s749-roster-attendance-leave-overtime, #s751-payroll-decisions,
#s781-ytd-earned-pay (and `docs/CROSS-REPO.md`, Closed, 2026-09-17), #s791-hss-ports, #s798-stage-1a

## Income tax, retirement relief and bonus tax

- `src/modules/hr/payroll/tds.js`: TDS by year-to-date cumulative projection; `computeMonthlyTds`
  spreads the year's tax over the months actually left. FY 2083/84 slabs apply from Shrawan 2083. SSF
  contributors have the 1% first slab waived.
- **CIT / provident fund is retirement relief, in ONE cap with SSF** (S748). A deduction component
  marked `retirement_fund` comes off take-home AND taxable income.
  `retirementRelief(annualContributions, annualGross)` in `tds.js` is the only cap (lower of NPR
  5,00,000 or a third of income); `retirementContributionOf()` in `payrollCompute.js` is the only sum.
  The payslip stores `retirement_contribution` (so `fetchYtdMap` relieves real prior months), and it
  is a `FRESHNESS_INPUT_FIELDS` member. Monthly TDS, Final Settlement and, since S750, Festival
  Allowance and Incentive Run use it; the bonus pages share `projectBonusTaxableBase()` in `tds.js`.
  A marker, never a name match.
- **Bonus tax lives in `bonusTax.js`** (Festival Allowance, Incentives). The pay month (`bs_month` on
  both tables) decides the fiscal year. The months left are projected at basic + earning components
  (`projectedMonthlyGross`), for the current employment's unpaid months only (`monthsStillToPay`,
  S798 2b). YTD gross includes overtime.
- **A bonus counts only what was paid BEFORE it:** other finalized bonuses by fiscal-year month,
  then run key within a month (`otherBonusesForFy(rows, fyStart, runKey, pay)`), and only a
  settlement from before its pay month. `fetchYtdMap` adds earlier-FY finalized bonuses to `gross`
  and `withheld`, not `count`. A new bonus-like table must join `fetchFinalizedBonuses`, or it is
  taxed as though never paid.
- **Monthly TDS treats bonus tax as settled at source** (`ytdBonusWithheld`): the year's tax minus
  bonus tax is what gets spread. Festival/bonus Finalize re-checks each draft's stored tax against a
  fresh figure.
- **A typed or kept tax is `tds_overridden`**: on `hr_festival_allowances` / `hr_incentives`, every
  automatic tax write clears it; `hr_payslips.tds_overridden` is set by the TDS box, and
  `payslipDrift` calls a TDS difference an override only when it is true (S751).
- **A finalized settlement from an earlier FY month is year-to-date income**
  (`fetchFinalizedSettlements`, S798 2b): `partial_salary` and the month SSF/CIT/tax as a paid month,
  the lump sums and `lump_tds` in the bonus fields. A settlement counts a bonus paid in its own month
  (`includeSameMonthBonuses`, Final Settlement only); never both ways.
- Payslips and settlements store `life_insurance_premium` / `health_insurance_premium`. The TDS
  certificate reads the year's latest stored pair, and falls back to the employee record (saying so)
  only for years paid before S753.
- **Festival months of service are completed BS months to the festival date**
  (`completedServiceMonths`; the share is kept for months worked). Several festival runs a year are
  allowed, with a warning. Daily/hourly rows are typed by hand, and Finalize is blocked while any is 0.
- **A month's SSF and tax to deposit is `monthDeposit`** (payslips + that month's finalized
  settlements + its finalized bonus tax). A failed read of the extras shows no figure, never the
  payroll-only one.
- **SSF is deposited by the 25th of the following month.** Read `SSF_DEPOSIT_DAY`; never hard-code
  the day in copy.
- Still with the accountant, deliberately unchanged: leave encashment ÷26, the 12-month gratuity
  rule, and taxing exit lump sums on top of the year at slab rates.

Why: the tax is a projection over the whole year, so any paid amount it does not see is withheld
wrongly in every month after it.

History: #s748-employees-pay-setup-holiday-calendar, #s751-payroll-decisions, #s753-open-list,
#s798-stage-2b

## Payroll Run: one builder, who is paid, and when a draft is stale

- **`buildPayrollRows()` in `payrollData.js` is the one builder**, used by Payroll Run
  (`PayrollRun.jsx`) and its expandable working. Order of the money:
  `computePayslip` → TDS (capped at what is left) → advance cut (capped at what is left after TDS;
  take-home never below zero; the rest stays owed and later cuts take it; there are no arrears) →
  TADA on top.
- **Who a month covers is `fetchPayrollEmployees()`**, not a status filter: active/probation OR
  `end_date` on/after the month start, filtered by `employedInPeriod`, minus anyone settled in the
  current employment from the month of `last_working_date` (`hr_run_settled_employee_names`). A join
  date after the settled last day is a rehire and is paid. Never key this on `settle_bs_*`. A stored
  payslip for someone NOT on the list must not be finalized.
- **Payroll Run refuses to finalize a stale draft.** It recomputes live through `buildPayrollRows` on
  every load and compares each employee with `payslipDrift(stored, live)` (`payrollData.js`), the one
  comparison: `'moved' | 'overridden' | null`. It compares inputs, never `net_pay`: the
  `FRESHNESS_INPUT_FIELDS` nobody can type into, the TADA claim id set and amount, and a net that is
  not its own parts (`payslipNetGap`) is `'moved'`. An override is reported, never blocking: the
  page names it ("typed by hand — locked as entered") and the TDS cell offers ↺ back to the
  calculated figure. Never write a second copy of the comparison.
- Finalize's confirm is a consequence summary: payslip count, total net pay, advance recoveries,
  TADA claims to be closed.
- **Net pay is its own parts:** gross + OT − absence − SSF − other − advance − TDS + TADA, within
  0.01. `payslipNetGap` (JS), `hr_payslips_guard_net` and `finalize_payroll_run` hold three copies; a
  new payslip column that moves money changes all three (S798 2b).
- **The Calculation page is Payroll's expandable row** (S768). `/hr/calculation` redirects to
  `/hr/payroll`. `PayslipCalculation.jsx` holds `CalcDetail` (a draft, from `buildPayrollRows`'
  `detail`) and `StoredDetail` (a finalized month as it was paid, never recomputed). A drifted draft's
  working opens with what moved (`driftParts`). `PayrollCalculation.jsx` no longer exists; archive
  sections that name it are history.
- **Page every read that is narrowed in JS rather than in the query** (S620): `fetchYtdMap` and the
  lifetime advance and repayment ledgers, where a truncated repayments side over-deducts, because
  `buildAdvanceMap` derives outstanding as `amount − repaid`. Use a unique tiebreaker:
  `.order('issued_date')` is not unique, so append `.order('id')`. `fetchApprovedTadaMap` filters in
  the query since S751 and is still paged.
- **An empty map is a real value** (S620; no prior payslips is the fiscal year's first month), so the
  `payrollData.js` helpers return `{ data, error }` and compose with `firstError()`. `generate()` and
  `regenerate()` persist TDS from these maps, so the check runs before `regenerate()`'s DELETE.
- **Before adding a fetch helper to `payrollData.js`, ask what Finalize does to the rows it reads.**
  If Finalize changes them, a live recompute of a locked month reads the post-finalize state.
- **Where a month stands is `PayrollMonthStatus`** (`monthStatus.js` for the arithmetic): unmarked
  days for daily/hourly staff only, approvals touching the month, the run, staff paid (S782), the SSF
  deposit. It never calls a passed deposit date missed (deposits are not recorded). On the HR
  Dashboard it is MANAGER-only because its steps link to manager pages, not because a supervisor's
  read would be empty (it is not; REPORTS-10). Its month is last month until that payroll is
  finalized, then the running month (H32), never a search back. HR Reports opens on `?tab=` and `?period=`.
- **Cost to Business is `payrollCashCost()`**: earned pay (gross − absence + OT) + employer SSF, with
  travel claims shown apart.

Why: a draft is a snapshot from Generate time, and every one of these failures produced a complete,
confident payroll with nothing raised.

History: #s570-stale-draft-and-fetch-helpers, #s600-leaver-proration-and-departed-bucket,
#s620-payroll-data-path, #s751-payroll-decisions, #s753-open-list, #s768-critique-fixes,
#s791-hss-ports, #s798-stage-2b

## Finalize, Reopen and the database locks

- **Payroll Finalize and Reopen are database functions**, one transaction each under `hr_pay_lock`:
  `finalize_payroll_run(run, payslip_ids, repayments)` / `reopen_payroll_run(run)` (S753). The page
  re-reads and runs `assessDraft` + `allocateAdvanceRepayments`, because the JS engine owns the
  arithmetic. The function refuses unless the stored payslip ids are exactly the ones checked,
  re-validates the allocation, and writes every ledger or none.
- **Every path that finalizes pay for a month takes `hr_pay_lock(client)`**: payroll Finalize
  (through `hr_payroll_runs_guard_settled`), both settlement functions and the salary-payment
  functions. Two checks in two transactions paid one month twice.
- **A run starts as a draft and stays in its month** (`hr_payroll_runs_guard_settled`, BEFORE INSERT
  OR UPDATE): no client write sets `finalized`/`finalized_at` or moves `period_id`
  (`payroll_period_fixed`), and status crosses `finalized` only through Finalize/Reopen
  (`payroll_status_direct`).
- **Locked by trigger, not by the page:** payslips of a finalized run (`hr_run_finalized`); a
  finalized run's delete; festival/incentive rows once finalized, where the only update allowed is
  Reopen to draft (`bonus_finalized`; the guard freezes `amount`, `tds`, `employee_id`, `bs_year` and
  `bs_month`, so other columns such as `tds_overridden` or the note can change with it); a period
  with finalized payroll (`period_has_finalized_payroll`); and a period delete needs admin or Owner.
- **The operator (`is_admin()`) passes the payslip, run-delete and bonus guards** so an
  Export/Import restore can write history. `period_has_finalized_payroll` refuses the operator too
  (restore deletes only an empty seed period). A guard's own stamp must sit above that seam, never
  behind it (the 20260914220000 lesson).
- **Reopen refuses over a write-off:** an advance the run recovered from that is now `written_off`
  blocks `reopen_payroll_run` (`payroll_reopen_written_off`) until Advances & Loans → Reactivate. The
  page refuses first (`writtenOffAdvancesForRun`).
- **Reopen rank:** Payroll Run, Festival Allowance and Incentive Run gate Reopen on
  `hasHrAccess('manager')` (S620), never `isAdmin`: that is the Crest operator, the tenant's owner is
  `isOwner`, and both resolve `hrRole` to `'manager'`. Final Settlement's Reopen is Owner or HR
  manager, in the database, with a reason (S752).
- **A check that could not run has not passed** (S613). A gate that reads data to decide (a refusal
  check, a freshness check, Reopen's read of its own tagged rows) refuses on a failed read and names
  the failure, and aborts before it touches anything.

Why: a browser sequence of writes can stop half-way, and a page check is skipped by any caller that
goes straight to REST.

History: #s613-finalize-gates, #s620-reopen-rank, #s682-finalize-and-reopen-pointer,
#s751-payroll-decisions, #s752-settlement-decisions, #s753-open-list, #s791-hss-ports,
#s798-stage-2a, #s798-stage-2b

## Salary payments: finalizing pays nobody (S782)

- **A payment is its own row (`hr_salary_payments`), keyed by run + employee**, never a payslip
  column: Reopen stays allowed after payment, and Regenerate deletes and re-inserts payslips.
  `paymentState()` names the difference: still to pay, or overpaid. Helpers: `salaryPayments.js`.
- **Written only by `record_salary_payments` / `void_salary_payment`** (DEFINER, HR manager or Owner,
  under `hr_pay_lock`; migration `20260923100000`). `hr_salary_payments_guard` refuses direct writes,
  operator exempt for restore. The amount is never a parameter: Mark paid records net pay less active
  payments, and refuses someone already paid rather than skipping them. Undo is a void with a
  required reason, never a delete.
- **A failed payments read is its own state** ("not checked", Mark paid hidden), never "not paid",
  and it does not take the register down. The Staff app swallows its read and shows nothing.
- **`runPaymentSummary()` walks payslips AND payments** (S788). Someone paid and then regenerated out
  of the month counts in `over` and `paidTotal` (not `owed`/`paid`), is listed in `noPayslip`, and
  gets their own row on Payroll Run so the Undo stays reachable.

Why: a paid mark on a payslip would be wiped by the next Regenerate.

History: #s782-salary-payments

## Advances and TADA

- **An advance is first deducted in the BS month after the month it was issued** (day irrelevant;
  Chaitra → Baisakh next year), the rule hss-suite runs. `firstRecoveryMonth` / `advanceDueIn` /
  `dueAdvances` (`payrollData.js`) are the one filter every per-period reader uses, and
  `buildAdvanceMap(advances, repayments, period)` throws without a period. Final Settlement does not
  use it: a leaver repays everything outstanding.
- **Advances are whole paisa end to end** (`toPaisa` / `roundPaisa` in `payrollCompute.js`;
  `buildAdvanceMap`, `recoverableAdvance`, `allocateAdvanceRepayments` in `payrollData.js`). An
  advance settles only at EXACT coverage, in JS and in the status trigger, with no 0.01 slack. Print
  through `nprPaisa()`. Never compare an advance figure with `Math.round`.
- **By trigger:** a repayment may not exceed what is owed or land on a non-active advance; the AFTER
  trigger `hr_advance_repayments_sync_status` keeps `status` in step with the balance (repaid →
  settled, a repayment removed → active), and no payroll or settlement function writes advance
  status (only Advances & Loans' own Settle, Write-off and Reactivate do);
  Settle is refused while owed; forgiving is `status = 'written_off'` with a required reason, and the
  amount, who and when are stamped server-side; an advance with repayments cannot be deleted.
- **A repayment tagged `payroll_run_id` or `final_settlement_id` is written only by the
  finalize/reopen functions** (`hr_advance_repayments_guard_ledger`; admin passes for a restore).
  `hr_advance_repayments.final_settlement_id` is the mirror of `payroll_run_id` (S600).
  Advances & Loans deletes Manual rows only. A Reopen reactivates only the advances read off its own
  tagged rows.
- **`hr_tada_claims` has no `bs_year`, `bs_month` or `period_id`.** It is keyed on AD `start_date` /
  `end_date`: convert the BS period to an AD range, and bucket by month client-side through
  `adToBs(start_date)` (TADA Claims' month filter, S564).
- **A TADA claim is paid by exactly one payroll:** `status = 'approved' AND end_date <= month end`
  (S751; supersedes S565's approved-or-paid overlap). The TADA amount on a payslip always equals its
  claims and is not editable; change the claim instead.
- **TADA ladder, by trigger:** pending → approved/rejected (never your own claim, matched on
  `profiles.hr_employee_id` or the employee record's email; `approved_by` set server-side); approved →
  paid needs a manager and a method; paid → approved only inside `reopen_payroll_run` /
  `reopen_final_settlement` (S798); a decided claim's employee, dates and total are frozen.
  Manager-entered claims go through `create_tada_claim` (one transaction); `submit_my_tada_claim`
  refuses an identical claim twice, NaN, and reversed dates.
- **`numeric` accepts `'NaN'`, and `NaN > 0` is true**, so a CHECK spells out `<> 'NaN'`.

Why: an advance or claim lives in its own ledger, and every rule here keeps the ledger and the
payslip from disagreeing about money already moved.

History: #tada-has-no-period, #s600-final-settlement-writes, #s620-payroll-data-path,
#s747-advances-and-ssf-predicate, #s751-payroll-decisions, #s753-open-list, #s791-hss-ports

## Final Settlement and gratuity

- **A leaver's final month is paid INSIDE the settlement, through the engine.** Final Settlement
  (`/hr/settlement`, `FinalSettlement.jsx`) records `hr_final_settlements` (S600); `computeSettlement()`
  (`settlement/settlementCompute.js`) calls `computePayslip` with `end_date` = last working day and
  attendance/OT cut at that `bs_day`, then `computeFinalMonthTds()` (`tds.js`) trues the year up.
  Every figure is stored (`month_*`, `calc_version = 2`).
- **A finalized row is rendered from what it stored, never recomputed**: `statementOf(row)` is the
  one renderer. Identity and rate constants are frozen on the row (name, code, basic, join date,
  `SSF_CAP`, the gratuity share, the vesting months, the ÷26 divisor), as on the Monthly Owner Report.
  SSF challan, TDS Report and TDS Certificate read settlements; a new filing sheet must too.
- **`hr_final_settlements_guard`:** insert as draft only; a draft cannot become finalized by UPDATE;
  a finalized row cannot be deleted or edited, only marked paid once (`paid_amount := net_payout`).
  A paid mark always stores `paid_amount`, the operator's too. One finalized settlement per spell is
  a unique index.
- **`finalize_final_settlement` re-checks before writing any ledger** and refuses on: outstanding
  advances, the approved TADA id set and finalized payslips for the month or later
  (`settlement_stale*`, `settlement_month_paid`); an overlapping finalized settlement
  (`settlement_overlap`); a live salary payment for the last month or later (`settlement_salary_paid`,
  refused, never netted off); overtime not on file (`settlement_stale_ot`, `hr_ot_on_file`: approved
  entries supersede the sheet per day, hours exact, rupees within 2); and the final month's attendance
  (`settlement_stale_attendance`, tallied by `hr_attendance_on_file` the way `computePayslip` does).
  **A change to the engine's tally (a new status, a new weight) changes `hr_attendance_on_file` and
  this check in the same commit.** The confirm re-reads the sheet (`attendanceSignature`).
- **`reopen_final_settlement` needs a reason** and puts back only what its own `final_settlement_id`
  rows name. Nobody below the Owner finalizes or reopens their own settlement.
- **Recovery is capped at the payout.** A settlement that nets negative leaves those advances
  `active`; there is no receivable ledger.
- **Notice is basic ÷ 30 per calendar day, and its direction follows the reason**
  (`noticeDirection`): resignation deducts (`notice_deduction`), termination adds (`notice_pay`, taxed
  with the lump sum), mutual and retirement none. Leave encashment is EARNED to date
  (`earnedLeaveBalance`: quota × completed months this BS year ÷ 12 − taken − encashed), ÷26. TADA:
  every approved unpaid claim.
- **Leave taken and leave encashed are windowed to the current employment**
  (`leaveUsed({ from, until })`, `leaveEncashed({ from })`). The Balances tab calls them without a
  window.
- **The year's salary tax still owed is capped at what the taxable payout bears:** month income +
  lump sums − SSF − other deductions − notice − lump TDS. Travel claims never bear tax.
- **The festival is paid once a fiscal year, by the run or the settlement**, enforced both ways under
  `hr_pay_lock`: `settlement_festival_paid` in Finalize, `festival_paid_by_settlement` in
  `hr_bonus_rows_guard` (through the DEFINER `hr_festival_settled_by`, current employment only). A
  saved draft that paid a share is unticked when a festival run was finalized since, and says so.
- **An earlier employment's settlement is never recomputed, reopened or finalized** (H26,
  `settlement_rehired`; `isEarlierSpell`). The page renders it from its stored columns, and
  `pickEmployee` never auto-opens it. A correction to it is paid by hand.
- **Rehire:** Employees refuses Active/Probation for a settled leaver until the join date moves past
  the settled last day (`rehireNeedsNewJoinDate`). A rehire clears the old End Date in the same save
  and says so first (H27, `staleRehireEndDate`); an End Date before the Join Date is refused
  (`endsBeforeJoining`).
- **A leaver's staff logins are BLOCKED at Finalize, never deleted**: every `profiles` FK from bills,
  KOTs, shifts and cash movements is `ON DELETE SET NULL`. Finalize bans the auth user, revokes its
  sessions, stamps `profiles.settlement_blocked_by` and lists the names in `blocked_logins`; Reopen
  unbans exactly its own. Only logins linked through `hr_employee_id` are found;
  `settlement_linked_logins(employee)` names them for the confirm.
- **`access_blocked` ends Self-Service access:** sessions are revoked by trigger, and the Staff-app
  RPCs call `hr_self_service_assert_active()` first. **A new Staff-app RPC must call it too**, or a
  blocked employee keeps using it for the life of their access token.
- **Gratuity lives in `src/modules/hr/gratuity/gratuityCompute.js`**, shared by Gratuity Tracker and
  Final Settlement (through `settlementCompute.js`). It counts COMPLETED months (`completedMonths`, a
  BS anniversary walk, day clamped). The SSF offset is stored employer SSF × `SSF_GRATUITY_SHARE_OF_EMPLOYER`
  (`fetchSsfContributions` / `ssfFundedFor`), never a start date × a rate. `calcGratuity` takes
  `ssfFunded = {amount, months} | null`; null is unknown coverage, and unknown gets no offset.

Why: a settlement is a document that says money moved, and the wrong guess silently reduces what a
leaver is paid.

History: #s600-final-settlement-writes, #s613-finalize-gates, #s620-reopen-rank,
#s752-settlement-decisions, #s753-open-list, #s791-hss-ports, #s798-stage-2a

## Attendance

- **A blank attendance day is PAID for monthly staff** (`unpaidDays` comes only from rows that
  exist) and pays daily and hourly staff nothing. Never write "a blank day is unpaid" in copy.
- **A month whose payroll run is FINALIZED is read-only**: Attendance, leave approve/cancel and every
  overtime action. Pages lock and say "reopen the payroll run"; a failed run-status read locks
  (`runStatus === 'unknown'`).
- **`hr_pay_month_guard()` is the one refusal for attendance and overtime writes**, called by both row
  guards (`hr_attendance_guard_finalized` / `hr_overtime_guard_finalized`) under `hr_pay_lock`: a
  finalized payroll month (except a leaver with no payslip there whose settlement is still a draft),
  and a finalized settlement's last month or later (`hr_month_settled`, the whole row). A bulk writer
  must leave settled leavers out, or one row fails the statement. Inside a DEFINER body the INVOKER
  guard returns early, so a new DEFINER writer of `hr_attendance` calls `hr_pay_month_guard` per row
  itself.
- **The parent-exists test that lets a client or period cascade through lives in the SECURITY
  DEFINER lookup, never in the INVOKER trigger**: an HR account's RLS view of `monthly_periods` can be
  empty, so an `EXISTS` there passes vacuously. Three INVOKER delete guards still test `clients` in
  their own body (`hr_shift_types_guard_delete`, `hr_leave_types_guard_delete`,
  `hr_employees_guard_delete`); that holds only because `clients_select` shows a caller its own client.
- **A non-working day carries no clock.** `NON_WORKING_STATUSES` (`attendance/attendanceRules.js`:
  absent, paid/unpaid leave, off, holiday; never the half-day ones). `withStatus()` clears the cell,
  the inputs switch off, `attendanceRowFor()` saves zeros, and leave approval's upsert clears a full
  day.
- **Bulk marks fill blanks only** (`fillBlankCells`). Save writes a cell that was blank at load ON
  CONFLICT DO NOTHING and names the days kept (S798, `splitFirstMarks`). Generate writes with
  `ignoreDuplicates` and counts the days it kept.
- **Attendance saves every unsaved cell, not the day on screen** (S768). Unsaved work is `records`
  compared with `savedRecords` by `cellSignature()` (what a cell SAVES as). One `saveChanges()`
  upserts all of them from either tab. **Every reload after a write passes `{ carry: true }`** and
  names what it deleted with `drop`; a period switch passes neither and asks first when there is
  unsaved work. `clearCell` removes the key from the saved copy on success.
- **A failed attendance read hides the grid** (`attendanceError`), because Generate, the bulk marks
  and Import decide "blank" from the screen. `loadAttendance` returns true / false / null
  (superseded), and a write whose reload fails says it landed.
- **Clear Month** (S743) refuses when the period's run is finalized and when that read fails, and deletes
  `.in('employee_id', listed)`, never the whole period: a mid-month leaver's days are what Final
  Settlement reads.
- **A shift's normal hours are not its length** (`hr_shift_types.regular_hours`, "Normal hrs", S742).
  `shiftRegularHours` / `shiftOvertimeHours` (`laborForecast.js`) are the one definition. NULL means
  the whole shift is normal time; never default it. Normal hours are CLOCK time, lunch included: on a
  shift with them Attendance compares the Start-to-End span, so Break does not reduce OT; on a shift
  without them the net-worked formula stays, and the "short" nudge follows the same basis.
- **Attendance reads `hr_shift_types` with `*`, not a column list**: a named new column fails the
  whole read on a database the migration has not reached, and an empty shift map makes every rostered
  span overtime.
- **Generate from Roster** (`attendanceFromRoster.js`) marks a roster row with hours Present, with
  `shiftOvertimeHours` as OT. A zero-hour marker becomes `zeroHourStatus(name)`: unpaid first ("UNPAID
  LEAVE" contains "paid leave"), then paid, and a leave name that says neither is UNPAID; then
  holiday; everything else (an off name, no name, any other name) is Off (S749). Only a "holiday" name
  may create a paid day. Generate and the board's assign-over-leave ask through `ConfirmModal`, naming
  what will be written.
- **Import from machine** (S775): `attendanceImport.js` reads the file, `planImport`
  (`attendanceImportPlan.js`) alone decides what each day becomes, `AttendanceImportModal.jsx` is the
  dialog.
  - An import writes nothing: its days land as unsaved marks and the sheet's Save writes them. Never
    give the dialog its own write.
  - People are confirmed on every import; no machine ID is stored.
  - Blank + full punch → Present with the sheet's own `autoHoursFor`; Present → machine times,
    untickable; any other status is never touched. No punch follows the roster (working → Absent,
    off → `zeroHourStatus`, unrostered → blank). One punch, or a span under 60 min or over 16 h →
    Present with hours blank, amber until `stillIncomplete` is false.
  - The roster rule never reaches an unlived day: nothing after today, nothing with no punch today,
    nothing outside `join_date`–`end_date`. An unread roster refuses the import.
  - Dates: the reading with the most REAL dates wins, then the most inside the month. A CSV is read
    with `raw: true`, or SheetJS turns a BS "05-01" into an AD date.
  - A grid cell is one DATE, so a shift past midnight splits across two cells (S798).
    `closeNightsInCells` moves a first punch before 5 AM back only on proof (the day before ends on an
    evening clock-in, and the overnight is shorter than the same-day reading). `suspectReason` sends
    the rest to check with hours `''`, which `stillIncomplete` holds open.
- Attendance's period switch is request-guarded.

Why: payroll reads the sheet and nothing else, so every mark the sheet loses, overwrites or
invents is a wrong payslip.

History: #s742-normal-hours, #s743-clear-month, #s749-roster-attendance-leave-overtime,
#s768-critique-fixes, #s775-import-from-machine, #s791-hss-ports, #s798-stage-1a, #s798-stage-1b

## Leave

- **An approval is two writes, and the `hr_attendance` rows are the one that pays.** Payroll builds
  `unpaidDays` only from rows that exist, and the Attendance Sheet never reads `hr_leave_requests`.
  On the Leave page `approveCore()` → `syncAttendance()` writes the days; the back-fill below is the
  other writer.
- **The back-fill** (S741): `backfillApprovedLeave({ clientId, period })` (`backfillApprovedLeave.js`) only calls
  `hr_backfill_approved_leave(p_period_id)` (DEFINER; admin, Owner, IMS or HR supervisor+). It runs
  where a period is minted (`createPeriodWithCarryForward`, `performPeriodClose`'s open-next), since
  `monthly_periods_one_open_per_client` leaves leave for a later month nowhere to write, and behind
  the Leave page's catch-up button. It fills only days with no attendance row; reports, never throws
  (`leaveFill`, and its own `leave_backfill` stage in `performPeriodClose`'s `failures`); sends one
  day once per upsert; and leaves settled leavers out, reporting them as `settled`.
- **`findApprovedLeaveGaps()`** splits `waiting` (no period yet: say so) from `unmarked` (period
  exists, days missing: actionable). Months before the client's earliest period are ignored. A failed
  read returns the error, never an empty list.
- **Say what the reader can do, or that there is nothing to do.** A banner that asks for an
  impossible action trains people to ignore banners.
- **`days` is derived by the database** (`hr_leave_requests_validate`): calendar days − public,
  not-removed Holiday Calendar days, through `hr_public_holiday_count()` (DEFINER, caller-checked)
  over `bs_months`. `leaveDayCount()` / `publicHolidayKeys()` (`leaveConstants.js`) are the page's
  copy. Rostered days off still count. Approval and the back-fill mark those days `holiday`. A
  days-only UPDATE does not fire the trigger, so a request decided before a holiday was added keeps
  its count. `submit_my_leave_request` keeps `p_days` in its signature and ignores it.
- **Two pending/approved requests for one employee may not share a day** (operator exempt for
  restore; an operator INSERT that is all public holidays is stored at 0 days, so key a restore seam
  on `is_admin()`). `findOverlappingRequest` / `finalizedMonthsFor` / `quotaOverrun` (`leaveRules.js`)
  let the page say so first. Over quota WARNS, never blocks.
- **Reopen (S740) returns a rejected/cancelled request to Pending, never to `approved`**, re-reads its
  status first, and refuses on a failed read. **An undo restores the state before the write, not the
  state after it, unless the undo itself performs the write.**
- **A revert touches only leave-status days** and marks a day that is a holiday NOW `holiday`
  (S798, `planLeaveRevert` in `leaveRules.js`). If an approval's status write fails after its days are written,
  `approveCore()` re-reads the request and, only if still pending, puts the days back as read before.
- **A decided request keeps employee, type, dates and day type** for every client caller, and only a
  pending one can be deleted (`leave_request_locked`). An approval, or any change to an approved
  request, in a month with finalized payroll is refused in the database (`hr_leave_range_finalized`,
  DEFINER, because a supervisor's view of runs is empty).
- A leave type cannot be deleted while requests use it (`hr_leave_types_guard_delete`, S798).

Why: the request is the decision, but the attendance row is the money, and the two drift apart
whenever one is written without the other.

History: #s740-leave-reopen-and-overtime-undo, #s741-leave-back-fill,
#s749-roster-attendance-leave-overtime, #s768-critique-fixes, #s791-hss-ports, #s798-stage-1b

## Overtime and the Holiday Calendar

- **One overtime entry per employee per day** (`hr_overtime_entries_employee_day_key`). An edit of an
  approved entry stays approved, by decision. After a save to another month, Overtime reloads the
  month ON SCREEN, never the saved one.
- **An OT entry stores its own `ot_type`**, so editing or removing a holiday never reprices existing
  overtime. Copy must not say otherwise.
- **Overtime's Undo is deliberately unlike Leave's Reopen:** page rank `supervisor`, no confirmation,
  no freshness re-read. Change it on its own merits, not to match.
- **`hr_holiday_calendar` decides the holiday 2× rate**: `Overtime.jsx` reads
  `holiday_type = 'public'` only, never `'optional'`. A row's type is money, not a label.
- **Three kinds of holiday, and only the first is derivable** (S635; `holidayData.js`, pinned by
  `holidayData.test.js`). FIXED: the same BS date every year, its BS year from
  `resolveYear(fyYear, bs_month)`, never a per-row field. MOVABLE: lunar or AD-fixed, transcribed from the Nepal Gazette
  and keyed by REAL BS year. SIGHTED (the two Eids, Mohammad Jayanti, Guru Nanak Jayanti, Bhoto
  Jatra): no gazetted date, named on screen as a known gap.
- **Extending the table is transcription, never calculation:** verify each date in two independent
  places and against `bsCalendar.js`'s month lengths.
- **Report coverage rather than seeding short:** the seed names a BS year whose gazette is not in the
  table.
- **The NAME is the dedupe key.** No two rows share a name (days with no tithi name of their own are
  named by BS day), and renaming a FIXED holiday needs a `legacy` name list. Tests assert both.
- **Seeding is additive and name-keyed:** a client's own entry or edit is never overruled. The one
  exception is a FIXED holiday found on the wrong date, which is corrected and named in the result
  (Martyrs' Day, Magh 5 → Magh 16). Region-split holidays (Holi) are seeded twice, named, and the
  operator removes one.
- **Writes need HR supervisor rank** (page and a RESTRICTIVE policy per write command).
  `(client_id, bs_year, bs_month, bs_day, name)` is unique; the table is audited. Seed runs only over
  a list that loaded, because it dedupes against the screen.
- **Removing a holiday is a stamp (`removed_at`), never a DELETE**, or the next Seed brings it back.
  `planSeed()` counts a removed row as present and never corrects its date. **Every reader outside the
  page filters `removed_at IS NULL`** (grep `hr_holiday_calendar`: today `Overtime.jsx`,
  `LeaveManagement.jsx`, `demandForecastData.js`, `setupSignals.js`, and in SQL
  `hr_public_holiday_count` and `hr_backfill_approved_leave`). Delete for good exists and forgets the
  removal.

Why: a missing or wrong holiday is a wrong rate on a real payslip, on the biggest working days of
the year.

History: #s635-holiday-calendar, #s740-leave-reopen-and-overtime-undo,
#s748-employees-pay-setup-holiday-calendar, #s749-roster-attendance-leave-overtime

## Roster, shift types and swaps

- **Shift types: unique name per client, and no delete while the roster uses one**
  (`hr_shift_types_guard_delete`). Never reintroduce a destructive tidy-up on a read path. A seed runs
  only after a successful read, and a 23505 on the seed is a second tab, answered by re-reading.
- **A roster row is not a person on duty** (S692). `computeScheduledCount` counts heads through
  `isOnDutyShift` (`laborForecast.js`): an off-type NAME (`isOffDay` / `OFF_SHIFT_KEYWORDS` in
  `payrollConstants.js`, a substring test also used by the Staff app) or an explicit `hours: 0` is
  off duty. A working shift with UNKNOWN hours (the default "Split": `hours: null`, no times) is on
  duty and flagged unpriced (`hasUnknownHours`). Generate from Roster does not use it (it keys on
  hours), so a "Day Off" type given hours is off duty here and Present there.
- **A swap approval is `approve_shift_swap(p_request_id)`**: SECURITY INVOKER, one transaction, every
  UPDATE's row count asserted (a write RLS filters out is 0 rows, not an error). Same day → trade
  `shift_type_id`. Different days → trade `employee_id`, and a Day Off trades the other way
  (`hr_shift_kind`: off / leave / work). Only a working shift or leave on the other day refuses
  (`swap_day_taken`, raised at request time too), and the traded rows must both be working shifts.
- **`request_shift_swap` refuses** a past day, an unpublished day, and a shift already in an open swap
  (`swap_day_past` / `swap_day_unpublished` / `swap_already_requested`). The Staff app's picker hides
  past days.
- **Shift Swaps is the Roster page's own tab** (S633), and its history is never period-scoped. The pending
  count rides on the tab button (`pending_admin` only, the `useHrApprovalCounts.js` filter), fetched by
  `Roster.jsx` with a `head: true` query, because the panel mounts only once the tab is opened.
- **A history outlives the people in it.** The board loads `status IN ('active','probation')`, so a
  page showing historical rows resolves the names its list filtered out: fetch the unknown ids once,
  tracked in a ref. `rejected_by_target` and `cancelled` have no `admin_decided_by`; name the coworker
  who declined or the requester who withdrew.
- Roster's board and publish loads are request-guarded. `hr_overtime_entries`, `hr_shift_types` and
  `hr_shift_swap_requests` are audited; `hr_roster` deliberately is not (volume).

Why: the roster is read as evidence of who works, by payroll, the forecast and the Staff app, so a
row that is not a shift must never count as one.

History: #s633-shift-swaps-tab, #s692-labor-forecast, #s749-roster-attendance-leave-overtime,
#s791-hss-ports

## Labor Forecast and the labour standard

- **Labour Cost % bands through `lcBand`** (`src/shared/operatingBands.js`), never a local threshold:
  `bandFigure(pct, lcBand, { decimals: 0 })`, rendering its `text`, which carries the ✓/△/▲ (see
  `ims-figures.md`).
- **A scheduled hour costs the LOADED rate** (S692), never `hourlyRateOf(basic)` alone: `loadedHourlyRateOf`
  is monthly `(basic + earning components) / (monthDays × 8)`, daily `basic / 8`, hourly `basic`, plus
  the 20% employer SSF (gated on `ssf_enrolled AND ssf_no`) over the same hours. With no components
  and no SSF it equals `hourlyRateOf`.
- **Hours and cost follow the Department filter; Scheduled Staff never does**, because Recommended
  Staff is covers ÷ target for the whole outlet. The tab shows the filter and says which columns it
  narrows.
- **A past day reads actuals.** Revenue from `sales_entries` (the Owner Dashboard's definition, and so
  the band's denominator); covers from closed paid `pos_orders`, only where the VIEWED client has POS
  (`clientModules.pos`, not `posEnabled`); hours from `hr_attendance`, with `ot_hours` priced at basic
  × 1.5 inside `hours_worked`. A holiday row costs 0 hours here, deliberately: this prices hours on
  the floor. A day with no attendance rows is `basis: 'roster'`, labelled "as rostered · no
  attendance", never 0h. Recommended Staff and Status are hidden for a non-POS outlet, and
  `staffedDays` guards the footer.
- **`laborStandard.js`** (S693) turns forecast revenue into required hours from a trailing 120-day window:
  a ratio of totals, never a mean of per-day ratios, linear through the origin with no intercept.
  `typicalShiftHours` is `Σ hours / Σ heads` from the window, NEVER `STANDARD_HOURS_PER_DAY` (a
  payroll constant).
- **Only evidence trains it:** `isTrainingSample` requires recorded hours, an existing period, and
  non-zero hours and revenue. A bulk `bs_day = 0` sales month is barred entirely.
- **`measureRosterBias`** (`Σ attendanceHours / Σ rosteredHours` over days carrying both) scales
  roster-only samples. Under 10 overlap days they train unadjusted and the tab says so. Never assume a
  direction: overtime pushes the ratio above 1.
- **The window's hours read EVERY employee, whatever their status** (`tallyWindowAttendance` filters
  by nothing); `computeActualLabor` skips anyone not in the list it is given, so never hand it the
  board's active list.
- **Say on the row which basis each number came from.** A weekday under 4 samples falls back to the
  all-days figure and says so (`describeBasis`); under 20 qualifying days there is no standard; a
  failed window read is an `ActionError` saying it failed, not a lack of history. It learns what this
  outlet normally uses, not what it should.
- **`covers_per_staff_target` stays a POLICY the owner sets.** The learned covers-per-shift figure is
  shown beside it and never written into it.

Why: each of these figures reads plausibly when it is wrong, and the band is shared with the Owner
Dashboard, so both must price the same hour.

History: #s660-status-colours-and-labour-band, #s692-labor-forecast, #s693-labour-standard,
#s749-roster-attendance-leave-overtime

## Rank, approvals and your own records

- **Rank is a database fence.** RESTRICTIVE supervisor-rank INSERT/UPDATE/DELETE policies on
  `hr_attendance`, `hr_leave_requests`, `hr_leave_types`, `hr_overtime_entries`, `hr_roster`,
  `hr_shift_types`, `hr_shift_swap_requests`, `hr_roster_publish_state` and the Holiday Calendar
  (S748–S749). Manager-rank WRITES on runs, payslips, components, settlements, salary payments,
  advances, repayments, festival, incentives and incentive types; supervisor-rank writes on TADA
  claims (S751). Reads are not fenced by rank: supervisors read pay, by the S750 decision, so never
  give a page a reason that rests on a supervisor's read coming back empty. `hr_employees` writes
  need manager (`hr_employees_write_rank_*`) while reads stay open to supervisors (S798). **A new HR table a page
  writes gets the same three policies.** Self-Service writes through SECURITY DEFINER RPCs.
- **A refused RLS write returns 0 rows and no error**, so a write that matters adds `.select('id')` and
  checks the count. The three employee writers say `NOT_SAVED_RLS` (`employeeFormData.js`).
- **Nobody below the Owner decides their own record:** `hr_leave_requests_guard_decision` (stamps
  `decided_by`), `hr_overtime_guard_own` and `hr_advances_guard_own` refuse `hr_own_request`;
  `hr_self_decision_exempt()` is admin OR Owner. A new approval queue gets the same trigger.
- **"Your own" covers more than Approve/Reject** (S798 1b), OLD or NEW employee: your own advance
  (delete, move, write-off, amount, instalment, issue date, type) and any repayment on it; your own
  approved overtime (employee, hours, type, day); your own APPROVED leave (no cancel, no reopen, H8).
  Withdrawing your own pending leave stays allowed. Pages test with `useIsOwnEmployee`
  (`ownRecord.js`, Owner exempt; TADA keeps `isOwnClaim`, operator-only) and render `OwnRecordNote`;
  a batch leaves own rows out.
- **HR-role logins read `monthly_periods`** (per-command write policies replaced S430's FOR ALL
  `no_hr_role_staff`). **When a check reads a table an HR login cannot see, it is not a check for
  that login.**
- **Staff rank, all three modules:** no rankless staff login (admin-user-ops refuses, and pages have
  no "No Access"); HR Manager is granted by the Owner or admin only; the staff role lists in `settings`
  are Owner-or-that-module's-manager (`settings_guard_staff_roles`); **no page re-ranks on load**, a
  mismatch is a banner and a confirmed Apply. `pos_email` joins every negative Owner test.
- **One approval control for Leave, Overtime, TADA and Shift Swaps** (`src/modules/hr/ApprovalControls.jsx`).
  A batch runs each row's OWN decision one after another (`decideEach`) and names every refusal; it
  never writes a set in one statement, because one refused row would fail them all. Leave's batch
  leaves out a request over quota or in a finalized month, and checks quota as if its earlier
  requests were already approved; `approveCore()` is the approval without the page's busy flag,
  message or reload. Approve and Reject are both neutral small ghosts.
- **A failed count is not a zero** (S734). `useHrApprovalCounts` returns the failure rather than `|| 0`. A
  queue tile whose empty state is good news needs a third rendering for a failed read: an em-dash
  plus "count unavailable — open the page", with the section label saying so. When you find this
  shape, check the rest of the screen (HrDashboard's Headcount: `setEmpStats(err ? null : {…})`).

Why: no route gate checks a role, and a restrictive policy answers `[]` instead of an error, so
every rank and every own-record rule has to hold in the database.

History: #s734-pending-counts, #s748-employees-pay-setup-holiday-calendar,
#s749-roster-attendance-leave-overtime, #s751-payroll-decisions, #s752-settlement-decisions,
#s768-critique-fixes, #s798-stage-1b

## Employees and Pay Setup

- **A form saves the fields it owns and changed, never the row it loaded.** `EmployeeForm` saves
  through `changedEmployeeFields()` (`employeeFormData.js`). Any other edit form over a table two screens write needs the
  same shape.
- **A field that affects pay is never hidden while it holds a value.** The End Date shows whenever it
  is set, with a warning when it is past on an active employee.
- **Pay Setup's editor refuses Save until its component read is `ok`.** Save deletes and re-inserts
  the set, so the set you send must be one you actually read.
- **An employee with pay history cannot be deleted, by anyone** (`hr_employees_guard_delete`,
  `employee_pay_history()`): finalized payslips, a finalized settlement, finalized festival
  allowances, any advance, or a Self-Service login. Deactivate is the lossless path; there is no
  force path. A whole-client deletion still cascades (the guard lets it through once the `clients`
  row is gone). Since S798 1b `employee_pay_history` answers only a login that can see employees at
  all (SELF-SERVICE-2), so for HR staff, POS, IMS and Self-Service logins it is RLS (manager-rank
  writes), not the guard, that refuses the delete.
- **Pay Setup previews are a full month before income tax**, and say so. The default tab is On
  payroll (active + probation), matching every payroll picker.

Why: two screens write `hr_employees`, and a stale copy saved over it reverts a raise, a settlement
or a login block.

History: #s748-employees-pay-setup-holiday-calendar, #s798-stage-1b

## Colour, ink and BS dates on HR screens

- **`HR_REQUEST_STATUS` / `TADA_REQUEST_STATUS` (`payrollConstants.js`) are the module's only status
  colours** (S660), across all five approval queues and Self-Service:

      amber = open, something is still required of someone
      brass = decided, but the money has not moved   (badge-yellow)
      green = closed, good
      red   = closed, refused
      grey  = closed, void — withdrawn or cancelled

  Take `.badge` for a chip and `.tint` for a hand-drawn one (it carries S549's fill-vs-text split:
  base token for the fill and border, `*-text` for the label). A ladder with a payment step extends the
  map (`TADA_REQUEST_STATUS` overrides only `approved` brass and `paid` green). Two open states on one
  page separate by LABEL and the amber/brass split, never a sixth hue. `Advances.jsx`'s
  `ADVANCE_STATUS` restates the same hues as literals; derive it from the map when touched.
- **A category never takes a signal colour:** a public holiday and holiday-rate OT are brass
  (`badge-yellow`), an optional holiday purple, weekday OT grey. Staff rank badges (S661) come from `src/shared/staffLevelBadge.js`, as in `HrStaff.jsx`
  (`STAFF_LEVEL_BADGE`, all three levels `badge-yellow`; `STAFF_LEVEL_BADGE_NONE` for no access to the
  module).
- **A correct payroll figure takes the ink; the sign carries direction** (registers, the working
  panel, Festival/Incentive runs, Final Settlement, Gratuity, Pay Setup's preview, `PayslipBody`).
  Colour is for flags only (SSF no. missing, no bank, out of date, split month, owed by the employee:
  amber with △). `RunStatusBadge` is the one Draft (amber) / Finalized (green) chip beside a run's
  title; Festival Allowance and Incentive Run still build their own per-run list chip, with a third
  state "Part finalized", in the same colours. A resigned or
  terminated employee is grey, not red.
- Final Settlement sits in the Payroll nav group; Gratuity stays in Reports.
- **A day inside a known month prints as `formatBsDay(day, bsMonth)`** (S614; "1st Bhadra"), or
  `bsDayOrdinal(day)` where the month is beside it (both `src/utils/bsCalendar.js`). A destructive
  confirm names the day in the words the roster shows. **Never retype the month list**: import
  `BS_MONTHS`.

Why: one hue meaning opposite verdicts on two screens a manager uses in one sitting is how a
palette stops meaning anything.

History: #s614-bs-day-labels, #s660-status-colours-and-labour-band, #s768-critique-fixes

## Export, restore and Danger Zone

- `RESTORE_ORDER` restores `hr_advance_repayments` / `hr_tada_claims` AFTER the payroll runs and
  settlements they reference. Danger Zone deletes repayments before runs, and salary payments before
  runs and employees (all NO ACTION FKs).
- The operator seam (`is_admin()`) is how a restore writes history past the HR guards; see Finalize,
  Reopen and the database locks.

Why: an FK with NO ACTION refuses the delete or insert in the wrong order.

History: #s752-settlement-decisions, #s782-salary-payments

## Migrations, tests and findings

- Migrations: S749 `20260914170000` (rank fences, finalized-month locks, swaps) and `20260914180000`
  (holidays inside leave); S751 `20260914210000`; S752 `20260914230000`; S753 `20260915090000`; S782
  `20260923100000`; S791 `20260928100000` (advances), `20260928110000` (leavers), `20260928130000`
  (swaps); S798 1b `20260930120000`, 2a `20261001120000`, 2b `20261001140000`, 2c `20261001160000`.
- Engine tests: `payrollS751.test.js`, `settlementCompute.test.js`, `gratuityCompute.test.js`,
  `holidayData.test.js`. The S798 findings and stage plans: `HR_TODO.md` (S798.2, S798.3).
- The S770 moves (S682's per-ledger Finalize/Reopen messages, the S628 row-cap sweep, the S628
  render-body fix) are at the top of `docs/rules-archive/hr-payroll.md`; the pre-S799 title and intro
  note: #title-and-intro-note.
