---
target: ims module
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-29T11-01-49Z
slug: src-modules-ims
---
Method: dual-agent (A: design-review agent · B: detector agents, CLI pass then browser pass; browser pass started after A released the browser)

# Critique: IMS module (src/modules/ims, 159 files)
Inspected live as the Crest admin viewing CASA ACAI CAFE (Ashwin 2083 open), at 1440 px and 390 px, mostly in Modernist Light. Read-only.

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Period chip, 196/322 progress, "✓ Saved" are good; a clean period close says nothing (Periods.js:206) |
| 2 | Match System / Real World | 2 | "D1…D12" day chips (Purchases.js:681) against the BS-day-name rule; "NPR 663.717" (Sales.js:1410); "0.1944 per GM"; Used In codes R/W/OS/CS/PAR/MV |
| 3 | User Control and Freedom | 3 | Hide instead of delete, bill drafts, Clear the form leaves saved figures alone |
| 4 | Consistency and Standards | 2 | Three tab styles (Recipes.js:1706 with no selected state, Items inline, Payables pills); ReportPage used by only 2 IMS report files; ⚠/✗ vs △/▲ |
| 5 | Error Prevention | 3 | Type-to-confirm Delete All and a paid bill that can't be deleted are excellent; placeholder "0" on uncounted stock works against this |
| 6 | Recognition Rather Than Recall | 2 | 10 Stock Reports, 3 of them variance reports; the Used In legend is only in a hover Tip |
| 7 | Flexibility and Efficiency | 3 | Command palette, Enter adds a bill line, Excel in and out; no Enter/↓ in Stock Count |
| 8 | Aesthetic and Minimalist Design | 2 | Red everywhere; period shown 4 times on Purchases; "Active" badge on every row |
| 9 | Error Recovery | 3 | ActionError/ReportLoadError give a plain sentence plus detail; a blocked delete names the fix |
| 10 | Help and Documentation | 3 | Tips nearly everywhere, "How to read this" on Variance; Tips are hover-only, so they don't open on a phone |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict
LLM: specific underneath (BS day names with the AD date, lakh grouping, "not measurable" rule, dashed OPEN △ chip, PIN store-keeper single-tab mode), interchangeable on top: on Light the Modernist red has spread into money figures, chips, links, input borders, headers and banners, so the screen reads as an admin template in a red skin and red no longer means loss. Pages are assembled by hand (three tab families, report shell rarely used).

Deterministic: CLI 0 findings across 159 IMS files and the shell/dashboard (exit 0); a control run on all of src found 10 findings outside IMS. The detector can't see inline JSX sizes (1,267 in IMS; hand tally 1,265 on the ramp, 2 off at VendorBalanceConfirmationPrint.jsx:73/:135). It missed PurchaseBillForm.jsx:587 animating `left`. Browser: 141 findings on 5 pages, 2 real: the 10px "· N bills" label inside the Purchases day chips (12) and the 10px "⚙ N sub" tag on Recipes (79). The rest are false positives: shell micro captions, "—" placeholders counted as em-dash overuse, a CSS comment in Stock.css, and a pointer-events:none search icon. The colour problem is semantic (right tokens, wrong meaning), which no detector catches. Config: stale Layout.css width/margin transition ignores in .impeccable/config.json.

## Priority Issues
- [P1] Red marks which kind of figure something is, not loss. accent-ink (#7c1405 on Light, beside danger #8f2440) is used 218 times across 42 IMS files, largely on ordinary figures (MonthlySummary.js:305/:316, Stock.js:2659); Returns/Wastage red at NPR 0; Closing Stock always green; count inputs get a 40% accent border once filled (Stock.js:2644); 44/116 red-family text nodes on Payables. The same token reads neutral on Night (#ffc4b8). Fix: figures in text1, chips neutral, colour only from fcBand/varianceBand/overdue, accent only for primary actions, active nav and focus. Command: quieter, then colorize.
- [P1] "Not counted" and "counted zero" look the same: placeholder "0" (Stock.js:2636, 2550); Variance shows a counted 0 as "—" (Variance.js:572, closeQty > 0); Monthly Summary shows uncounted closing stock as a green NPR 0. Fix: empty placeholder, a has-count flag, a neutral "Not counted". Command: harden, clarify.
- [P1] Verdicts shown on incomplete inputs: resolveLabour returns verdictWithheld:false for 'none' with HR on (labourSource.js:84), so the dashboard showed 45.8% ✓ beside "Labour: none yet" (the test at labourSource.test.js:104 says "not a judged zero-labour month"); the open-month FC% is unjudged but still 24/800 (215.3%); Variance sorts by |value| (Variance.js:548), so "No Recipe Linked" noise tops the list. Fix: withhold on hrOn && none; "Needs closing count"; judged/flagged rows first. Command: harden.
- [P2] Stock Count gives two instructions about saving and has no visible focus: autosave on leaving a box (Stock.js:2635) vs banner "then click Save All" (Stock.js:2430); inline outline:none (Stock.js:2642, 55 in IMS) leaves a 12%-alpha ring; no Enter/↓; Sales opens on Bulk Entry with empty 0 fields. Fix: "saves when you leave the box", Save All as retry only, form-input, Enter/↓ to the next row. Command: clarify, harden.
- [P2] Phone hides the answer: Purchases table 745px in 298px (bill total off-screen); Recipes FC% off-screen; Monthly Summary KPIs stack and fill the first screen; the hamburger covers the table header. Fix: card rows below 480px with the key figure first; a 2-column compact stat grid. Command: adapt.

Cognitive load: 5/8 failed (high). More than 4 options: Stock Reports 10, Operations 9, Stock Count tabs 8, Purchases day chips 13, Recipes toolbar 8 + 6 + 4 + 4 per row, Monthly Summary 10 KPIs.
Emotional journey: the period close ends silent on success; valleys at 215.3% FOOD COST mid-month and Variance opening on noise; delete reassurance is good, undercut by Stock Count's Save All copy.

## Persona Red Flags
- Alex: 13 D-index chips instead of a date jump; no row-to-row keys in Stock Count; mixed Recipes toolbar button sizes.
- Sam: ~110 11px Edit/Del buttons that don't name their bill (Purchases.js:858); tabs with no selected state; emoji read aloud; count inputs with no visible focus.
- Owner on a phone (English as a second language): "Used In: R, W, OS, CS, PAR, MV" only in a hover Tip; "Dairy &."; "NPR 663.717"; "0.1944 per GM".
- Accountant: no bill-date column on Outstanding Payables; red "31–60 days" beside 0 overdue; "Closing —" for a real 0; red "Returns NPR 0".
- Store-keeper: placeholder 0; Save All copy vs autosave; a non-PIN login lands on Opening Stock mid-month.

## Minor Observations
- Items.js:1226-1227 truncation turns "Dairy & Beverages" into "Dairy &.".
- 265 hand-rolled toLocaleString('en-IN') calls in IMS instead of nepalMoney; 3-decimal prices.
- Purchases day chips at 11px with a 10px bill count inside a clickable control; Recipes "⚙ N sub" at 10px.
- Requisitions empty state: two identical "+ New Requisition" buttons, green "Issued 0".
- Variance quantities show 3 decimals; "Cash" uses badge-green (a verdict colour on a category).
- The floating Add button covers a row's Edit/Del at 1440px; instruction banners are hand-made accent divs.
- PurchaseBillForm.jsx:587 animates `left`; VendorBalanceConfirmationPrint 12.5/9.5 sizes are off the ramp.

## Questions to Consider
- If signal red paints every rupee on Light, what colour is left for "you are losing money"?
- Should an open month show a food-cost % at all, or refuse the way Variance does?
- Could Variance, Theoretical Variance and Shrinkage be one report with three views?

## Resolution

Every finding above was fixed in S796 (seven stages, last commit `0d660124`, `crest-v360`), with the
owner's four decisions: honest figures first, colour means a verdict only, withhold the Net Margin
✓ when HR is on and no payroll is finalized, and scope everything. The four things S796 left open
were fixed in S797 (`crest-v361`): the hamburger that covered table headings now sits in a phone top
bar above the page (which also clears an installed iPhone's status bar); the floating Add button is
a header button on a computer or tablet and floats only on a phone; "0.1944 per GM" reads
"NPR 194.40 per KG (0.1944 per GM)" wherever a gram or ml price is shown; and the Dashboard's
Revenue vs Cost card withholds its Net Margin verdict before day 10, as the tile does.
