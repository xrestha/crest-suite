---
target: ims module
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-09-16T07-48-04Z
slug: src-modules-ims
---
## Design Health Score

Method: dual-agent (A: design review, source-only; B: detector + deterministic sweeps). Deviation: B returned before A finished, so detector evidence entered synthesis ahead of the design review; the specificity verdict was re-derived from A's source evidence and all headline claims from both were independently re-verified. Browser evidence unavailable — no dev server, and /ims/count is the only IMS route outside ProtectedRoute (a PIN keypad needing a device secret or QR token). No overlay injected, no route rendered, no screenshot. All contrast figures computed from tokens, not measured.

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Count "done" cue fires on keystroke not save (Stock.css:72); Sales.js:932 paints NPR 0 in accent 95 lines above its loading guard. |
| 2 | Match System / Real World | 4 | Near-exemplary: BS native, lakh grouping, purchase-unit conversion, IRD Annexure 13 / NPR 100k artefacts. |
| 3 | User Control and Freedom | 3 | Archive-over-delete done properly (Vendors.js:311 names the alternative). Undercut by 15 window.confirm on consequential actions. |
| 4 | Consistency and Standards | 2 | ReportPage: 2 adopters of ~44 routes. 13 hand-rolled tables. Two confirm systems in the same 9 files. Two tab-ARIA conventions. 5 duplicated closed-period banners, copy already drifted. |
| 5 | Error Prevention | 4 | Excellent: Stock.js:783 refuses to write an untouched cell; Items.js:852 locks UOM once referenced; Vendors.js:299 fails closed when the reference check itself fails. |
| 6 | Recognition Rather Than Recall | 2 | 40 destinations behind 7 dropdowns labelled by calculation name. "Menu & Vendors" (Layout.js:148). |
| 7 | Flexibility and Efficiency | 2 | PurchaseBillForm.jsx has zero onKeyDown/autoFocus/refs. Zero roving tabIndex module-wide. |
| 8 | Aesthetic and Minimalist Design | 3 | Modernist coherent; token discipline clean (0 real colour/radius findings from 159 raw hex). Dragged by banner stacking and off-scale hand-rolled stat cards. |
| 9 | Error Recovery | 3 | errorText.js -> ActionError best-in-class where applied. Undercut by alert() as the SUCCESS state of a bulk import (RecipeImportButton.jsx:279). |
| 10 | Help and Documentation | 4 | Tip on 59 files, explaining why not what. Variance.js:496 prints the COGS formula on the page. |
| **Total** | | **29/40** | **Good** |

## Design Specificity Verdict

Authored for this product in its domain model and copy; category-interchangeable in composition. The one surface genuinely composed for a real Nepali scene cannot be reached on the device that scene happens on.

Domain specificity is strong: PurchaseBillForm.jsx:497 prints "= {qty x cf} {uom}" live with a 5x master-rate deviation warning; :594-640 says "As printed on the supplier's bill" over inputMode="decimal" boxes so "9,702.00" off paper parses; Variance.js:44 gives non-recipe items (gas, foil, napkins) their own grey state so they stop wearing a permanent red Over.

Deterministic scan: detect.mjs --json src/modules/ims exits 0 with []. Verified real via a synthetic control file planted in the target path (fired 4 findings at exit 2). All 159 raw hex literals triage to documented exemptions (109 print templates, rest Recharts SVG + chart palettes).

CRITICAL: one pass is a SUPPRESSION, not an absence. .impeccable/config.json's design-system-font-size ignore for 26px names parkingSlipHtml.js:29 in its reason but carries NO files: key while its siblings do — so it suppresses 26px globally, masking 8 on-screen sites: ImsCountLogin.jsx:217, PosLogin.jsx:243, GuestMenu.jsx:1058, Pricing.js:322/371/408, Settings.js:980, ClientDrawer.js:1659, ArrivalAlert.css:38. 26 is off the ramp (…24, 32, 48). Fix: add files: ["src/modules/pos/parking/parkingSlipHtml.js"].

The clean run says nothing about the largest defect class: aria-controls 0 occurrences, role="tabpanel" 0, roving tabIndex 0, module-wide.

## Overall Impression

Better than its score; the gap is distribution. Good decisions get made once, at the site where the problem appeared, and do not propagate. ReportPage exists and 42 of 44 routes declined it. ConfirmModal exists and 9 files that import it still call window.confirm. .tab-btn--active was fixed to use --theme-accent-ink and a hand-rolled copy in Stock.css kept the old bug. var(--theme-bg) is used correctly in VendorReport.js and hardcoded as rgba(10,12,18,0.7) in its twin. Biggest opportunity: make the module's own best decisions reach the other 40 pages.

## What's Working

1. Variance.js is the reference implementation for a report that refuses to lie. bandOfRow() routes the Flag column, the Flagged Items tile and the Over/Under filter through one varianceBand call (the comment at :32-37 records that they previously disagreed about the same month). KPI tiles read "Not measurable yet" rather than "NPR 0", and a Data Coverage tile (:474) reports which of the two required inputs is present.
2. The error sentences beat most commercial products. Stock.js:597-605 distinguishes "the server now holds no closing count figure for it" from "what is on screen is not known to be stored", never claims a failed write did not land, and keeps the Postgres detail as fine print.
3. Tip is the cheapest answer to PRODUCT.md's hardest principle. PurchaseBillForm.jsx:461 explains Rate for the store-keeper AND names per_uom_rate for the accountant in one 300px tooltip. 59 files.

## Priority Issues

### [P0] The stock-count touch UI is unreachable on every tablet

Stock.js:187 sets isMobile = window.innerWidth < 768, gating the authored count experience at :1900/:1950/:1957/:2122 — per-item cards, the 20px right-aligned input, the progress bar, the fixed save bar. 768 is exactly iPad-portrait width so "< 768" excludes it; landscape is 1024+; a 10-inch Android tablet is ~800 portrait. No tablet ever sees it. Tablets get the desktop data-table with a 110px QtyInput on 6px 10px padding (~38px, under the 44px coarse-pointer floor), no progress indicator, and Save All above a 200-row scroll.

Compounding: .mobile-cat-btn.active (Stock.css:24) is a hand-rolled .tab-btn duplicate that kept the bug the real class was fixed for — color: var(--theme-accent) on a --theme-focus-ring fill, the exact pairing Layout.css:2799 uses --theme-accent-ink to avoid. Computed ~2.8:1 on Modernist Light at 12px. Stock.css has no @media (pointer: coarse) block at all.

Why it matters: PRODUCT.md names the store-keeper on a shared tablet as a primary scene and says "a control they cannot use is not a smaller problem than a wrong number."

Fix: replace the width test with a capability test — window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900. Then delete .mobile-cat-strip/.mobile-cat-btn and use tab-bar tab-bar--scroll + tab-btn/tab-btn--active, which brings the correct ink, the focus pair and the touch floor for free.

Command: /impeccable adapt

### [P1] The tab bars and row drilldowns are not keyboard-operable

Both assessments converged on this independently. aria-controls: 0 occurrences in src/modules/ims. role="tabpanel": 0. Roving tabIndex: 0, module-wide. Seven bars claim role="tablist" + role="tab" + aria-selected and deliver none of the rest (Stock.js:1404, Purchases.js:614, Items.js:927, Sales.js:958, Overheads.js:772, PaymentReport.js:307, VendorReport.js:842); 19 of 26 files with tab-btn carry no tab semantics at all, including FixedAssets.js:82 (5 tabs) and Recipes.js:1466. No shared Tabs component exists.

Plus 11 keyboard-unreachable drilldowns (onClick on a tr/td with no role, tabIndex or key handler), 4 icon-only buttons with no accessible name (Recipes.js:1584, :1700; Overheads.js:873; AssetCategoryModal.jsx:117), and 15 of 24 filter-chip rows with no aria-pressed, so which filter is applied is carried by colour alone.

Why it matters: reaching Stock Count's Settings tab — where blind counting and recount protection live — costs 8 Tab presses. ClientDashboard.jsx:49-73 already contains a complete roving-tabIndex implementation written for the S569 critique and never generalised.

Fix: extract that ChartTabs contract into a shared Tabs component in src/components/, then sweep the 26 files onto it. Convert the 11 drilldowns to RowDisclosure, which already exists and is the documented primitive.

Command: /impeccable audit

### [P1] Sales Entry paints NPR 0 in the accent above its own failed-read card

Verified in source: Sales.js:932 opens <div className="stat-grid no-print"> unconditionally. The loading guard is 95 lines below at :1027, and ReportLoadError renders inside it at :1032. So on every visit and every period change the page shows Items Sold 0, Items with Sales 0 of 0 active recipes, and Period Revenue NPR 0 in .stat-value gold — and on a failed read those three stay painted, permanently, directly above "could not load".

Same shape, transient only, at Overheads.js:717: the KPI grid has no loading guard, so during every load each bucket reads "Not entered yet" — a positive claim about data the page has not read.

Why it matters: this is DESIGN.md's own ReportPage rule ("the KPI strip does not render while loading or after a failure"), live on the page that produces the revenue denominator for every food-cost figure in the product. An owner glancing at Sales Entry on a slow connection reads "we sold nothing this month".

Why it survived: .claude/rules/report-pages.md scopes its paths: to reports/, stockcount/, recipes/, variance/ — NOT sales/. The rule that documents this defect never loads on the file that has it.

Fix: wrap Sales.js:931-952 in {!loading && !loadError && (...)} and hoist ReportLoadError above the strip; wrap Overheads.js:717-765 in {!loading && (...)}. Then add src/modules/ims/sales/**, purchases/** and items/** to that rule file's paths:.

Command: /impeccable harden

### [P1] Outstanding Payables' drilldown is a frozen near-black, illegible on Modernist Light

OutstandingPayables.js:1143 paints the expanded bill panel background: 'rgba(10,12,18,0.7)', then fills it with var(--theme-text1)/text2/text3. Its near-identical twin — same panel, same bill table — uses the token: VendorReport.js:1306 is background: 'var(--theme-bg)'. Both verified.

Computed (not measured), on Modernist Light the overlay composites to ~#4D4E53, putting --theme-text1 at ~2.0:1 against AA's 4.5:1.

Why it matters: Outstanding Payables IS the accountant's screen, and the drilldown holds the item lines, rates, totals and payment history. PRODUCT.md: "they need to trust the exact figure." A figure they cannot read is worse than one they distrust.

Fix: one word — var(--theme-bg), matching its twin. Then sweep the sibling frozen literals: Purchases.js:929/1133/1135 (two zebra stripes that also disagree with each other, 0.03 vs 0.015), Overheads.js:1071/1144, VatReport.js:605, NonVatReport.js:399, MenuPricing.js:961.

Command: /impeccable polish

### [P2] Two confirmation systems live inside the same nine files

15 window.confirm calls across 11 IMS files. Nine of those files already import ConfirmModal/useConfirm (verified by set intersection): AssetRegisterTab.js, Items.js, Purchases.js, ReturnsTab.jsx, Recipes.js, Sales.js, ReorderReport.js, Stock.js, Vendors.js.

Worst sites: Requisitions.js:311 and :428 (the stock-shortfall warning — "you are issuing more than is on hand"), Vendors.js:338 (Archive, while Delete four lines away uses the product's own ConfirmModal), Recipes.js:542 (a three-paragraph message with \n\n handed to a dialog that will not render it as written).

Why it matters: PRODUCT.md's stated anti-reference is "legacy Nepali accounting/ERP software", and a native browser dialog is the single most legacy artefact available — unbrandable, unstyleable, no danger treatment, thread-blocking, and on a tablet it renders as "crest-suite.vercel.app says…", which is how a phishing warning looks. This is not non-adoption; it is half-adoption, so a user meets both systems in one session on one row.

Fix: sweep the 15 to useConfirm with danger: true on the destructive ones; start with Requisitions.js:311/428, the one that costs real stock. Convert RecipeImportButton.jsx:279's alert() success to the setPageNotice pattern Stock.js already uses.

Command: /impeccable harden

## Persona Red Flags

Alex (impatient power user — a bookkeeper entering 30 supplier bills off paper): PurchaseBillForm.jsx contains zero onKeyDown, zero autoFocus, zero refs. "+ Add Item" (:578) is reachable only by tabbing past every field of every existing line; nothing focuses the new row; nothing commits a row on Enter. A 15-line bill is ~135 tab stops, and adding line 16 means traversing all of them. This is the highest-frequency form in the product.

Sam (screen reader + keyboard): seven tab bars announce themselves as tablists via role="tab" and aria-selected, then provide no aria-controls and no role="tabpanel" — a screen reader is told a tab is selected and given nothing to say what it selected. A partial ARIA contract is worse than none, because it suppresses the fallback reading.

Bikash (store-keeper, shared tablet — derived from PRODUCT.md's tertiary persona): gets the desktop table, not the card list (P0). No saved-confirmation — the accent border fires on keystroke, so on a shared device where a colleague may be counting the next shelf, typed and stored look identical. A failed row write reports at the top of the page (Stock.js:1334), 40 screens away from the row. Stock.js:1334-1396 can stack five full-width banners — Notice, Scope, Locked, Offline, Pending — before the tab bar.

Sujata (accountant at filing time): the Payables drilldown is unreadable on Light (P1). And tabular-nums does not reach the money — Layout.css:2122 scopes it to table.data-table td and .stat-value, but the purchase bill line table is a hand-rolled table, so the product's most-used money entry form renders in proportional figures and a right-aligned currency column does not line up digit for digit. Same for 12 other hand-rolled tables. Separately, TheoreticalVariance.js:465 hand-rolls its stat cards at fontSize 22 on a 180px grid floor, where .stat-grid was deliberately raised to 200px because a Nepali-grouped NPR 12,48,650 wraps below it — so the three headline figures on the page that tells an owner money went missing neither align nor reliably fit.

## Minor Observations

- The Starter tier's nav deletes rather than upsells, and it contradicts the product's own other decision. Layout.js:593 drops any item whose featureKey fails; a Starter client loses 22 of ~40 destinations (Costing collapses to Menu Pricing alone — a group named Costing whose only item is a price list; Stock Reports to Wastage only; Menu & Vendors vanishes). Meanwhile Layout.js:703-718 keeps the Crest Suite group visible for clients who have not bought it, with a PRO chip and an inline SuiteGate upsell, commenting that "a featureKey would make the row DISAPPEAR instead of upselling." PremiumGate.js is a carefully-written upsell screen reachable only by typing a URL.
- The 26px detector ignore needs files: ["src/modules/pos/parking/parkingSlipHtml.js"] — a one-line config fix that un-blinds 8 sites.
- #f59e0b is a second amber with two live IMS sites (MenuEngineering.js:49's Q_HEX.Puzzle, MenuPricing.js:961). Layout.js:1122 carries a comment saying this exact value was already found and removed there; the sweep never reached IMS. The Puzzle scatter dots do not match the Puzzle tile beside them.
- Three live instances of the documented "don't dim a row with opacity" rule: MenuPricing.js:961 (0.45), RecipeMargin.js:361 (0.45, on dishes with zero sales — the rows most worth reading on a margin report), PurchaseOrders.js:721 (0.4). Computed ~2.8:1 on Night.
- Five byte-identical closed-period banners inline-styled across Purchases.js:517, Sales.js:909, Stock.js:1358, Overheads.js:689, PurchaseOrders.js:1065 — and the copy has already drifted. PayrollRun.jsx's amberBanner is the extraction precedent.
- fontSize: 9 on real text at PurchaseBillForm.jsx:529 (the 13% VAT marker under each ticked line); 9px is the chevron glyph step, 10px is the text floor.
- .mobile-progress-bar (Stock.css:35-45) declares transform-origin/transition while Stock.js:1952 sets width inline — inline wins, so the transition is dead CSS and the bar animates a layout property in intent. No role="progressbar". 0.3s is also off the --motion-fast/--motion-slow pair.
- .mobile-progress-label (Stock.css:48) and .mobile-stock-value (:133) both use var(--theme-accent) as text; computed ~3.5:1 on Modernist Light. Should be --theme-accent-ink.
- Three report pages have no empty branch at all (PaymentReport.js, Overheads.js, BudgetVsActual.js); seven more hand-roll one instead of .empty-state.
- SupersedeConfirmModal.jsx:80 is the module's only bare className="btn" with no colour variant, then hand-paints red inline instead of btn-danger.
- MenuEngineering.js:609 uses inline overflowX:'auto' instead of the global .table-wrap.
- AssetCategoryModal.jsx:69-83 renders a headers-only table when a client has no asset categories — the first-run state of that modal.
- Verified clean, do not re-raise: zero badge-gold; zero role="button" on a tr; zero non-zero borderRadius outside print templates; every type="password" has autoComplete="new-password"; 9/9 Fab pages pair table-wrap--fab-clear; 9/9 Recharts series carry chartMotion(); 6/6 .btn-icon carry aria-label and title; zero .toISOString() on bsToAd output; StockCountSettings.jsx:356's background '#fff' is a QR quiet zone and is correct.

## Questions to Consider

1. The nav is filed by what the calculation is; should it be filed by what the owner just noticed? Three of ten Stock Reports are variance under different names, and "Menu & Vendors" is an ampersand admitting the grouping failed. What if the top of the IMS panel were four questions — Where is my money going? / What's on the shelf? / What do I owe? / What should I charge? — with the 40 reports filed beneath them? The command palette already proves people search by intent; the dropdowns are the only surface still filed by implementation.
2. You run two upsell grammars in one nav bar — which one did you actually choose? Suite stays visible with a PRO chip and upsells in place; the plan ladder deletes the row. One is a considered decision and the other is the default behaviour of a featureKey.
3. ReportPage has 2 adopters in 44 routes, and every recurring defect of this class was found on a hand-rolled page. Each was fixed where it was found. At what point does adopting the shell become cheaper than the fifth incident — or, put the other way: if 42 pages declined it, is the shell the wrong shape?
4. What is the count screen's peak-end moment supposed to be? A counter's last impression of a two-hour shelf count is a button that reads "Saved" for a moment. The section totals are already computed at Stock.js:1888-1893 and rendered only as a strip.
5. The module's best writing only appears when something is wrong. PurchaseBillForm.jsx:634's "Matches the supplier's bill (within NPR 1)" proves you can write the good case just as well. Where else is the product silent at exactly the moment it has something reassuring to say?
