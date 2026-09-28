# COSTS — overheads/P&L, budgets, fixed assets (book + tax pools), gate passes, S790 setup-guide IMS steps
Files reviewed (in progress): Overheads.js (all 1306 lines), periodCost.js, labourSource.js, BudgetVsActual.js (load/save),
assets/* (FixedAssets, AssetCard, AssetFormModal, AssetCategoryModal (part), AssetRegisterTab, DepreciationRunTab,
DisposalReportTab, ValuationReportTab, TaxPoolTab, depreciationCompute(+test), taxPoolCompute, taxPoolConstants),
gatepasses/GatePasses.jsx, shared/nepalTime.js, onboarding/setupSignals.js, setupSteps.js, useSetupGuide.js;
migrations 20260803110000/130000/140000/150000 (assets), 20260717120000 (gate passes), 20260918100000 + 110000 (S756),
20260708130000 / 20260719120000 / 20260720170000 (staff-isolation lists), baseline overheads/budgets policies.
Also: GatePassPrint.jsx, NewGatePassModal.jsx, ClientDashboard settle guard (for comparison), MonthlySummary/ConsolidatedPnl
revenue reads (tie-out). Skipped: GatePasses.test.js (not run), setupStrip/setupViewer (not IMS-signal code). ~33 files.

### COSTS-1 [P0] `overheads` and `budgets` have no IMS rank fence and no closed-month guard at the DB
- Where: baseline `overheads_all` (20260705074838:4036) and `client_own` on budgets; no trigger on either table in any migration
  (`grep "ON public.overheads\|ON public.budgets"` → none). Pages: Overheads.js:651 (manager only), BudgetVsActual.js:210 (supervisor).
- What happens: any IMS login of the client — a Staff-rank email login or a 4-digit count-PIN tablet session (`ims_email`,
  ims_role 'staff') — can `DELETE /rest/v1/overheads?period_id=eq.<id>` or insert fake rows for any month, including CLOSED
  months. `overheads` is read by the Overheads P&L, ClientDashboard Fixed Costs %/Est. Net Margin, OwnerDashboard,
  computeMonthlyReport (frozen Owner Report on Regenerate), get_group_pnl and Recipes' True Cost. Budgets likewise.
- Evidence: overheads is only on the no_self_service / no_pos_pin_staff / no_hr_role_staff restrictive lists; it is NOT on
  `no_ims_staff` (20260719120000:34-42 lists hr_*/pos_* only) and S756's `ims_rank_guard` was attached to purchase_entries,
  vendor_returns, payable_payments, par_levels, recipe_ingredients, assets_* … but not overheads/budgets
  (20260918100000:402-597). `ims_closed_period_guard` (D1) list also omits overheads.
- Status: missed by S756 (the stage-1 rank inventory "listed the writers first" and skipped these two).
- Fix: `ims_rank_guard('manager','recording fixed costs')` on overheads, `('supervisor','setting a budget')` on budgets
  (ims_caller_has_rank already refuses count PINs); add overheads to `ims_closed_period_guard`.
- Confidence: Confirmed from the migration set (verify live with `pg_trigger` on both tables before building).

### COSTS-2 [P1] "Current NBV" is picked by period_end, so a reversal or corrective run for an EARLIER period never reaches the book value — and the D24 disposal advice produces a wrong gain/loss
- Where: depreciationCompute.js:119-127 `latestPostedByAsset` (key = period_end|created_at|id); consumers AssetCard.jsx:51-62,
  DepreciationRunTab.js:106/132, AssetRegisterTab.js:63, ValuationReportTab.js:50.
- What happens: every posting opens from the then-current NBV (DepreciationRunTab.js:142 / computeAssetDepreciationLine), so
  the NBV chain runs in POSTING order, but the "latest" row is chosen by period_end. Two live paths break:
  (a) D24 disposal flow. Asset 100/day, run A 17 Jul 2025→16 Jul 2026 charged 36,500. Disposed 15 Jan 2026 → AssetCard warns
  "reverse that run on the Depreciation Runs tab (Adjustment) before disposing". Owner does: the adjustment row shares A's
  period_end, so it becomes latest (NBV back to cost). Dispose: lastEnd = 16 Jul 2026 > 15 Jan → periodStart 17 Jul 2026,
  `line: null`, extraDepreciation 0, gain/loss struck against FULL COST — the 182 days (~18,200) owed are never charged, and
  the amber "a posted run already charges … past this date" note stays up after the reversal. Posting the "right figures as a
  normal run" (the Adjustment tab's own Tip) for 17 Jul 2025→15 Jan 2026 does not help: its period_end is earlier than the
  adjustment's, so latestPostedByAsset still returns the adjustment row.
  (b) Reversing any run that is not the asset's latest by period_end (run picker offers every posted run, DepreciationRunTab.js:
  277/308): the adjustment's closing_nbv (opening + charged) loses to the later run's row, so Register/AssetCard/Valuation NBV
  and the next run's opening ignore the write-back, while Σ effectiveDepreciation (Overheads D23 memo) includes it —
  accumulated depreciation and NBV disagree. Same for a back-dated regular run posted after a later one.
- Evidence: test pins only the shared-period_end case (depreciationCompute.test.js:165-171).
- Status: NEW in S756's D24 build (unreviewed) — REGRESSION of D24 in effect (charge-to-disposal-date and adjustment runs do
  not do what the decision says outside the one tested ordering).
- Fix: pick the latest row by posting order (created_at, id) for "current NBV"; for as-of valuations use cost − Σ charges with
  period_end ≤ as-of, not a chosen row. Re-derive `postedPastDisposal` from non-reversed runs.
- Confidence: Confirmed by reading (pure function; scenario is arithmetic).

### COSTS-3 [P2] Overheads judges the OPEN month: a full month of fixed costs against month-to-date revenue, red "Operating at a loss" / "Below break-even" from day 1
- Where: Overheads.js:151 (opens on the open period), 505 netProfit, 564-575 bars, 997-1011 callout, 1204-1243 break-even.
- What happens: rent/labour/tax lines are whole-month figures (and on a new month they are auto-copied from last month as a
  draft, 198-225); revenue is sales so far. Day 8 of Kartik: revenue 1.2 lakh, fixed 3.5 lakh → "✗ Operating at a loss this
  period" in red and "✗ Below break-even by NPR 2.x lakh", every % bar over target. The chip says OPEN △ but every verdict is
  painted. ClientDashboard withholds the same ratios before day 10 (`periodTooEarly`) and D7 withholds verdicts on Monthly
  Summary / Budget vs Actual for an open month; Overheads has neither.
- Status: missed by S756 (D7 scoped to two pages).
- Fix: apply D7 — neutral colour, no ✓/✗ wording, "month still open" note — until the period closes (or see Owner question 1).
- Confidence: Confirmed.

### COSTS-4 [P2] Valuation "as of" a past date drops assets disposed AFTER that date
- Where: ValuationReportTab.js:47 `a.status === 'active'`.
- What happens: accountant picks As Of = 16 Jul 2025 (FY-end) in Bhadra 2083; a fridge sold in Poush 2082 is `disposed` now, so
  it vanishes from the FY-end valuation — cost, accumulated depreciation and NBV all understated for a date when it was owned.
- Fix: eligible = acquired ≤ asOf AND (active OR disposal_date > asOf).
- Status: missed by S756. Confidence: Confirmed.

### COSTS-5 [P2] Tax pool: a missing prior-year run silently opens every pool at 0, and a client's existing assets never enter a pool
- Where: TaxPoolTab.js:103-128 (prior = only FY−1's run; `openingWdv = prior ? … : 0`), 131-138 (additions only if acquired in FY).
- What happens: FY 81/82 posted, 82/83 skipped, preview 83/84 → priorRun null → opening WDV 0 in all five pools, no warning; the
  Tip says "0 if this pool has never been used before". Postable. Separately, a cafe that joins with 5 years of kitchen
  equipment has no way to enter an opening WDV: those assets never become "additions", so Pools A–D depreciate nothing for them
  ever (Pool E, by contrast, amortizes pre-existing assets — COSTS-6).
- Fix: when FY−1 has no run but any earlier run exists, refuse/warn naming the gap; add an opening-WDV entry for the first year.
- Status: missed by S756. Confidence: Confirmed.

### COSTS-6 [P2] Pool E keeps amortizing past useful life and can post depreciation larger than the pool
- Where: TaxPoolTab.js:163-179, taxPoolCompute.js:95-103.
- What happens: software 30,000 / 3 yrs bought Shrawan 2079 amortizes 10,000 every year forever (no end-of-life test). In
  FY 82/83 with eOpening 0: `depreciation_amount: eAmortization` = 10,000 while closing is clamped `max(0,…)` = 0 and base 0 —
  a deduction on a pool worth nothing; with several Pool E assets the dead one eats the live ones' WDV.
- Fix: stop at useful life per asset; clamp depreciation_amount to base. Confidence: Confirmed.

### COSTS-7 [P2] Tax pool repair list can be the wrong year's, and a shown preview can be posted after the inputs changed
- Where: TaxPoolTab.js:49-57 (no request guard; error keeps old list), 101-102 (Preview clears `err`), 65-99 (add/delete
  expense do not clear `lines`), 188-231 (post sends `lines`).
- What happens: switch FY 82/83→83/84, repair read fails → red error, but 82/83's repairs stay in state; Preview clears the
  error and caps 83/84 against 82/83's repairs → Post locks it. Fast FY switching lets a slower response land last (same
  result). Adding a repair after Preview leaves the old preview (without it) on screen and Post locks that.
- Fix: clear repairExpenses + block Preview while its read failed; useLatestRequest keyed on FY; clear `lines` on any repair edit.
- Status: KNOWN+ (S683/S756 fixed the empty-on-error half; the stale-list half remains). Confidence: Confirmed.

### COSTS-8 [P2] Editing an asset's cost or dates after depreciation is posted silently re-values it
- Where: AssetFormModal.jsx:76-94 (all fields editable, supervisor rank at DB — ims_assets_register_guard only raises disposal
  columns to manager).
- What happens: cost 1,00,000, runs posted to NBV 80,000; supervisor edits unit cost to 1,20,000 → Current NBV stays 80,000,
  "Accumulated Depreciation" and "% Depreciated" jump to 40,000 / 33% (Valuation too), next run's annual charge uses the new
  cost from the old NBV, and a changed acquisition date moves the asset between tax-pool years after a pool run was posted.
- Fix: D5-style — refuse (or warn and require an adjustment) for cost/life/salvage/acquisition edits once a posted row exists.
  See Owner question 2. Confidence: Confirmed.

### COSTS-9 [P3] Overheads Labor tooltip still says "gross pay plus employer SSF"
- Where: Overheads.js:738. The figure is gross + overtime + employer SSF (labourSource.js:44-48, owner decision S756).
- Fix: add overtime to the sentence. Confidence: Confirmed.

### COSTS-10 [P3] Break-even card paints red when nothing is entered
- Where: Overheads.js:1204-1226. With totalFixed 0 (new client, blank seeded rows) `breakEvenRev` is null → `isAboveBreakEven`
  false → red card tint and red "Actual Revenue/Dishes" beside "Enter overhead costs above…". A verdict on an uncomputed figure.
- Fix: neutral styling when breakEvenRev is null. Confidence: Confirmed.

### COSTS-11 [P3] Asset pages print stored AD dates through `new Date(d).toLocaleDateString('en-IN')`
- Where: AssetCard.jsx:14, AssetRegisterTab.js:19, DepreciationRunTab.js:18, ValuationReportTab.js:16, DisposalReportTab.js:7,
  TaxPoolTab.js:207/300 (raw `expense_date`).
- What happens: `new Date('2026-01-15')` is UTC midnight, so a viewer west of UTC sees 14 Jan; and every date is AD only while
  the rule is `formatAdAsBs()` for a stored date. Pickers are AD `<input type="date">` too (GAP 1).
- Confidence: Confirmed.

### COSTS-12 [P3] Two devices opening Gate Passes after 6 AM: the loser shows closed passes as still open with a false warning
- Where: GatePasses.jsx:110-125. Both loads read the same stale list; the second update matches 0 rows (`.eq('status','open')`)
  → `sweepFailed` true, "could not be closed automatically" shown, and those rows stay `open` in that device's state until reload.
- Fix: after a short sweep, re-read or drop the unmatched rows as closed-elsewhere. Confidence: Confirmed (benign; reload fixes).

### COSTS-13 [P3] Asset category save retry duplicates categories
- Where: AssetCategoryModal.jsx:41-63 — an inserted row's id is not kept; after a later row fails, Save again re-inserts it.
- Confidence: Confirmed.

### COSTS-14 [P3] A month deliberately saved with no fixed costs reopens as "Nothing is saved yet" with last month's figures
- Where: Overheads.js:431-452 (Save with every row removed = delete only), 183-226 (empty period → carry-forward draft).
- What happens: owner clears every row for a month the shop was shut and presses Save → next visit shows the amber
  "Nothing is saved for Kartik yet… copied from Ashwin", and the page's P&L/verdict for Kartik is built from Ashwin's costs,
  while the Dashboard/Owner Report read Kartik's saved zero. There is no way to record "zero this month".
- Fix: remember "saved empty" (a marker row or a period flag) and skip the carry-forward. Confidence: Confirmed.

### COSTS-15 [P3] Gate-pass `issued_by` / `exited_by` are whatever the browser sends
- Where: GatePasses.jsx:137, 156; ims_gate_pass_void_guard stamps only `voided_by` (20260918110000:139-141).
- What happens: any IMS login can write another staff member's id as issuer/exit-confirmer over REST; the printed pass and
  the list show that name. Same rule the void guard already follows ("attribution the subject can choose is not attribution").
- Fix: stamp both from auth.uid() in the existing BEFORE trigger (INSERT for issued_by, open→closed for exited_by).
- Confidence: Confirmed.

### COSTS-16 [P3] Two managers can post the same depreciation period twice
- Where: DepreciationRunTab.js:218-230 — the overlap check is a browser read before the RPC; post_asset_depreciation_run
  (20260803130000) has no lock or overlap test. Two tabs pressing Post within the same second both see "no earlier run" and
  both charge the period; the schedule is immutable, so only an adjustment undoes it.
- Fix: advisory lock per client + overlap check inside the RPC (refuse unless an explicit `p_allow_overlap`).
- Confidence: Plausible (needs two concurrent posts; the code path is certain).

### COSTS-17 [P3] Setup guide menu step: `.eq('is_active', true)` on a nullable column, and an IMS-only dish unticked "On POS" never counts
- Where: setupSignals.js:91-95. `recipes.is_active` is nullable (S724 uses `.not('is_active','is',false)` for this reason) and
  `.not('pos_enabled','is',false)` also applies to IMS-only clients, where the flag means nothing.
- What happens: only a never-ticks edge (not a false tick); new clients' rows carry the defaults, so low impact.
- Fix: NULL-safe `is_active`; drop the pos_enabled test when POS is off. Confidence: Plausible (depends on whether the IMS-only
  Menu Pricing branch shows the On POS toggle to that client).

## GAPs
1. **Existing equipment has no starting point.** A cafe that joins with 5-year-old ovens can add them to the register, but the
   first book run opens them at full cost (no "depreciation already taken" field) and the tax pools open at 0 with the old
   assets never entering any pool (only this year's purchases count). Both schedules are wrong for every established client
   from day one, with nothing on screen saying so.
2. **Depreciation runs are picked in AD dates, free-form.** Owners think in Shrawan–Ashadh; there is no "this fiscal year /
   this BS month" preset, and nothing warns about a GAP between runs (days never charged) — only overlaps are warned.
3. **Two "Net Profit" figures for one month.** Overheads' P&L is purchase-based; /pnl (Consolidated P&L) is COGS-based. Both
   are labelled in fine print, but an owner comparing the two green/red verdicts sees two answers to "did we make money in
   Bhadra". A one-line pointer on each ("the other page says X because stock went up/down by Y") would close it.
4. **Gate pass list has no date or vehicle search.** "All" is every pass ever issued (paged, unbounded); finding "was van
   BA 5 KHA 5678 in on 12 Bhadra" means scrolling.
5. **Fixed Assets has no export.** Valuation, disposal and tax-pool schedules print only; the accountant who files the return
   gets no Excel, unlike every IMS report.

## Owner questions
1. **Overheads in the middle of the month** (COSTS-3). Rent and salaries are for the whole month, but sales are only so far, so
   the page says "Operating at a loss" until near month-end. Options: (a) show the figures but no green/red verdict until the
   month is closed, like Monthly Summary — *recommended*; (b) scale fixed costs by days passed (day 10 of 30 = one third of
   rent) and judge that; (c) leave as is.
2. **Changing an asset's price or purchase date after depreciation has been posted** (COSTS-8). Options: (a) refuse it and
   say "reverse the runs first, or record the difference as a new asset"; (b) allow it with a warning that names what changes
   (book value, next year's charge, tax-pool year) — *recommended, same as D5's price warning*; (c) allow silently (today).
3. **Starting tax pools for an existing business** (GAP 1). Options: (a) let the owner type each pool's opening value once,
   from last year's tax return — *recommended, it is the figure the accountant already has*; (b) compute it from the register
   by replaying every year since purchase; (c) start from zero and say so on screen.

## Checked and fine
- S756 Overheads: Save during load / wrong period — `save()` captures `pid`, refuses while `loading`, button disabled; period
  change clears rows; `useLatestRequest` on period and client (Overheads.js:126-171, 401-406). ✓
- S756 Overheads: purchases through `allocateBillDiscounts`; all multi-row reads paged; carried-forward draft named; blank-
  category/negative rows refused before the delete; delete-then-insert ordered with the no-reload recovery path. ✓
- S756 Overheads: IMS-role login cannot read payroll → `isPayrollFenced`, "not judged on this login", verdict withheld. ✓
- D22 / overtime: `payrollLabourTotal` = gross + ot_amount + ssf_employer; `resolveLabour` XOR bucket, ignored bucket named. ✓
  (tooltip wording aside, COSTS-9)
- D23 memo: posted runs overlapping the BS month, pro-rated by overlapping days, dates via `formatAd(bsToAd…)` (no
  toISOString), adjustment lines net off, failed read says so, never subtracted. ✓
- periodCost.js: revenue excludes pos_comp in JS, unit_price with current-price fallback, discounts; COGS via computeUsed.
  Overheads' own revenue loop is arithmetically identical (reads `source`, no server `.neq`). ✓
- Budget vs Actual: failed reads block; blur-without-edit does not upsert; failed save named with recovery; open month
  provisional (D7); uncategorised spend in Totals. ✓
- Fixed assets S756: FixedAssets withholds every tab (and both Post buttons) on a failed read; AssetCard blocks disposal on a
  failed schedule read; regular/adjustment override bounds; disposal posts depreciation first then the register update, and a
  retry cannot double-charge; tax-pool AD parse is local (`parseAdDateLocal`); repair dated outside the FY refused;
  prior-run read failure refuses the preview; second schedule for a FY needs confirmation. ✓
- DB fences: assets_* rank triggers (supervisor register/categories/repairs, manager posting/disposal/delete), posted
  schedule + pool lines immutable, count PIN refused by `ims_caller_has_rank`, all COALESCE-wrapped. ✓
- D27 gate passes: day start = `serviceDayStartIso` + 6h (most recent 6 AM Nepal); sweep `.eq('status','open').select('id')`,
  only closed ids shown closed; void keeps number, reason required, supervisor+ and final at the DB, `voided_by` stamped;
  reprint awaited; list paged; print date/time pinned to Nepal. ✓
- ims_gate_passes is on no_hr_role_staff / no_pos_pin_staff / no_self_service lists. ✓
- Setup guide IMS steps: every signal is head-only, tenant-scoped (scopedFrom, or period ids from the client's own months for
  period-keyed tables), wrapped in withTimeout, null on error ("couldn't check", blocks "all done"); counts all months so a
  tick survives a new month; recipes "costed" requires ingredient rows (chunked `.in`), so Menu Pricing's +Add Item cannot tick
  it; closing count needs `physical_qty IS NOT NULL`; only the viewer's own signals are read. No false-tick path found. ✓
