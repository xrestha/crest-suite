---
target: crest-suite, all modules
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-26T09-59-51Z
slug: crest-suite-all-modules
---
# Crest Suite — product-wide critique (re-run vs 2026-08-18 baseline)

Method: dual-agent (A: design review from source · B: detector + measured browser evidence, Dark + Light presets, live app via Playwright).

## Design Health Score — 32/40 (Good)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | New surfaces have full state grammar; older reports have no loading/error distinction |
| 2 | Match System / Real World | 4 | BS calendar, NPR, IRD/SSF/TDS to statute, plain-language reframes — strongest suit |
| 3 | User Control and Freedom | 3 | Reopen paths everywhere; routine deletes still confirm-no-undo |
| 4 | Consistency and Standards | 2 | State grammar is 3-pages-new vs ~19-old; window.confirm vs ConfirmModal split 75:9 |
| 5 | Error Prevention | 4 | Master-rate amber flags, closed-period defaults, cycle guards, stale-draft Finalize block |
| 6 | Recognition Rather Than Recall | 3 | Strong working-memory bridges; 12 expert-named stock reports force recall |
| 7 | Flexibility and Efficiency | 4 | Palette, pins, Alt+C, expression inputs, Save&Next |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined density; ~35 elements of 10px functional text on dashboard; 9-col bill grid |
| 9 | Error Recovery | 2 | 69 error-swallowing destructures in src/modules; statutory + frozen-snapshot paths included |
| 10 | Help and Documentation | 4 | Help + module guides + ubiquitous domain Tips |
| **Total** | | **32/40** | **Good** |

Baseline 2026-08-18 was 34/40. The drop is evidence-depth, not regression: this run measured Light (baseline-era runs that measured Dark found zero contrast failures; Light has 4), injected the live detector (10px text class invisible to source review), and grepped adoption of the product's own new patterns.

## Design Specificity Verdict

**Authored, not template** (Assessment A, pre-detector). BS calendar native, NPR everywhere, Nepal FY first-class, IRD Annexure 13/VAT/SSF/TDS to actual statute, login copy from real operator pain, jargon reframed for owners ("cash on a shelf"), vendor-bill-mirror purchase entry, scoped bone-and-pine guest palette. Specificity concentrates on recently-touched surfaces; middle-aged reports (VatReport, MonthlySummary) are the plainer residue.

**Deterministic scan**: detector exit 2, 20 findings — 16 design-system-color, 2 layout-transition (Layout.css:325 width, :825 margin-left), 1 font, 1 font-size. False positives: ThemeContext.js:52 (token-definition file, permanent FP), CRA boilerplate (App.css:28, index.css:32), 8 chart-palette literals (allowed class). Genuine candidates: PinEntry.js:24,39 (#94a3b8/#e2e8f0), Roster.jsx:667 + EmployeeJoiningForm.jsx:62 (#bbb), viewPosBill.js:34 (#c00 print HTML). Raw-hex grep: 473 across 55 files but dominated by allowed classes (print templates, var() fallbacks, chart palettes). Base-signal-token-as-text grep: 0 (the S576/S578 sweeps held).

**Browser evidence**: live app measured on Dark AND Light, admin session on dummy client, measure-only. Dark: 0 genuine contrast failures. Light: 4 (see P2 below). Overlay injection succeeded on /dashboard — ~35× undersized-ui-text (10px functional text below the 11px floor: KPI card labels/sublines, sidebar labels, FC legend, "Full Report →" links). Mobile 390px: zero horizontal overflow on /login, /pricing, /dashboard. Item Edit dialog: full dialog semantics, all 7 fields labeled, 0 contrast failures. Dev server and live-server both stopped after measurement.

**One A/B disagreement, unresolved**: A reports Stock.js:703-707 Summary body cells using base signal tokens as text (while its tfoot at :718-723 uses *-text); B's grep for that class found 0 occurrences product-wide. B's pattern misses ternary/variable-mediated colors (~⅓ of sites historically), so A's claim is plausible-unverified — check that file before or during the fix pass.

## Overall Impression

The product's new grammar (ReportPage's six states, consequence-copy confirms, pack-price helper, scopeLine-everywhere) is genuinely excellent — and adopted by almost nothing built before it. Every P1/P2 in this run is the same shape: a rule the product itself wrote, enforced on 3 pages and absent on 19. The single biggest opportunity is adoption sweeps, not new design.

## What's Working

1. **ReportPage.jsx state grammar** — six states, stats gated on !loading && !error — plus ConsolidatedPnl's ignored-labour footnote naming the amount (ConsolidatedPnl.jsx:457-464).
2. **Items.js pack helper (:518-553) + PurchaseBillModal per-row master-rate hints (:285-291)** — error prevention exactly where a mispriced item poisons every report at once.
3. **Both phone surfaces are state-machine complete** — SelfServiceToday.jsx:65-90 (five distinct roster states), GuestMenu's visibility-gated polling keeping last-known stage.

## Priority Issues

1. **[P1] Failed reads render as NPR 0 on ~19 of 22 report pages, including statutory and frozen-snapshot paths.** 69 `const { data } = await` error-swallows in src/modules. Worst: VatReport.js:82 and NonVatReport.js:77 (statutory, zero error handling), computeMonthlyReport.js ×5 + generateMonthlyReport.js:12 (a swallowed error freezes a wrong number into the immutable snapshot permanently), MonthlyOwnerReport.jsx ×4, VendorBalanceConfirmation.js:73,85, OutstandingPayables.js:154,169, VendorReport.js:90, BestSellers.js:56. ReportPage/firstError adopted by exactly 3 files. An accountant files on a silently-zeroed VAT report. Fix: firstError() + error branch, statutory and snapshot generators first. → /impeccable harden

2. **[P1] The S601 stale-load race is still open on the two pages that motivated the fix.** ConsolidatedPnl.jsx:140-146 and StockAgeing.js:102-107 lack useLatestRequest while 19 siblings carry it; CLAUDE.md documents ConsolidatedPnl as the motivating example and the sweep as done. Arrow-keying the period select fires N concurrent 11-query loads and the last to land wins the figures while subtitle, print title, Excel scopeLine AND filename come from the selected period — one month's figures inside another month's workbook. Fix: periodReq.begin/isCurrent, plus reconcile the CLAUDE.md claim. → /impeccable harden

3. **[P2] Light theme measurably fails where Dark passes; 10px functional text floor.** Light failures: Layout.js:1004-1005 (and :604) hardcode the Dark green tint rgba(52,211,153,0.1) under a Light text token → 4.42:1 subscription chip; ClientDashboard.jsx:1655-1656 chart-palette literals (#c9a84c, #34d399) used as HTML legend text → 2.29:1 and 1.92:1, failing even the 3:1 graphics floor; sidebar-pin ☆ 4.07:1 @14px. Plus ~35 elements of 10px text on the dashboard. → /impeccable polish

4. **[P2] The S528/S529 1000-row truncation class has 4 live sites.** FifoReport.js:75-77 (sales_entries + wastages — the documented realistic 1000-crosser — + staff_meals), BestSellers.js:59, PeriodComparison.js:132 (sales_entries across MULTIPLE periods; sibling :123 is wrapped), Items.js:73-110 (checkAllUsage feeds the delete guard and "unused" filter — a used item can be reported unused and deleted). All produce believable smaller numbers, never errors. → /impeccable harden

5. **[P2] Period close runs entirely on window.confirm.** Periods.js:112,123,199,265,297 — ConfirmModal not even imported — despite the S575 rule naming period close as its #1 case. Same family: PayrollRun.jsx:240 (Regenerate deletes departed employees' payslips), Stock.js:354/396/430 (negative-usage save, clear-all, opening-stock overwrite). window.confirm 75 : ConfirmModal 9 files. → /impeccable harden

## Persona Red Flags

**Alex (power user)**: arrow-keying the period select on ConsolidatedPnl/StockAgeing fires concurrent multi-query loads with last-writer-wins figures. Otherwise well served (Alt+C, pins, expression inputs).

**Sam (accessibility)**: ~50 unlabeled controls remain — the S603 sweep closed selects, the residue is bare checkbox/color/time inputs in table cells (ShiftSettingsPanel.jsx:176-208, MenuPricing.js:297-698, FinalSettlement.jsx:727,731, PurchaseBillModal.jsx:331,363); placeholder-only toolbar search (Items.js:667); hue-only column coding in Stock summary; 10px text; the 4 Light-preset contrast failures.

**Rajan (owner-operator, phone, between services)**: 16px floor now covers him; his question "am I losing stock?" is split across three expert-named variance reports with nothing routing him; NPR-unit facts living only in hover Tips he can't hover.

## Minor Observations

- Print ungated while Export is gated on the same action rows.
- React key collision on duplicate outlet names in the group matrix (Excel dedupes, screen doesn't).
- rate=0 accepted silently in the Items form.
- borderRadius: 8 literals in PosOrders banners; PinEntry.js:24,39 slate hexes; #bbb in Roster.jsx:667/EmployeeJoiningForm.jsx:62.
- Layout.css transitions on width (:325) and margin-left (:825) — layout-thrash class.
- IA: Vendor Balance Confirmation (an IRD letter) filed under "Menu & Vendors" instead of Finance Reports (Layout.js:83-96).
- Stock Reports nav group = 12 items, the product's heaviest single decision point (cognitive-load chunking failure; the other checklist failures: PurchaseBillModal's 8 interactive cells per row, "Total" vs "Amount" near-synonym money columns). Overall cognitive load: moderate (2–3 fails).

## Questions to Consider

1. What makes ReportPage adoption *inevitable* rather than aspirational — a lint rule, a checklist step, or a migration sweep with a deadline?
2. Are Variance / Theoretical Variance / Shrinkage three reports, or one question ("am I losing stock?") at three rigor levels behind one entry point?
3. CLAUDE.md said the S601 race guard was "now on 19 pages" while it was absent from the page the rule was written about — what ritual reconciles a "done" claim against grep before it's written down?
