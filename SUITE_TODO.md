# Crest Suite — Consolidated To-Do List

Open work on **Crest Suite** (sold as Crest Suite Pro): the owner layer on top of IMS, HR and POS.
Its pages are the Owner Dashboard, the Monthly Owner/Manager Report, Consolidated Profit & Loss, the
Group Console (with Outlet Access, HQ push and Item Prices), Demand Forecast and Fixed Assets, plus the
Suite Pro gate and its billing. Until S848, Suite items were filed in `IMS_TODO.md`, `HR_TODO.md` and
`POS_TODO.md`; those stay where they are (two are cross-referenced below as KNOWN).

**When an item here ships, record it in that session's CHANGELOG entry and mark the row ✅ with the
session number** (or move it to a decisions record if one is started), so this file stays a to-do list.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-10-15 (S848 — the first whole-module review of Crest Suite, filed below).

---

# S848 re-analysis (2026-10-15)

The first whole-module review of Crest Suite. IMS (S792), HR (S798) and POS (S809) each had one; Suite
never had, though its pages read from all three modules and sit where an owner makes decisions.

**Method.** Nine read-only area reviews, ACCESS, OWNER-DASHBOARD, OWNER-REPORT, PNL, GROUP, FORECAST,
ASSETS, DATABASE and DOCS, then a completeness pass, GAPS, covering:

- the same figure across pages (FIGURES);
- cached data across outlet switches and sign-outs (CACHE);
- the Crest operator inside a tenant (OPERATOR).

Each area ran reviewer → adversarial verifier. The verifier re-opened every file:line and the last
migration defining each object, and re-checked each P1. For ASSETS-1 and ASSETS-2, the verifier read
the Income Tax Act 2058 (the Law Commission text). Nothing was written to the live database, and no
app code changed.

**Checked live afterwards.** Live reads were refused at first, so the review and verification were
built from `supabase/migrations/` (the last definition wins). Once the owner approved, about 130
read-only queries ran against the live project on the same day. Each area file's
`## Live checks (run 2026-10-15)` records every query as run and its result. The checks changed no
severity and rejected nothing. The catalog matched the migrations, and the live function bodies match
their last migration. S848.2 summarises the exposure.

**Result: 138 findings, 0 P0 · 9 P1 · 52 P2 · 77 P3.** This is after five duplicates were merged into
the finding that owns them (S848.3). About 33 need a migration. There are 23 owner decisions: 11 to
ask (SU1–SU11) and 12 folded in as recommended (SU12–SU23). One finding was rejected outright, and
GAPS-2 later reinstated part of it. The verifiers changed about eight severities and corrected most
"What happens" lines; each finding's "Verified:" line says what. Evidence per ID is in
`docs/suite-review-s848/<AREA>.md`.

**Live exposure is small.** There are four clients. Three have Suite Pro, all dated to mid-2027:
BLOOM CAFE and BLOOM CAFE - PKR (the demo group) and CASA ACAI CAFE. Most findings have no live case
yet. The ones that do are in S848.2.

**The nine P1s in plain words:**

- **DATABASE-2:** since 2026-09-10, the operator's Create User and Move login on Admin → Clients make
  the login but never link it to its business.
- **FORECAST-1:** a manager's Recompute quietly replaces the Owner's demand forecast with an empty
  one, and the HR roster loses its recommended staff for that week.
- **GROUP-1:** an outlet that leaves a group (or is sold) can still be the source of the group's HQ
  push, so its menu, purchase rates and recipes can be copied into the remaining outlets. This becomes
  P0 if any live group's HQ is already outside it.
- **GROUP-2:** an HQ push can delete ingredient lines from a branch's recipes, with no warning and no
  way back.
- **ASSETS-1:** the tax depreciation schedule caps repair costs at 5% of the wrong base. The Act has
  said 7% of the pool's depreciation base since the 2060 amendment.
- **ASSETS-2:** a pool sold for more than its tax value goes negative on the locked schedule instead
  of showing the gain as income; an emptied pool never writes off.
- **PNL-1:** Foodmandu/Pathao commission is recorded in Crest but is on no profit line, so Net Profit
  is overstated by all of it.
- **GAPS-1:** the Owner Report's Net Margin never subtracts wastage or staff meals, while the P&L's
  does, and the report's tip says they match (23.8% against 19.8% in the worked example).
- **OWNER-DASHBOARD-1:** mid-month, True Net Margin takes a whole month of rent off part of a month's
  sales (−10% on day 12 for a month that ends at 17%). The main Dashboard has the same problem.

**How it gets fixed.** Per the owner's standing preference, fixes are made in one batch in one session,
not slice by slice. Helpers work in parallel by group, A to D below, over disjoint files. Each migration
is planned first and applied only on the owner's "apply". There is one build check and one release.
ACCESS-5's fix changes what the billing export sends hss-suite, so it needs a `docs/CROSS-REPO.md` line
there.

## S848.0 Index

**S849 (2026-10-19, crest-v465): all 138 fixed** (✅), migrations `20261019100000`–`20261019100600`. One partial (◐):
OWNER-DASHBOARD-9, where the Owner Dashboard's HR reads now start right after the month read rather than beside it
(one extra round trip). Deferred, not a finding: the DATABASE-9 policy wording on `monthly_owner_reports` (cosmetic;
no access changes). Post-release support task: regenerate the seven newer frozen owner reports (SU answer, S849).

Group: **A** = security, tenant boundaries and admin tools; **B** = money, tax and frozen records stored
or printed wrong; **C** = figures and screens that mislead or lose work; **D** = copy, docs, polish
and hygiene. Within a severity, rows run A → D. Mig = the finding's fix needs a migration (as its
area file's Fix line says). Decision = the SU question in S848.1.

### P1 (9)

| ID | Finding | Group | Decision | Mig |
| --- | --- | --- | --- | --- |
| ✅ DATABASE-2 | Admin → Clients "Create User" and "Move login" fail since 2026-09-10: the login is never linked to its client | A | SU20 | yes |
| ✅ FORECAST-1 | An IMS supervisor/manager's Recompute replaces the Owner's forecast with an empty one and says "rebuilt"; Roster loses its staffing for that week | A | SU1 | yes |
| ✅ GROUP-1 | Once the HQ outlet leaves its group, its items, purchase rates, recipes and prices can still be pushed to the remaining outlets (P0 if a live group's HQ is already outside it) | A |  | yes |
| ✅ ASSETS-1 | Tax repair-cost cap is 5% of the post-depreciation value; the Act says 7% of the depreciation base | B |  |  |
| ✅ ASSETS-2 | A pool sold above its value goes negative on the locked tax schedule with no income line; an emptied pool never writes off | B |  | yes |
| ✅ GAPS-1 | The Owner Report's Net Margin never subtracts wastage or staff meals, the P&L's does, and the tip says they take off "the same costs" (23.8% vs 19.8%) | B | SU23 |  |
| ✅ GROUP-2 | A push deletes branch recipe lines whose ingredient has no match at the branch, with no preview warning and no audit trail | B | SU2 | yes |
| ✅ PNL-1 | Delivery-partner commission (Foodmandu, Pathao) is recorded but on no P&L line, so Net Profit is overstated by all of it | B | SU3 | yes |
| ✅ OWNER-DASHBOARD-1 | True Net Margin subtracts a whole month of fixed costs from part of a month's sales (−10% on day 12 for a 17% month); main Dashboard too | C | SU4 |  |

### P2 (52)

| ID | Finding | Group | Decision | Mig |
| --- | --- | --- | --- | --- |
| ✅ ACCESS-1 | A lapsed outlet stays in the group roll-ups (Console, P&L matrix, Item Prices); the server filter never reads the Suite end date (+ PNL-9) | A |  | yes |
| ✅ ACCESS-2 | A Suite (or any add-on) end date keeps the whole outlet open after its modules lapse | A | SU5 | yes |
| ✅ ASSETS-4 | Posted run headers stay writable by any IMS manager: a tax year can be un-posted or relabelled | A |  | yes |
| ✅ GROUP-3 | A stock-count PIN can be given a sibling outlet and then counts into it (S809 ACCESS-4 covered till PINs only) | A |  | yes |
| ✅ GROUP-9 | Access grants to an outlet that left the group stay behind and block that person's row | A |  | yes |
| ✅ GROUP-11 | Crest support joins a client to another group with one dropdown change and no confirm | A |  |  |
| ✅ OWNER-REPORT-4 | "Frozen" is page-only: the Owner's login can rewrite or delete a report over REST, including who made it; no audit | A | SU9 | yes |
| ✅ ACCESS-3 | Switching IMS off keeps Suite billed while every Suite page says "needs Crest IMS" | B |  |  |
| ✅ ACCESS-5 | The billing export prices a blank IMS tier at NPR 0, so hss-suite under-invoices | B |  |  |
| ✅ ASSETS-3 | Restore cannot bring back the asset register (generated total_cost), so posted book depreciation is lost on Archive → Restore | B |  |  |
| ✅ ASSETS-5 | An asset left "Not tracked" silently drops out of the tax schedule | B |  |  |
| ✅ ASSETS-6 | Any personal-use % removes an asset from the Valuation Report while everything else counts it in full | B | SU6 |  |
| ✅ ASSETS-8 | A gap between depreciation runs is never charged or warned about, not even at disposal | B |  |  |
| ✅ ASSETS-9 | A wrong typed opening value cannot be corrected once a tax schedule is posted | B | SU7 | yes |
| ✅ GAPS-2 | An outlet switch in another tab or on the phone makes the Owner Report save a permanent report for the new outlet on the old outlet's month | B |  | yes |
| ✅ OWNER-REPORT-2 | A section that fails at close is frozen out for good; the close says it went fine; print and Excel show no gap | B |  |  |
| ✅ OWNER-REPORT-3 | Regenerate ignores its own write error and overwrites a complete report with a partial one, saying "Regenerated" | B |  |  |
| ✅ OWNER-REPORT-7 | A report made after the close reads staff status as of today, so leavers drop out of headcount and labour | B |  |  |
| ✅ ACCESS-4 | Operator screens disagree with the gate on whether Suite is on (no end date, grace week, long-lapsed ★ SUITE) (+ DOCS-M5) | C | SU12 |  |
| ✅ FORECAST-2 | Forecast Revenue ignores bill discounts, so it runs high and the Roster over-staffs by the same share | C |  |  |
| ✅ FORECAST-3 | The buying list leaves out every guest-chosen ingredient (Customization, build-your-own) | C | SU13 |  |
| ✅ FORECAST-4 | The rainy-day factor is applied twice in the monsoon (about 11% under-buy) | C |  |  |
| ✅ FORECAST-5 | Bills are sorted into weekdays by the device clock, not Nepal time | C |  |  |
| ✅ GAPS-3 | After an outlet switch on Home, every tile keeps the old outlet's figures under the new name until the new loads land | C |  |  |
| ✅ GAPS-4 | Labour comes from a different source on each Suite page while payroll is not finalized (HR estimate vs Overheads Labor tab vs none) | C | SU11 |  |
| ✅ GAPS-5 | For the running month the Group Console bands a whole month's labour over part of a month's revenue, red and "Highest" | C |  |  |
| ✅ GROUP-4 | On the running month every outlet reads red "▼ vs last month", and Spend % is banded from day 1 | C |  |  |
| ✅ GROUP-5 | Group Spend % and Net Purchases leave out a PAN-only outlet's unclaimable VAT (+ DOCS-2; KNOWN IMS_TODO:202) | C |  | yes |
| ✅ GROUP-6 | Push preview, push result and item-price comparison are cut at 1,000 rows silently | C |  | yes |
| ✅ GROUP-7 | Two branch recipes with the same name or code abort the whole push with a raw constraint error | C |  | yes |
| ✅ GROUP-8 | Saving one Outlet Access row throws away other rows' unsaved ticks, including a removal | C |  |  |
| ✅ GROUP-10 | A failed push says "the branches are unchanged" whatever happened, and a hung push has no timeout | C |  |  |
| ✅ GROUP-12 | A push never carries the Veg / Egg / Non-veg mark, so a guest menu can call a now-meat dish vegetarian | C | SU8 | yes |
| ✅ OWNER-DASHBOARD-2 | After a failed read the tiles still show figures with green ticks behind a dismissible banner (+ DOCS-M1) | C |  |  |
| ✅ OWNER-DASHBOARD-3 | Labour estimate picks staff differently from payroll: leavers counted twice or left out | C |  |  |
| ✅ OWNER-DASHBOARD-4 | Labour estimate ignores attendance: no overtime, daily staff paid every calendar day | C | SU16 |  |
| ✅ OWNER-DASHBOARD-5 | Staff with no pay set read Labour "0.0% ✓"; wages typed on Overheads are ignored | C | SU17 |  |
| ✅ OWNER-DASHBOARD-6 | Retry on one section during load leaves every tile on shimmers until reload | C |  |  |
| ✅ OWNER-DASHBOARD-7 | Overdue Payables ignores VAT, discounts and returns and counts lines as bills (KNOWN S747) | C |  |  |
| ✅ OWNER-DASHBOARD-8 | Labour % reads high early each morning: today's full wages against part of today's sales | C |  |  |
| ✅ OWNER-REPORT-1 | A failed Inventory Depth sub-section is invisible ("Not enough history", Excel 0s) | C |  |  |
| ✅ OWNER-REPORT-5 | The Executive Summary uses fixed 35/45 food-cost bands against the client's own thresholds (+ DOCS-M2) | C |  |  |
| ✅ OWNER-REPORT-6 | Report generation has no timeout: the close dialog can sit on "Closing…" for good | C |  |  |
| ✅ OWNER-REPORT-8 | Both "unpaid credit" figures compare VAT-added payments with ex-VAT totals (KNOWN IMS_TODO:302, + the IMS row) | C |  |  |
| ✅ PNL-2 | A month closed with uncounted stock prints a coloured Net Profit and no warning | C |  | yes |
| ✅ PNL-3 | Net Profit is before depreciation but claims "every cost" (+ ASSETS-7) | C | SU19 | yes |
| ✅ PNL-4 | Arrowing the period select can show and export one month's figures under another month's name | C |  |  |
| ✅ PNL-5 | An outlet with no period adds nothing yet counts in "N outlets" | C |  |  |
| ✅ PNL-6 | The Excel export drops the warnings the screen carries | C |  |  |
| ✅ PNL-7 | A group outlet without HR shows Labour NPR 0 with no word | C |  |  |
| ✅ PNL-8 | No inter-outlet stock transfer, so central-kitchen supply booked as a purchase is counted twice in the group | C | SU10 |  |
| ✅ DOCS-1 | Help files the Suite pages under IMS tiers ("IMS Pro unlocks Fixed Assets, Demand Forecast") | D |  |  |

### P3 (77)

| ID | Finding | Group | Decision | Mig |
| --- | --- | --- | --- | --- |
| ✅ ACCESS-6 | Suite is a browser-only paywall, and no rule says that is the agreed design | A | SU14 |  |
| ✅ ASSETS-12 | The server takes every depreciation figure as the browser sent it | A |  | yes |
| ✅ ASSETS-13 | "Viewing is supervisor+" is page-only: staff and count PINs can read the register over REST | A |  | yes |
| ✅ DATABASE-3 | Another client's id can be planted in a Suite row and then blocks that client's Danger Zone partway | A |  | yes |
| ✅ DATABASE-4 | Posting a tax-pool schedule has no per-client lock or duplicate refusal; the fiscal year is free text | A |  | yes |
| ✅ DATABASE-5 | Outlet Access grants, repair expenses, asset categories and HQ changes leave no Audit Log trace | A |  | yes |
| ✅ DATABASE-8 | The dashboard's frozen monthly Target can still be planted or blocked by any login, a till PIN included | A |  | yes |
| ✅ FORECAST-7 | The weather function fetches any point in Nepal at 1 km resolution, with no per-client budget | A |  | yes |
| ✅ GAPS-12 | The operator's Delete asset erases posted depreciation lines with no record | A |  | yes |
| ✅ GROUP-15 | Outlet Access judges "Owner" with a fourth, out-of-step copy and lists Self-Service logins (+ DATABASE-6) | A |  | yes |
| ✅ ACCESS-7 | Group pages are gated on the outlet the Owner is in, not the group | C | SU15 |  |
| ✅ ACCESS-8 | The Crest operator cannot see a client's Group Console | C |  | yes |
| ✅ DOCS-9 | A Group Console branch with no period prints NPR 0 though Help says it is not shown as zero | C | SU21 |  |
| ✅ ACCESS-9 | Every Suite page loads its data behind the upsell card and the role redirect | D |  |  |
| ✅ ACCESS-10 | The Roster's Labor Forecast sends every HR client to Demand Forecast without saying it is Suite (+ DOCS-M8) | D |  |  |
| ✅ ACCESS-11 | Suite state is read once per page load, so a switch-off or lapse mid-session does not reach an open tab | D |  |  |
| ✅ ACCESS-12 | Three hand-written copies of the Suite gate test, each narrower | D |  |  |
| ✅ ACCESS-13 | Docs and copy drift around the Suite gate (+ DOCS-M9) | D |  |  |
| ✅ ACCESS-14 | No Suite countdown or grace notice before Suite closes | D |  |  |
| ✅ ASSETS-10 | A tax schedule row does not add up when last year's repair excess joins the base | D |  |  |
| ✅ ASSETS-11 | A tax schedule can be posted for the unfinished or next fiscal year, locking the openings | D |  |  |
| ✅ ASSETS-14 | A 366-day BS year charges 366/365 of the annual straight-line figure | D |  |  |
| ✅ ASSETS-15 | Blocking awaits without withTimeout; the register read is unpaged | D |  |  |
| ✅ ASSETS-16 | The Disposal Report totals every disposal ever, with no fiscal-year filter | D |  |  |
| ✅ ASSETS-17 | Three post failures say nothing was written when the server may have saved; a late retry can double-charge | D |  |  |
| ✅ ASSETS-18 | A pool under NPR 2,000 is carried forward instead of written off that year | D |  |  |
| ✅ DATABASE-7 | Delete → recreate → Restore loses the Suite plan, end date and group, silently | D |  |  |
| ✅ DATABASE-9 | Hygiene: asset numbering jammed by one edit, inline admin tests, the SQL rules file's first example | D |  | yes |
| ✅ DOCS-3 | Docs still say no client has an outlet group | D |  |  |
| ✅ DOCS-4 | The Suite guide's report-version list is stale | D |  |  |
| ✅ DOCS-5 | With no open period the Owner Dashboard says "create one in Periods", which only Crest admin can do | D |  |  |
| ✅ DOCS-6 | The Suite price card says it needs only IMS; Owner Dashboard also needs HR, covers need POS | D |  |  |
| ✅ DOCS-7 | Fixed Assets Help says IMS staff can view the register; the page refuses below supervisor | D |  |  |
| ✅ DOCS-8 | Three Suite messages break the error rules (raw server text, "branches unchanged") | D |  |  |
| ✅ DOCS-10 | PRODUCT.md and the rules miss Suite and the multi-outlet owner | D |  |  |
| ✅ FORECAST-6 | A client that turns POS off is forecast from old till bills for up to six weeks | D |  |  |
| ✅ FORECAST-8 | The run log is not per horizon; a failed clean-up says no forecast was made when one was | D |  |  |
| ✅ FORECAST-9 | Help, the IMS guide and Settings describe the buying list and rain setting as before S756/S800 (+ DOCS-M4) | D |  |  |
| ✅ FORECAST-10 | Small items | D |  |  |
| ✅ GAPS-6 | An operator whose own profile had a grouped client would see its own group on every client (latent) | D |  |  |
| ✅ GAPS-7 | The page cache is cleared only by this tab's own Sign out | D |  |  |
| ✅ GAPS-8 | The P&L's Wastage line leaves out wasted prep and its tip does not say so (KNOWN design FIGURES-5) | D |  |  |
| ✅ GAPS-9 | An operator's "view as" switch keeps the previous client's module switches until the new ones load | D |  |  |
| ✅ GAPS-10 | A switch whose profile reload fails shows the old outlet's name over the new outlet's reads | D |  |  |
| ✅ GAPS-11 | An operator-made report is headed with the operator's personal name until reload | D |  |  |
| ✅ GAPS-13 | Demand Forecast records nobody: every Recompute is an anonymous run on the device clock | D |  | yes |
| ✅ GROUP-13 | A refused outlet switch from the Console wipes every figure and calls it a failed read | D |  |  |
| ✅ GROUP-14 | Two quick outlet links race: the window shows one outlet while the login is in the other | D |  |  |
| ✅ GROUP-16 | Smaller items: docs drift and hygiene (free bill lines in "Same item, different price") | D | SU22 |  |
| ◐ OWNER-DASHBOARD-9 | About 13 serial round trips on a busy till outlet; five tables read twice | D |  |  |
| ✅ OWNER-DASHBOARD-10 | With no open period, Items Below Par counts every item; a failed read reads as "No open period" | D |  |  |
| ✅ OWNER-DASHBOARD-11 | The trend card reads a failed load as "no history yet" and names only Food Cost's step (+ DOCS-M7) | D |  |  |
| ✅ OWNER-DASHBOARD-12 | Revenue does not say before VAT and after discounts; always green | D |  |  |
| ✅ OWNER-DASHBOARD-13 | Purchases · Cash / Credit does not tie to the Payment Report | D |  |  |
| ✅ OWNER-DASHBOARD-14 | The approved-overtime read is unpaged | D |  |  |
| ✅ OWNER-DASHBOARD-15 | Staff and non-Suite Owners fire about 25 reads before the guard decides | D |  |  |
| ✅ OWNER-DASHBOARD-16 | A hung read loads forever; banners not announced; nested focusable controls | D |  |  |
| ✅ OWNER-DASHBOARD-17 | "Today" comes from the viewer's device clock, not Nepal time | D |  |  |
| ✅ OWNER-REPORT-9 | A Suite client without HR gets no Net Margin or labour line | D | SU18 |  |
| ✅ OWNER-REPORT-10 | Labour on page one never says "estimated" | D |  |  |
| ✅ OWNER-REPORT-11 | The Net Margin gate leaks and names the wrong tier; a downgrade hides a frozen figure (+ DOCS-M6) | D |  |  |
| ✅ OWNER-REPORT-12 | Trend calls months better/worse where the summary withholds verdicts | D |  |  |
| ✅ OWNER-REPORT-13 | Attendance Rate counts weekly offs and holidays: perfect attendance reads about 84% | D |  |  |
| ✅ OWNER-REPORT-14 | A leave crossing a month boundary counts in full in both months | D |  |  |
| ✅ OWNER-REPORT-15 | Inventory Turnover's "value used" is not the report's own COGS | D |  |  |
| ✅ OWNER-REPORT-16 | Three HR reads behind the labour estimate are unpaged | D |  |  |
| ✅ OWNER-REPORT-17 | Loads run outside SuiteGate: an Owner without Suite mints and saves a snapshot | D |  |  |
| ✅ OWNER-REPORT-18 | Letterhead read drops errors; Export/Print not gated, a PAN outlet can print as VAT (+ DOCS-M10) | D |  |  |
| ✅ OWNER-REPORT-19 | A month whose prior report was not made freezes "No report was generated" into its Trend | D |  |  |
| ✅ OWNER-REPORT-20 | Docs drift: regenerate is not admin-only, labour labelling, "read from snapshot" (+ DOCS-M3) | D |  |  |
| ✅ PNL-10 | On an open month Gross and Net Profit are coloured over a whole-shelf COGS | D |  |  |
| ✅ PNL-11 | Till bills still waiting for Inventory after close are missing from revenue, unsaid | D |  | yes |
| ✅ PNL-12 | A closed month's statement moves when item prices change (KNOWN D5; the export says nothing) | D |  |  |
| ✅ PNL-13 | The group matrix depends on a sibling read that drops its error | D |  |  |
| ✅ PNL-14 | Print never gated; a stalled read leaves "Building the statement…" forever | D |  |  |
| ✅ PNL-15 | Hygiene: two reads off the scoped layer, an unpaged read, a dropped error detail | D |  |  |
| ✅ PNL-16 | No fiscal-year (Shrawan→Ashadh) or multi-month statement | D |  |  |

## S848.1 Owner decisions (SU1–SU23)

Each question is in plain words; the finding's area file holds the technical detail. **(rec)** marks
the reviewers' recommendation. SU1–SU11 need the owner's answer. SU12–SU23 are folded into the fix
list as recommended unless the owner says otherwise.

### To ask

**Answered by the owner on 2026-10-15 (S848):** SU1 (a), SU2 (a), SU3 (a), SU4 (a), SU5 (a),
SU6 (a), **SU7 (b), against the recommendation: build a way for the client to correct a wrong
typed opening value**, SU8 (a), SU9 (a), SU10 (a), SU11 (a). SU12–SU23 stand as folded in. The owner
also asked for the live checks to be run.

- **SU1 (FORECAST-1). Who may rebuild the demand forecast on an outlet with a till?** (a) Supervisors
  and managers too, through a server read that hands back only daily totals. They already see the
  forecast's revenue and covers on that page **(rec)**. (b) Only the Owner; anyone else is told who to
  ask.
- **SU2 (GROUP-2). When HQ pushes a recipe to a branch and one ingredient has no match there, what
  happens to the branch's recipe?** (a) The branch keeps its whole recipe and the push lists the dish
  as skipped, so nothing is lost **(rec)**. (b) HQ's version is written, missing line and all, but the
  preview warns first.
- **SU3 (PNL-1). Delivery-partner commission (Foodmandu, Pathao) on the profit statement.** (a) Count it
  in the month the bill was sold, and say when some of that month's delivery bills are not settled
  yet; a closed month can then move when a late settlement lands **(rec)**. (b) Count it in the month
  the partner paid. (c) No line; tell the owner to type it in by hand.
- **SU4 (OWNER-DASHBOARD-1). Mid-month profit margin on the dashboards.** (a) Count rent and other
  fixed costs only for the days that have passed, so the figure is right all month and keeps its
  colour **(rec)**. (b) Keep the whole month's fixed costs, but show no colour or mark until the month
  closes (what the Overheads page does).
- **SU5 (ACCESS-2). Should a prepaid add-on (Suite, Customization) keep an outlet's whole account open
  after IMS, HR and POS have lapsed?** (a) No: only the main modules' dates decide whether the outlet
  is open **(rec)**. (b) Yes, and write it down. (c) Go further: each module closes on its own date.
- **SU6 (ASSETS-6). An asset partly used privately (a scooter used 30% at home).** (a) Count it in full
  everywhere and say so on the page **(rec)**. (b) Split it by the private-use share everywhere (needs
  a tax adviser's answer first). (c) Leave it: it vanishes from the Valuation Report only.
- **SU7 (ASSETS-9). A last-year tax value typed in wrong, found after this year's tax schedule is
  posted.** (a) Crest support corrects it, and the screen says so **(rec)**. (b) Build a way for the
  client to correct it. (c) Let a manager edit it, with a warning naming the posted years.
- **SU8 (GROUP-12). A dish's Veg / Egg / Non-veg mark when HQ pushes recipes.** (a) It follows HQ,
  because the ingredients do, and the preview names each change **(rec)**. (b) Each branch keeps its
  own mark; the preview names every dish whose mark differs from HQ's.
- **SU9 (OWNER-REPORT-4). Should the frozen monthly report be tamper-proof?** (a) The database refuses
  edits and deletes except through Regenerate, and records who made it itself **(rec)**. (b) The same,
  and also keep every earlier version so a regenerate can be undone. (c) Leave it, and say in Help it
  is not tamper-proof.
- **SU10 (PNL-8). Stock a central kitchen sends to a branch.** (a) Add a stock transfer between outlets
  that the group total cancels out **(rec)**. (b) Let a supplier be marked as a sister outlet, so its
  bills drop out of the group total. (c) Only a sentence saying it is not netted.
- **SU11 (GAPS-4). Labour cost before payroll is finalized, for an outlet on Crest HR.** (a) Every page
  uses the HR wage estimate (recommended: it is the one built from the staff list). (b) Every page
  uses the wages typed on the Overheads Labour tab.

### Folded in as recommended (say if not)

- **SU12 (ACCESS-4).** A Suite with no end date stays open, and the operator's screens show a
  "No end date" marker, as they do for modules (the recorded decision).
- **SU13 (FORECAST-3).** The buying list learns the average guest choices and adds them.
- **SU14 (ACCESS-6).** Suite stays a screen-level paywall, written down as the agreed design.
- **SU15 (ACCESS-7).** A group page opens from any outlet when some outlet in the group has Suite.
- **SU16 (OWNER-DASHBOARD-4).** Daily and hourly staff are estimated from attendance where it is
  entered and from calendar days where it is not, and the Tip says so.
- **SU17 (OWNER-DASHBOARD-5).** Staff with no pay set: no verdict, and the Labour-tab amount is named
  as not counted.
- **SU18 (OWNER-REPORT-9).** A Suite client without HR: the report uses the Overheads Labour tab,
  labelled "from Overheads".
- **SU19 (PNL-3).** Depreciation shows as a memo line under Net Profit, not subtracted (extends D23).
- **SU20 (DATABASE-2).** Fix the login-linking trigger now (a one-line migration); move linking into
  the server function later.
- **SU21 (DOCS-9).** A Group Console branch with no period shows "—", not NPR 0.
- **SU22 (GROUP-16).** Free lines on a supplier bill are left out of "Same item, different price".
- **SU23 (GAPS-1).** The Owner Report's Net Margin subtracts wastage and staff meals, as the P&L does.

## S848.2 What the live checks found (2026-10-15)

Each result, with the query as run, is in that area file's `## Live checks (run 2026-10-15)`.

**Live today:**

- **DATABASE-2 is confirmed.** The browser role holds only SELECT on the outlet-access table, and
  the trigger runs as the caller. The audit log has no operator-made login move since 2026-09-08.
  BLOOM CAFE - PKR, the only client added by hand since then, has no Owner login.
- **PNL-1:** NPR 53,104 of Foodmandu/Pathao commission sits on no P&L line. BLOOM CAFE has NPR 40,976
  across 204 settled bills, about 1.5% of its till sales. BLOOM CAFE - PKR has NPR 12,128. Commission
  runs about 16% of delivery value.
- **GAPS-1:** BLOOM CAFE's frozen Bhadra 2083 report shows Net Margin 21.9% "Healthy". On the P&L's
  basis it is 20.0% "Watch" (staff meals NPR 12,400 and raw wastage NPR 5,281). Other BLOOM months
  read 1.6–2.0 points high.
- **GROUP-1 is not P0 today:** the only group's HQ, BLOOM CAFE, is in the group. But the audit log
  shows it was taken out of its own group twice in September, once for about 46 hours. The exposed
  state has happened, though only between one owner's own outlets.
- **OWNER-DASHBOARD-1:** both BLOOM outlets save the whole month's fixed costs on day 1, so their
  margin carries a full month's rent from day 1. CASA saves on days 14–29.
- **OWNER-DASHBOARD-4:** CASA records overtime only on the attendance sheet (63.1 h so far in
  Ashwin), and the estimate misses all of it.
- **OWNER-DASHBOARD-7:** the overdue tile counts 24 lines where BLOOM has 2 overdue bills, and 12
  where PKR has 1.
- **OWNER-REPORT-4:** the Owner can rewrite or delete 8 reports at 3 clients today. There is no
  trigger and no audit, and nothing ties a report's period to its own client. The fix should check
  that too.
- **OWNER-REPORT-7:** CASA's Ashadh and Shrawan 2083 reports, regenerated by Crest support on 13 Oct,
  show Active Headcount 2 where payroll paid 4.
- **FORECAST-3:** both BLOOM outlets sell with guest choices (2,075 and 1,391 choice lines), and none
  of those ingredients reach the buying list.
- **FORECAST-4 is bigger than filed.** Three clients run the rain setting at 50%, not 85%, so a wet
  spell leaves the buying list about 37% short, not 11%. It is kept at P2: no rain is forecast now.
- **ACCESS-5 is a trap.** The price row has no IMS key today, so nothing is under-invoiced. But the
  next Plan Pricing save with the IMS boxes blank stores an empty IMS price. Billing-export would
  then send IMS at NPR 0: NPR 3,500 a month per client, and CASA is the only real one.

**No live case yet:** ACCESS-1/2/3/4, GROUP-2/3/5/6/7/9/12, PNL-2/3/5/7/8/9/11, every ASSETS
finding, FORECAST-1, -6 and -7, OWNER-REPORT-1/2/5/9, OWNER-DASHBOARD-3/5, GAPS-2/5/6.

- **The tax P1s:** the only posted tax schedule is CASA's FY 83/84, posted with every pool at 0.
- **FORECAST-1:** no client has POS on together with an IMS supervisor or manager login. CASA has two
  such logins, POS off, and so only risks losing the holiday days.

**Found while checking, not yet filed as findings:**

- The two BLOOM demo outlets are not marked as trials and have paid-through dates, so they count in
  MRR and the billing export marks them billable.
- The live Suite CHECK still admits 'starter' and 'growth', which DATABASE-9 already notes.
- All 17 asset codes are `FA-001`… while the trigger issues `AST-`, so the next asset added in the app
  starts a parallel series (extends DATABASE-9).
- The schedule's asset link is NO ACTION live, a third column that can block a delete (extends
  ASSETS-11).
- CASA has two posted book runs with no schedule lines and no assets left (GAPS-12).
- The audit log starts on 2026-08-30 and holds no asset rows.
- Logged-in users run with an 8-second statement timeout, so a push that takes longer is rolled back
  (softens GROUP-10).

## S848.3 Merged duplicates and carry-overs

Merged into the finding that owns them (each kept as an uncounted pointer in its own area file):

- ASSETS-7 → PNL-3
- DATABASE-1 → GROUP-1
- DATABASE-6 → GROUP-15
- the GROUP reviewer's move-login entry → DATABASE-2
- PNL-9 → ACCESS-1
- DOCS-2 → GROUP-5
- the GAPS reviewer's old GAPS-11 → PNL-4

`DOCS.md` → "Merged into other areas" (DOCS-M1 to DOCS-M10) lists ten Help/guide findings folded into
the behaviour findings they describe, each with the copy sites the fix must also change. The index
marks those rows "(+ DOCS-Mn)".

Already filed elsewhere and still open, cross-referenced here as KNOWN:

- `IMS_TODO.md:202`: group purchases ex-VAT for a PAN outlet (GROUP-5)
- `IMS_TODO.md:302`: the vendor aging basis (OWNER-REPORT-8)
- S747 "still open": Overdue Payables (OWNER-DASHBOARD-7)
- S792 COSTS GAP 2: the depreciation-run gap (ASSETS-8)
