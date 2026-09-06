---
target: crest-suite, all modules, features, pages & branches
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 5
timestamp: 2026-09-06T05-59-39Z
slug: crest-suite-all-modules
---
# Crest Suite — product-wide critique (all modules / features / pages / branches)

Method: dual-agent (A: design judgment from source, no detector/browser · B: bundled detector + live
browser measurement on the public routes + a static harness over the real Layout.css + 13
claim-vs-measured verification greps). Parent independently re-verified the P0 and the en-NP finding.
Scope: all 97 routes in App.js, four module trees, shell, admin, two PWAs, print surfaces, and the
conditional branches inside them (plan, role, module flag, outlet, page-internal, state). `master` is
the only git branch, so "branches" was read as the product's own.

## Design Health Score — 29/40 (Fair)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Offline pending count nested in `{!isOnline && …}` (PosOrders.jsx:3586→3601) — failing queued order invisible on a reconnected till; no toast system; payroll finalize ends in a 12px span (PayrollRun.jsx:470) |
| 2 | Match System / Real World | 3 | `en-NP` renders Western grouping at 261 sites; printed IRD bill says "Three Lakh…" beside `342500.00` (posOrderPrintHtml.js:147 vs :138) |
| 3 | User Control and Freedom | 3 | Reopen paths exemplary; close dialog promises entry pages lock and HR ignores it |
| 4 | Consistency and Standards | 2 | ReportPage 3 importers / 29 report pages; 4 gate grammars; 52 money formatters; 323 frozen rgba vs 173 color-mix; IMS zero ConfirmModal |
| 5 | Error Prevention | 3 | Period-close preflight now real (Periods.js:139-170); persistSalesDay.js:170 double-post guard fails open; posTeam fail-closed in nav only |
| 6 | Recognition Rather Than Recall | 3 | Supervisor↔Manager difference described only in HrStaff.jsx:20-21, which is manager-gated (:332) |
| 7 | Flexibility and Efficiency | 3 | Ctrl+K, pins, arithmetic, 42 exports — vs 18 `<tr onClick>` drill-downs, 0 with tabIndex/onKeyDown/role |
| 8 | Aesthetic and Minimalist Design | 3 | 24 kpiCard() + 4 charts on one dashboard; 49-destination IMS panel; AdminClients.js:476-648 = 13 affordances in a row |
| 9 | Error Recovery | 3 | Doctrine adopted (43 errorText / 36 ActionError importers, 149 errorLine, 11 raw .message all wrapped); GroupDashboard.jsx:214 renders a table outside the !error guard its KPI strip has at :195 |
| 10 | Help and Documentation | 3 | Help.js:885 tab state in useState, no URL sync; linked identically from every route; no page context |
| **Total** | | **29/40** | **Fair — strong bones, one broken promise, one unmeasured layer** |

NOT a regression from 34. Two prior P1s verified closed: inline stat-grid overrides = 0 (was ~25);
period close has a real data-derived preflight. The four points came off heuristics the prior pass
scored 4 on unmeasured claims ("NPR/en-NP throughout", "failed≠empty product-wide", offline counters,
"searchable Help").

## Design Specificity Verdict

Authored, deeply, in every layer except the one the product is sold on.

Real authorship: bsCalendar.js:47-57 BS_MONTHS_SHORT exists because a 3-char slice renders both Ashadh
and Ashwin as "Ash"; holidayData.js:1-20 models fixed/movable/sighted and says only the first is
derivable (a missed Dashain pays 1.5x not 2x); PayForm.jsx:236 glosses महँगी भत्ता against the Labour
Act 2082 floor; AppErrorBoundary.jsx:24-55 builds a redacted one-tap-copy crash report sized for
WhatsApp.

Then the money (verified by the parent, not taken on report):
  en-NP (261 sites) -> 1,248,650    en-IN (1 site) -> 12,48,650    en-US -> 1,248,650
  new Intl.NumberFormat('en-NP').resolvedOptions().locale === 'en'
Plus 146 bare toLocaleString() calls rendering in the VIEWER's locale (a German browser prints
1.248.650 on /pricing). The single en-IN site is SubscriptionAgreement.jsx:36 — the contract the
client signs is the one place the product groups numbers the way its readers do. DESIGN.md:559 derives
.stat-grid's 200px floor from "a Nepali-grouped NPR 12,48,650" — a format the product never renders.

Deterministic scan: detect.mjs --json src -> exit 2, 7 findings, ALL false-positive, 0 real.
2 ThemeContext.js Light literals (documented class), 3 leaveConstants.js categorical hues pre-declared
in an in-file comment at :11-16 and never rendered as raw text, viewPosBill.js:23 #c00 (measured
5.89:1 on white, theme-independent popup), parkingSlipHtml.js:26 26px (80mm thermal template).
DETECTOR BUG: all 7 are severity "advisory" but --no-advisory still returns 7 and still exits 2 — CI
gated on this fails permanently.

Visual overlays: NOT available. B measured through its own instrumentation and a hand-built static
harness rather than live-server.mjs injection (which would have violated read-only). No user-visible
overlay tab; measured evidence is the fallback signal.

## Overall Impression

Three piles, and only the first is a design problem in the usual sense.
1. Promises the code doesn't keep: the close dialog says entry pages lock (HR never implemented it);
   KITCHEN_TEAM_ALLOWED_PATHS says fail-closed (it fails closed in the nav only); DESIGN.md says
   ReportPage is the frame every report renders inside (three do).
2. A whole preset nobody has looked at. Dark declares no *Text keys, so applyTheme falls
   --theme-*-text back to the base: base and variant are BYTE-IDENTICAL in the default preset, and
   every misuse looks correct until someone switches to Light.
3. One number the product got wrong 261 times while believing it was right.
All three share a shape: something was written down, looked correct, and was never executed against
reality.

## What's Working

1. The failure grammar is a lived doctrine, not a lint rule. ReportLoadError 49 files, ActionError 38,
   firstError gating batch reads, NoPeriodState on 19 pages with a `what=` prop. Only 11 raw .message
   renders remain and every one is wrapped in a consequence sentence.
2. useLatestRequest adoption is COMPLETE and the docs understate it: 38 importers, 38/38 carrying both
   begin( and isCurrent(. CLAUDE.md says 22. The opposite of the campaign's recurring
   "shipped-helper-reaches-zero-call-sites" pattern.
3. Gating is three genuinely separate axes and each gate's BEHAVIOUR follows its axis (SuiteGate never
   redirects; PremiumGate takes the viewport; ModuleGate redirects). The model is the strongest thing
   in the architecture.

## Priority Issues

### 1. [P0] The close dialog promises entry pages lock. HR ignores it completely. (NEW)

ClientDashboard.jsx:2457 "Entry pages for {month} become read-only for your team."
Periods.js:192 "{month} {year} locks for the client's own logins."
grep -rn "status === 'closed'|isClosed|periodClosed" src/modules/hr -> 0 (verified by parent).
8 IMS files DO enforce it. Every `closed` reference in HR is cosmetic — appending "(open)" to a select
label (PayrollRun.jsx:595, AttendanceSheet.jsx:605, Overtime.jsx:258, PayrollCalculation.jsx:394,
HrReports.jsx:272, TadaClaims.jsx:423). No HR page disables anything.
Why: the Monthly Owner Report snapshot is captured at close and never recomputed. A supervisor edits
Bhadra attendance after Bhadra "locked" and the frozen artifact an accountant files on no longer
matches the HR data behind it — with a dialog on record saying it couldn't happen.
Fix: mirror IMS's lock (disabled + disabledStyle() + the amber admin-editing-a-closed-month banner) on
Attendance/Overtime/Leave/TADA/Payroll entry. One-hour version: add a bullet naming which modules lock.
-> /impeccable harden

### 2. [P1] Money: 52 formatters, no shared module, four incompatible conventions. (NEW)

52 local formatters. 261 en-NP (American grouping), 146 bare toLocaleString (viewer locale), 1 en-IN,
.toFixed(2) ungrouped on the printed IRD bill. Four byte-identical fmtNpr copies in POS alone
(posOrdersConstants.js:5, CreditNotes.jsx:13, IssueCreditNoteModal.jsx:18, PosCustomers.jsx:18) plus a
fifth in GuestMenu.jsx. VendorBalanceConfirmationPrint.jsx:77 does BOTH conventions in one sentence on
an IRD Annexure 13 letter.
The repo solved this one type over: nepalTime.js exists because 18 clock renders each formatted in the
runtime's timezone. Money is the same defect, 3x as common, with no src/shared/nepalMoney.js.
NOTE: this is a DECISION, not just a sweep — en-IN changes the appearance of every figure.
-> /impeccable clarify

### 3. [P1] The Light preset is a second product, and nothing measures it. (RECURRING — S682 named 4 sites; this pass enumerated the class)

Dark declares no *Text keys, so --theme-red-text resolves to --theme-red. Base and variant identical
in the default preset -> every misuse renders correctly in the theme you develop in.
Measured on the real Layout.css:
  --theme-accent as text:     Dark 7.45 | Light on card 3.61 FAIL | Light on page bg 3.27 FAIL
  --theme-accent-ink:         Dark 7.45 | Light 6.61 pass
  --theme-red as text:        Dark 6.15 | Light on card 4.83 | Light on page bg 4.37 FAIL
  --theme-red-text:           Dark 6.15 | Light 8.42 pass
23 accent-as-text sites incl. Login.js:279, ResetPassword.js:82, Legal.jsx:242, SearchableSelect.js:167,
BsCalendarPicker.js:277, Overheads.js:21/314/646, payrollConstants.js:15/130/132/136.
14 of the 43 total base-token-as-text sites are inside TERNARIES — a property-level regex finds 6,
which is why this class kept reading as nearly closed.
LARGER: 323 rgba() tints frozen to Dark-preset RGBs — rgba(201,168,76,·)x118 accent,
rgba(248,113,113,·)x116 red (Light's red is 220,38,38), x61 green, x23 amber, x5 purple. Concentrated
in Help.js (41), AdminDashboardOverview.jsx (23), Sales.js (20), Stock.js (18), Overheads.js (16).
The preset-following form already exists and is used 173 times across 38 files
(color-mix(in srgb, var(--theme-*) …)). Both conventions coexist with nothing choosing between them.
CONTRAST SPLIT: public routes are FLAWLESS — 0 failures on /login, /pricing, /legal/terms,
/legal/privacy, /reset-password at 1440x900 and 390x844 in both presets, min ratio 4.74:1 over 728 text
nodes, 0 horizontal overflow, 0 focus gaps across 84 controls. Every failure is inside the app, in the
shared classes, in the preset nobody develops in.
-> /impeccable colorize

### 4. [P1] The POS double-post guard fails open. (NEW)

persistSalesDay.js:170 — `const { data: posRows } = await …` drops the error on the
POS-supersedes-manual guard. On a failed read posRows is null, the index is empty, every manual row is
treated as not-superseded -> DOUBLE DEPLETION. This is CLAUDE.md's own "a guard that drops its read
error passes vacuously" rule, live, in the money path the rule was written about.
Surrounding class measured honestly: 56 reads destructuring { data } with no error (ims 14, pages 10,
pos 9, shared 7, utils 6, context 6, admin 3, hr 1) and 30 discarded scoped* writes — down from S682's
~230, so the sweep worked. What remains needs per-site triage, and this site changes a figure.
Second real one: demandForecastData.js:151 — error-dropping AND unwrapped by fetchAllRows while
.in('period_id', periodIds) spans every period.
-> /impeccable harden

### 5. [P1] The nav is doing permission work in three places, and only the nav. (NEW)

Layout.js:181 KITCHEN_TEAM_ALLOWED_PATHS = ['/pos/kds'], applied at :408, commented as "fail-closed, so
a future new POS page is hidden from kitchen/bar by default." posTeam appears in 4 files in the whole
tree (verified); the only POS page reading it is KitchenDisplay.jsx, for station locking, not access.
A kitchen/bar account typing a URL reaches /pos/orders, /pos/parking, /pos/reservations, and at
supervisor rank /pos/customers and /pos/shifts — the cash-drawer reconciliation screen.
Siblings, both verified: /menu-pricing (App.js:232) is the ONLY in-app route with no ModuleGate, gated
on a Starter key that passes for everyone — an HR-only client reaches it by URL and gets the POS-only
branch. And there is NO path="*" anywhere in App.js: an unmatched URL renders an empty #root. That was
fixed for /legal alone (:139-142), with a comment explaining why truncating a URL is ordinary user
behaviour, and never generalised.
This is the project's own recurring rule on the one axis every prior sweep missed, because posTeam is
not a min*Role tag.
-> /impeccable harden

### 6. [P1] Six "we can help" surfaces degrade to a Gmail address, waiting on one constant. (NEW)

supportContact.js:22 SUPPORT_PHONE_RAW = '[[NEEDS VALUE: SUPPORT_PHONE]]' — the only unfilled marker
left in the product (legalCompany.test.js:57 asserts the legal docs have none). supportPhone() correctly
returns null, so every consumer hides the phone: the crash page renders no Call and no WhatsApp
(SupportContactLine.jsx:24-27), PremiumGate's upgrade card shows email+website only, likewise
SubscriptionLock, the offline banners, the login footer and Help -> Support.
SUPPORT_HOURS already promises "outlet-down issues any time" with no way to reach anyone at that hour.
The wa.me normalisation, the tel: href and the hours line are all built and waiting on one constant.
-> /impeccable clarify

## Branch findings

PLAN/TIER. Four gates, four grammars. ModuleGate = three bare <Navigate to="/dashboard">, NO COPY AT
ALL. PremiumGate.js:44-51 headlines the PLAN ("Growth Plan Required") and lists ten features; featureKey
is in scope at :10 and unused for copy, so someone who clicked Variance Report gets a paragraph
containing it. SuiteGate module-missing (:37) says "Contact your consultant" with no phone/email/link —
the only gate not using useSupportContact(). SuiteGate tier-missing is the best of the four and should
be the template. Worst compound: staff see upsells they cannot buy (Layout.js:689-727 teaser has no role
check; SUITE_NAV Demand Forecast is minImsRole 'supervisor' under a PRO chip), and both CTAs
navigate('/pricing') — declared at App.js:134, OUTSIDE ProtectedRoute. A signed-in Growth supervisor
lands on a signed-out marketing page showing "Login →" and "Start Free Trial →", with "← Back" the only
way home.

ROLE. IMS/HR guard coverage is COMPLETE — 22 HR and 40+ IMS pages each carry an in-page early return
matching their nav tag; that recurring defect is closed. POS's posTeam axis is what's left (issue 5).
Rank mismatch: HolidayCalendar.jsx:201 gates at 'staff', and that account can delete a gazetted holiday
(:110-127) whose own confirm body correctly warns overtime on it drops to the normal rate. Lowest rank,
money-moving consequence. Also: a supervisor typing /pos/staff bounces through three redirects
(PosStaff.jsx:349 -> PosTableManagement.jsx:140 -> Pos.js:58 -> /dashboard).

MODULE FLAGS. ConsolidatedPnl.jsx:314 defines hrOn and uses it at exactly ONE site, :608 — when HR is
off the Labour line prints NPR 0 with an EMPTY-STRING annotation and Net Profit is overstated by exactly
that much, with nothing on the page saying HR is disabled. The page's own loud amber footnote for
ignored labour sits at :469-476; the machinery exists and is not wired to this branch.
MonthlyOwnerReport.jsx mirrors it at :452/474/511/760-764, dropping whole sections silently.
ClientDashboard.jsx:2470-2477 handles the no-modules case well and shows what the others should do.

MULTI-OUTLET. After switching outlets, TWO strings change on an ordinary page: the sidebar name
(Layout.js:954) and the context bar (:1232). Same colour, same chrome, no HQ/branch marker anywhere —
hq_client_id is read in one component in the whole tree (MasterPushPanel.jsx:63-76) and reaches no badge.
Even the Group Console, which lists every outlet with Viewing / No Suite Pro / No period badges
(GroupDashboard.jsx:252-254), has no HQ badge. On a product where the switcher re-points every RLS
policy, "which outlet am I in" deserves more than one word in 13px fog. Credit: the switcher offers
switchableOutlets not outlets, shows each outlet's subscription state BEFORE you switch into a locked
app, and blocks the switch while the POS offline queue is non-empty.

PAGE-INTERNAL. PosOrders.jsx has two returns — order screen :2416-3406 and floor :3410-3897 — and the
msg banner renders only in the first (:2481), so floor-view outcomes have no channel. Three unrelated
permission models sit on one billing modal: rank (:2791), the per-profile boolean pos_allow_void
(:2919), and the numeric pos_discount_limit (:438) which caps SILENTLY and then reports the cap. None is
named on screen, and the staff waiter's Charge button is ABSENT rather than disabled (:2791) — their
model becomes "the app is broken for me". MenuPricing.js:250 vs :510 is well-reasoned but silent: 5
columns vs 9, and "Cost Price" changes meaning between them with nothing saying a second variant exists.

STATE. Grammar strong and adopted; three real gaps: KDS has NO empty-board state (three cards each
rendering a bare "—", KitchenDisplay.jsx:271-273), surfaces a raw error.message on write failure
(:177-179), and MenuPricing.js:58,76 drops read errors and renders a failure as "No menu items yet."
GroupDashboard.jsx renders ReportLoadError ("Nothing here is a real figure") directly above a table body
reading "No outlets in this group" (:214 unguarded, :92 sets rows to [], :288-289 render through load and
error too). Print is a real surface (29 files with print-only, letterhead helpers, print-blank-input) —
but /pricing has no print handling and Legal.jsx:335 renders Print only for the current version, so the
404 and superseded branches have no print path. Legal.jsx is otherwise the reference implementation for
states in this codebase.

## Persona Red Flags

ACCOUNTANT VERIFYING A FIGURE. The digits don't group the way the words do — NPR 342,500 beside "Three
Lakh Forty-Two Thousand Five Hundred" IN ONE SENTENCE on the Annexure 13 letter they send a supplier for
signature. VAT and Non-VAT default to the open period and state it with PeriodScope but without
provisionalWhenOpen, so a statutory filing reads as settled while the month is still moving. And the HR
figure they reconcile against can change after the month "locked".

OWNER IN WEEK ONE. First screen is 24 KPI tiles and 4 charts with no "start here". Help is one 1,789-line
page reachable only from the sidebar, identical from every route, with no URL sync — nothing can link
them to the help for the page they're stuck on, and a locked feature is a dead row with a "Not on your
plan" badge and no upgrade path (Help.js:1017-1030). Clicking a module they don't own bounces them to the
dashboard in silence.

PHONE-FIRST FLOOR MANAGER BETWEEN SERVICES. The pending-orders count vanishes the moment the till
reconnects, so a queued order failing on RLS is invisible — no banner, no count, no retry. Their waiters'
Charge buttons are absent, not disabled. If the till crashes, recovery offers an email address. And the
two screens actually operated on a tablet — Stock.js and PurchaseBillForm.jsx — contain ZERO .form-input
between them: every field is an inline style object (four copies of the same one in Stock.js alone at
:980/1051/1200/1214/1350), so none picks up :disabled, the [aria-invalid] hook, or the coarse-pointer
rules — including two width:15/height:15 checkboxes that defeat the touch floor outright
(PurchaseBillForm.jsx:402-408, MenuPricing.js:307-309).

## Where the two assessments disagreed

- LABELS. A found only 3 unlabelled <select>s out of 208 and called labelling a strength. B found 78
  unlabelled controls — 76 of them <input> — 60 without even a placeholder. Both right: the S576 sweep
  targeted selects and held completely; inputs were never swept.
- window.confirm. A counted 21; B counted 22 + 8 window.alert = 30, one of which is useConfirm's own
  fallback. Use B's. ConfirmModal/useConfirm have 20/23 importers and IMS — which holds 9 of the
  remaining sites — has adopted neither.
- CONTRAST. A, reading source, found no contrast issues. B, measuring, found the public pages perfect
  and the shared classes failing in Light. Neither could have found the other's result. This is the
  argument for running both lanes.

B also ruled out 49 apparent htmlFor->missing-id violations as false positives: they point at
<SearchableSelect id=…> / <BsCalendarPicker id=…>, which forward id onto a <button type="button">, a
labelable element. The invariant holds: 0 real violations.

## Minor Observations

PurchaseBillForm.jsx:412 — the bill LINE TOTAL, the one box a receiver types a supplier's own figure
into, is a plain <input type="number"> while qty and rate beside it are QtyInput with arithmetic;
backwards · FestivalAllowance.jsx:264 and IncentiveRun.jsx:269 hardcode role="status" on a span carrying
errors as well as successes — an assertive failure announced politely, while four sibling files switch on
msg.startsWith('ok') correctly · Self-Service uses two different empty-state treatments one tab apart
(SelfServiceToday.jsx:44-54 vs SelfServiceHome.jsx:925-927) and contains ZERO <Tip>, on the surface with
the least-expert readers · three genuinely unlabelled selects remain (EmployeeList.jsx:397,
Purchases.js:565, ClientDrawer.js:1299) · of five IMS asset tabs only ValuationReportTab.js has
ReportLoadError · pricingPlans.js:139 says "Six of the seven features are per-outlet"; the list has six ·
.legal-summary-ref §-chips measure 10.8–18.3 x 17px, below the 24x24 AA floor and unaffected by any
coarse rule · fetchAllRows adoption is strong — 78 importers, 110 wrapped reads, only 2 real unwrapped
candidates · inline style={{ animation }}: 0 · Recharts series carrying chartMotion(): 27/27. Both of
those classes are fully closed.

## Questions to Consider

1. What does `en-NP` mean to you? Every money figure in the product was written believing that string
   made the number Nepali. It doesn't. What else in this codebase is correct-looking, load-bearing, and
   never once run?
2. Why does IMS have no ConfirmModal? 20-23 files use it; nine window.confirm calls and several
   unconfirmed asset-disposal and depreciation runs live in IMS. Not "when will it be swept" — why did
   the module that computes the money never adopt the component the module that collects it did?
3. The confirm dialog says entry pages lock. Who is responsible for that sentence being true? The copy is
   a spec. Nothing tests it, nothing rebuilds it from the code, and HR was built after it.
4. If a kitchen account can reach the cash-drawer screen by typing a URL, was KITCHEN_TEAM_ALLOWED_PATHS
   a permission or a preference? Should permissions be expressible in the nav array at all, or does that
   shape guarantee this bug?
5. You built a wa.me link, a tel: href, and "outlet-down issues any time" — and no phone number. Is that
   an oversight, or is there no line to publish? If the second, the hours string is a promise the
   business hasn't made.
6. DESIGN.md calls ReportPage "the frame every report renders inside." Three files import it. The
   ReportLoadError extraction relieved the pressure to migrate by making the shell optional. Finish the
   migration or rewrite the sentence — a design system that describes a product that doesn't exist is
   worse than no document, because it is the one thing the next agent will trust.
7. What is the second-most-repeated decision in this product after money formatting? There are shared
   modules for time, bands, ranks, errors, formulas and rank badges. Money — 52 copies — was invisible
   because every copy looked local and correct. What else looks local?
