# Crest HR — Re-analysis To-Do

One whole-module review lives here: **S798 (2026-09-30)**. H1–H25 are its owner decisions, all answered
on 2026-09-30. Stage 1a (ENGINE-1, ATTENDANCE-1, SELF-SERVICE-1) shipped the same day, and Stage 1b (migration `hr_integrity_s798`: PEOPLE-ACCESS-1, BONUS-LEDGERS-1, LEAVE-OT-HOLIDAYS-1/-2, SISTER-1, GAP-PAY-STATE-1, SELF-SERVICE-2) that evening, then 1d (ATTENDANCE-3) and 1c (DATABASE-1, admin-user-ops v62). Stage 1 is done. The last whole-module HR reviews were S748–S753; their decisions live in `.claude/rules/hr-payroll.md`
and are not re-asked. Start from the S798.0 index.

**When an item here ships, strike it in the same commit and move it to the CHANGELOG entry.**

**Status key:** 🔴 Not started · 🟡 Partial · ✅ Done · 🔵 Deferred · ⚪ Known, open

---

# S798 re-analysis (2026-09-30)

Fourteen read-only area reviews covered the pay engine, payroll, bonus runs and ledgers, settlement,
attendance, roster, leave/overtime/holidays, people and access, Crest Staff, the database, HR reports, HR
figures read by other modules, the docs and the hss-suite sister check. A completeness pass added three gap
areas: the pay-state machine across pages (GAP-PAY-STATE), multi-outlet groups (GAP-OUTLETS) and the Crest
operator inside a tenant (GAP-OPERATOR). Each area ran reviewer → adversarial verifier → judge, and the judge
re-checked every P0 and P1. The database reviewer read the live catalog (policies, grants, triggers, function
bodies, FK delete actions); most areas re-read the live bodies they relied on. The evidence for each ID is in
`docs/hr-review-s798/<AREA>.md`: where, what happens, evidence, fix, confidence, verification.

Code added since S748–S753 had never been reviewed:

- S768 attendance save rules, the leave batch approve, the HR Dashboard month strip;
- S775 Import from machine; S777 the payroll approval sheet;
- S781 bonus tax on earned pay; S782 salary payments (Mark paid); S788 the strip's overpaid state;
- S786 weather on the HR Dashboard; S790 the setup guide;
- S791 the nine hss-suite ports (settled leavers, rehire, PIN reservation, swap Day Off, month locks).

Many findings sit in that code (ATTENDANCE-3/-4/-5, PAYROLL-2, REPORTS-1/-3, PEOPLE-ACCESS-3/-4,
SETTLEMENT-5, GAP-PAY-STATE-4, SELF-SERVICE-6). The rest is older code the S748–S753 reviews missed;
ENGINE-1 dates from S309.

**109 findings in the area files, 106 rows after merging.** Merged: ENGINE-5 = PAYROLL-6,
PAYROLL-2 = REPORTS-2, ATTENDANCE-7 = ROSTER-5 (all P2). After merging: **2 P0 · 16 P1 · 58 P2 · 30 P3.**
25 owner decisions (H1–H25) block 27 rows. The three GAP-OUTLETS rows are latent: no client has a group yet.

## S798.0 Index

Stage: 1 = security and money stored wrong, 2 = wrong figures and lost work, 3 = waits on a decision,
4 = docs, copy and polish. Mig = needs a migration.

### P0 (2)

| ID | Finding | Area | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |
| ENGINE-1 | Daily-wage staff lose half a day's pay on every approved half-day leave; finalized payslips and SSF carry it | ENGINE | 1 | H16 (back pay) | no |
| PEOPLE-ACCESS-1 | Any HR supervisor can rewrite basic, bank account, SSF, status and dates, or add and delete employees, over REST; payroll pays from it | PEOPLE-ACCESS | 1 | — | yes |

### P1 (16)

| ID | Finding | Area | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |
| ENGINE-2 | Women may be over-withheld income tax: the 10% rebate is never applied | ENGINE | 3 | H17 | no |
| BONUS-LEDGERS-1 | An HR manager can delete, fake-repay, move or shrink their own loan, so it is never recovered | BONUS-LEDGERS | 1 | — | yes |
| SETTLEMENT-1 | A paid settlement reopened and re-finalized still shows Paid; the difference is never paid, and the reopened draft can be deleted | SETTLEMENT | 3 | H4 | yes |
| ATTENDANCE-1 | A failed attendance read shows a blank, writable month; Generate or All Present turns unpaid leave and absences into paid days | ATTENDANCE | 1 | — | no |
| ATTENDANCE-2 | A Split-shift day is paid as all overtime when times are typed or imported, and Generate marks it Off | ATTENDANCE | 3 | H10 | no |
| ATTENDANCE-3 | Import from machine reads a shift ending after midnight as the gap between shifts: 5–7 h of overtime a day | ATTENDANCE | 1 | — | no |
| ROSTER-1 | Editing a shift type's hours rewrites earlier days not yet generated, so Generate pays them at the new length | ROSTER | 3 | H12 | no |
| LEAVE-OT-HOLIDAYS-1 | When an IMS supervisor or manager ends the month, the new month's approved leave is silently never marked, so unpaid leave is paid | LEAVE-OT-HOLIDAYS | 1 | — | yes |
| LEAVE-OT-HOLIDAYS-2 | An HR supervisor can inflate their own approved overtime, or move a colleague's onto themselves, and it stays approved and paid | LEAVE-OT-HOLIDAYS | 1 | — | yes |
| SELF-SERVICE-1 | A failed sign-out on a shared phone leaves the last employee signed in for the next person | SELF-SERVICE | 1 | — | no |
| SELF-SERVICE-2 | Any Crest Staff login can learn coworkers' advance counts and who was settled out (`employee_pay_history`) | SELF-SERVICE | 1 | — | yes |
| DATABASE-1 | After Archive and Restore every staff login loses its employee link: Crest Staff stops, leavers keep PINs, own-record rules stop | DATABASE | 1 | — | no |
| LABOUR-FIGURES-1 | Festival allowance, incentives and a leaver's final pay are in no labour figure, so Dashain's labour reads a wage bill low | LABOUR-FIGURES | 3 | H18 | yes |
| LABOUR-FIGURES-2 | The Group Dashboard shows every outlet "0.0% ✓ Healthy" labour until payroll is finalized | LABOUR-FIGURES | 2 | — | no |
| GAP-PAY-STATE-1 | An HR manager can put a payroll-paid travel claim back to Approved over REST (their own too), so it is paid again | GAP-PAY-STATE | 1 | — | yes |
| GAP-OPERATOR-1 | A Crest operator screen opened before Finalize can still rewrite finalized payslips, bonus rows and repayments | GAP-OPERATOR | 3 | H3 | yes |

### P2 (58)

| ID | Finding | Area | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |
| ENGINE-3 | Settlement pre-fills too few leave days when leave falls after the last day or in an earlier spell | ENGINE | 2 | — | no |
| ENGINE-4 | Festival Allowance pays some leavers one month's share too few | ENGINE | 2 | — | no |
| ENGINE-5 = PAYROLL-6 | A same-year rehire is under-withheld TDS: year-to-date ignores their Final Settlement | ENGINE, PAYROLL | 2 | — | no |
| PAYROLL-1 | Staff set off-payroll with no last working day drop out; their worked days are never paid | PAYROLL | 3 | H9 | no |
| PAYROLL-2 = REPORTS-2 | The approval sheet, SSF card and strip show less SSF and TDS to deposit than the challan | PAYROLL, REPORTS | 2 | — | no |
| PAYROLL-3 | An HR manager can move a finalized run to another month over REST, so the month is paid twice | PAYROLL | 2 | — | yes |
| PAYROLL-4 | A net pay edited over REST is finalized, paid and banked; nothing checks net equals its parts | PAYROLL | 2 | — | yes |
| PAYROLL-5 | Approved overtime is read unpaged; past 1,000 entries some overtime is underpaid | PAYROLL | 2 | — | no |
| BONUS-LEDGERS-2 | A travel claim approved by mistake cannot be taken back; duplicates are paid twice | BONUS-LEDGERS | 3 | H13 | yes |
| BONUS-LEDGERS-3 | A leaver's claim still pending at settlement is never paid, while the page promises the next payroll | BONUS-LEDGERS | 3 | H11 | yes |
| BONUS-LEDGERS-4 | A leaver whose last month is a bonus pay month can be under-taxed at settlement | BONUS-LEDGERS | 2 | — | no |
| BONUS-LEDGERS-5 | An HR manager can type their own festival allowance or bonus and finalize the run | BONUS-LEDGERS | 3 | H2 | yes |
| SETTLEMENT-2 | Settling while an earlier run is a draft pays gratuity twice, taxes the year without it, and repays a reopened run's claims | SETTLEMENT (+ GAP-PAY-STATE dropped 5) | 3 | H15 | yes |
| SETTLEMENT-3 | Absences marked after the settlement screen loaded are paid at Finalize | SETTLEMENT | 2 | — | yes |
| SETTLEMENT-4 | The final-month tax true-up is capped at that month's take-home; the rest is dropped | SETTLEMENT | 2 | — | no |
| SETTLEMENT-5 | Re-finalizing an earlier spell after a rehire rewrites it and marks the working rehire as left | SETTLEMENT | 2 | — | yes |
| SETTLEMENT-6 | An HR manager can settle a fellow HR manager and ban their logins | SETTLEMENT | 3 | H20 | yes |
| ATTENDANCE-4 | Importing after Generate never finds absences: a Present day with no punch stays paid | ATTENDANCE | 3 | H14 | no |
| ATTENDANCE-5 | Generate and All Present mark days before joining, after leaving and in the future | ATTENDANCE | 3 | H7 | no |
| ATTENDANCE-6 | Generate overwrites marks saved elsewhere since the sheet opened (approved unpaid leave → paid) | ATTENDANCE | 2 | — | no |
| ATTENDANCE-7 = ROSTER-5 | Shifts named with "off", "leave" or "holiday" inside ("Coffee Bar", "Holiday Duty") are treated as days off | ATTENDANCE, ROSTER | 2 | — | yes |
| ROSTER-2 | After a swap is approved the Board is stale, and clearing the old cell deletes the coworker's shift | ROSTER | 2 | — | no |
| ROSTER-3 | An unanswered swap cannot be withdrawn or rejected and blocks both shifts; leavers are offered | ROSTER (+ SELF-SERVICE dropped dup) | 3 | H23 | yes |
| ROSTER-4 | Once any day is published, Crest Staff calls every draft day "Not scheduled" | ROSTER | 2 | — | yes |
| ROSTER-6 | With a Department filter, days read Covered and Suggest disappears | ROSTER | 2 | — | no |
| ROSTER-7 | Past forecast days drop hours worked by leavers, so labour cost reads low | ROSTER | 2 | — | no |
| ROSTER-8 | A grouped Owner's publish or swap decision at a sibling sends no push; big publishes skip staff | ROSTER (+ SELF-SERVICE dropped dup) | 2 | — | no |
| ROSTER-9 | HR logins see past forecast days as Revenue 0 and "Was covered" (known-open, IMS_TODO.md:317) | ROSTER | 2 | — | yes |
| LEAVE-OT-HOLIDAYS-3 | Approving your own leave writes its days before the refusal; a later Reject never clears them | LEAVE-OT-HOLIDAYS | 2 | — | no |
| LEAVE-OT-HOLIDAYS-4 | Cancelling leave after a holiday was added inside it leaves that day docked | LEAVE-OT-HOLIDAYS | 2 | — | no |
| LEAVE-OT-HOLIDAYS-5 | An HR supervisor can mark their own absences Present or Paid Leave, and payroll pays it | LEAVE-OT-HOLIDAYS | 3 | H2 | yes |
| PEOPLE-ACCESS-2 | An HR manager can raise their own salary in Pay Setup and finalize the payroll that pays it | PEOPLE-ACCESS | 3 | H2 | yes |
| PEOPLE-ACCESS-3 | A rehire keeps the old End Date, and payroll silently leaves them out of every month | PEOPLE-ACCESS | 2 | — | no |
| PEOPLE-ACCESS-4 | A rehire's till, stock or HR login stays blocked unless the old settlement is reopened | PEOPLE-ACCESS | 3 | H21 | yes |
| SELF-SERVICE-3 | Crest Staff resumed next day shows yesterday as Today and a worked shift as Next | SELF-SERVICE | 2 | — | no |
| SELF-SERVICE-4 | A failed publish-status read says "not published" over loaded shifts; suppliers fail silently | SELF-SERVICE | 2 | — | no |
| SELF-SERVICE-5 | On a shared phone, the last employee's pushes keep arriving and the next cannot subscribe | SELF-SERVICE | 2 | — | no |
| DATABASE-2 | A restore drops the whole leave history if one leave is all public holidays; balances reset | DATABASE | 2 | — | yes |
| DATABASE-3 | An HR supervisor can delete an in-use leave type; its leave is re-encashed and back-fills as unpaid | DATABASE | 2 | — | yes |
| REPORTS-1 | The Bank Transfer sheet lists full net pay whatever was paid, so reuse pays staff twice | REPORTS | 3 | H1 | no |
| REPORTS-3 | In payroll week the dashboard strip shows the running month, not the month being paid | REPORTS | 2 | — | no |
| REPORTS-4 | The operator's HR Reports guide describes the pre-S752 challan and misreads the SSF-number count | REPORTS | 4 | — | no |
| LABOUR-FIGURES-3 | Labour outside HR counts joiners' full months and unpaid days, unlike the payroll sheet | LABOUR-FIGURES | 3 | H19 | yes |
| LABOUR-FIGURES-4 | Owner Dashboard and Owner Report net margins leave out Tax & Fees | LABOUR-FIGURES | 2 | — | no |
| LABOUR-FIGURES-5 | A month-end leaver drops out of the Owner Report estimate and terminations (UTC date parse) | LABOUR-FIGURES | 2 | — | no |
| LABOUR-FIGURES-6 | The Owner Report reads leave unpaged; past ~1,000 requests Leave taken freezes short | LABOUR-FIGURES | 2 | — | no |
| LABOUR-FIGURES-7 | Labor Analytics counts Present days without times as 0 hours; its hour figures are nonsense | LABOUR-FIGURES | 2 | H24 | no |
| DOCS-1 | Help says days start Present, so marking only absences pays daily and hourly staff nothing | DOCS | 4 | — | no |
| SISTER-1 | An HR supervisor can cancel their own approved, taken leave and have it encashed at exit | SISTER | 3 | H8 | yes |
| SISTER-2 | An unlinked HR login escapes the own-record rule and the settlement login block | SISTER | 3 | H6 | no |
| GAP-PAY-STATE-2 | Leave and overtime pending at settlement: leave paid as worked and encashed, overtime never paid | GAP-PAY-STATE | 3 | H11 | yes |
| GAP-PAY-STATE-3 | A leaver can get the full festival allowance and the settlement's festival share | GAP-PAY-STATE | 2 | — | yes |
| GAP-PAY-STATE-4 | Reopening a settlement after payroll skipped the leaver, then cancelling the leaving, leaves a month unpaid | GAP-PAY-STATE | 3 | H5 | yes |
| GAP-OUTLETS-1 | At a sibling outlet whose payroll they are on, a manager can approve their own leave, claims and advance write-off (latent) | GAP-OUTLETS | 3 | H6 | no (yes for per-outlet links) |
| GAP-OUTLETS-2 | A window left on the old outlet shows HR empty and "saves" edits that change nothing (latent) | GAP-OUTLETS | 2 | — | no |
| GAP-OUTLETS-3 | Settling a second outlet leaves access; settling home bans the login everywhere (latent) | GAP-OUTLETS | 3 | H22 | yes |
| GAP-OPERATOR-2 | After an operator client switch, By Employee saves marks against the old client's employee | GAP-OPERATOR | 2 | H3 (remount) | no |
| GAP-OPERATOR-3 | An operator's settlement Mark paid stores no amount, so a re-finalize shows the new figure as paid | GAP-OPERATOR | 2 | — | yes |

### P3 (30)

| ID | Finding | Area | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |
| PAYROLL-7 | The approval sheet and payment dialogs round to rupees while the register prints paisa | PAYROLL | 4 | — | no |
| PAYROLL-8 | A hung Mark paid, Finalize or Reopen leaves the page stuck (no `withTimeout` in HR) | PAYROLL | 4 | — | no |
| BONUS-LEDGERS-6 | Advances still promises a salary cut for a settled leaver | BONUS-LEDGERS | 4 | — | no |
| SETTLEMENT-7 | The finalized settlement printout and history show the last day in AD only | SETTLEMENT | 4 | — | no |
| ATTENDANCE-8 | A Save refused by a finalize or settlement elsewhere says "press Save again" | ATTENDANCE | 4 | — | no |
| ATTENDANCE-9 | Month Summary leaves out Holiday and leave days, so Total Days never shows a full month | ATTENDANCE | 4 | — | no |
| ROSTER-10 | Copy to Next Week copies LEAVE and Holiday markers into days people work | ROSTER | 4 | — | no |
| LEAVE-OT-HOLIDAYS-6 | Approving leave on a stale page says "nothing to do now" though the month exists | LEAVE-OT-HOLIDAYS | 4 | — | no |
| LEAVE-OT-HOLIDAYS-7 | A settled leaver's later leave keeps the "not on the sheet" banner up for good | LEAVE-OT-HOLIDAYS | 4 | — | no |
| SELF-SERVICE-6 | A server failure at sign-in counts as a wrong PIN and can lock staff out | SELF-SERVICE | 4 | — | yes |
| SELF-SERVICE-7 | The employee's own payslip lacks the absence day count and CIT note | SELF-SERVICE | 4 | — | yes |
| SELF-SERVICE-8 | The swap list names a day as a bare "3rd" with no month | SELF-SERVICE | 4 | — | no |
| DATABASE-4 | Every restore blanks each employee's Reports-to supervisor | DATABASE | 4 | — | no |
| REPORTS-5 | A failed run read on the HR Dashboard says "No finalized payroll yet" | REPORTS | 4 | — | no |
| REPORTS-6 | The HR Dashboard paints last month's SSF deposit red every month from the 26th | REPORTS | 4 | — | no |
| REPORTS-7 | A failed poll clears the HR rail dot (and the POS pending count) | REPORTS | 4 | — | no |
| REPORTS-8 | HR Reports' Excel exports are headed "Payroll" when the company-name read failed | REPORTS | 4 | — | no |
| REPORTS-9 | Basic Payroll leaves out wage staff unlabelled; the leave queue prints AD dates | REPORTS | 4 | — | no |
| REPORTS-10 | Rules and guide say pay is manager-only to read; only writes are fenced | REPORTS | 4 | — | no |
| LABOUR-FIGURES-8 | The labour estimate charges employer SSF on allowances | LABOUR-FIGURES | 4 | — | no |
| LABOUR-FIGURES-9 | The setup guide ticks the pay step after one salary; zero-pay staff go unwarned | LABOUR-FIGURES | 4 | — | no |
| LABOUR-FIGURES-10 | When two close steps fail, only the first is reported | LABOUR-FIGURES | 4 | — | no |
| DOCS-2 | The getting-started steps end at Finalize and never mention Mark paid | DOCS | 4 | — | no |
| DOCS-3 | A Help tip says daily and hourly gratuity is worked out at Final Settlement | DOCS | 4 | — | no |
| DOCS-4 | Roster Help still gives the old Recommended Staff rule | DOCS | 4 | — | no |
| DOCS-5 | Help says only the owner or admin sets travel rates; an HR manager can | DOCS | 4 | — | no |
| DOCS-6 | Help sends the owner to Settings → Property, which only the operator sees | DOCS | 3 | H25 | no |
| DOCS-7 | A swap refused without a code says "Try again", which fails the same way | DOCS | 4 | — | no |
| DOCS-8 | The operator's HR guide gives rules changed in S749, S751, S781 and S791 | DOCS | 4 | — | no |
| DOCS-9 | The setup card says "+ Add Employee (bottom right)"; it is in the header now | DOCS | 4 | — | no |

## S798.1 Owner decisions (taken with Aashish, 2026-09-30; ordered by money at stake)

All 25 taken on 2026-09-30, each as recommended; the question text is kept below as the record. BONUS-LEDGERS-1, LEAVE-OT-HOLIDAYS-2, LEAVE-OT-HOLIDAYS-3 and GAP-PAY-STATE-1 need no
decision: they complete rules already set (S752).

**H1. Once some staff are already paid, what should the bank transfer sheet list?** Unblocks REPORTS-1.
Example: Bhadra's 15 staff are paid by bank on 5 Ashwin. On 12 Ashwin you reopen Bhadra to add a cook's
missed overtime. The bank file still lists all 15 at full pay, about NPR 3,12,000: uploading it pays twice.

- (a) List only what each person is still owed, and name anyone left off.
- (b) List everyone at full pay, with a Paid column and a warning.
- (c) Leave it as it is.

**Decided 2026-09-30 (as recommended): (a).** The sheet can then never pay someone twice.

**H2. Should someone with the HR manager login be able to set their own pay?** Unblocks BONUS-LEDGERS-5,
PEOPLE-ACCESS-2, LEAVE-OT-HOLIDAYS-5.
Example: Sita keeps the books with the HR manager login. She cannot approve her own leave, but she can raise
her own basic from 35,000 to 45,000, double her own Dashain allowance, or mark her own absent days Present,
then finalize the run that pays her. A floor manager with the HR supervisor login can mark his own days too.

- (a) Only you change their own pay setup and finalize a run that pays them; their own attendance marks
  are listed for you before you finalize payroll.
- (b) They can, but the sheet you sign lists every pay change since last month and every own-row mark.
- (c) Leave it as now.

**Decided 2026-09-30 (as recommended): (a).** One rule that cannot be dodged by changing the salary first; daily marking stays easy.

**H3. Crest's own support login: may it change a month already paid, and what happens to the open page when
it switches between your companies?** Unblocks GAP-OPERATOR-1; also GAP-OPERATOR-2's remount.
Example: Crest opens BHATTI CHOILA's Bhadra draft at 4:50. At 5:00 the Owner finalizes and marks it paid. At
5:05 Crest, still on the old screen, presses Regenerate: Ram's loan cut and travel claim drop out and his paid
payslip now owes NPR 1,800 more. Your managers would have been refused.

- Paid months: (A) Crest takes your managers' Reopen path, except when restoring a backup into an empty
  company; (B) a "Crest correction" button with a reason, logged; (C) as now.
- Company switch: (a) go to the Dashboard; (b) restart the same page fresh; (c) fix pages one by one.

**Decided 2026-09-30 (as recommended): (A) and (b).** Crest follows your staff's rule; unsaved work for the old company could not
be saved correctly anyway.

**H4. You reopen a paid settlement, fix it and finalize again. What should Crest show?** Unblocks
SETTLEMENT-1.
Example: waiter Bikash is settled at NPR 1,20,000 and paid by bank. You then add 6 forgotten leave days
(NPR 6,000) and finalize again. Crest still shows Paid, the NPR 6,000 appears nowhere, and while reopened the
settlement could be deleted with the record of the first payment.

- (a) Keep the first payment and show "NPR 6,000 still to pay" (or "overpaid") until you record a top-up.
- (b) Clear the paid mark on Reopen, so you record the whole payment again.
- (c) Do not allow Reopen once a settlement is paid.

**Decided 2026-09-30 (as recommended): (a).** Nothing is lost and the gap is visible. In every option it can no longer be deleted.

**H5. You reopen a leaver's settlement after that month's payroll left them out, and they then stay.**
Unblocks GAP-PAY-STATE-4.
Example: Ram (NPR 26,000) leaves on 10 Ashwin; his settlement pays 1–10 Ashwin, so Ashwin's payroll skips
him. On 5 Kartik he stays after all: you reopen it and set him Active. Nobody now pays his Ashwin salary.

- (a) Warn at Reopen, naming that payroll month, and flag it until he is paid somewhere.
- (b) Refuse to reopen until you reopen that month's payroll first.
- (c) Keep it as today.

**Decided 2026-09-30 (as recommended): (a).** Most reopens end in the same month again, which is already right.

**H6. Should every supervisor or manager login of someone on your payroll be tied to their employee record,
at each outlet that pays them?** Unblocks SISTER-2, GAP-OUTLETS-1 (and H22).
Example: Anita got HR Supervisor through "Existing User", and her record has no email. Crest does not know the
login is hers: she can approve her own leave and NPR 6,000 claim, and her login is not blocked when she
leaves. At a second outlet, Sita (Thamel's HR manager, also paid by Lakeside) could write off her own
NPR 50,000 advance at Lakeside.

- (a) HR Staff gets a Link button and warns about unlinked logins, including ones from other outlets; a link
  per outlet comes before the first group goes live.
- (b) Make the link compulsory when such a login is created, with a "not on our payroll" choice.
- (c) Keep relying on matching emails.

**Decided 2026-09-30 (as recommended): (a).** It fixes existing logins too, at one click per person.

**H7. Should Generate from Roster fill days that have not happened yet?** Unblocks ATTENDANCE-5.
Example: Generate on 12 Kartik marks 13–30 Kartik Present. Ram, a dishwasher on NPR 900 a day leaving on
15 Kartik, is paid 15 days he never worked (NPR 13,500) if payroll runs before his settlement.

- (a) Fill only up to today, as Import from machine does.
- (b) Fill the month, but say how many days are still in the future.
- (c) Keep it as it is.

**Decided 2026-09-30 (as recommended): (a).** In every option, days before joining or after leaving are skipped (that ships first).

**H8. Once a manager's own leave is approved, may they cancel it themselves?** Unblocks SISTER-1.
Example: Ramesh (HR supervisor login) takes 10 days of approved paid leave, then cancels it himself. His
balance returns, and if he leaves this year those days are paid again (about NPR 11,540 on NPR 30,000).

- (a) Only you or another manager cancels an approved leave; anyone may withdraw their own while it waits;
  approved leave can be cancelled but not re-dated or deleted.
- (b) Only stop people cancelling their own approved leave.
- (c) Leave it as it is.

**Decided 2026-09-30 (as recommended): (a).** It is the S752 rule you already set, applied to Cancel.

**H9. Someone is set Inactive or Resigned with no last working day, after working part of the month.**
Unblocks PAYROLL-1.
Example: Ram (NPR 15,000) works 1–18 Bhadra and walks out; he is set to Resigned. There is no last-day box,
payroll skips him without a word, and his 18 days (about NPR 8,700) are never paid.

- (a) Stop and name him until you enter his last day or settle him; the form shows the last-day box.
- (b) Pay him automatically up to his last marked day.
- (c) Leave him out, with a warning naming his marked days.

**Decided 2026-09-30 (as recommended): (a).** You decide the last day, nothing is guessed, and he is paid for his work.

**H10. A working shift has no length set. What should Attendance assume?** Unblocks ATTENDANCE-2.
Example: the ready-made "Split" shift has no hours. A cook works 10:00–21:00 with a 3-hour break and gets
8 hours plus 8 of overtime (about NPR 8,100 extra over eight days). Generate marks the day Off instead, so a
daily-wage helper is paid nothing.

- (a) An ordinary 8-hour day, with a note asking you to set the shift's hours.
- (b) Hours from the times, overtime left for you to type; Generate leaves the day blank.
- (c) Calculate nothing, and refuse Generate, until the hours are set.

**Decided 2026-09-30 (as recommended): (a).** That is how a day with no roster entry already works.

**H11. A leaver has leave, overtime or a travel claim still undecided when you settle them.** Unblocks
GAP-PAY-STATE-2, BONUS-LEDGERS-3.
Example: Bikash (NPR 26,000) asks for 4 days off in his last week; 6 hours of his overtime await approval;
Hari's NPR 1,800 bus claim is pending. Today the 4 days are paid as worked and cashed out again (NPR 4,000
extra), the overtime and the claim go unpaid, and the leave and overtime cannot be approved afterwards.

- (a) Refuse to finalize until each is approved or rejected, and name them on the screen.
- (b) Warn and let you finalize.
- (c) Keep it as today.

**Decided 2026-09-30 (as recommended): (a).** One click per request, and the settlement pays exactly what was decided.

**H12. You change a shift's hours part-way through a month. Which days change?** Unblocks ROSTER-1.
Example: "Full Day" drops from 12 to 11 hours from 15 Kartik. Today 1–14 Kartik change too, so month-end
Generate pays them an hour short (about NPR 1,750 for a worker on NPR 20,000).

- (a) Only days from a date you pick (Crest makes a new shift for them).
- (b) Every day, but Crest first says how many past days will change.
- (c) Keep it as it is.

**Decided 2026-09-30 (as recommended): (a).** It matches the floor. Until built, Crest refuses such an edit and asks for a new shift.

**H13. A travel claim was approved by mistake. What can a manager do before payroll pays it?** Unblocks
BONUS-LEDGERS-2.
Example: rider Ram sends a NPR 3,200 claim and a corrected NPR 2,700 copy; both are approved together, and
payroll will pay NPR 5,900.

- (a) "Undo approval" back to Pending, for an HR manager or you, until a finalized payroll pays it.
- (b) Allow rejecting an approved claim directly.
- (c) Keep it as now.

**Decided 2026-09-30 (as recommended): (a).** Leave and Overtime already work this way.

**H14. Staff marked Present who never punched in: should the fingerprint import say so?** Unblocks
ATTENDANCE-4.
Example: you fill Kartik with Generate, then import the machine file. Suman missed the 18th and 19th, keeps
both Present marks and is paid for them (about NPR 1,550), and the import is silent.

- (a) List such days in the review with a tick, off by default, to mark them Absent.
- (b) List them for information only.
- (c) Keep it as it is.

**Decided 2026-09-30 (as recommended): (a).** Nothing you marked changes unless you tick it.

**H15. Can you settle a leaver while an earlier month's payroll is still a draft?** Unblocks SETTLEMENT-2.
Example: Sita (basic NPR 30,000, in SSF) is settled on 5 Bhadra while Shrawan's payroll is a draft. The
settlement pays Shrawan's gratuity share (about NPR 1,000), Shrawan's payroll pays it into SSF again, and the
year's tax leaves Shrawan out. A month reopened after payday also gets its travel claims paid twice.

- (a) Refuse until every earlier month is finalized, naming the month.
- (b) Allow it with a warning naming the month.

**Decided 2026-09-30 (as recommended): (a).** Finalizing last month first is one click, and SSF and tax come out right.

**H16. Daily-wage staff underpaid on half-day leave in months already paid: top up, or fix from now on?**
Decides back pay for ENGINE-1 (the formula fix ships in Stage 1 regardless).
Example: a kitchen helper on NPR 1,000 a day took a paid half day in Bhadra and worked the other half; she
was paid NPR 500 for the day, not NPR 1,000.

- (a) Crest lists everyone owed, with amounts, and you pay a one-off top-up.
- (b) Fix only from now on.

**Decided 2026-09-30 (as recommended): (a).** It is wages owed. **Checked live the same day: nobody is
owed.** No client has a daily-wage employee, a daily payslip or a daily settlement.

**H17. Should Crest apply the 10% income-tax discount for women?** Unblocks ENGINE-2.
Example: a woman whose only income is her salary gets 10% off her income tax. Crest never applies it: a
manager on NPR 70,000 a month has about NPR 840 a year too much taken, someone on 15 lakh about NPR 6,000.

- (a) Apply it to every employee marked Female.
- (b) Only when you tick "salary is her only income".
- (c) Leave it off.

**Decided 2026-09-30 (as recommended): (a), once your accountant confirms it for FY 2083/84.** You cannot see other income anyway.

**H18. Should the Dashain allowance, incentives and a leaver's final pay count as labour cost?** Unblocks
LABOUR-FIGURES-1.
Example: a 12-staff cafe pays NPR 2,07,600 of Dashain allowance in Ashwin. Every labour figure outside HR
shows NPR 2,90,000 (24%, green) when the month cost NPR 4,97,600 (41%, red).

- (A) Yes, in the month paid, with a line "includes Dashain bonus NPR 2,07,600".
- (B) Spread the bonus: one-twelfth a month.
- (C) Leave them out, with a "not included" note under every figure.
- And a leaver's gratuity: in the month paid, or in HR reports only?

**Decided 2026-09-30 (as recommended): (A), gratuity in the month paid, named.** It matches what left your bank.

**H19. Labour cost for a joiner or unpaid days: full salary, or what was earned?** Unblocks LABOUR-FIGURES-3
(it reopens the S756 formula on this point only).
Example: two waiters on NPR 20,000 join on 16 Bhadra. Your payroll sheet counts NPR 10,323 each; every
dashboard counts NPR 20,000 each. Monthly staff's unpaid days count the same way; daily staff's do not.

- (A) Only what was earned, as on the payroll sheet.
- (B) The full salary, and rename the payroll sheet's figure.

**Decided 2026-09-30 (as recommended): (A).** One number everywhere, and daily and monthly staff are treated alike.

**H20. Can one HR manager settle another HR manager?** Unblocks SETTLEMENT-6.
Example: GM Ramesh and accountant Sita both hold the HR manager login. Sita settles Ramesh and his logins are
blocked, although HR Staff says only you change an HR manager's login. (Reopen undoes it.)

- (a) Only you finalize the settlement of someone with an HR manager login.
- (b) They can, but that login stays open and you are told to block it.
- (c) Keep it as today.

**Decided 2026-09-30 (as recommended): (a).** It is rare and matches the HR Staff rule; stock and till managers are unaffected.

**H21. You take back someone who left and was settled. Should their old Crest logins come back?** Unblocks
PEOPLE-ACCESS-4.
Example: Sunita, a waiter with a till PIN, is settled in Ashadh and returns for Dashain. Payroll pays her,
but she is missing from the till, and only reopening her old settlement unblocks her PIN.

- (a) Yes, automatically when you save her new join date.
- (b) An Unblock button on each "Blocked at settlement" login.
- (c) Delete the old login and make a new one (her name leaves her old bills).

**Decided 2026-09-30 (as recommended): (a).** Same person, and her name stays on her old bills.

**H22. Someone who works at two of your outlets leaves one. What happens to their login?** Unblocks
GAP-OUTLETS-3 (needs H6's per-outlet link; no group is live yet).
Example: Ramesh's login belongs to Thamel; he transfers to Lakeside. Settling Thamel blocks him at Lakeside
too. Sita stops at Lakeside, but settling Lakeside leaves her able to open its payroll.

- (a) Remove only that outlet; block the whole login only when they leave its home outlet and have no other
  job in the group.
- (b) Always block the whole login.
- (c) Nothing automatic; the settlement names the login and you untick the outlet.

**Decided 2026-09-30 (as recommended): (a).** Ramesh keeps working, and Sita loses Lakeside's payroll the day her job there ends.

**H23. Someone asks in Crest Staff to swap with a coworker who does not use the app.** Unblocks ROSTER-3.
Example: Ram asks to swap with Hari, who never had Crest Staff (or has left). Hari can never answer, and both
shifts are blocked from any other swap until the day passes.

- (a) Only list coworkers who have Crest Staff.
- (b) List everyone; the manager accepts or cancels for them.
- (c) List everyone; the request lapses when the day passes.

**Decided 2026-09-30 (as recommended): (a).** Nothing gets stuck, and the manager can still swap them on the Board. In every option
the asker gets a Withdraw button and leavers are not listed.

**H24. Present days with no clock times: what should the Owner Report assume?** Decides only imputing hours
for LABOUR-FIGURES-7 (its "hours not recorded" fix ships in Stage 2).
Example: 12 staff are marked Present all month with no times; the report shows a few dozen hours worked
against 2,700 rostered.

- (a) Say "hours not recorded" and leave out hours-based figures.
- (b) Assume the rostered shift, here and in Roster's forecast.

**Decided 2026-09-30 (as recommended): (a).** (b) would change the Roster forecast too.

**H25. Who types in your company PAN and address?** Unblocks DOCS-6.
Example: they print on payslips and tax certificates. Only Crest can enter them, but Help sends you to
Settings → Property, which you cannot see.

- (A) Keep it with Crest; Help says "ask Crest support".
- (B) Give you a Property screen with the old-bills warning.

**Decided 2026-09-30 (as recommended): (A).** That screen also holds your bill prefix and VAT switch, which reprint old bills.

## S798.2 Stage 1 — security, and money paid or stored wrong

| ID | What to change | Status |
| --- | --- | --- |
| ENGINE-1 | Daily `workedDays` adds half_paid_leave×1 and half_unpaid_leave×0.5 (`payrollCompute.js:212`); add half_unpaid_leave×0.5 to `present_days` (`:190`); daily tests for both. Fix `PayslipCalculation.jsx:142` and `hrGuideData.js:395` (with the holiday credit). Back pay: H16. | ✅ S798 stage 1a (crest-v362). Back pay (H16): none owed, no client has a daily-wage employee (live, 2026-09-30). |
| PEOPLE-ACCESS-1 | RESTRICTIVE `hr_employees_write_rank_insert/update/delete` with S751's `rank_ok`; reads stay open (S750). PayForm and EmployeeForm `.select('id')`, 0 rows = not saved. Add `hr_employees` to supabase-sql.md's money tables. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. Supervisor PATCH of basic = 0 rows, supervisor read works, manager PATCH = 1 row, supervisor INSERT refused (42501). |
| BONUS-LEDGERS-1 | `hr_advances_guard_own` → INSERT/UPDATE/DELETE, OLD and NEW employee, also freezing installment_amount, issued_date, type; new `hr_advance_repayments_guard_own`; keep the `current_user` return. Page: `isOwnAdvance` hides Record Repayment and Delete. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. Own delete, instalment change, move and repayment all refused; another manager records and edits normally. |
| ATTENDANCE-1 | A failed attendance read renders the error card instead of the grid (no writes); clear `records` on month switch; `loadAttendance` returns ok/failed; Generate upserts with `ignoreDuplicates: true` and reports skips. | ✅ S798 stage 1a (crest-v362). |
| ATTENDANCE-3 | Grid/daily-cell import moves a pre-cutoff first punch to the previous day's out only after an evening in; `planImport` flags early in-times and spans > shift + 4 h and shows in/out times. Get a real late-shift export first; add a 17:00–01:00 fixture. | ✅ S798 stage 1d (crest-v365). Made-up 17:00–01:00 fixture (owner decision); also flags a 21:00–07:00 day by its rostered shift. |
| LEAVE-OT-HOLIDAYS-1 | DEFINER RPC `hr_backfill_approved_leave(p_period_id)` called by closePeriod, checking the caller's client and repeating every back-fill rule; EXECUTE to authenticated only. Interim: tell IMS closers leave was not checked, word payrollPreflight as "couldn't check", show unmarked leave on Payroll Run. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. Run as an IMS supervisor it marked 5 days (a holiday as Holiday, a half day, a day already Present left alone, a settled leaver left out); a second run marked 0. Interim JS items not needed: S792 D42 already keeps the payroll note from IMS closers. |
| LEAVE-OT-HOLIDAYS-2 | `hr_overtime_guard_own`: below the Owner, refuse changing employee, hours, type or day on an approved own row (OLD or NEW); mirror in `hr_leave_requests_guard_decision`. Page hides Approve/Edit on own rows and drops them from the batch. SISTER-1 rides along if H8 is answered. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. Own approved OT edit, moving a colleague's onto yourself and moving-and-approving your own pending entry all refused. |
| SELF-SERVICE-1 | Unsubscribe push (best effort), then `signOut()`; on error remove the auth storage key and `location.replace` to the PIN pad. Same in `AuthContext.signOut`. Test in airplane mode. | ✅ S798 stage 1a (crest-v362), `src/shared/deviceSignOut.js`. Checked 2026-09-30 against the installed supabase-js with the network cut: offline and a 500 both return an error and keep the stored session; the helper's clear removes it; online signs out normally. |
| SELF-SERVICE-2 | `employee_pay_history`: add NOT is_hr_self_service / is_hr_staff_rank / is_pos_pin_staff / is_ims_staff to the client branch inside the COALESCE; rebuild from the live body; the Owner's delete guard must still refuse. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. HR staff-rank and Self-Service callers get 0 rows; a manager still gets the history; the Owner's delete of an employee with pay history is still refused. |
| DATABASE-1 | admin-user-ops `relink_staff_accounts` run by Restore: relink `hr_employee_id`, and `settlement_blocked_by` while finalized; export it; re-ban a recreated leaver; count every staff-login kind. Interim copy on the Archive card and data-export.md. Shares code with SISTER-2. | ✅ S798 stage 1c (crest-v366), admin-user-ops v62 deployed 2026-09-30. Not run end to end (needs a real Archive and Restore); the Restore message names what it re-linked. |
| GAP-PAY-STATE-1 | Delete the paid → approved branch in `hr_tada_claims_guard` (both Reopens are DEFINER); reword hr-payroll.md:654. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. A payroll-paid claim moved back to Approved is refused (tada_transition_invalid). hr-payroll.md reworded. |

**Migration `hr_integrity_s798`:** `hr_employees` write policies (PEOPLE-ACCESS-1); `hr_advances_guard_own`, new
`hr_advance_repayments_guard_own` (BONUS-LEDGERS-1); `hr_overtime_guard_own`, `hr_leave_requests_guard_decision`
(LEAVE-OT-HOLIDAYS-2, + SISTER-1); `hr_tada_claims_guard` (GAP-PAY-STATE-1); `employee_pay_history`
(SELF-SERVICE-2); new `hr_backfill_approved_leave` (LEAVE-OT-HOLIDAYS-1). Inventory every writer first; rebuild
functions from their live bodies. Rolled-back dry run on CASA ACAI CAFE's real logins (supervisor PATCH of
`basic_salary` = 0 rows, supervisor SELECT still works, manager PATCH works; strip the stand-in's other staff
markers). **Apply live only on the owner's "apply" (apply-migration skill), then verify against the live
catalog:** `hr_employees` policies, trigger events on the four guarded tables, the rebuilt bodies, and
`has_function_privilege` (anon, PUBLIC revoked) for both functions. **Edge Functions:** admin-user-ops.

**Files:** `payrollCompute.js` (+ test), `PayslipCalculation.jsx`, `hrGuideData.js`; `PayForm.jsx`,
`EmployeeForm.jsx`, `Advances.jsx`; `AttendanceSheet.jsx`, `attendanceImport.js`, `attendanceImportPlan.js`,
`AttendanceImportModal.jsx` (+ tests); `closePeriod.js`, `Periods.js`, `ClientDashboard.jsx`,
`backfillApprovedLeave.js`, `PayrollRun.jsx`; `Overtime.jsx`, `LeaveManagement.jsx`; `SelfServiceHome.jsx`,
`AuthContext.js`; `admin-user-ops/index.ts`, `ClientDrawer.js`, `exportClientData.js`; rules hr-payroll.md,
supabase-sql.md, data-export.md.

## S798.3 Stage 2 — wrong figures and lost work

**Stage 2 decisions (taken with Aashish, 2026-10-01, all as recommended).** Eight rows left a choice open; the
other 29 have one fix.

- **H26 (SETTLEMENT-5):** once someone is rehired, their earlier settlement cannot be reopened; a correction is
  paid by hand and noted. (Reopening today recomputes it on the new spell and re-bans a working login.)
- **H27 (PEOPLE-ACCESS-3):** on a rehire, clear the stale End Date in the same save and say so, rather than
  refusing the save.
- **H28 (GAP-OPERATOR-3):** backfill `paid_amount` (from `net_payout` where never reopened, from `audit_logs`
  where reopened); count first; list, never guess, any reopened row with no log entry.
- **H29 (PAYROLL-4):** count live payslips whose net ≠ its parts before adding the trigger; if any, list them
  (name, month, difference) for the owner and change nothing.
- **H30 (ROSTER-9):** HR supervisors and managers see each past day's total sales and covers (totals only).
- **H31 (LABOUR-FIGURES-7):** withhold hour-based figures when more than half the working days have no times;
  always print the count.
- **H32 (REPORTS-3):** the strip moves to the running month at Finalize, not at Mark paid.
- **H33 (BONUS-LEDGERS-4):** yes, show "Settled on (date)" on Incentive Run.

**Slices, one short chat and one migration each** (this replaces the single `hr_figures_s798` below). **2a DONE 2026-10-01** (crest-v367, migration live). **2b DONE 2026-10-01** (crest-v368, migration live). **2c DONE 2026-10-01** (crest-v369, migration live):

1. **2a Settlements:** GAP-OPERATOR-3, SETTLEMENT-3, -4, -5, GAP-PAY-STATE-3, ENGINE-3, PEOPLE-ACCESS-3.
   Migration `hr_settlements_s798`. Rebuild `finalize_final_settlement` for Stage 2 only; Stage 3 rebuilds it
   again from the live body.
2. **2b Payroll and tax:** PAYROLL-3, -4, -5, ENGINE-4, ENGINE-5, BONUS-LEDGERS-4, PAYROLL-2, REPORTS-3.
   Migration `hr_payroll_s798`.
3. **2c Attendance and leave:** ATTENDANCE-6, GAP-OPERATOR-2 (with the H3(b) remount), LEAVE-OT-HOLIDAYS-3, -4,
   DATABASE-2, -3. Migration `hr_leave_s798`. GAP-OUTLETS-2 moved to 2f (owner, 2026-10-01).
4. **2d Crest Staff and rosters:** ROSTER-2, -4, -8, ATTENDANCE-7, SELF-SERVICE-3, -4, -5. Migration
   `hr_roster_s798`; hr-push.
5. **2e Labour figures:** ROSTER-6, -7, -9, LABOUR-FIGURES-2, -4, -5, -6, -7. Migration `hr_labour_s798`. Before
   the next month close: the Owner Report freezes its figures then.
6. **2f Outlet switch:** GAP-OUTLETS-2. No migration; admin-user-ops (409 on a client mismatch) and the shared
   auth layer (`AuthContext.js`, `sessionKeepAlive.js`), since IMS and POS share the root. Split off 2c because
   it is app-wide, not HR.

| ID | What to change | Status |
| --- | --- | --- |
| LABOUR-FIGURES-2 | Group Dashboard takes labour from `get_group_pnl` (payroll, else Labor tab); "not finalized" and no band when payroll is null on an HR outlet; group % only when every outlet has one. Consolidated P&L: a "no finalized payroll" marker and no Net Profit colour. | 🔴 |
| ENGINE-3 | `leaveUsed` gets an optional {from, until} window (current join date to last day, straddles prorated); the settlement selects `end_date` and passes both; `leaveEncashed` gets the same `from`. | ✅ S798 stage 2a (crest-v367). `leaveUsed({ from, until })` prorates a straddling request; `leaveEncashed({ from })`. Optional Cancel-future-leave action not built. |
| ENGINE-4 | `bonusTax.js:152`: end exclusive via `dayAfter(endRaw)`; test an end one day before an anniversary. | ✅ S798 stage 2b (crest-v368). `completedServiceMonths` measures to `dayAfter(end_date)`; tested with the last day one day before an anniversary (8 months, not 7). |
| ENGINE-5 = PAYROLL-6 | `fetchYtdMap` and `payslipYtdForFy` fold finalized settlements from earlier FY months (paged): month pay, SSF, retirement, `month_tds`, +1 month; lump sums to `e.bonus`, `lump_tds` to `e.bonusWithheld`. | ✅ S798 stage 2b (crest-v368). `fetchFinalizedSettlements` feeds `fetchYtdMap` and `payslipYtdForFy`; a bonus counts only a settlement from before its pay month. Also fixed: a rehire's bonus "months still to come" (`monthsStillToPay`) counted the first spell's payslips against the second. |
| PAYROLL-2 = REPORTS-2 | One "month's deposit" helper (payslips + the month's finalized settlements + finalized festival/incentive rows) for the approval sheet, PayrollMonthStatus, the SSF card and HR Reports; print the parts; a failed read never falls back to payroll-only. | ✅ S798 stage 2b (crest-v368). `monthDeposit.js` (+ `fetchMonthDepositExtras`) for the approval sheet (read at print, parts named, "could not be read" on a failure), the strip's SSF step and the HR Dashboard SSF cards. HR Reports kept its own sheets (the reference) and shares `settlementLump`. |
| PAYROLL-3 | `hr_payroll_runs_guard_settled` → BEFORE INSERT OR UPDATE: refuse a non-draft insert, any `period_id` change and a direct `finalized_at` change. | ✅ S798 stage 2b (crest-v368), migration `20261001140000_hr_payroll_s798`, applied live 2026-10-01 after a 13-case rolled-back dry run as CASA logins: a finalized insert, a period move (finalized and draft) and a finalized_at edit refused; Finalize and Reopen still work. |
| PAYROLL-4 | `payslipDrift` returns 'moved' when net ≠ its parts (> 0.01); a trigger on `hr_payslips` refuses such a net (operator exempt); `finalize_payroll_run` refuses a run holding one. Count live rows that fail it first. | ✅ S798 stage 2b (crest-v368), migration `20261001140000_hr_payroll_s798`, applied live 2026-10-01 (H29: 13 live payslips counted, none off). `hr_payslips_guard_net` refused a net-only edit and allowed a typed TDS and the operator; `finalize_payroll_run` refused a bad net by name; `payslipDrift` and `driftParts` name it on the page. |
| PAYROLL-5 | Page the approved-overtime read in `readInputs` (`PayrollRun.jsx:238`), `.order('id')`. | ✅ S798 stage 2b (crest-v368). Paged with `.order('id')`. |
| BONUS-LEDGERS-4 | `ytdFromPayslips({ includeSameMonth: true })` from FinalSettlement only. Optional: mark settled leavers on Incentive Run. | ✅ S798 stage 2b (crest-v368). `fetchYtdMap(…, { includeSameMonthBonuses: true })` from Final Settlement only; H33: Incentive Run shows "Settled on (date)" for a settled leaver of the current employment. |
| SETTLEMENT-3 | New `hr_unpaid_days_on_file` (twin of `hr_ot_on_file`); finalize refuses `settlement_stale_attendance`; the page re-reads at the confirm. | ✅ S798 stage 2a (crest-v367), migration `20261001120000_hr_settlements_s798`, applied live 2026-10-01 after a 10-case rolled-back dry run as CASA logins. New `hr_attendance_on_file`; the formula reproduced a real stored settlement (1.00 unpaid day) before applying; a Present turned Absent was refused (1.00 vs 2.00). The confirm re-reads the sheet and offers Recalculate now. |
| SETTLEMENT-4 | Cap `monthTds` at what the whole payout bears, not the final month's net (`settlementCompute.js:111`); add a test. | ✅ S798 stage 2a (crest-v367). Capped at what the taxable payout bears, never from travel claims; tests added. |
| SETTLEMENT-5 | Refuse Reopen, and Finalize as backstop, once rehired (`settlement_rehired`); render an earlier spell from stored columns, never auto-opened. Narrows S791: an earlier-spell correction is paid by hand. | ✅ S798 stage 2a (crest-v367), migration `20261001120000_hr_settlements_s798`, applied live 2026-10-01 after a 10-case rolled-back dry run as CASA logins (H26). Reopen and Finalize refuse `settlement_rehired`; the page shows the earlier spell as stored. |
| ATTENDANCE-6 | Generate: `ignoreDuplicates` (with ATTENDANCE-1) and report skips. Save: first marks in their own ON CONFLICT DO NOTHING upsert, naming days already taken. | ✅ Generate half S798 stage 1a; Save half S798 stage 2c (crest-v369): a cell blank at load is written ON CONFLICT DO NOTHING (`splitFirstMarks`), and a day marked meanwhile elsewhere is kept, shown and named (`firstMarksKeptOut`; a row identical to the cell is the sheet's own earlier Save, not a clash). |
| ATTENDANCE-7 = ROSTER-5 | One classifier ported from `hr_shift_kind` (off only for zero-hour, no start time, named off/holiday; leave by name; else work) in the import, todayView, RosterWeek, the swap picker and `isOnDutyShift`; `get_coworker_roster` returns the kind. | 🔴 |
| ROSTER-2 | SwapRequestsPanel `onDecided` reloads the Board and forecast; Clear deletes on id AND employee AND day. | 🔴 |
| ROSTER-4 | Return published day numbers (new RPC or a per-day flag in `get_my_roster`); key Crest Staff's views by day; read the error (with SELF-SERVICE-4). | 🔴 |
| ROSTER-6 | Drive Recommended, Status, Rec and Suggest from the outlet-wide need; the department need only under Hours. | 🔴 |
| ROSTER-7 | Past days load every employee with attendance in range, whatever their status. | 🔴 |
| ROSTER-8 | hr-push checks the active outlet, else the home client; page the fan-out read; say "staff were not notified" on failure. Redeploy hr-push. | 🔴 |
| ROSTER-9 | Caller-checked DEFINER `hr_labour_actuals(client, from, to)` (revenue and covers, HR supervisor+); until then "—" for HR logins. Close IMS_TODO.md:317 with it. | ⚪ |
| LEAVE-OT-HOLIDAYS-3 | Refuse your own request on the page before any write and skip it in the batch; if the status update fails after the upsert, put the days back and say so truthfully. | ✅ First half S798 stage 1b; second half S798 stage 2c (crest-v369): `approveCore` reads the days first, and when the status update fails it re-reads the request — approved after all stands, still pending puts the days back as read; a failed put-back names the days to correct. |
| LEAVE-OT-HOLIDAYS-4 | `revertAttendance` acts only on the four leave statuses: delete them, but set a now-holiday day to 'holiday'. | ✅ S798 stage 2c (crest-v369). `planLeaveRevert`: only leave-status days change, a day that is a holiday now becomes Holiday (no clock), hand re-marks and Holiday rows stay; the Cancel/Reject confirm says so. |
| PEOPLE-ACCESS-3 | The rehire path refuses (or clears, saying so) a stale End Date; refuse end_date < join_date; name both steps in the refusal, `Help.js:349`, `hrGuideData.js:634`. | ✅ S798 stage 2a (crest-v367), H27: the save clears the stale End Date and the form says so first; End Date before Join Date refused. |
| SELF-SERVICE-3 | Hold today in state; on resume recompute it and move the week and Home days when the BS day changed; test the handler. | 🔴 |
| SELF-SERVICE-4 | Destructure both errors in loadRoster; "Could not load suppliers" in the TADA sheet. With ROSTER-4. | 🔴 |
| SELF-SERVICE-5 | Sign-out unsubscribes push first; `subscribeToPush` re-subscribes on an RLS upsert error. | 🟡 Sign-out unsubscribes first (S798 stage 1a); the re-subscribe on an RLS upsert error is open. |
| DATABASE-2 | `hr_leave_requests_validate`: on an operator INSERT skip only the all-holidays refusal and store 0 days. Never key it on `current_user`. Rolled-back probe. | ✅ S798 stage 2c (crest-v369), migration `20261001160000_hr_leave_s798`, applied live 2026-10-01 after an 8-case rolled-back dry run (operator, CASA Owner, system role). Keyed on `is_admin()`; the operator's all-holiday insert stores 0 days, the Owner is still refused, and approving a pending one stays refused. Counted first: no live request was at risk. |
| DATABASE-3 | `hr_leave_types_guard_delete` (as `hr_shift_types_guard_delete`): refuse while referenced, "untick Active instead". | ✅ S798 stage 2c (crest-v369), same migration and dry run: an in-use type is refused (`leave_type_in_use`, worded in `errorText.js`), an unused one deletes, the system role passes. Counted first: no request or settlement had lost its type. |
| REPORTS-3 | Look only at the month before today's: show it if its payroll is not finalized, else the running month. Fix the test, docstring, `Help.js:337`, `hrGuideData.js:49`, component-library.md:28. | ✅ S798 stage 2b (crest-v368), H32. `pickStatusPeriod` looks only at last month (by year and month) and the running month; test, docstring, Help, hrGuideData and component-library.md corrected. |
| LABOUR-FIGURES-4 | Read overheads with `.or('bucket.is.null,bucket.in.(overhead,tax_fees)')` on OwnerDashboard and computeMonthlyReport; Tax & Fees line (schema bump). | 🔴 |
| LABOUR-FIGURES-5 | One local-date parser for 'YYYY-MM-DD' in both estimates, headcount and leave; test a month-end last day. | 🔴 |
| LABOUR-FIGURES-6 | Owner Report leave read: approved, `formatAd` bounds, `fetchAllRows` + `.order('id')`. | 🔴 |
| LABOUR-FIGURES-7 | Count Present rows with 0 hours, freeze it, and withhold hour-based figures as "hours not recorded" when most days lack hours. Imputing is H24. | 🔴 |
| GAP-PAY-STATE-3 | Under `hr_pay_lock`: settlement finalize refuses `settlement_festival_paid`; `hr_bonus_rows_guard` refuses `festival_paid_by_settlement`. Page: a stale draft unticks with "Paid since this draft was saved". | ✅ S798 stage 2a (crest-v367), migration `20261001120000_hr_settlements_s798`, applied live 2026-10-01 after a 10-case rolled-back dry run as CASA logins. Both directions refused; a stale draft unticks with "Paid since this draft was saved"; Festival Finalize re-reads settlements. |
| GAP-OUTLETS-2 | admin-user-ops 409 on a client mismatch; AuthContext checks `active_client_id` on wake and reloads; `switchOutlet` tells other tabs; fix the Outlet Access footnote. Shared layers. | 🔴 Moved to slice 2f (owner, 2026-10-01). |
| GAP-OPERATOR-2 | AttendanceSheet keeps the selected employee only if listed; `saveChanges` refuses keys for unlisted employees. Remount: H3. | ✅ S798 stage 2c (crest-v369). Both page fixes (`keysOutsideList` refuses the whole save), and H3(b): `Layout.js` keys `<Outlet>` on the client for the operator, so a client switch restarts the page. The optional cross-client database check was not built. |
| GAP-OPERATOR-3 | `hr_final_settlements_guard` fills `paid_amount` before the operator return; backfill paid, never-reopened rows; reopened rows from `audit_logs`. Ship before SETTLEMENT-1. | ✅ S798 stage 2a (crest-v367), migration `20261001120000_hr_settlements_s798`, applied live 2026-10-01 after a 10-case rolled-back dry run as CASA logins (H28). Stamp above the seam, fill-only; 1 live row backfilled (NPR 27,128.07), no reopened paid row existed. SETTLEMENT-1 (Stage 3) may now build on it. |

**Migration `hr_figures_s798`:** `hr_payroll_runs_guard_settled` (PAYROLL-3); `hr_payslips` net trigger and
`finalize_payroll_run` (PAYROLL-4); new `hr_unpaid_days_on_file`, `finalize_final_settlement`,
`reopen_final_settlement` (SETTLEMENT-3, -5, GAP-PAY-STATE-3); `hr_bonus_rows_guard` (GAP-PAY-STATE-3);
`hr_final_settlements_guard` + backfill (GAP-OPERATOR-3); `get_my_roster` or a published-days RPC (ROSTER-4);
`get_coworker_roster` (ROSTER-5); new `hr_labour_actuals` (ROSTER-9); `hr_leave_requests_validate` (DATABASE-2);
new `hr_leave_types_guard_delete` (DATABASE-3). Stage 3 touches `finalize_final_settlement` again (H11, H15, H20,
H22): if those answers are in, rebuild it once. **Apply live on "apply", then verify against the live
catalog:** trigger events on runs and payslips, the settlement bodies, RPC columns and grants, backfill count.
**Edge Functions:** hr-push (ROSTER-8), admin-user-ops (GAP-OUTLETS-2).

**Files:** `payrollData.js`, `bonusTax.js`, `PayrollRun.jsx`, `PayrollApprovalSheet.jsx`,
`PayrollMonthStatus.jsx`, `monthStatus.js`; `leaveBalance.js`, `LeaveManagement.jsx`; `FinalSettlement.jsx`,
`settlementCompute.js`, `FestivalAllowance.jsx`; `HrDashboard.jsx`, `HrReports.jsx`; `AttendanceSheet.jsx`,
`payrollConstants.js`; `Roster.jsx`, `laborForecast.js`, `SwapRequestsPanel.jsx`, `RosterWeek.jsx`,
`todayView.js`, `SelfServiceHome.jsx`, `webPush.js`; `EmployeeForm.jsx`, `employeeFormData.js`, `Help.js`;
`GroupDashboard.jsx`, `ConsolidatedPnl.jsx`, `OwnerDashboard.jsx`, `computeMonthlyReport.js`,
`computeLaborAnalyticsSection.js`; `AuthContext.js`, `sessionKeepAlive.js`, `OutletAccessPanel.jsx`;
`hr-push/index.ts`, `admin-user-ops/index.ts`.

## S798.4 Stage 3 — the decisions

Every H is answered (2026-09-30, all as recommended), so each group can be built.

| H | ID | What to change | Status |
| --- | --- | --- | --- |
| H1 | REPORTS-1 | Read `fetchRunPayments`; Paid and Still to pay per row; sheet and exports carry only what is owed and name who was left off; a failed read disables export. | 🔴 |
| H2 | BONUS-LEDGERS-5 | `hr_bonus_rows_guard`: a non-exempt caller cannot finalize or reopen their own row; Finalize says "The Owner finalizes a run that pays you". | 🔴 |
| H2 | PEOPLE-ACCESS-2 | Triggers refuse own changes to pay, bank, SSF and premium columns on `hr_employees` and own rows in `hr_salary_components` below the Owner; PayForm opens your own row read-only. | 🔴 |
| H2 | LEAVE-OT-HOLIDAYS-5 | (a): Payroll Run shows the Owner every own-row attendance change this month before Finalize (`audit_logs` or a `marked_by` column). (b) needs bulk writes to skip own rows first. | 🔴 |
| H3 | GAP-OPERATOR-1 | Operator exemption only on INSERT in the payslip, bonus, repayment (+ledger), run-delete, TADA (+items), settlement and salary-payment guards and the leave overlap test; none in `hr_advances_guard`. Re-read the advance before repay/delete; `.eq('status','draft')` on writeTds and inlineWrite; Regenerate re-reads status. Reword hr-payroll.md:646; test a restore. H3(b) adds `<Outlet key={clientId} />`. | 🔴 |
| H4 | SETTLEMENT-1 | When `paid_amount` ≠ `net_payout`, show still-to-pay or overpaid on the statement, print, history and Tracker; a top-up function or `hr_settlement_payments`; refuse deleting a paid draft (`settlement_paid_record`, every option). After GAP-OPERATOR-3. | 🔴 |
| H5 | GAP-PAY-STATE-4 | Reopen names finalized payroll months that skipped the person; EmployeeForm names them on reactivation; no delete of such a reopened draft; PayrollMonthStatus flags "employed, no payslip, no settlement". | 🔴 |
| H6 | SISTER-2 | admin-user-ops `link_hr_employee` (Owner/admin; shares DATABASE-1's code); HR Staff Linked column, Link button and an unlinked warning. Interim Help: put the login's email on the record. | 🔴 |
| H6 | GAP-OUTLETS-1 | Now: HR Staff and Outlet Access list logins from other outlets and flag any without a matching record email here. Before the first group: `profile_employee_links` and a third arm in `hr_is_own_employee`. | 🔴 |
| H7 | ATTENDANCE-5 | Pass join and end dates into `buildAttendanceFromRoster` and `fillBlankCells`, skip and grey days outside employment (no decision; ship first); per (a), stop at the Nepal date. | 🔴 |
| H8 | SISTER-1 | Below the Owner, refuse moving your own approved request to cancelled or pending; decided requests keep employee, type, dates, day type; delete only pending; no status change in a finalized month. Page hides Cancel on your own approved row. | ✅ S798 stage 1b (crest-v364), migration `20260930120000_hr_integrity_s798`, applied live 2026-09-30 after a rolled-back dry run as CASA logins. Own approved cancel, re-date and delete refused; own pending withdraw, a colleague's cancel and deleting a pending request work; a cancel in a finalized month is refused; an employee delete still cascades through approved leave. |
| H9 | PAYROLL-1 | `assessDraft` and Generate name unsettled off-payroll staff with marks this month and block Finalize; split the "departed" copy; per (a) End Date shows for every off-payroll status. | 🔴 |
| H10 | ATTENDANCE-2 | Unknown-hours shifts measure against `STANDARD_HOURS_PER_DAY`; Generate handles them per H10 with a separate count; a note says to set the hours; test the shipped Split. | 🔴 |
| H11 | GAP-PAY-STATE-2 | Settlement lists pending leave and OT and blocks Finalize until decided; a saved draft compares its leave days with the balance; finalize refuses `settlement_pending_requests`. | 🔴 |
| H11 | BONUS-LEDGERS-3 | Same for pending claims (`settlement_pending_tada`); TADA Claims says "Left — not paid by payroll; Mark Paid when handed over". | 🔴 |
| H12 | ROSTER-1 | An hours edit with past ungenerated days asks "from which day?" and splits the type. Interim, no decision: refuse it, "add a new shift type". Recalculate Hours when times change. | 🔴 |
| H13 | BONUS-LEDGERS-2 | `hr_tada_claims_guard` allows approved/rejected → pending at manager rank, clearing the stamp; "Undo approval" naming any draft run holding it. | 🔴 |
| H14 | ATTENDANCE-4 | Review lists "Present, no punch, rostered" with an off-by-default Absent tick; reword the Tip; word no-time Present differently. | 🔴 |
| H15 | SETTLEMENT-2 | At the confirm, name a draft or missing earlier FY month; finalize refuses `settlement_prior_month_open` (a reopened run counts). Optional: Payroll's Reopen names leavers with draft settlements. | 🔴 |
| H17 | ENGINE-2 | After the accountant: `annualTaxFor(…, isFemale)` = slabs × 0.9 in monthly, final-month and both bonus TDS paths; add `gender` to the employee reads; show the rebate line. | 🔴 |
| H18 | LABOUR-FIGURES-1 | One "other labour paid" read (festival and incentive by pay month; settlements by settle month, gratuity per H18) in every labour reader, the Owner Report (schema bump) and the group SQL rebuilt from live bodies; name it on tiles; drop the Labor tab's bonus hint. Old runs read bs_month 6. | 🔴 |
| H19 | LABOUR-FIGURES-3 | (A): labour = gross − absence + OT + employer SSF on every reader and the group SQL; Owner Report line; dashboards.md and `labourSource.test.js`. | 🔴 |
| H20 | SETTLEMENT-6 | Finalize refuses `settlement_manager_login` for a non-exempt caller; `settlement_linked_logins` returns the rank for the confirm. | 🔴 |
| H21 | PEOPLE-ACCESS-4 | (a): DEFINER `hr_unblock_rehired_logins(employee)` clears the latest earlier settlement's stamps after a rehire save. Every option: the badge on IMS Staff and HR Staff. | 🔴 |
| H22 | GAP-OUTLETS-3 | With per-outlet links: ban only at the home outlet with no other link, else remove that outlet's access and stamp it; Reopen restores what it stamped; the confirm says what happens. Move a "who can reach this outlet" list out of the Suite gate. | 🔴 |
| H23 | ROSTER-3 | `cancel_my_swap_request` + Withdraw; the manager tab lists and rejects "waiting on coworker"; refuse inactive (and per (a) app-less) coworkers; `respond_shift_swap` refuses a past day; the badge ignores past rows. | 🔴 |
| H25 | DOCS-6 | (A): `Help.js:461`, `:466` and the payslip-header tip say "ask Crest support". (B): show Property to the Owner. | 🔴 |

Also decided here without blocking a row: H16 back pay (ENGINE-1, Stage 1); H24 imputed hours
(LABOUR-FIGURES-7, Stage 2); H3(b) remount (GAP-OPERATOR-2, Stage 2).

**Migration `hr_decisions_s798`, after the answers:** own-pay triggers and `hr_bonus_rows_guard` (H2); the
operator seam in ten guards (H3); settlement delete refusal and top-up (H4); `reopen_final_settlement` (H5);
`profile_employee_links` and `hr_is_own_employee` (H6, before the first group); the leave guard and a DELETE
trigger (H8, unless in Stage 1); `finalize_final_settlement` and `settlement_linked_logins` (H11, H15, H20, H22);
`hr_tada_claims_guard` (H13); `hr_unblock_rehired_logins` (H21); `get_group_summary`/`get_group_pnl` (H18, H19);
the swap functions (H23). Rebuild each guard from its live body after Stages 1–2 (several are touched twice).
**Apply live on "apply", with a rolled-back dry run and a restore test for H3; verify every body, trigger and
grant against the live catalog.** **Edge Functions:** admin-user-ops (H6).

**Files:** `HrReports.jsx`; `PayForm.jsx`, `FestivalAllowance.jsx`, `IncentiveRun.jsx`, `PayrollRun.jsx`,
`PayrollMonthStatus.jsx`; `Advances.jsx`, `Layout.js`; `FinalSettlement.jsx`, `GratuityTracker.jsx`,
`EmployeeForm.jsx`; `HrStaff.jsx`, `ImsStaff.jsx`, `OutletAccessPanel.jsx`, `admin-user-ops/index.ts`;
`attendanceFromRoster.js`, `AttendanceSheet.jsx`, `attendanceImportPlan.js`; `LeaveManagement.jsx`;
`ShiftSettingsPanel.jsx`; `TadaClaims.jsx`; `tds.js`, `bonusTax.js`, `payrollData.js`; `labourSource.js` and its
readers, dashboards.md; `SelfServiceHome.jsx`, `SwapRequestsPanel.jsx`, `todayView.js`; `Help.js`.

## S798.5 Stage 4 — docs, copy and polish

| ID | What to change | Status |
| --- | --- | --- |
| DOCS-1 | `Help.js:362`: "A day stays blank until you mark it. Payroll pays monthly staff for a blank day but daily and hourly staff nothing, so mark every day they worked. All Present fills the blanks." | 🔴 |
| REPORTS-4 | Rewrite `hrGuideData.js:565-572` from the code (challan incl. settlements; add the SSF number; SSF Basic matches SOSYS; deductions and employer cost as coded); Help: six tabs; two Tips gain exit tax and settlements. | 🔴 |
| PAYROLL-7 | `nprPaisa` on the approval sheet, MarkPaidDialog, the short/over text and the strip. | 🔴 |
| PAYROLL-8 | `withTimeout` on payments, finalize/reopen, generate/regenerate (and Roster's Copy Week, publish); on timeout "could not confirm — reload". | 🔴 |
| BONUS-LEDGERS-6 | For a non-active employee: "Left — no payroll will cut this; record a cash repayment or write it off", also in the Reactivate copy. | 🔴 |
| SETTLEMENT-7 | BS last working day (AD in brackets) on every statement; BS in the history column. | 🔴 |
| ATTENDANCE-8 | On `hr_month_finalized`/`hr_month_settled` drop "press Save again", re-read the run; for settled, reload staff and say marks were dropped. | 🔴 |
| ATTENDANCE-9 | Leave and Holiday columns; Total Days counts every mark; an Unmarked count; Holiday in the export. | 🔴 |
| ROSTER-10 | Copy to Next Week skips zero-hour leave and holiday markers, or lists them with a tick. | 🔴 |
| LEAVE-OT-HOLIDAYS-6 | `approveCore` re-reads `monthly_periods` for missing months before writing. | 🔴 |
| LEAVE-OT-HOLIDAYS-7 | Leave settled leavers out of `findApprovedLeaveGaps`; `fillUnmarked` names them. | 🔴 |
| SELF-SERVICE-6 | Derive the password before reserving; count only `invalid_credentials`; else release (new `release_hr_pin_attempt`) and 503; fixed catch-all text. Same in pos- and ims-staff-login. | 🔴 |
| SELF-SERVICE-7 | DROP/CREATE `get_my_hr_payslips` with `unpaid_days`, `retirement_contribution`; assert first; REVOKE PUBLIC, GRANT authenticated. | 🔴 |
| SELF-SERVICE-8 | `formatBsDay(day, r.bs_month)` on both sides of the swap list. | 🔴 |
| DATABASE-4 | Drop `supervisor_id` from `ATTRIBUTION_EXTRA`; restore it in a second pass. | 🔴 |
| REPORTS-5 | Keep the runs error: "—" and "could not be read", never "No finalized payroll yet". | 🔴 |
| REPORTS-6 | Neutral "was due by …" once passed, as the strip. | 🔴 |
| REPORTS-7 | `useNavBadgeCounts` keeps the last good value on a failed count (HR and `posPending`). | 🔴 |
| REPORTS-8 | Disable the .xlsx exports while `clientInfoError` is set, with a notice. | 🔴 |
| REPORTS-9 | "monthly-paid staff, basic only"; BS dates in the leave queue. | 🔴 |
| REPORTS-10 | Reword hr-payroll.md (S768, S751), component-library.md:28, `hrGuideData.js:49`, the HrDashboard comment: rank fences writes; supervisors read pay (S750). | 🔴 |
| LABOUR-FIGURES-8 | Employer SSF on min(basic × days worked ÷ month days, cap) in both estimates. | 🔴 |
| LABOUR-FIGURES-9 | Tick the pay step only when no active employee has basic 0; say how many; optional Payroll Run warning. | 🔴 |
| LABOUR-FIGURES-10 | Show every failed close stage's sentence (Periods.js, ClientDashboard.jsx). | 🔴 |
| DOCS-2 | Add "pay staff, then Mark everyone paid" to the workflow, setup step 5, the monthend strip, tip :460 and `hrGuideData.js:49`. | 🔴 |
| DOCS-3 | `Help.js:481`: no daily/hourly gratuity yet, here or in Final Settlement; `:480` "active and probation". | 🔴 |
| DOCS-4 | Delete tip 402's POS sentence; tip 411 describes the fallback rule. | 🔴 |
| DOCS-5 | "The Owner or an HR manager" in `Help.js:491`, `TadaClaims.jsx:883` and `:125`; drop the Rate/KM tip. | 🔴 |
| DOCS-7 | Busy state and reload-on-error on Accept/Decline; errorText rules for the uncoded swap refusals (or raise the existing codes). | 🔴 |
| DOCS-8 | `hrGuideData.js` :395-396, :438, :467, :90, :329, :39, :673, :216 as the DOCS-8 fix says; also :633 (passed on by ATTENDANCE). | 🔴 |
| DOCS-9 | "+ Add Employee (top right; bottom right on a phone)" at `setupSteps.js:178` and the four IMS strips. | 🔴 |

After Stages 1–3, reword `Help.js:505` and `hrGuideData.js:663` ("payroll money records are Manager-only")
and `Help.js:500` ("an employee can only ever see their own data"), which DOCS flagged.

**Migration `hr_polish_s798`:** new service-role `release_hr_pin_attempt` (SELF-SERVICE-6); DROP/CREATE
`get_my_hr_payslips` (SELF-SERVICE-7). **Apply live on "apply"; verify return columns and grants.**
**Edge Functions:** hr-selfservice-login, pos-staff-login, ims-staff-login.

**Files:** `Help.js`, `hrGuideData.js`, `setupSteps.js`, `setupSignals.js`; `PayrollApprovalSheet.jsx`,
`SalaryPaymentDialogs.jsx`, `PayrollRun.jsx`, `PayrollMonthStatus.jsx`, `Roster.jsx`, `Advances.jsx`,
`FinalSettlement.jsx`, `AttendanceSheet.jsx`, `LeaveManagement.jsx`, `backfillApprovedLeave.js`;
`SelfServiceHome.jsx`, `errorText.js`, `TadaClaims.jsx`; `exportClientData.js`, `restoreClientData.js`;
`HrDashboard.jsx`, `useNavBadgeCounts.js`, `HrReports.jsx`; `OwnerDashboard.jsx`, `computeMonthlyReport.js`;
`Periods.js`, `ClientDashboard.jsx`; the three login functions; hr-payroll.md, component-library.md.

## S798.6 Settled — not re-raised

**Owner decisions already taken (never re-ask):** leave encashment = basic ÷ 26; gratuity vests at 12
months; exit lump sums are taxed on top of the year's income at slab rates; festival allowance = the share for
completed BS months worked, several runs a year allowed with a warning, daily/hourly amounts typed; public
holidays inside a leave are not charged; shortfall hours are never auto-deducted; Overtime's Undo differs from
Leave Reopen on purpose; a leaver's logins are blocked at settlement, never deleted; payroll labour counts
overtime and employer SSF everywhere (S756; LABOUR-FIGURES-3 reopens only the joiner/unpaid-days point, H19);
JEEVAN TAMANG (CASA ACAI CAFE) was not double-paid; CASA ACAI CAFE and BHATTI CHOILA each have two Owner logins
on purpose; supervisors read pay (S750); partial salary payments are not recordable (S782); a finalized month
is read-only for overtime (S749).

**Dropped, corrected, or seen and not raised:**

- ENGINE: hourly OT typed into hours worked (depends on entry); employer SSF before the one-third cap, the
  monthly OT divisor (accountant questions); a bonus in Ashadh or a final month not trued up (projection
  drift); no projected SSF relief for wage staff's bonus (negligible); `daysInBsMonth` 30 outside the table.
- PAYROLL: period dropdown enabled while busy; the losing tab's 23505 message; no lower bound on the Mark paid
  date — noted, no harm.
- BONUS-LEDGERS: the bonus-side half of BONUS-LEDGERS-4 merged into ENGINE-5; Incentive Run's settled mark is
  polish; supervisor edits a pending claim (approver sees it); manager inserts finalized rows (holds those
  powers); TADA km not stored (design); a repayment delete on a written-off advance is page-guarded (same
  manager may write off).
- SETTLEMENT: future leave → ENGINE-3, rehire YTD → ENGINE-5; the final-month bonus outside the YTD was not
  raised here but is BONUS-LEDGERS-4 (P2), not settled; one leave type per settlement; Tracker vs settlement
  gratuity differ by design.
- ATTENDANCE: the hours tables lack `no_hr_staff_rank` (DATABASE: hours, not money); cross-client attendance
  rows (GAP-OPERATOR-2's optional trigger); device-clock "today" (fold into ATTENDANCE-5); `hrGuideData.js:633`
  (fold into DOCS-8); daily half-day pay → ENGINE-1.
- ROSTER: settled — published-day edits unnotified, swaps trade a Day Off (S791), Holiday at 0 forecast hours
  (S749); noted — Roster `withTimeout` (PAYROLL-8), `loadForecast` unguarded (keyed by date), recipes unpaged
  (> 1,000 only), push reaches blocked leavers, `approve_shift_swap` takes a past day, swap approval ignores
  approved leave (coworker accepts first), `weekly_off_weekday` unread.
- LEAVE-OT-HOLIDAYS: the first LEAVE-OT-HOLIDAYS-4 scenario (refuted: back-fill reads the calendar); "Reject
  clears leave rows" (withdrawn); "daily cook silently unpaid" (corrected); a never-created month; flat quotas
  (disclosed); OT on a later full-day leave (narrow); no 2084 holidays (until gazetted).
- PEOPLE-ACCESS: daily SSF shown as 11% (refuted); SET NULL FKs to profiles (not displayed, audited); an
  insider's second unlinked login (noted); Owner tests without `ims_email`/`pos_email` (harmless);
  EmployeeJoiningForm is blank by design.
- SELF-SERVICE: two duplicates merged into ROSTER-3 (app-less coworker, respond after the day, badge) and
  ROSTER-8 (fan-out paging); hr-push callable by staff rank (fixed text); PIN lockout by strangers (inherent);
  trivial RPCs callable with a Staff token; notificationclick window choice (narrow).
- DATABASE: restore recounting other leave (refuted, S749 rule); the `current_user` seam for DATABASE-2 (never
  re-propose: it zeroes Crest Staff requests); MAINTAIN and default-ACL grants (known-open S782); RI cascades
  run as owner (don't rely on the seam); fail-closed bare IF; no unique key on salary payments (lock covers);
  claim items and roster unaudited (S749); anon picker (S464); Owner-only month rename; IMS custodian export.
- REPORTS: pending OT in a finalized month (S749: Reopen decides it); REPORTS-3 and REPORTS-10 side claims
  corrected; summary colours (style); queues show the newest 8.
- LABOUR-FIGURES: an estimate frozen when payroll finalizes after close (design); `useClientFeatures.js` dead;
  group covers counted from UTC midnight (passed to POS).
- DOCS: lines owned by REPORTS-4, PEOPLE-ACCESS-3 and ENGINE-1 are not re-filed.
- SISTER: five SISTER-1/-2 claims corrected or withdrawn (hss did not close own-cancel; balance returns to
  earned-to-date; the pay cut belongs to LEAVE-OT-HOLIDAYS-5; own pending withdraw stays; the email tie
  exists); Crest Staff list in whole rupees; `hr_ot_on_file` through-day only; deliberate differences
  (`recover_in_issue_month`, advance Edit, Finance items, X-Forwarded-For, whole-row month lock, swap notes).
- GAP-PAY-STATE: finding 5 merged into SETTLEMENT-2; unlocked advance read (theoretical); month-end leaver
  already paid (S791); incentive pay month (choose the earned month).
- GAP-OUTLETS: nine corrected claims (email tie exists; no PAN matching; loud leave refusal; silent OT;
  HR Employee mode refuses; revoke holds; no HR-and-POS grants; confirm names the login; Sita not a leaver);
  same rank at a sibling (S617); Owner exempt by design.
- GAP-OPERATOR: double-counted overlapping leave (refuted); Regenerate replacing typed tax (by design);
  `hr_advances_guard` has no INSERT event; daily cook unpaid after a switch (flagged); the NPR 0 banner
  (softened); stale selects show a placeholder; every client has a period.

## S798.7 Cross-repo (hss-suite)

HR, payroll, settlement and `bsCalendar.js` are shared with hss-suite. A fix here stays open there until it is
filed in hss-suite's `docs/CROSS-REPO.md`.

**File in hss-suite's CROSS-REPO.md (the same code is confirmed there):**

- ENGINE-1 — hss `payrollCompute.js:190` has the same daily line; its half-day row covers only the CHECK.
- SELF-SERVICE-1 — hss `SelfServiceHome.jsx:426-429` has the identical unchecked sign-out.
- SELF-SERVICE-5 — hss `webPush.js:66` has the same upsert.
- ENGINE-2 — hss keeps the women's rebate as an open accountant question (BUILD-LOG 10031, 10908); share
  H17's answer.
- SISTER-1 — hss #4/#43 (72faa01) was never filed in either ledger. Crest ports #43; crest's own-cancel
  refusal (H8) is new and hss has none: file both ways.

**Record in crest's `docs/CROSS-REPO.md` as ported from hss when they ship:** BONUS-LEDGERS-2 (hss
approved → pending, 20260925000010); ROSTER-3 (hss active-coworker check, 20260926000003:1781); SISTER-2
(hss #9 `linked_employee_id`); PEOPLE-ACCESS-1 (hss pay-rate guard, 72faa01 D2); PAYROLL-3/-4 (hss #8b);
BONUS-LEDGERS-1 (hss #8c–d); PAYROLL-2 = REPORTS-2 (hss #26).

**Check in hss as each shared-code fix ships (same lineage, not verified there):** ENGINE-3/-4/-5,
BONUS-LEDGERS-4, SETTLEMENT-1 to -5, GAP-PAY-STATE-1 to -4, LEAVE-OT-HOLIDAYS-1 to -4, ATTENDANCE-1/-2/-5/-6,
ATTENDANCE-7 = ROSTER-5, SELF-SERVICE-2/-3/-4/-7.

**Carried from IMS_TODO.md (S792 still open):** HR Staff's Last Seen is an AD `toLocaleDateString`; fix here and
file it there.

**Never copy a permission gate across.** Here `isAdmin` is the Crest operator and the Owner is `isOwner`; in hss
`isAdmin` aliases the company's Owner. Re-derive GAP-OPERATOR-1's INSERT-only seam and every
`hr_self_decision_exempt` test there; do not copy them.
