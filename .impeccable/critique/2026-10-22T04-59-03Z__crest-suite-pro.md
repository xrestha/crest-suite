---
target: crest-suite-pro (owner layer)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-10-22T04-59-03Z
slug: crest-suite-pro
---
# Crest Suite Pro owner layer: design critique

Method: dual-agent (A: design review from source · B: bundled detector + static measured evidence). Browser visualization skipped: the Claude in Chrome extension was not connected and every route needs a sign-in.

Scope: Owner Dashboard (src/pages/dashboard/OwnerDashboard.jsx), Monthly Owner Report (MonthlyOwnerReport.jsx/.css), Consolidated P&L (ConsolidatedPnl.jsx), Group Console (GroupDashboard.jsx + OutletAccessPanel, MasterPushPanel, GroupItemPrices), Demand Forecast (src/modules/ims/stockcount/DemandForecast.js), Fixed Assets (src/modules/ims/assets/*), SuiteGate (src/components/SuiteGate.js), the Suite nav group in Layout.js. Mode: Operate.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Loading, retry and not-judged states strong; the month sits in subtitle prose; four reads have no timeout (AssetCategoryModal.jsx:50,70-71, ValuationReportTab.js:40, MonthlyOwnerReport.jsx:239, DemandForecast.js:67) |
| 2 | Match with the real world | 2 | Depreciation period uses AD type="date" (DepreciationRunTab.js:406-414); MTD, Prime Cost, COGS, WDV, pp unexplained; push actions shown as raw codes adopt/conflict (MasterPushPanel.jsx:347) |
| 3 | User control and freedom | 3 | Push previews first; a regular depreciation Post with no overlap posts permanently with no confirm (DepreciationRunTab.js:301) |
| 4 | Consistency | 2 | Four names for one margin (OwnerDashboard.jsx:559, MonthlyOwnerReport.jsx:809, ConsolidatedPnl.jsx:541, Home); Labor vs Labour; three hand-rolled amber banners |
| 5 | Error prevention | 3 | "View Full Monthly Report" beside "Bhadra · Open" opens the latest CLOSED month (OwnerDashboard.jsx:444-448, MonthlyOwnerReport.jsx:224) |
| 6 | Recognition rather than recall | 2 | Report Financial Summary has no prior-month column; comparison is the last section (MonthlyOwnerReport.jsx:747, 1438) |
| 7 | Flexibility and efficiency | 2 | No URL period state on any page; no prev/next month; split Month/Year selects (GroupDashboard.jsx:399-406) |
| 8 | Aesthetic and minimalist design | 2 | Nine equal tiles; ~900-char tips (OwnerDashboard.jsx:533, GroupDashboard.jsx:462); 60-word trend footer (OwnerDashboard.jsx:670-676); four prose notes above Demand Forecast table (DemandForecast.js:755-789) |
| 9 | Error recovery | 3 | ActionError/ReportLoadError name consequences; "This month is still open" is a dead end (MonthlyOwnerReport.jsx:650-656) |
| 10 | Help and documentation | 3 | Tips on every dashboard KPI but long; Fixed Assets nearly untipped (ValuationReportTab 0/3, AssetCard 1/4, AssetRegisterTab headers 1/11) |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

LLM: The detail is authored for this owner (BS months, "Spend % so far" kept apart from Food Cost %, settledFigure withholding colour and marks, labour basis printed under the figure). The page COMPOSITIONS are category furniture: Owner Dashboard = 5 tiles + 4 tiles + line chart (OwnerDashboard.jsx:503-703); Group Console = filter card + 4 KPIs + table (GroupDashboard.jsx:396-594); P&L = 3 KPIs + table (ConsolidatedPnl.jsx:516-689). All specificity lives in tips and 11px subtext. The Monthly Owner Report is the exception: letterhead, written summary, Actual vs Target, print-surviving DirectionMark.

Detector: 0 findings across 23 files / 11,542 lines (exit 0; --no-config also 0; a planted bad file was flagged, so the scan is real). Measured drift: 630 inline style={{ (MonthlyOwnerReport 136, DemandForecast 81, TaxPoolTab 52), 23 on buttons/inputs; non-zero radius at MonthlyOwnerReport.jsx:714 (borderRadius 6) and ValuationReportTab.js:106 (Bar radius); 14 hand-rolled uppercase section labels at 4 sizes x 4 letter-spacings; 6 empty <th> (AssetCategoryModal.jsx:99, AssetRegisterTab.js:189, TaxPoolOpeningsCard.jsx:311, TaxPoolTab.js:718, DemandForecast.js:814, OutletAccessPanel.jsx:251); 0 sticky headers; 179 inline textAlign right; hand-rolled chip row DepreciationRunTab.js:390-393. False positives: none. onClick on tr/td/div (AssetRegisterTab.js:194, :217, OwnerDashboard.jsx:403) each wrap a real button, so no keyboard loss.

Contrast: every text token passes 4.5:1 on both presets (tightest Light text3 on card 4.54). Light-theme chart series under 3:1 (Food Cost 1.89, Labor 2.10, Net Margin 1.59), recorded as accepted in chartColors.js. Print footer #aaa at 10px 2.32:1.

Overlays: none (no browser).

## Overall Impression

Honest and careful, with the honesty printed at the smallest size. Biggest opportunity: open the Owner Dashboard with a one-line answer ("Bhadra so far: you keep NPR 8 of every NPR 100") with the margin large.

## What's Working

1. Refuses to judge early: settledFigure withholds colour and marks (OwnerDashboard.jsx:347-356); P&L "Not judged: count incomplete" (ConsolidatedPnl.jsx:510-515).
2. The Owner Report is a real document: DirectionMark prints "▲ worse" (MonthlyOwnerReport.jsx:84-91); missing sections are named (:694-730).
3. Master push preview-before-write with a counted danger confirm (MasterPushPanel.jsx:169-201); no page renders KPIs while loading or after a failed read.

## Priority Issues

1. [P1] Owner Dashboard has no answer. Nine equal tiles, margin fifth; Profitability/Operations headings sr-only (OwnerDashboard.jsx:502, 580); margin tile links to /overheads (:560). Fix: one-line verdict with the margin large; visible headings; Operations row as a "needs you" list; margin links to P&L. Command: layout, then distill.
2. [P1] Depreciation run posts permanently with no confirm (DepreciationRunTab.js:301); AD date inputs (:406-414); disabled Post inside an unreachable Tip with hand-faked opacity (:442-447); 12px success text. Fix: BsCalendarPicker; ConfirmModal naming NPR amount, asset count and BS period, "can only be reversed"; aria-disabled with an explaining press; a success panel; withTimeout on the four untimed reads/writes. Command: harden.
3. [P1] Unclear which owner page does what: four margin names; Dashboard link opens a different month (OwnerDashboard.jsx:444-448 vs MonthlyOwnerReport.jsx:224); nav "Owner Report" (ownerOnly) vs title "Monthly Owner/Manager Report" (MonthlyOwnerReport.jsx:161). Fix: one margin name; a one-line tense per subtitle (so far / last month frozen / any period as accounts / every outlet); relabel link with the month name. Command: clarify.
4. [P1] SuiteGate does not sell: one generic card, 🔒, no price, no preview (SuiteGate.js:165-180); View plans goes to /pricing whose signed-in buttons are mailto links (Pricing.js:136). Fix: per-page problem-then-relief line under 16 words in SUITE_PAGES; per-outlet price from useSettings().pricing; sample/own-revenue preview; Call Crest as primary. Command: clarify, then bolder.
5. [P2] Too much reading for second-language readers: 300-900 char tips; one comma-chained summary sentence (reportNarrative.js:38-108); WDV (TaxPoolOpeningsCard.jsx:375), pp (MonthlyOwnerReport.jsx:131), Variance % (:1316), COGS only in a hover title (GroupDashboard.jsx:354). Fix: short first sentence + More; three-sentence summary ending "Look at: …"; spell out every short form. Command: clarify.

## Persona Red Flags

Alex (power user): no deep link to a month; no prev/next; split Month/Year selects (GroupDashboard.jsx:399-406); no two-month P&L; Demand Forecast needs a manual Recompute (DemandForecast.js:733).

Sam (keyboard/screen reader): ~180 tab stops of focusable Tips in a 30-day Demand Forecast (DemandForecast.js:861-865); push options two stops each (MasterPushPanel.jsx:251-259); unreachable ineligible-Post tip; emoji read aloud (ConsolidatedPnl.jsx:463, DemandForecast.js:738-739); 6 empty headers.

Sita (two Kathmandu cafes, phone between services, English second language): MTD and Prime Cost % in four tiles, margin below the fold; 7-column Group table with no phone layout or sticky outlet column (GroupDashboard.jsx:492); push-to-every-branch checkboxes just below the figures; report padding 22px 30px on a 375px screen (MonthlyOwnerReport.jsx:659); AD dates in Fixed Assets.

## Minor Observations

- Report section titles in accent-ink ten times per document (MonthlyOwnerReport.jsx:40-41).
- Items Below Par / Overdue Payables red with no shape mark (OwnerDashboard.jsx:601, 615).
- △ x25 vs ⚠ x2 (TaxPoolTab.js:594, DemandForecast.js:852).
- Mixed button glyphs: 🖨 ↓ 📊 ↻ vs plain "Export Excel" (MonthlyOwnerReport.jsx:574).
- "Depreciation Runs" vs "Tax Depreciation (IRD)" unexplained side by side (FixedAssets.js:18-21).
- "No month is open… contact Crest support" shows the Periods link to the operator only (OwnerDashboard.jsx:490-497).
- No print path: OwnerDashboard, GroupDashboard, AssetRegisterTab, DepreciationRunTab.
- KPI values at weight 700 vs DESIGN Figure 600 (OwnerDashboard.jsx:389).
- Stale "rounded UI card" comment (MonthlyOwnerReport.css:46).
- Lone dead-end and "Loading…" text (no skeleton) on most non-dashboard pages.

## Questions to Consider

1. If an owner sees one number on opening the Suite tab on a phone, which is it, and why is it the fifth tile?
2. Four pages, or one page in three tenses plus the group view?
3. The upsell already has the owner's own revenue: why a padlock instead of their numbers half-revealed?
4. What if refusing to judge early were the visual signature instead of 11px fine print?
