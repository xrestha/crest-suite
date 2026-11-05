---
target: crest-suite-pro (owner layer)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-11-05T03-40-57Z
slug: crest-suite-pro
---
# Crest Suite Pro owner layer: design critique (re-run after S857, S858, S877)

Method: dual-agent (A: a806d5b43555a8eda design review from source plus live evidence · B: aa9f033395647cd53 bundled detector plus measured static evidence). Browser overlay skipped: no browser tool in this helper session. Live evidence at 375px (BLOOM CAFE, Ashwin 2083, viewed as Crest support, 2026-11-05) was supplied by the lead and used as fact; screenshots owner375-fin, phone-group, group-0..4, phone-ownerreport and margin were viewed.

Scope: same as 2026-10-22: Owner Dashboard (src/pages/dashboard/OwnerDashboard.jsx), Monthly Owner Report (MonthlyOwnerReport.jsx/.css + src/modules/ownerReport/), Profit & Loss (ConsolidatedPnl.jsx + pnl/pnlStatement.js), Group Console (GroupDashboard.jsx + OutletAccessPanel, MasterPushPanel, GroupItemPrices), Demand Forecast (src/modules/ims/stockcount/DemandForecast.js), Fixed Assets (src/modules/ims/assets/*), SuiteGate (src/components/SuiteGate.js), plus MonthStepper and LetterheadButton. Mode: Operate. Same rubric as the 25/40 run, so the scores compare.

## Design Health Score

| # | Heuristic | Was | Now | Key issue now |
|---|---|---|---|---|
| 1 | Visibility of system status | 3 | 3 | Period chip on every page and all four old reads bounded. On a zero-revenue month the verdict says "the message above says which figure is missing" and there is no such message (OwnerDashboard.jsx:499-505). Group banner says "Showing 2 of 2 outlets" when one has no month (GroupDashboard.jsx:303-305, 512) |
| 2 | Match with the real world | 2 | 3 | BS dates everywhere in Fixed Assets, "so far", plain push words, "points". Unit prices print to four decimals, "650.7292 / KG" (GroupItemPrices.jsx:33) |
| 3 | User control and freedom | 3 | 3 | Depreciation asks first. The Tax pool first post locks a schedule at one press (TaxPoolTab.js:575) |
| 4 | Consistency and standards | 2 | 2 | One margin name on Suite pages, shared .amber-banner. Group Console marks a no-count closed outlet that P&L and the Report decline to judge (groupVerdicts.js:77-80, GroupDashboard.jsx:418); "Labour" beside "Labor Cost %" in one header row (GroupDashboard.jsx:590-591); Home still "Est. Net Margin %" |
| 5 | Error prevention | 3 | 3 | Report link names its month. Tax pool first post unconfirmed; Regenerate Snapshot (overwrites a frozen report) sits at Print weight (MonthlyOwnerReport.jsx:692-697) |
| 6 | Recognition rather than recall | 2 | 3 | Last month column in the Financial Summary (MonthlyOwnerReport.jsx:873-875). Band names live only in title attributes a phone never opens (MonthlyOwnerReport.jsx:898, 921, 934, 948) |
| 7 | Flexibility and efficiency | 2 | 2 | Month in the address and the stepper on three pages. Group Console still split Month and Year selects plus Refresh (GroupDashboard.jsx:488-501); no two-month P&L; manual Recompute on Demand Forecast |
| 8 | Aesthetic and minimalist design | 2 | 3 | Verdict, five tiles, Needs you, compact row; tips cut to 1-2 sentences; one note on Demand Forecast. Group Console on a phone shows about 720px of header, filters and four stacked tiles before the first outlet (phone-group.png) |
| 9 | Error recovery | 3 | 3 | Open month offers two ways forward (MonthlyOwnerReport.jsx:761-781); strong "no answer came back" copy (AssetCategoryModal.jsx:57-60). The verdict's false pointer above |
| 10 | Help and documentation | 3 | 3 | Fixed Assets now tipped (Valuation 5, AssetCard 7, Register 7 of 12). Only Food Cost has a tip on its target; Labor, Prime and Net Margin targets have none (MonthlyOwnerReport.jsx:921, 930, 963) |
| **Total** | | **25** | **28/40** | **Good (bottom of the band)** |

## Since the last critique (2026-10-22, 25/40)

Priority issues:
- P1#1 Owner Dashboard has no answer: FIXED. Verdict sentence (OwnerDashboard.jsx:486-526, Layout.css .owner-verdict), visible headings (:607, :690), Needs you list (:690-723), Net Margin opens /pnl?period= (:666-668).
- P1#2 Depreciation posts with no confirm: FIXED. Confirm names amount, assets and BS period, says "can only be reversed" (DepreciationRunTab.js:301-390); BsCalendarPicker (:484-489); Post aria-disabled with an explaining press (:289-299, :520); role="status" success panel (:540-580); the four untimed reads are bounded (AssetCategoryModal.jsx:53, :78; ValuationReportTab.js:51; MonthlyOwnerReport.jsx:282, 335, 360; DemandForecast.js:188-205). The same defect remains on the sibling Tax pool tab (new P1 below).
- P1#3 Unclear which owner page does what: PARTLY (mostly). Tense in each subtitle (OwnerDashboard.jsx:542, MonthlyOwnerReport.jsx:173, ConsolidatedPnl.jsx:817, GroupDashboard.jsx:758); report link names its month (OwnerDashboard.jsx:545-549); title "Monthly Owner Report". Left: Home says "Est. Net Margin %"; three Owner Report tips still say "Consolidated P&L" (MonthlyOwnerReport.jsx:631, 1036, 1065).
- P1#4 SuiteGate does not sell: FIXED. Per-page problem then relief (SuiteGate.js:63-117), price from Plan Pricing (:259-264), made-up example drawn like the page (:274-288), Call Crest primary (:266-268), no padlock.
- P2#5 Too much reading: PARTLY (mostly). Three-sentence summary ending "Look at" (reportNarrative.js:150-184); WDV, pp, Variance %, COGS spelled out or tipped. Left: 11px paragraphs of about 60 words in Outlet Access (OutletAccessPanel.jsx:317-327); a 9-line capitals list in the amber footnote under the Financial Summary at 375px (owner375-fin.png).

Heuristic key issues from the old table: 1 fixed; 2 fixed; 3 fixed; 4 partly (Labor/Labour, Home name); 5 fixed; 6 fixed; 7 partly (split selects); 8 fixed; 9 fixed; 10 mostly fixed.

Personas: Alex partly (deep links and stepper fixed; split selects, no compare, manual Recompute open). Sam fixed (one Tip per forecast day plus Show averages, DemandForecast.js:659-664, 724; one Tab stop per push option, MasterPushPanel.jsx:262-281; no emoji; blank headers named). Sita fixed as listed (verdict first, Group phone cards GroupDashboard.jsx:674-722, push moved to the end :745-748, report padding MonthlyOwnerReport.css:12-16, BS dates); new phone problems below.

Minor observations: fixed 7 of 10 (accent section titles, unmarked red counts, ⚠ vs △, button glyphs, Depreciation vs Tax note, no-month dead end, stale CSS comment). Partly: print path (Owner Dashboard, Group Console, Depreciation Runs still have none); figure weight (report cells still fontWeight 700, MonthlyOwnerReport.jsx:882). Open: bare "Loading…" text (13 places, e.g. DemandForecast.js:640, GroupDashboard.jsx:597); inline styles unchanged at about 630.

## Design Specificity Verdict

LLM: The Owner Dashboard composition changed where it matters. It opens with a sentence ("you keep NPR 8 of every NPR 100 you sell"), then a Needs you list, then a compact row; the five-tile ratio row under it is still category furniture. SuiteGate is now an offer with an example drawn like the page. The Group Console is still furniture: filter card, four tiles, table or cards, then three admin panels on one scroll. P&L is three tiles over a statement, which suits a statement. The product signature, refusing to judge early, moved up from 11px fine print into the 13px verdict line, but it is still not a visual mark of its own, and the Group Console breaks it.

Detector: 0 findings across 21 files / 10,063 lines (exit 0; --no-config also exit 0). A planted file was flagged (exit 2), so the scan is live. Coverage gap: gradient text and font names written as camelCase JSX inline style objects are not matched (only CSS syntax is), so a clean run says nothing about those.

Measured, against the last run: non-zero radius 2 -> 0; empty th 6 -> 0 (5 labelled by sr-only text); type="date" -> 0 (6 BsCalendarPicker); emoji glyphs -> 0; ⚠ 0, △ 28; inline style={{ 632 (was 630; MonthlyOwnerReport 133, DemandForecast 79, TaxPoolTab 52), 23-31 on controls; inline uppercase labels 14 -> 7 plus 1 constant; inline textAlign right 180 (was 179); sticky 0 -> 1 (P&L first column, ConsolidatedPnl.jsx:700); disabled vs aria-disabled 48 / 19; title-only explanations on non-focusable elements 13 (OwnerDashboard.jsx:437, 440, 512, 516; MonthlyOwnerReport.jsx:898, 921, 934, 948; GroupDashboard.jsx:441, 548, 556; DemandForecast.js:729, 755); Tip 118. Five user-blocking writes with no timeout: AssetRegisterTab.js:160 (deleteAsset invoke), TaxPoolTab.js:358 and :374, TaxPoolOpeningsCard.jsx:192-193. Literal hex: chart series and print-only only.

Contrast: text tokens unchanged since 2026-10-21 (S852 added input-border only), not re-measured.

Overlays: none (no browser in this session).

## Overall Impression

The four P1s are closed and the Owner Dashboard finally answers before it explains. What is left is the second ring: two places where a fix landed on one page and not its sibling (the zero-revenue guard, the post confirm), a Group Console that judges what the other owner pages refuse to judge, and phone fit on the two screens an owner reads most. Biggest opportunity: make the Group Console say the verdict per outlet, the way the Owner Dashboard does, instead of four group tiles.

## What's Working

1. The verdict is built only from the tiles' own figures and withholds exactly when they do (OwnerDashboard.jsx:369-389, 486-526).
2. The depreciation post is now the model for every post button in the product: amount, assets, BS period, "can only be reversed", then a status panel with next steps (DepreciationRunTab.js:289-390, 540-580).
3. The upgrade screen is honest: made-up figures that read nothing of the client (S849 ACCESS-9 holds), price from Plan Pricing, Call Crest as the primary action (SuiteGate.js:240-291).

## Priority Issues

1. [P1] The zero-revenue guard was fixed in one file only. ownerDashboardData.js:127 now needs revenue of at least 0.01, but the same float residue still passes `> 0` in pnlStatement.js:15 (`pctOf`, every P&L percentage), computeMonthlyReport.js:231, 744, 747 (would freeze an absurd Food Cost / Labor / Net Margin into a snapshot), groupVerdicts.js:87, foodCostBasis.js:60, 90. On the Owner Dashboard the same month now reads "NPR 0 sold. Net Margin could not be worked out: the message above says which figure is missing", and no message exists (OwnerDashboard.jsx:499-505). Fix: one shared `hasRevenue()` with the paisa floor used by every ratio, and the verdict's zero-revenue branch says "No sales are recorded". Command: harden.
2. [P1] The Tax pool first post locks a schedule with no confirm. With no follow-up questions `askInTurn([])` calls straight through (TaxPoolTab.js:461-465) and a first post goes to `submitPost` (:575); the copy two lines later says a posted schedule cannot be edited and next year's openings are taken from it (:582). This is the defect P1#2 fixed on the sibling tab. Its two writes (:358, :374) and the openings card's (TaxPoolOpeningsCard.jsx:192-193) have no timeout. Fix: always end the question list with one summary dialog naming the fiscal year, the pools and the total allowance; wrap the writes in withTimeout. Command: harden.
3. [P2] The Group Console judges what the other owner pages refuse to judge. An outlet closed without a count wears an amber "No count" badge and still gets a △ on Food Cost %, because `costBandWithheld` ignores has_closing (groupVerdicts.js:77-80, GroupDashboard.jsx:418, 430-433), while P&L says "Not judged: count incomplete" (ConsolidatedPnl.jsx:631) and the Report withholds it. The group total shows a green ✓ over two △ outlets (GroupDashboard.jsx:330; group-1.png). The banner headline "Showing 2 of 2 outlets" counts an outlet with no month as shown (:303-305, 512). Fix: withhold the band when has_closing is false; "mixed, not judged" for a total over mixed bases; headline from inScope ("1 of 2 outlets has figures for Kartik"). Command: clarify.
4. [P2] Phone fit on the two most-read Suite screens (live, 375px). Owner Report Financial Summary: "NPR" wraps away from "7,05,786" and "≤60–65%" breaks at the dash, because the money cell (MonthlyOwnerReport.jsx:880-882), LastMonthCell (:97-99) and the target cells (:910, 922, 935, 962) carry no nowrap, npr() joins with an ordinary space (nepalMoney.js:63-65), and `.owner-report-nowrap` (MonthlyOwnerReport.css:48) is used only in TrendRow (:140); "estimate — payroll not finalized" repeats in three rows (:918, 927, 952). Group Console: unit prices to four decimals beside two (GroupItemPrices.jsx:33 passes `{ precise: true }` to unitRate.js:28-33), and about 720px of chrome before the first outlet card. Fix: owner-report-nowrap on each figure and target span (atom-level, so the Metric column absorbs the squeeze) and the payroll note once as a marked footnote; drop `precise` on the price table; `stat-grid stat-grid--pair` for the group tiles and one MonthStepper in place of the Month and Year selects plus Refresh. Command: adapt, then typeset.
5. [P2] Name drift left over from P1#3. "Labour" sits beside "Labor Cost %" in one header row (GroupDashboard.jsx:590-591; also labourSource.js:247-255, reportNarrative.js:36-41); three Owner Report tips say "Consolidated P&L" (MonthlyOwnerReport.jsx:631, 1036, 1065); Home says "Est. Net Margin %"; "Made when Ashwin was ended" (reportMadeLine.js:31) where the page says "closed" (MonthlyOwnerReport.jsx:765); three phrasings of COGS. Fix: one sweep to Labor, Profit & Loss, Net Margin, closed, "Food used (COGS)". Command: clarify.

## Persona Red Flags

Alex (power user): split Month and Year selects plus a Refresh button on the Group Console; no arrow-key step on the stepper; no two-period P&L; Demand Forecast still needs a manual Recompute; no print on the Owner Dashboard or Group Console.

Sam (keyboard and screen reader): a focusable "—" Tip in the Last month column (MonthlyOwnerReport.jsx:98); stepper buttons 30x44px (Layout.css:2016-2021, 2107-2110); "estimate — payroll not finalized" read three times in a row; 13 explanations that live only in title attributes on non-focusable elements.

Sita (two Kathmandu cafes, phone between services, English second language): "NPR" splits from its figure; four-decimal prices; a ✓ group total over two △ outlets; about 720px of controls before her outlets; a 9-line capitals list in amber; "labour estimated" beside "Labor Cost"; band names she cannot see on a touch screen.

## Minor Observations

- Regenerate Snapshot appears twice; keep the one on the made-by line (MonthlyOwnerReport.jsx:844-848, 1711-1714) and give it danger weight.
- Report subtitle says "Last month as it stood" though any month can be picked (MonthlyOwnerReport.jsx:173).
- "your consultant sets that" vs "Crest support" (MasterPushPanel.jsx:226-232).
- Group Revenue tip says "this month" while a past month is on screen (GroupDashboard.jsx:532).
- Demand Forecast says "click" in one place and "Press" in another (DemandForecast.js:634 vs 647-648).
- Group cards hide labour and purchases behind a disclosure (GroupDashboard.jsx:447-451).
- Fixed Assets tab row has five tabs (FixedAssets.js:16-22).
- Report figure cells at weight 700 vs DESIGN Figure 600 (MonthlyOwnerReport.jsx:882).
- Bare "Loading…" text in 13 places; no print path on three pages; inline styles about 630, unchanged.
- Fixed in the lead's working tree, not a finding: Home's Est. Net Margin % of "-240397222296944640000.0%" on zero revenue (ownerDashboardData.js:127).

## Questions to Consider

1. Should the Group Console be two pages: one to read the figures, one to manage the group (access, push, prices)?
2. If a figure is not judged, should it shrink and go grey instead of staying bold beside the judged ones?
3. Why can the Owner Report still freeze a number that the Owner Dashboard has just learned to refuse?
4. Would Sita rather see "you keep NPR 8 of every 100" for each outlet on her phone than four group tiles?
