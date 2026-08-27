---
target: crest-suite, all modules
total_score: 34
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-26T13-36-09Z
slug: crest-suite-all-modules
---
# Crest Suite — product-wide critique (post-S612 fix pass, vs 34 → 32 baseline)

Method: dual-agent (A: design review from source · B: detector + measured verification greps + hand-rolled Playwright pass on the built public pages; the MCP browser was unavailable this session, so authenticated routes were not browser-measured).

## Design Health Score — 34/40 (Good)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Context bar/offline/posted-counters excellent; blemish: window.alert outcomes on Periods, a stale-loading edge in PaymentReport.js:44-55 |
| 2 | Match System / Real World | 4 | BS/NPR/FonePay/IRD series + the bill-shaped purchase form — the crown jewel |
| 3 | User Control and Freedom | 3 | Reopen paths explain themselves; Regenerate destroys manual TDS/TADA edits; no Save All undo |
| 4 | Consistency and Standards | 2 | Two page-shell dialects (POS vs rest); 3 tab families; ReportPage the full shell on 3 of ~30 reports; ~25 pages override their own stat-grid standard |
| 5 | Error Prevention | 3 | Payroll freshness gate is 4/4-grade; period close — max stakes — has no preflight |
| 6 | Recognition Rather Than Recall | 4 | Formulas restated in place, master-rate under the rate box, Data Coverage badges |
| 7 | Flexibility and Efficiency | 3 | Ctrl+K/Alt+C/arithmetic inputs; mouse-only drill-downs; Variance lacks export |
| 8 | Aesthetic and Minimalist Design | 3 | One-accent holds; PayrollRun's 180-word footnote wall; 6-KPI strips |
| 9 | Error Recovery | 4 | ReportLoadError's failed≠empty sentence now product-wide; reopen failure names the alternative path |
| 10 | Help and Documentation | 4 | Searchable Help + glossary; NoPeriodState teaches the core concept |
| **Total** | | **34/40** | **Good** |

Trend context: 34 (baseline) → 32 (deeper evidence) → 34. The recovered two points are the S612 fix pass measured landing: state grammar (H9 2→4), confirms (H5 2→3 with the period-close gap now the headline), consistency held at 2 for structural reasons (dialects/shell adoption), not token drift.

## What B verified about the fix pass (all confirmed by measurement)

- window.confirm in Periods.js / Stock.js / PayrollRun.jsx / MonthlyOwnerReport.jsx / ClientDashboard.jsx: **0** (each imports ConfirmModal). 55 real sites remain product-wide, dominated by routine single-row deletes the S575 rule deliberately keeps native.
- useLatestRequest: **21 importers — matches CLAUDE.md's corrected count exactly**; ConsolidatedPnl and StockAgeing carry begin()/isCurrent().
- firstError imported by 32 files, ReportLoadError by 34 — report pages near-fully covered.
- The argument-shape token grep (`('var(--theme-`): 6 hits, **zero violations** — Stock.js's tdStyle cells confirmed on the *-text variants.
- Layout.js dark-tint rgba literals: **0**.
- Detector: 20 → 17 findings; 15 of 17 in known false-positive classes; the 2 standing are the documented sidebar collapse transitions.
- Built public pages (Playwright, 1440×900 + 390×844): **0 contrast failures** (min ratio 5.45), **0 horizontal overflow**. Public pages render their own fixed dark palette. Authenticated routes not measured — no credentials without the MCP browser profile.

## Design Specificity Verdict

**Authored, not category-interchangeable** (A, unanchored). BS calendar first-class, NPR/en-NP throughout, FonePay native, IRD artifacts to statute (TI/PB/NC series, "can't be filed on the challan"), plain-language reframes at owner altitude ("waste, theft, over-portioning", "Whole chicken = 70%"), localized benchmarks ("28–35% for Nepal F&B"). The copy layer is the product's strongest design asset. Residual generic surface: KPI-tile chrome only.

**Measurement-pattern note (not a regression):** the previous run's "base-token-as-text: 0" used a narrower property grep. This run's broader pattern found **79** `color: 'var(--theme-BASE)'` sites — ~21 are compliant fill-slot pairs (color+textColor object maps), **~54 are direct text usage**, concentrated in Help.js (32), Periods.js (15), Settings.js (8). The earlier sweeps were real; this is the tail their patterns couldn't see.

## Overall Impression

The fix pass held: the failure grammar is now a lived, measured, product-wide rule, and the two agents' verification agrees with the docs for the first time in the campaign's history. What remains splits cleanly in two: a small set of genuinely new findings (mobile KPI crush, the period-close preflight), and known classes whose *tails* are now enumerated instead of estimated (unpaged wastages reads, write-path error swallows, the *-text and 10px residues).

## What's Working

1. **State-grammar doctrine product-wide** — ReportPage/ReportLoadError/NoPeriodState + firstError in 30+ files; "a failed read must never render as NPR 0" is enforced, not aspirational.
2. **Domain authorship in copy** — Variance's over/under banner, PayrollRun's SSF/OT chips, Items tooltips, PurchaseBillModal's bill-shaped form with the rate-suspect amber.
3. **High-stakes flow design** — PayrollRun's data-derived freshness gate + consequence-summary confirms are the pattern the rest of the product should be measured against.

## Priority Issues

1. **[P1] ~25 report pages override `.stat-grid`'s auto-fit with inline `repeat(N,1fr)` (N up to 6)** — an inline style outranks every media query, so phones get N crushed KPI columns on exactly the pages an owner checks between services. The codebase already documents this trap class (`.dash-3col-*` exists because of it). Fix: delete the overrides — `Layout.css`'s stat-grid rule already reflows. File list in A's checkpoint. → /impeccable adapt

2. **[P1] Period close has no closing-count preflight** (Periods.js close flow). The product's highest-stakes action — it locks the month AND mints the frozen Monthly Report — carries only advisory prose, while payroll finalize earned a data-derived gate. A period closed without counts freezes structurally-wrong figures into the immutable artifact. Fix: count items missing closing entries into the ConfirmModal body, danger-styled when >0 — the PayrollRun pattern. → /impeccable harden

3. **[P2] The S528 truncation class has an enumerated tail: ~20 unwrapped transaction reads in report files.** `wastages` is the systematic gap (10 of 12 reads unwrapped — one row per item per day, the documented realistic crosser), incl. multi-period AnnualSummary.js:87, PeriodComparison.js:124, ShrinkageReport.js:74; `sales_entries` splits 9/9 (unwrapped incl. fiscal-year AnnualSummary.js:93, MonthlySummary:68, StockReport:74); ReorderReport.js:97 is the sole unwrapped purchase_entries. → /impeccable harden

4. **[P2] The error-swallow class is closed for report renders but open on WRITE and guard paths**: 144 error-dropping destructures remain in 54 files — Roster.jsx drops errors on two writes (scopedInsert:240, scopedUpsert:434), Periods.js:128 drops a period-INSERT error, FinalSettlement.jsx has 4 guard reads inside the finalize money flow (:429 is the staleness re-check itself), PosOrders.jsx carries 19. A dropped write error is silent data loss, not a silent zero. → /impeccable harden

5. **[P2] POS reports are a different dialect**: mouse-only `<tr onClick>` drill-downs (PosExceptionReport.jsx:380, KotLog.jsx:473 — the RowDisclosure sweep never reached POS), inline h2-first heading outlines, hand-rolled KPI tiles, a third tab family. Decide: codify the till dialect in DESIGN.md or converge it. → /impeccable polish

## Persona Red Flags

**Alex**: mouse wall on drill-downs in an otherwise keyboard-first product; Variance — "the money report" — has no export while lesser siblings do; no saved filters.
**Sam**: unreachable row drill-downs; unnamed payroll spin buttons; Stock.js:835's opacity-0.4 dimmed rows (violates DESIGN.md's own Don't); h2-first outlines on POS pages. Counterweights are strong: Modal contract, FieldError, tablists, skip link.
**Rajan**: the KPI crush lands on exactly the pages he checks on a phone between services; the payroll footnote wall is unreadable there; offline stock count and the context bar remain genuine phone-first wins.

## Minor Observations

Loading/empty copy varies per sibling · PayrollRun.jsx:665 renders a literal `\'` in UI copy and its footnote is a 180-word wall · Variance banners/filters render during loading · KOT/BOT uses success-green for a category · PurchaseBillModal's VAT label uses base amber as text and its error `<p>` lacks role=alert · ~80 unlabeled controls remain by approximate scan (PosOrders 9, OutstandingPayables 5, Sales.js 4) · fontSize:10 product-wide is ~187 non-chart sites (AdminDashboardOverview 15, Help 12, Purchases 10) — needs the same micro-caps-vs-plain-case triage ClientDashboard got, or a documented decision · 212 green/gold rgba tint literals across 41 files are candidates for colorTint() consolidation but are mostly the documented literal-tint convention.

## Questions to Consider

1. ReportPage claims to be "the shell every report renders inside" — 3 of ~30 are; did the error-card retrofit permanently relieve the pressure to converge? Finish the migration or rewrite the doc.
2. The thesis is "trust the figure enough to file on it" — why did payroll finalize earn a data-derived gate while period close, which mints the frozen artifact, got one advisory sentence?
3. Is POS deliberately a different room, or drift? Write it into DESIGN.md or erase it.
4. Is the phone a supported reporting surface? The breakpoint says yes; 25 inline overrides say no. Decide once.
