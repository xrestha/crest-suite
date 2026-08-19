---
target: crest-suite (all modules) — campaign phase 8 synthesis
total_score: 34
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-18T23-56-44Z
slug: crest-suite-all-modules
---
Method: dual-agent (A: isolated design review from source · B: detector + structural greps + measured evidence on a fresh production build)

Campaign phase 8 of 8 — Synthesis. Scope: the whole product (shell, public/entry, dashboards, IMS, HR, POS, admin — all 86 routes, sampled representatively). Mode: Operate (public pages Persuade). This is the campaign's single full scored report; phases 1–7 ran light ranked findings by design.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:---:|-----------|
| 1 | Visibility of System Status | 4 | Context bar (client · BS period · Open/Closed · plan) on every route; skeletons with `aria-live`; offline pending-sync badges; payroll Draft/Finalized chip. Gap: Stock's Save All shows one "Saving…" over a per-item request loop. |
| 2 | Match System / Real World | 4 | Specificity goes down to the arithmetic: BS calendar as the product's spine, `pos_cash_movements` modelling credit-settled-in-cash, SSF/TDS/Annexure reality as UI, Dearness Allowance named in Nepali. |
| 3 | User Control and Freedom | 3 | Payroll Reopen fully reverses ledger side-effects; Archive-over-Delete; Escape/focus-restore contracts. But most destructive ops are native-confirm-then-gone with no undo. |
| 4 | Consistency and Standards | 3 | Token system is exceptional, but: 31 `badge-*` sites missing the base `badge` class (both agents independently); OwnerDashboard hardcodes FC banding (≤35/≤45) while IMS pages use the client's own `fc_warning_pct` via `fcBand()`; POS still carries 104 base-signal-token text sites vs 10 variant adoptions (measured). |
| 5 | Error Prevention | 3 | Best-in-class peaks (stale-payroll Finalize refusal, negative-usage save guard, closed-period defaulting, typed-name Danger Zone, shift close blocked on open orders) — capped by two live money-path gaps: short cash tender accepted as full payment; Sales Exceptions' mixed-unit staff total. |
| 6 | Recognition Rather Than Recall | 4 | Tips with the formula at the point of use (`COGS_FORMULA` imported, never re-typed); the context bar is a working-memory bridge; Purchases names ex-VAT vs incl-VAT totals side by side. |
| 7 | Flexibility and Efficiency | 3 | Ctrl+K palette, pinned favorites, Alt+C calculator, arithmetic-accepting `QtyInput`, bulk Excel. Gap: Save All is one awaited round trip per item (`Stock.js:358`); no keyboard path to hop periods. |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined single-accent system, closed scales, sticky-column hierarchy on 17-column tables. Deduction: reassurance arrives as walls of 11px text exactly where a nervous operator needs chunking (`PayrollRun.jsx:622`, long Help guides). |
| 9 | Error Recovery | 3 | Per-section load-error banners with Retry so a failure never reads as a zero; login errors split rate-limit/network from credentials. But many surfaces pipe raw `err.message` (PostgREST jargon) to the operator; some queue-flush catches are silent. |
| 10 | Help and Documentation | 4 | `Help.js` is a real searchable per-page manual in operator voice; Tip coverage keeps most help in place. |
| **Total** | | **34/40** | **Good — top of the band** |

Coverage honesty (from Assessment A): ~25 files read substantively across all seven areas; ~50 routes unopened (list in the assessment); scores could shift ±2 with full coverage.

## Design Specificity Verdict

**Authored, not category-interchangeable — and the specificity goes all the way down to the arithmetic.** The BS calendar is the product's spine (periods, fiscal year, day strips, even the pricing footer's "© 2083 BS"); the cash drawer models how money actually moves in this market; statutory reality (SSF challan deadlines, TDS YTD projection, Annexure 13) is UI, not documentation; and PRODUCT.md's "two literacy levels on one screen" is genuinely executed — Variance prints the formula for the accountant and shelf-language for the owner on the same screen. Both anti-references (legacy-ERP cram, generic AI-SaaS template) are avoided.

**Deterministic scan** (19 findings across 7 directories): 2 known false positives (`Layout.css` sidebar width/margin transitions, documented exceptions); ~6 legitimate categorical/print-template hexes (`Roster.jsx` DEFAULT_SHIFTS, `parkingSlipHtml.js`); ~9 real drift sites — `Help.js:1522` `#0b0b0b`, `ImsGuideTab.jsx` ×4, two `#bbb`, `PosTableManagement.jsx:236` `#666`, and the S521-eradicated indigo `#60a5fa` resurfaced in `leaveConstants.js:10`. The detector remains nearly inert on JSX; every structural finding below is grep- or measurement-derived.

**Measured evidence** (no live overlay — no authenticated server was running and no login was performed, so measurements are scoped to a fresh production build's pre-auth pages on the default theme): fonts 100% Poppins on all controls; all 21 contrast combinations measured on /login and /pricing pass AA (worst 5.45:1); autoComplete correct everywhere; shell focus rules carry the S574 outline pair — but login fields override it with a 0.15-alpha ring alone, and the public pages have no skip link (the `.skip-link` exists only in the authenticated shell).

## Overall Impression

A year of accretion produced a product whose *system* is now stronger than most design teams ship: token discipline with measured rationale annotated in the CSS, choreographed high-stakes flows (payroll finalize, shift close, danger zone, subscription lock), and figures that defend themselves — one formula source, frozen snapshots, coverage-first banners. The campaign's seven fix phases removed every P0 either agent could find; what remains is a thin layer of P1/P2 residue concentrated in POS (the one module whose mechanical sweep was deferred) and a recurring bug class (string-concatenated alpha on `var()` tokens) that has now shipped in four places and is live in `Help.js` today. The single biggest opportunity is no longer any page — it is retiring `window.confirm` from the product's most consequential sentences, which are currently delivered in unthemed OS chrome by a product that owns a stacked, focus-trapped, themed Modal.

## What's Working

1. **The design system is enforced, measured, and remembered.** `Layout.css` reads like a lab notebook — contrast ratios, WCAG floors and failure post-mortems annotated at the exact rule. Reduced-motion, coarse-pointer, focus-pairing and print fragmentation are handled systemically.
2. **Figures defend themselves.** Formulas printed at point of use from one shared source; closed-period defaulting with neutral rendering when inputs are missing; per-section error banners so a failed fetch never masquerades as zero; frozen Z-report and Owner Report snapshots so a reprint cannot disagree with what was signed.
3. **High-stakes flows are choreographed** with consequence summaries, refusals-with-fixes and reversibility — the subscription lock is the scariest screen in the product and its most reassuring.

## Campaign Trend — July baselines → now

| Surface | July baseline | Mid-campaign (pre-fix) | Now |
|---|---|---|---|
| IMS module | 24/40 (Jul 18) | 21/40 (phase 4, Aug 13) | fixed through S551 |
| HR module | 25/40 (Jul 18) | 26/40 (phase 5, Aug 18) | fixed through S570/S572 |
| POS module | 27/40 (Jul 18) | 5 P0s (phase 6, no score) | money paths fixed S573 |
| GuestMenu | 27/40 (Jul 12) | — | — |
| ClientDashboard | — | 28/40 (Aug 14) | fixed S558/S569 |
| **Product-wide** | — | — | **34/40** |

Not like-for-like — the July runs scored single modules, this run scores the product — but the direction is real: the deeper phase critiques scored *lower* than the July baselines on the same surfaces (more evidence, harsher), and the post-fix product now sits 7–10 points above any baseline. The campaign found and fixed 12 P0s (five POS money-path, seven Admin entitlement/data-loss), plus the app-wide contrast-variant system (S549) and its ~750-site adoption sweep (S550/S551), the focus-outline pair (S574), and four payroll-correctness defects (S570).

**Standing open items, carried forward deliberately** (recorded in `.claude/rules/pos-billing.md` and the S574 log): POS discount-cap/void/comp enforced only in the browser (needs a `close_pos_order` RPC); `usePosIdleLock.js` written but not wired; a fired item removable by any Staff account; the admin drawer's 8-tab IA regroup; a global error-message mapping layer; ToS/Privacy named but not linked (no documents exist to link). **Pending manual deploy steps from phase 7:** migrations `20260818180000` (is_premium fold — before deploying) and `20260818190000` (trial fold) in the SQL Editor, `supabase functions deploy admin-user-ops`, and a `CACHE_NAME` bump.

## Priority Issues

**[P1] A short cash tender is accepted and stored as full payment**
- **What**: `payDisabled = saving || !orderId || !isOnline` (`PosOrders.jsx:2126`) — no tendered check for single-payment Cash; a tender below the bill total stores `tendered_amount` short while `paid_amount` records the full amount, and the change line clamps to 0, so nothing on screen hints.
- **Why it matters**: the drawer goes short with no cause recorded; the variance surfaces hours later at shift close, attributed to nobody.
- **Fix**: when `payMethod === 'Cash'` and a tender is entered below `payTotal`, block Confirm Payment with "Tendered NPR X is less than the bill total NPR Y" — split mode already guards this; mirror it.
- **Suggested command**: /impeccable harden

**[P1] The printed cash-settlement slip contradicts itself**
- **What**: `buildShiftSlipHtml` computes Variance as `closing − (opening + cashSales)` (`PosShifts.jsx:85`), ignoring cash in/out, while the Expected Cash line two rows above on the same slip includes them (`:126`) — and the stored `closing_report` uses the correct `expectedCashOf`.
- **Why it matters**: any shift with a supplier payment or credit settlement prints a *signed paper record* whose Variance disagrees with its own Expected Cash and with the screen — precisely the reproducibility failure the S573 freeze work existed to close.
- **Fix**: derive the slip's Variance from the same `expectedCashOf` figure; delete the local formula so exactly one definition exists.
- **Suggested command**: /impeccable harden

**[P2] Sales Exceptions ranks named staff on a number that isn't a quantity of anything**
- **What**: per-row `amount` is discount NPR for discounts, menu value incl. VAT for voids, and food *cost* for comps (`PosExceptionReport.jsx:96–101`), then summed and sorted per staff member. Compounded: `usePosIdleLock.js` is imported nowhere, so on a shared till attribution records whoever last typed a PIN.
- **Why it matters**: this screen exists to accuse people; a waiter can be confronted over an incoherent figure attributed to the wrong person.
- **Fix**: three per-type columns instead of a blended total (or normalize all three to revenue-equivalent value and label it); wire the idle lock before shipping any per-staff ranking.
- **Suggested command**: /impeccable clarify (the ranking) + /impeccable harden (the idle lock)

**[P2] The string-concatenated alpha-tint bug class is live in Help.js — its fourth shipping**
- **What**: `Help.js:1358/1375/1383` build `${tier.planColor}15/08/30/35` and `:1520/1529` build `${MODULE_COLORS.ims}70/18/15/40`, where every source is a `var()` token — invalid CSS, silently discarded. Tier lock-chips, upgrade-nudge boxes, the module highlight border and plan badge tints all render untinted/borderless today. `pricingPlans.js`'s own comment states the concat no longer works. (Measured: 7 concat sites in `src/pages`, 4 in HR — the HR ones are hex-sourced and valid, classified not dropped.)
- **Why it matters**: same class as S570 (Attendance legend), S572 (Leave badges, Overtime pills) — it fails invisibly, three times over. The remaining sites cluster in `pages/`.
- **Fix**: route through `colorTint()` (exported from `pricingPlans.js` since S574); then a one-time repo grep for the pattern as a regression guard.
- **Suggested command**: /impeccable harden

**[P2] Filter and period selects are mostly nameless to assistive tech — and POS labels barely exist**
- **What**: ~196 `form-select` sites with only ~25 accessible names — the period picker on nearly every report announces "combo box, Ashadh 2083" with no name. POS measures 60 `<label>` occurrences against 7 `htmlFor` (every other module is near-parity after the S569/S572 sweeps).
- **Why it matters**: the S546/S569 label sweep keyed off `.form-field`, so header filters and POS's local styles escaped it — a screen-reader user loses the one control that scopes every figure on the page.
- **Fix**: one sweep adding `aria-label`/visually-hidden labels to non-`.form-field` selects, plus the POS label wiring; the convention to copy already exists in HR.
- **Suggested command**: /impeccable harden

**[P2] 31 status chips render half-styled — the badge-gold failure class, recurring**
- **What**: `className="badge-green|amber|gray|yellow"` without the base `badge` class gets tint+color but no padding/radius/11px size (both agents found this independently; B enumerated all 31 sites — concentrated in `Roster.jsx` ×7, `SalesReport.jsx` ×6, `PosCustomers.jsx` ×4, `KotLog.jsx` ×3, plus GroupDashboard, GratuityTracker, FinalSettlement, SwapRequestsPanel, PosOrders, PosShifts).
- **Why it matters**: chips are inconsistent page to page, and this exact class of silent CSS failure already shipped once for months (`badge-gold`).
- **Fix**: mechanical — add the base class at all 31 sites; add a grep guard since it has now happened twice.
- **Suggested command**: /impeccable polish

## Persona Red Flags

**Alex (impatient power user, daily entry)**: Well served — Ctrl+K, pins, Alt+C, `QtyInput` arithmetic, cached revisits. Red flags: Stock's **Save All** awaits one request per visible item (`Stock.js:358`) — a 300-item closing count is minutes of a single "Saving…" with no progress count; no keyboard shortcut to hop periods; the Regenerate → Finalize native confirm he will stop reading by week three.

**Sam (screen reader / keyboard-only)**: Better served than most B2B tools (skip link in shell, stacked modal traps, roving tablists, per-cell `aria-label`s on Attendance). Red flags: the **unnamed filter selects** on nearly every report; `Tip` content not dismissable with Escape (WCAG 1.4.13); `SearchableSelect`'s trigger on the UA default ring while every neighbour gets the themed pair; login fields override the focus-outline pair with a 0.15-alpha ring alone (measured).

**Rajan (non-accountant owner)**: The product's best-served persona — Variance explains what a missing count *means* before showing red; Tips carry Nepal-market benchmarks; SubscriptionLock answers his actual fear. Red flags: the **Sales Exceptions staff total** is a number he *will* act on against a person; OwnerDashboard's hardcoded FC banding can disagree with the Variance page it links to if he customized thresholds (`OwnerDashboard.jsx:479` vs `fcBand`); `PayrollRun.jsx:622`'s ~90-word 11px footer is exactly the wall PRODUCT.md says he can't parse.

**Mina (accountant, reconciliation & filing)**: Strongly served — one formula source, ex-VAT/incl-VAT named separately, frozen snapshots, PAN on the payslip letterhead, .json+.xlsx pairing. Red flags: the **self-contradicting printed settlement slip** (P1 above) is precisely the failure she exists to catch, on signed paper; **Stock Count vs Monthly Summary COGS** differ by exactly the sub-recipe amount with nothing on either page disclosing it — deliberate internally, but Mina doesn't read CLAUDE.md; one sentence on either page saves her an afternoon; raw `err.message` strings can print PostgREST jargon into her workflow.

## Minor Observations

- `Layout.js:321` still selects the vestigial `trial_ends_at` column (folded by migration `20260818190000`).
- `.sidebar-dropdown-panel` declares `box-shadow` twice; the hardcoded one wins over the themed token (`Layout.css:611,615`).
- Stock's "✓ Saved" tick auto-clears in 2.5s with no `role="status"` (payroll's `msg` does it right).
- The indigo `#60a5fa` is back in `leaveConstants.js:10` as a leave-type categorical colour — decide whether it's a documented categorical palette (like Roster's DEFAULT_SHIFTS) or the ninth recurrence of the tracked drift.
- Real detector drift worth a 10-minute sweep: `Help.js:1522` `#0b0b0b`, `ImsGuideTab.jsx` ×4, `EmployeeJoiningForm.jsx:62`/`Roster.jsx:535` `#bbb`, `PosTableManagement.jsx:236` `#666`.
- Public pages lack a skip link (the shell's `.skip-link` never renders pre-auth); "Forgot password?" measures 120×28 (below the touch floor).
- OwnerDashboard's empty-trend card ("appears once your first period closes") is a model empty state worth propagating.

## Questions to Consider

1. **Should the browser speak for the brand at its most consequential moments?** Period close, payroll regenerate, drawer-short, whole-day clears — all `window.confirm` (70 sites product-wide), while the product owns a stacked, focus-trapped, themed Modal. The content is excellent; the vessel undercuts it.
2. **How many definitions of a food-cost verdict should exist?** Settings-driven `fcBand` on IMS pages, hardcoded 35/45 on the Owner Dashboard, frozen 35 in Menu Engineering — individually defensible, but two screens can colour the same month differently for the same owner.
3. **Should a screen that ranks named employees meet a higher evidential bar before shipping the ranking?** Until the idle lock is wired and the units are coherent, "spot the outlier" is a feature the evidence doesn't yet support.
