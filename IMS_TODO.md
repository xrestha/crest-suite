# Crest IMS — Re-analysis To-Do

Two whole-module reviews live here: **S792 (2026-09-28)** first, then **S756 (2026-09-15)**. D1–D28
are S756's decisions and D29–D42 are S792's. None is re-asked. Start from the S792 section. Above
them sits the S793 load-time backlog (PERF-n), from measuring the module on a slow connection.

**When an item here ships, strike it in the same commit and move it to the CHANGELOG entry.**

**Status key:** 🔴 Not started · 🟡 Partial · ✅ Done · 🔵 Deferred · ⚪ Known, open

---

# S793 load time on a poor connection (2026-09-29)

Measured on Chrome's Fast 3G profile (0.56 s per round trip) on CASA ACAI CAFE. On a slow link the
load time is the number of requests that wait on an earlier one, not the bytes. Detail and numbers:
the S793 CHANGELOG entry.

| # | Item | Status |
| --- | --- | --- |
| PERF-1 | The recipe walk fetched one sub-recipe level per round trip. The recipe book now loads in one request (`loadRecipeBook`, `useRecipeBook`). Stock Movements 12.5 s → 2.8 s, Variance 5.1 s → 2.5 s, Recipe Costing 5.0 s → 4.3 s. | ✅ S793 |
| PERF-2 | Every period page spends its first round trip finding the open month (~0.6 s on ~35 pages). A shared period list would let their data reads start in the first level. Touches every page's `init()`, so it needs its own plan. | 🔴 |
| PERF-3 | Item Master waits for the Used In count (a paged RPC, two levels) before showing the list. Painting first needs a "checking…" state in the delete guard, which must still refuse while the count is unknown. | 🔴 |
| PERF-4 | The service worker deletes every cached JS chunk on every deploy, so a slow link re-downloads the whole app after each release, even chunks whose hashed name did not change. Keep hashed `/static/` files across deploys and prune to the new asset manifest. Read the production cache headers first; unmeasured. | 🔴 |
| PERF-5 | The Dashboard's 12-month trend is the heaviest download (~180 KB, 4 levels on a first visit). It is cached on revisit, so it is lowest priority. The Dashboard, Reorder and Stock Report still walk recipes level by level and could take the book. | ⚪ |

---

# S792 re-analysis (2026-09-28)

Ten read-only reviewers covered master data, purchases, stock, sales, recipes, figures, planning,
tax, costs and the database. The database reviewer read the live catalog. Every P0 and P1 cited in the
plan was spot-checked against source before any decision was asked. The full evidence for each ID
below is in `docs/ims-review-s792/<AREA>.md`: where, what happens, evidence, fix and confidence.
Code added since S756 had never been reviewed, and most new findings sit in it:
- S758–S760 Customization;
- S761 count-PIN trim;
- S779 bill draft;
- S780–S786 forecast and weather;
- S790 setup guide;
- S774 `periodCost.js`.

## S792.1 Owner decisions (taken with Aashish, 2026-09-28)

| # | Decision | Status |
|---|---|---|
| D29 | Hiding an item or dish **never changes history**: past months keep every purchase, count and sale. Sales Entry shows hidden dishes that sold this month in a separate block, still editable. | ✅ S792 (Sales Entry stage 1; every period figure + `get_group_pnl` stage 2) |
| D30 | **Food Cost % = used (COGS) ÷ sales for closed months, everywhere.** The running month shows "Spend % so far" (purchases ÷ sales). Owner Reports already generated stay as they were. | ✅ S792 stage 2 (`foodCostBasis.js`; Owner Report schema 9) |
| D31 | **PAN-bill (not VAT-registered) outlet: the typed menu price is the price the guest pays**, stored whole. Existing dishes show their real till price so the owner can re-enter them. | ✅ S792 stage 2 (`menuPriceVat.js`, `PanPriceBanner`) |
| D32 | **PAN-bill outlet: supplier VAT counts as food cost**, and is not called "claimable". Needs a short design first (stage 4). | ✅ S792 stage 4 (`vat_is_cost`, `lineCost`; migration 20260929120000 live 2026-09-29) |
| D33 | A return against a discounted bill **credits the discounted price**, on payables and the balance letter too. | ✅ S792 stage 2 (`billOwedAfterReturns`) |
| D34 | The bill line's typed **Total is after VAT when VAT is ticked**. Ticking or unticking changes the Rate, never the Total. | ✅ S792 stage 2 (`billLineVat.js`; a typed Rate stays ex-VAT and gains 13% on the tick) |
| D35 | A dish typed as a Bulk total, later sold on the till: **Sales Entry asks for the pre-till days as daily figures**. The Bulk total is ignored for stock only after that. | ✅ S792 stage 2 (`bulkTillHandover`; POS clients may enter the pre-till days on Daily Entry) |
| D36 | Variance and Theoretical vs Actual **both judge an ingredient whose stock fell while its dishes sold nothing**. | ✅ S792 stage 2 (`variancePopulation.js`, Shrinkage and the Owner Report too) |
| D37 | A second count of an already-counted item **asks: replace, or add yours?** (stage 4) | ✅ S792 stage 4 (`save_closing_counts`; migration 20260929100000 live 2026-09-29) |
| D38 | Offline counts arriving in a closed month under the Owner's login are **listed, with one button "Add to Bhadra and carry into Ashwin's opening stock"**. Nothing lands silently. | ✅ S792 |
| D39 | **Counting tablets lock after 10 idle minutes** and return to the PIN screen, like POS tills. Sign out also goes back to the PIN screen. | ✅ S792 |
| D40 | Existing businesses **type each tax pool's opening value once**, plus "depreciation already taken" per old asset (stage 4). | ✅ S792 stage 4 (`assets_tax_pool_openings`; migration 20260929110000 live 2026-09-29) |
| D41 | **Moving Item Master's price from a purchase bill needs Supervisor+**, enforced in the database. | ✅ S792 (database + bill page) |
| D42 | When an IMS Supervisor ends the month, the Owner Report is still made at the Owner's first view. **The close screen and the report header say when it was made.** | ✅ S792 stage 3 (`closerMakesReport`/`deferredReportNote`, `reportMadeLine.js`) |

**Settled by precedent (shown to the owner in the approved plan, not asked separately):**
- Overheads gives no verdict for an open month (D7).
- Editing an asset's cost or dates after a posted run warns, naming what changes (D5).
- A stale bill draft is not auto-restored; the owner chooses which version to keep.
- Editing an old or closed-month bill never offers to roll Item Master's price back.
- Only the Owner grants IMS Manager (the S752/S754 rule for HR and POS).
- The HQ push skips, and lists, a branch item whose unit differs and has history (D5), and never copies `is_active` onto a branch row.
- A duplicate supplier name or PAN warns but allows the save.
- A closed-month count correction offers "carry into next month's opening" as one button.
- The dashboard never samples today's partial day (S694).
- Build-your-own dishes are "Not rated — costed by build" on the menu reports.
- The stock cost of extras counts in margin.
- Dead Stock counts staff meals as movement, but not wastage.
- The reorder total is priced at whole packs.
- A cross-year return sits in the year it happened on the 1L report (D10), with a Help note for the accountant.

## S792.2 Stage 1 — security and silent data loss — ✅ shipped S792

Migration `20260928140000_ims_integrity_s792.sql` applied live 2026-09-28 after a rolled-back dry run on CASA ACAI CAFE's real logins (21 behavioural checks, then read back from the live catalog and re-run against the live migration, all passing). `admin-user-ops` v60 and `ims-staff-login` v5 deployed. Left for later: `staff_meals` is still not audited (it has no `client_id`, so `log_audit()` cannot place it without a change to that function).

**Migration `ims_integrity_s792`.** First inventory every writer of each table, as S756 did. Then do a rolled-back dry run on CASA's accounts. Apply only on the owner's "apply".
- ✅ S792 — DATABASE-1 **[P0]** `settings_guard_staff_roles` does not fence `ims_count_scope_enforced` / `ims_count_blind` / `require_count_attribution`. Any login can switch off section scope and recount protection; gate these on `ims_can_manage_counts()`.
- ✅ S792 — MASTER-1 / DATABASE-4 **[P0]** No rank guard on `items`, `vendors` or `categories`, and a count PIN can rewrite master data.
  - Changes:
    - supervisor+ for all three;
    - `items.uom` refused while referenced (D5 in the DB);
    - vendor archive, restore and delete limited to Owner or admin (D25);
    - `items.rate` from a bill needs supervisor+ (D41).
  - Also `items.category_id`, which lets a scoped counter move an item into their own section.
- ✅ S792 — COSTS-1 / DATABASE-3 **[P0]** `overheads` (manager) and `budgets` (supervisor) have no rank guard. `overheads` is also missing from `ims_closed_period_guard`.
- ✅ S792 — DATABASE-2 **[P1]** `sales_entries` has no rank guard, so a POS waiter or a count PIN can rewrite the open month. Guard by source:
  - manual → IMS staff+;
  - `pos` / `pos_comp` → POS or IMS supervisor+;
  - `pos_credit` → POS manager.
- ✅ S792 — DATABASE-4 `purchase_orders` / `purchase_order_items` need supervisor+. Today `qty_received` / `status` can be written directly, which makes the double-receive guard advisory. Also rank `demand_forecast_daily`, and put `recipe_suggestions` behind `no_pos_pin_staff`.
- ✅ S792 — DATABASE-6 `settings` has no UNIQUE(client_id), so a second row breaks every `.maybeSingle()` read. Check live for duplicates first.
- ✅ S792 — MASTER-3 **[P1]** "Sign out all counting tablets" does not end sessions that are already signed in. `rotate_ims_device_secret` and `revokeClientTablets` must delete those `auth.sessions`.
- ✅ S792 — MASTER-2 **[P1]** `push_master_data` rewrites a branch item's unit and active flag and keeps its rate. A unit mismatch on a referenced item should become a `conflict`, and `is_active` should never be copied.
- ✅ S792 — PURCHASES-1 **[P1]** `purchase_order_items.unit_price numeric(12,2)` plus `round(rate,2)` in `receive_purchase_order`. Per-gram prices get mispriced, and anything under 0.005 becomes a free line.
- ✅ S792 — PLANNING-7 A snapshot column on `monthly_periods` should only be replaceable by a newer model.
- ✅ S792 — COSTS-15 Stamp gate-pass `issued_by` / `exited_by` from `auth.uid()`.
- ✅ S792 — COSTS-16 `post_asset_depreciation_run` needs an advisory lock and an overlap refusal.
- ✅ S792 — DATABASE-7 Add `log_audit` on `payable_payments`, `staff_meals` and `overheads`.
- ✅ S792 — DATABASE-8 REVOKE the stray TRUNCATE / REFERENCES / TRIGGER / MAINTAIN grants on `assets_*`, `ims_count_assignments` and `monthly_owner_reports`.

**Edge Functions**
- ✅ S792 — MASTER-4 `admin-user-ops`: only the Owner grants IMS Manager (create_ims_staff, update_ims_role). Hide Manager in the ImsStaff pickers for a non-Owner.
- ✅ S792 — DATABASE-5 **[P1, Plausible]** The Danger Zone's unchunked `.in()` deletes can 414 partway through Archive or Delete. Drop them; the FK cascades cover the same rows.
- ✅ S792 — MASTER-7 `ims-staff-login` drops the error on its device read, so a DB blip reads as "not set up" and the tablet erases its setup. Return 503 instead.
- ✅ S792 — MASTER-8 (part) The `create_ims_staff` / `create_ims_pin_staff` employee-link reads drop `error`.

**Frontend**
- ✅ S792 — SALES-1 **[P0]** A hidden dish's manual rows are deleted by `save_sales_day` on any day or Bulk save. Carry them through the payload and show them (D29). Period Revenue should count all rows.
- ✅ S792 — SALES-2 **[P1]** Regression of S457 via S756: `mode={pendingSave.mode}` is always undefined, so the Bulk save's delete warning names the opposite deletion.
- ✅ S792 — STOCK-2 Every S756 IMS database refusal (closed month, month rank, IMS rank, recipe rank) shows the generic "not allowed" text, because the generic 42501 rule in `errorText.js` wins. Reorder the rules and add a test per hint.
- ✅ S792 — STOCK-1 **[P1]** / STOCK-9 / STOCK-3 / STOCK-4 Offline replay in `Stock.js`:
  - it runs outside `persistLocks`, out of order, and with no single-flush guard;
  - non-network refusals are retried for ever, then land under a higher rank;
  - Sync Now is hidden after a failure;
  - a replay under the Owner's login lands silently in a month closed meanwhile (D38).
- ✅ S792 — PURCHASES-2 **[P1]** An S779 draft is restored over a newer saved version of the bill. Store the base signature, and let the owner choose which to keep.
- ✅ S792 — D39 Count-PIN idle lock and sign-out to `/ims/count`. Also MASTER-8: hide Clear All for `imsCountOnly`, and correct the Stock Count Settings dialog copy.

## S792.3 Stage 2 — wrong numbers — ✅ built S792

Built by eight agents over disjoint files, then a follow-up pass (group dashboard, Stock Count Summary, a deleted return un-settling a bill). Two migrations, both applied live 2026-09-28 after a rolled-back dry run: `20260928160000_ims_group_figures_s792` (`get_group_pnl` keeps hidden items) and `20260928160100_demand_forecast_run_id_s792`. Owner Report schema 9. Live figures change for: hidden items' past months, Food Cost % on closed months, assets with a back-dated or reversed depreciation run, and bills settled before D33 that had a discounted return (they now owe the discount share of it).

- ✅ S792 stage 2 — RECIPES-2 **[P1]** On PAN-bill outlets the pricing screens divide the typed price by 1.13 and the till charges the divided figure (D31). Change Recipes.js, MenuPricing.js (**both** branches), MenuRepricing.js and RecipeImportButton.jsx.
- ✅ S792 stage 2 — FIGURES-1 **[P1]** Hiding an item removes its purchases from every past month on Monthly Summary, the P&L, `get_group_pnl`, Annual Summary and Period Comparison (D29). FIGURES-9 is the matching Budget vs Actual reconciliation claim.
- ✅ S792 stage 2 — FIGURES-3 "Food Cost %" is two formulas under one name (D30). Fix the tip, the Help FAQ and glossary, and the comments that claim they agree.
- ✅ S792 stage 2 — FIGURES-2 **[P1]** / SALES-3 **[P1]** The Owner Report's Inventory Variance and Shrinkage Trend are pre-S719 copies:
  - they read unpaged;
  - an uncounted item counts as 0;
  - there is no tolerance;
  - they skip the depletion rule, so credit notes and choice lines subtract usage;
  - Variance leaves out staff meals.
  Rebuild them on the live helpers and bump the schema version. FIGURES-8 (the `.neq` on revenue) and TAX-7 (active-only vendor name map) go in the same rebuild.
- ✅ S792 stage 2 — FIGURES-4 Variance and Theoretical vs Actual judge different populations (D36).
- ✅ S792 stage 2 — D35 Bulk + till notice on Sales Entry. `salesDepletion.js` ignores the Bulk total only after re-entry.
- ✅ S792 stage 2 — PURCHASES-3 **[P1]** Outstanding Payables and the balance letter credit returns at list price with the whole discount kept (D33). A fully returned bill tells the supplier they owe us. Related: PURCHASES-8, where a fully returned credit bill never leaves Outstanding.
- ✅ S792 stage 2 — TAX-1 **[P1]** Vendor Report drilldown "Total paid" = ex-VAT total − VAT-basis remaining. It should be Σ payments.
- ✅ S792 stage 2 — TAX-2 **[P1]** Vendor Report's payable/status ignores a return entered in a later month (D10).
- ✅ S792 stage 2 — TAX-3 The 1L report values a cross-year return at list price, because `readPriorBillLines` is missing.
- ✅ S792 stage 2 — PURCHASES-4 The line Total flips meaning with the VAT tick order, and the header toggle leaves Total and Amount disagreeing (D34).
- ✅ S792 stage 1 — PURCHASES-5 Editing an old or closed-month bill offers, pre-ticked, to roll Item Master back (D41 and precedent).
- ✅ S792 stage 2 — PURCHASES-6 = MASTER-6 Price Tracker changes the master price with no D5 warning and no zero-row check.
- ✅ S792 stage 2 — RECIPES-1 **[P1]** Build-your-own dishes are still judged at their bowl-and-spoon cost:
  - the detail view, printed card, WhatsApp share, pills and export;
  - Menu Engineering and its `me_class` write-back;
  - Recipe Margin, Repricing and Best Sellers;
  - the Owner Report ME section.
- ✅ S792 stage 2 — RECIPES-3 **[P1]** Extras are counted as revenue but their stock is not counted as cost on Recipe Margin and Best Sellers.
- ✅ S792 stage 2 — COSTS-2 **[P1]** Fixed assets choose "current NBV" by period end, not by posting order, which breaks D24's reversal and disposal flow. Also COSTS-4, where valuation drops assets disposed after the as-of date; COSTS-5, where a missing prior-year pool run opens every pool at 0 (warning part only); COSTS-6, where Pool E runs past its useful life; and COSTS-8, where an asset edit after posting gives no warning (D5).
- ✅ S792 stage 2 — PLANNING-1 Demand Forecast reads at most 1,000 bills, and its stored read is unpaged. The old-run delete puts every new id in the URL. Needs a `run_id` column.
- ✅ S792 stage 2 — PLANNING-2 / PLANNING-3 The dashboard forecast and the frozen Target count today's partial day as a whole day (S780–S783 code).
- ✅ S792 stage 2 — PLANNING-4 Dead Stock ignores staff meals as movement, so staff rice reads "write it off". The Owner Report copy has the same flaw.
- ✅ S792 stage 2 — SALES-4 Two quick Save Day presses can deplete stock twice. SALES-5 An import with a negative net quantity is dropped silently.
- ✅ S792 stage 2 — MASTER-5 Two items added in one visit share a code, and Recipe Import resolves by code first.
- ✅ S792 stage 2 — STOCK-5 (KNOWN+ of the banner item) A closed-month correction never reaches next month's opening. STOCK-6 A month switch shows old figures, with Export live.
- ✅ S792 stage 2 — COSTS-3 Overheads gives a verdict on the open month (D7 precedent). COSTS-9 The labour tooltip leaves out overtime. COSTS-10 Break-even shows red with no figure entered.

## S792.4 Stage 3 — hygiene (one sweep) — ✅ built S792 stage 3

Built by nine agents over disjoint files (details in the CHANGELOG entry "IMS stage 3"). One migration,
`20260928180000_ims_hygiene_s792`: RECIPES-7's cycle trigger, DATABASE-9, DATABASE-11, the HQ push's
VAT-status rule and `ims_first_till_bill_at` (D35 for IMS-rank logins).

- ✅ TAX-4 / TAX-5 / TAX-6 / TAX-8 / TAX-9 / TAX-10 / TAX-11 / TAX-12 / TAX-13
- ✅ PURCHASES-7 / PURCHASES-9 / PURCHASES-10 (the double-payment check is client-side; see Still open)
- ✅ STOCK-7 / STOCK-8
- ✅ PLANNING-5 / PLANNING-6 / PLANNING-8 / PLANNING-9
- ✅ COSTS-7 / COSTS-11 / COSTS-12 / COSTS-13 / COSTS-14 / COSTS-17
- ✅ FIGURES-5 (two named figures: `periodWastageValue` for "thrown away", the raw-item COGS term on Monthly Summary) / FIGURES-6 / FIGURES-7 / FIGURES-10 / FIGURES-11
- ✅ RECIPES-4 / RECIPES-5 / RECIPES-6 / RECIPES-7 / RECIPES-8 / RECIPES-9 / RECIPES-10
- ✅ SALES-6 / SALES-7 / SALES-8
- ✅ MASTER-8 (the rest, plus the sub-recipe and product-code renumber reads)
- ✅ DATABASE-9 / DATABASE-10 / DATABASE-11
- ✅ D42 wording on the close screen and the report header
- ✅ Found while building stage 2 — every item below built, except the two marked accepted:
  - ✅ Shrinkage's observation loop, `bandShrinkageItem` and `shrinkageStatus` live in `variance/shrinkageCalc.js`; the Owner Report's twins are deleted.
  - ✅ The Owner Report's trend stores `trendSnapshotOf()` only, not the whole prior snapshot (schema 10).
  - ✅ Recipe Margin's Export is gated on loading/loadError/biz.error and letterheaded.
  - ✅ Price Tracker's confirm names the past records it re-values (`priceImpactSentence`, `readItemRefCounts` in `itemRefTables.js`).
  - ✅ `push_master_data`: a branch whose VAT status differs keeps its own price and VAT rate; a new dish arrives off the till with no price (migration `20260928180000`).
  - ✅ Overheads shows `ClosedPeriodBanner canEdit`; Requisitions its own amber note (Owner/admin) and the red banner (staff).
  - ✅ Fixed assets: a part-reversed period counts only its charged days; a Pool E asset disposed in the year leaves the pool (our reading of Schedule 2 — confirm with an accountant).
  - ⚪ Accepted: a month Target captured from a part-day before PLANNING-3 corrects itself when the month ends; bumping `SNAPSHOT_MODEL` would replace every client's Target mid-month.
  - ✅ `Items.test.js` pins `rememberInBook` (`bookWith`).
  - From the stage-2 write-path review:
    - ✅ The per-day lock stays; a stock update still waiting after 20s now says so under Save, with the way out.
    - ✅ D35's first till day is the earlier of `sales_entries` and the till's own first paid/comp bill (`ims_first_till_bill_at`, every IMS rank).
    - ⚪ Accepted (owner, 2026-09-28): a bill paid before `payable_payments` existed and brought to 0 by a return reopens if that return is deleted. Rare, the confirm names the amount, and it needs a manager; recorded in `returnChangeReopensBill`'s doc and Help.
    - ✅ A Recompute deletes only runs older than its own, so two at once leave the newer.
  - ✅ `Overheads.js` says Purchases / Spend %, not Food Cost.

**Still open after stage 3** (found while building it):
- No SERVER guard against paying a bill twice: Outstanding Payables re-reads payments just before recording one (PURCHASES-10), but two payments in the same second both land. A BEFORE INSERT trigger on `payable_payments` or a pay RPC with a row lock would close it.
- The HR Staff page's Last Seen is still an AD `toLocaleDateString` (the ImsStaff/PosStaff fix, `nepalBsLong`). HR is shared with hss-suite: fix here and file it in `docs/CROSS-REPO.md` there.
- `PosOrders.jsx` (`writeSalesEntries`) and `IssueCreditNoteModal.jsx` date "today" with `getBsToday()` (the device's clock zone) while the backfills now use the Nepal date (SALES-6). Fine on a till in Nepal; `nepalBs(new Date())` would make them agree.
- `ClosedPeriodBanner` could take a prop to drop its "regenerate the snapshot" clause, so Requisitions can use the component too.
- (stage 4) `get_group_summary` — the Group Console's Spend % — still values a PAN outlet's purchases ex-VAT (D32 covered `get_group_pnl` only).
- (stage 4) On a bill line, ticking VAT after the rate was prefilled from Item Master does not re-divide it by 1.13; the Item Master VAT review banner looks back 3 months of bills.

## S792.5 Stage 4 — design first, shown before building — ✅ built S792 stage 4

Designs: `docs/ims-review-s792/STAGE4-DESIGN.md`; owner took every recommendation (Q1–Q7). All three migrations **live 2026-09-29**: 20260929110000 (D40), 20260929120000 (D32), and 20260929100000 (D37, after a pre-apply fix: an add no longer makes the adder the total's sole owner).

- ✅ D32 PAN-bill supplier VAT as cost. The valuation basis for stock and purchases touches every COGS reader and the group SQL.
- ✅ D40 Opening pool WDV and per-asset "depreciation already taken" (schema and UI).
- ✅ D37 Two-location count prompt (a fresh server read on save).

**GAPs the reviewers raised, not scheduled yet.** Each area file has its own list. The strongest:
- no Item and Vendor Excel import;
- item categories cannot be added or renamed;
- no print or export on Outstanding Payables;
- "Overdue" ignores supplier terms;
- no small-balance write-off;
- no dish cost history;
- no Fixed Assets export;
- sales_entries has no audit trail.

---

# S756 re-analysis (2026-09-15)

Whole-module review of Crest IMS, 2026-09-15, in the shape of the S754 POS re-analysis. Nine
read-only reviewers covered: items/vendors/gate passes/IMS staff/count PIN; purchases/returns/POs/
payables; stock count/periods/movements; sales/requisitions; recipes/menu; variance/summaries/budget;
reorder/dead stock/forecast/FIFO/ageing; VAT/1-lakh/vendor reports; overheads/fixed assets/IMS-wide
access. High-severity claims were spot-checked against source before any decision was asked.

## 1. Owner decisions (taken with Aashish, 2026-09-15)

| # | Decision | Chosen |
|---|---|---|
| D1 | Closed-month lock | **Database refuses writes to a closed period** on `opening_stock`, `closing_stock`, `wastages`, `staff_meals`, `sales_entries`, `purchase_entries`, `vendor_returns`, `requisitions`/`requisition_lines` (admin carve-out; paying a closed month's bill stays allowed; POS backfill path preserved). ~~Owner may reopen~~ → **changed the same day to Owner edits closed months in place** (reopening cannot work: only one period may be open and the next month is already open). Offline replay into a closed month is refused and surfaced, not landed. ✅ S756 |
| D2 | Who ends/reopens the month | Owner, IMS supervisor/manager, Crest operator — enforced in DB on `monthly_periods` INSERT/UPDATE, and the Dashboard button hidden for everyone else. Reopen/relabel: Owner or operator. ✅ S756 |
| D3 | Recipe ranks | **Hide/unhide a dish: IMS supervisor+. Delete a dish: manager+.** Enforced in DB (`guard_recipe_rank`; rank check on `recipe_ingredients` writes). ✅ S756 |
| D4 | Counting tablets | One **"Sign out all counting tablets"** button (rotates `ims_device_secret`); also rotated by archive/clear/delete client. ✅ S756 |
| D5 | Item unit/price edits with history | **Refuse a unit change** once the item has purchases or counts ("hide it and create a new item"). **Warn on a price change**, naming how many past records it re-values. ✅ S756 |
| D6 | Uncounted items on summaries | Stock Count Summary, Monthly Summary, Annual Summary, Period Comparison: **amber warning naming the uncounted items, marked in table and export; FC% shown without a colour verdict** while the gap is material. Totals unchanged. ✅ S756 |
| D7 | Open-month reports | Monthly Summary / Budget vs Actual keep opening on the current month, **marked provisional, no red/green verdict** until closed. Fall back to latest period when none is open. ✅ S756 |
| D8 | Price on a corrected past sales day | **Every row keeps its stored `unit_price`**; only new rows take today's menu price. ✅ S756 |
| D9 | Lump-sum supplier payment | **One amount per supplier, applied oldest bill first, split shown before saving.** Per-bill entry stays. ✅ S756 |
| D10 | Late returns | A return may pick a bill from an earlier month and **sits in the month it happened** (VAT timing to be confirmed by an accountant — say so in Help). ✅ S756 |
| D11 | Supplier credit | **"Settle using supplier credit"** on a payment against another bill of the same supplier. ✅ S756 |
| D12 | Same PAN on two suppliers (1L report) | **Aggregate by PAN**, listing all names; warn on blank PANs. ✅ S756 |
| D13 | Invoice VAT capture | **Two optional fields** on a purchase bill (invoice VAT, invoice total); flag mismatch > NPR 1. Migration. ✅ S756 |
| D14 | Requisitions | **Record requested_by / issued_by / issued_at**; add **Rejected** status with reason. No two-person rule, no back-orders. ✅ S756 |
| D15 | Dish VAT toggle | **Keep the guest price** on both Recipe Costing and Menu Pricing; show resulting ex-VAT. ✅ S756 |
| D16 | Dish photos | **Upload button** storing photos in Crest (Supabase Storage). ✅ S756 |
| D17 | Non-recipe items on Variance | Grey **"no recipe linked"** state, excluded from flagged count and loss total. ✅ S756 |
| D18 | Reorder quantities | **Both units, rounded up to whole packs** — print, WhatsApp and Excel. ✅ S756 |
| D19 | Stock Ageing / FIFO basis | **Anchor to the physical count** where one exists (oldest removed first), **state the basis**, **rolling 12-month** window. ✅ S756 |
| D20 | Dead stock | **Dead after 2–3 consecutive months** with no movement (shorter = Slow); **suggested next step** per item. ✅ S756 |
| D21 | Demand forecast | **Exclude past holidays** from weekday averages; ingredient list shows **forecast use / in store / to buy**. ✅ S756 |
| D22 | Dashboard labour | Dashboard Fixed Costs % / Est. Net Margin **use finalized payroll**, like Overheads, naming the source. ✅ S756 |
| D23 | Depreciation in profit | **Memo line** on Overheads P&L — shown, not subtracted. ✅ S756 |
| D24 | Asset fixes | **Charge depreciation to the disposal date**; **Adjustment run** to reverse a wrong run + warn before posting an overlapping period. Personal-use apportionment **not** chosen (legal question). ✅ S756 |
| D25 | Supplier tidy-up | **Owner can archive, restore and delete** suppliers (DB trigger still refuses deleting one with history). ✅ S756 |
| D26 | Bill edit with a return against it | **Refused** until the return is removed (same shape as `purchase_bill_has_payments`). Migration. ✅ S756 |
| D27 | Gate passes | Day boundary **6 AM Nepal time**; **void with reason** keeping the number. ✅ S756 |
| D28 | Accountant extras | **Bill-wise sheet** in VAT export; **Sales import warns** when the file's date range ≠ selected day. ✅ S756 |

Open question for an accountant, not engineering: IMS-only clients have no sales-side VAT view (net VAT payable) anywhere in Crest.

---

## 2. Clear-cut fixes (one right answer)

**Stage 2 (wrong numbers and lost changes) shipped in S756** — migration `20260918110000` (bill edit refused with returns, non-negative discount CHECK, gate-pass void) plus ~60 frontend files, with owner decisions D5, D8, D12, D15, D17, D18, D21, D23, D24, D25, D26, D27 and D28 built alongside the fixes in the same files.

**Stage 3 (owner decisions) shipped in S756** — migrations `20260918120000` (supplier credit pairs), `20260918130000` (invoice VAT/total columns), `20260918140000` (requisition attribution + Rejected, and the staff-adds-lines-to-an-issued-slip gap closed), `20260918150000` (dish-photos bucket), `20260918160000` (Logos SELECT policy — logo replace/remove had been failing since 20260914140100). All eleven remaining decisions are built.

**Stage 4 (follow-ups and judgment calls) shipped in S756** — frontend, plus migration `20260918170000` (group payroll figures include overtime, applied live after a rolled-back dry run). Owner answers: payroll labour includes overtime on every page; Owner Dashboard uses finalized payroll when it exists; parking closes at 6 AM too; the Annual Summary year-total verdict stays withheld when the year's gap is material; Stock Ageing stays cautious about count surpluses; the Stock Count export gets the letterhead; the One Lakh report keeps deducting unlinked returns and says so; disposals recorded before S756 are left as recorded.

- ✅ S756 stage 4 — A return against an EARLIER month's bill is valued at that bill's discount on PaymentReport, VendorReport, SupplierContribution and computeVendorPurchasingSection (`applyPriorBillFactors` / `mergeFactors` in `supplierAttribution.js`). VendorReport's drilldown lists earlier-bill and unlinked return rows.
- ✅ S756 stage 4 — Monthly Owner Report dead stock uses `deadStockCalc.js` (3 counted still months); `CURRENT_SCHEMA_VERSION` 7, which also covers the vendor section's discounted returns, returns' own payment method and paged read.
- ✅ S756 stage 4 — Overheads.js adopts `labourSource.js` and pages its payslips read.
- ✅ S756 stage 4 — OwnerDashboard Labor/Prime/True Net Margin use the finalized payroll run when one exists (gross + OT + employer SSF, the Owner Report's figure), name the source, show dashes on a failed read, and withhold the verdict when a full month's payroll sits against part of a month's revenue.
- ✅ S756 stage 4 — KitchenDisplay.jsx imports `serviceDayStartIso` from nepalTime.js.
- ✅ S756 stage 4 — POS parking auto-close cuts off at the actual 6 AM, like gate passes (owner decision).
- ✅ S756 stage 4 — Stock Count export carries the letterhead (owner decision). Annual Summary year-total verdict: kept as built (owner decision).
- ✅ S756 stage 4 — Stock Ageing count surpluses: kept cautious (owner decision, no change).
- ⚪ Budget vs Actual's provisional line talks about spend rather than food cost — wording only.
- ⚪ Dish photos uploaded to a NEW recipe that is then cancelled leave an unused file in storage.
- ⚪ **S761 left the counter trim as a DISPLAY control, and the owner knows.** Only `closing_stock`
  carries counter-scoped RESTRICTIVE policies (`ims_count_scope_*`, migration `20260910120000`);
  `opening_stock`, `wastages` and `staff_meals` have none, so a count PIN's JWT can still write
  them over REST even though the tabs are gone. Blind count and section scoping already carry the
  same caveat and say so on the Settings tab. Making it a real boundary is a migration and a
  separate owner decision — not started. **→ Taken into S792 stage 1** (DATABASE-4, owner-approved
  plan 2026-09-28): the count PIN is refused on `opening_stock`, `wastages` and `staff_meals`, and the
  settings that switch scope and blind count off are fenced (DATABASE-1).
- ⚪ **S761 was not click-verified as a count account.** The PIN is hashed, so the trimmed page was
  checked by build, lint, the full suite and by hand-checking the header/body/footer column counts
  across all four `hideValues` × `blindCount` combinations — not by signing in on a phone. Worth a
  real look on a storeroom handset before the next month-end count.
- ✅ S756 stage 4 — Payroll labour cost includes OVERTIME everywhere (owner decision): gross + overtime + employer SSF on Overheads, ClientDashboard, ConsolidatedPnl, Group Dashboard and the group P&L (migration `20260918170000`, applied live), matching the Owner Report and Owner Dashboard. `payrollCashCost` (absence subtracted) stays the cash-paid figure.
- ⚪ `purchaseTaxSplit.js` keeps a private `mergeFactors`; `billPayables` could take prior bill lines directly (tidy-up).
- ⚪ Owner Report vendor section: cash/credit split is pre-discount, and its aging total is compared against payments that include VAT.

- ✅ S756 stage 3 — D22 — ClientDashboard Fixed Costs % / Est. Net Margin use finalized payroll, and say "labour unreadable on this login" for an IMS staff login (Overheads does both now).
- ✅ S756 stage 3 — VendorReport: `provisionalWhenOpen` on PeriodScope; SupplierContribution + VendorReport export gating on loading/biz.error.
- ✅ S756 stage 3 — PaymentReport `billPayables`: unlinked returns valued with no VAT added back and no banner (VAT/Non-VAT now name them).
- ✅ S756 stage 3 — ReorderReport export has no letterhead (`sheetWithLetterhead`).
- ✅ S756 stage 3 — PurchaseBillPage `applyRateUpdates` rewrites `items.rate` with no D5 price warning and no zero-row check; its `load()` shows raw `error.message`.
- ✅ S756 stage 3 — Purchases/Returns "Delete All" has no zero-row check; OutstandingPayables bulk `paid_at` `.in()` is not chunked.
- ✅ S756 stage 3 — TheoreticalVariance's Over/Under-consumed filter buttons test raw `variance > 0.01`, not the tolerance band.
- ✅ S756 stage 3 — `findSupersededRows` / `persistSalesDay` rethrow `new Error(error.message)`, losing the error code.
- ✅ S756 stage 3 — Move `serviceDayStartIso` (POS parking) into `src/shared/nepalTime.js`; GatePasses imports it from the POS modal. Decide whether POS parking's auto-close should use the actual 6 AM like gate passes (it cuts off at the service day's midnight).
- ✅ S756 stage 4 — Disposals recorded before S756 keep a gain/loss measured at the last posted run — left as recorded (owner decision).
- ✅ S756 stage 4 — 1L report: an UNLINKED return is still deducted from its supplier's total — kept, and the page says so (owner decision).
- ⚪ Demand Forecast Recompute now skips past holidays, which changes what Roster's Labor Forecast reads.

**Stage 1 (security + closed months) shipped in S756** — migration `20260918100000`, `admin-user-ops`, `ims-staff-login`. Assets were fenced to match the page (register/categories/repairs supervisor; disposal and posting manager), not all-manager. Known gaps it left: a staff login can add lines to an issued requisition over REST; Sales, Stock Count, Overheads and Requisitions show no amber "editing a closed month" banner to the Owner; Roster's labour-actuals reads still hit tables fenced from HR logins (`recipes`, `sales_entries`, `pos_orders`) — ✅ closed S798 stage 2e (crest-v371): both Labor Forecast loaders read the day's totals from the caller-checked `hr_labour_actuals` (migration `20261001200000`, HR_TODO.md ROSTER-9).

### 2a. Database (migrations)
- ✅ S756 — `monthly_periods` INSERT/UPDATE rank fence (D2) — any PIN account can reopen/close/relabel over REST.
- ✅ S756 — Closed-period triggers (D1).
- ✅ S756 — IMS rank: `purchase_entries`/`vendor_returns`/`payable_payments` (staff can delete bills and payments over REST; Delete All is supervisor+, payables manager).
- ✅ S756 — `requisitions`/`requisition_lines`: issued slip changes supervisor+ only.
- ✅ S756 — `stock_movements` DELETE admin/Owner/IMS manager; `par_levels` DELETE supervisor+.
- ✅ S756 — `recipes`/`recipe_ingredients` (D3).
- ✅ S756 — `assets_register`/`assets_depreciation_runs`/`assets_repair_expenses` + post RPCs: IMS manager. `settings` IMS threshold columns: manager.
- ✅ S756 — `demand_forecast_daily` readable by HR roles (Roster labour overlay silently empty for every HR login).
- ✅ S756 — `save_purchase_bill` refuses superseding lines with returns (D26).
- ✅ S756 — `get_ims_count_staff`: drop settlement-blocked employees; RAISE on bad device secret.
- ✅ S756 — `ims_device_secret` rotate RPC (D4).
- ✅ S756 — `purchase_entries` CHECK `discount_amount >= 0`.

### 2b. Edge Functions
- ✅ S756 — `admin-user-ops update_ims_role`: refuse any rank but `staff` for a count-PIN (`ims_email`) target; `revokeClientTablets` also rotates `ims_device_secret`.

### 2c. Frontend — security/access
- ✅ S756 — `AuthContext.js:225` profile select lacks `ims_email` → `imsCountOnly` always false; count PIN reaches everything staff can.
- ✅ S761 — the other half of that one, found from a photo of a counter's phone, not from the audit: `imsCountOnly` fences the ROUTE and nothing inside it, so a count PIN opened `/stock` to all seven tabs — Opening Stock (an entry grid over the month's starting basis) as the DEFAULT, Summary with COGS/purchase value/Excel export of the cost base, and Print Sheet + Summary making `ims_count_blind` readable in two taps. Now one tab (Closing Stock), no NPR per line for any Staff-rank counter, and blind count covering all three screens. **Display control only** — see below.
- ✅ S756 — `ImsStaff.jsx:594/245/167` hide rank select for PIN rows; exclude from job-title sync.
- ✅ S756 — `ClientDashboard.jsx:2574-2596` End Period button role check (D2).
- ✅ S756 — `Overheads.js:210+` IMS-role login can't read payroll → says "no payroll run" and green Net Profit; say labour unreadable, withhold verdict.

### 2d. Frontend — wrong numbers / data loss
- ✅ S779 — `PurchaseBillForm.jsx` held a whole vendor bill in React state until Save, so a Chrome
  auto-update restart, a tablet discarding the backgrounded tab, the memory saver or a
  deploy-triggered chunk reload took 10–20 typed lines with it, silently. Reported live. Drafted to
  `localStorage` per bill per login (`purchaseBillDraft.js`), restored behind an amber notice,
  cleared on save and on cancel. Rule: `.claude/rules/offline-and-cache.md`.
- ⚪ **`Sales.js`' bulk grid is the same shape and is not drafted.** A human legitimately spends
  minutes in it before Save and nothing survives the page dying. Stock Count is covered by the
  offline queue and per-row saves; Sales Entry is covered by neither.
- ✅ S780 — Dashboard's Daily Purchases vs Sales Target was a least-squares line through the
  month's first 5 days, frozen. CASA, Ashwin 2083: it ran to zero by day 14 (sales target 92,144
  against 73,846 sold by day 6), and the 1.25× ceiling became the purchase forecast (2,40,207).
  Rebuilt in `src/modules/dashboard/dailyForecast.js`. The Target is the last 4 weeks' weekday
  pattern from Day 1, and the forecast is that pattern × this month's pace. Old snapshots are
  replaced once. Rule: `.claude/rules/dashboards.md`.
- ✅ S783 — The purchase Target was still one flat daily average. It now follows the client's own
  buying week, a no-bill day counting as zero (CASA: Sunday restock ~12,800, Saturday ~2,350), and
  deliberately does not follow the sales curve. The purchase snapshot moved to model 3 and was
  replaced once; the sales Target was left frozen.
- ✅ S784 — The dashed SALES forecast can allow for rain (Growth+). The Owner sets the city and "a
  rainy day sells about N%" in Settings → Weather; MET Norway via the `weather-forecast` Edge
  Function; purchases and both Targets never move. Rule: `.claude/rules/dashboards.md`.
- ✅ S784 — `weather-forecast`'s signed-in path, unexercised at ship, confirmed live the same day:
  CASA ACAI CAFE set Kathmandu at 50%, and the first dashboard load wrote a `weather_locations` row
  with `last_error` NULL and ten `weather_daily` rows (today incomplete, the nine days ahead complete).
- ✅ S785 — the header strip's high/low, cloud and thunder, unobserved at push, confirmed live
  2026-09-24: every Kathmandu and Pokhara row carries them, `last_error` NULL on both, and CASA's
  strip matched the stored rows (S786 moved the strip to POS and HR too).
- ⚪ **The Target's weekday averages still count past public holidays.** Demand Forecast
  (`DemandForecast.js`, D21) leaves them out and applies Holiday Calendar multipliers. Here, a
  Dashain Saturday in the 4-week window lifts the Saturday target for the next month, and a big
  pre-festival restock lifts that weekday's purchase target the same way. A holiday in the open
  month is not marked either. Candidate: read the same Holiday Calendar and exclude
  those days in `historyWindowDays()`.
- ✅ S756 — `Stock.js:709-727` Save All writes/deletes every visible row (parallel tablets wipe each other; restamps counted_by; recount guard refuses) → send changed cells only.
- ✅ S756 — `Stock.js:549-586` offline replay into closed period (with D1).
- ✅ S756 — `Stock.js:810,242` bare selects (pull-from-last-month, items).
- ✅ S756 — `computeMonthlyReport.js:58,77-84` six bare selects inside the frozen snapshot.
- ✅ S756 — `Stock.js:944-951,1163` Summary purchases at master rate, no discounts; wrong "exactly" note.
- ✅ S756 — `closePeriod.js:78-88` counted-vs-active mismatch.
- ✅ S756 — `Purchases.js:383-399,703` Item filter values half a bill (negative totals).
- ✅ S756 — `vendorBalanceHelpers.js:83-87` legacy-bill discount multiplied.
- ✅ S756 — `PurchaseBillForm.jsx:358` discount unvalidated; `:292` Save live after save → duplicate bill.
- ✅ S756 — `ReturnsTab.jsx:67` return dated before its bill; `OutstandingPayables.js:396` silent overpay cap.
- ✅ S756 — `persistSalesDay.js:43-49` unpaged supersede check → silent month delete.
- ✅ S756 — `Sales.js` save against stale day/period baseline (3 windows) → capture `{periodId, bsDay}` at click.
- ✅ S756 — `Sales.js:348-373` unit_price restamp (D8).
- ✅ S756 — `persistSalesDay.js:186-191` cross-mode supersede leaves stock_movements (double depletion); `:170` huge `.in()` / unpaged.
- ✅ S756 — `SalesImportButton.jsx:6-9,40` `1,250.00`→1; `Disc %` picked as amount.
- ✅ S756 — `Sales.js:635` From-POS revenue at today's price; `:225` unpaged day read; `:676` admin closed-month banner.
- ✅ S756 — `Recipes.js:1896` list-view errors render nowhere (Delete/Hide refusals invisible).
- ✅ S756 — `Recipes.js:1469…`, `RecipeCostCardPrint.jsx` no-ingredient recipe shows `0.0% ✓` → `recipeCostOf`/`menuFcPct`.
- ✅ S756 — `Recipes.js:703` update re-activates hidden dish.
- ✅ S756 — `Recipes.js:899,906,907` dropped write errors (mirror link).
- ✅ S756 — `.neq('source','pos_comp')` drops NULL rows: `Recipes.js:227`, `MonthlySummary.js:74`, `AnnualSummary.js:109`, `PeriodComparison.js:166`.
- ✅ S756 — `MenuPricing.js:350,403` null category crash (ask branch before editing — POS-only branch).
- ✅ S756 — `RecipeImportButton.jsx:29` Selling Price column is ex-VAT, unlabelled.
- ✅ S756 — `Variance.js:51-53` total band NPR ÷ mixed quantities; `:210-248` flag vs band disagree.
- ✅ S756 — `ShrinkageReport.js:211,217` uncounted = zero; no tolerance/materiality.
- ✅ S756 — `PeriodComparison.js:153-166` includes inactive + sub-recipe mirror items.
- ✅ S756 — `BudgetVsActual.js:52,142` budgets typed with no open period silently discarded.
- ✅ S756 — Superseded load clears `loading`: `Variance.js`, `TheoreticalVariance.js`, `MonthlySummary.js`, `BudgetVsActual.js`; `init()` never `begin()`s on those four + `StockReport.js:39`.
- ✅ S756 — `TheoreticalVariance.js:532` footer includes unmeasured rows.
- ✅ S756 — `AnnualSummary.js:72` request key collides calendar/FY.
- ✅ S756 — `BudgetVsActual.js:275` negative actual renders `—`.
- ✅ S756 — `DeadStock.js:170` float equality; `:76` defaults to open month.
- ✅ S756 — `FifoReport.js:40`/`StockAgeing.js:43` as-of = end of last month while it is still open (expired shows green).
- ✅ S756 — `FifoReport.js:178`/`StockAgeing.js:195` returns against out-of-window bills lost; `StockAgeing.js:398` 90+ card ✓.
- ✅ S756 — `DemandForecast.js:122` past days listed as "next 7"; `:159` dropped error; `:177` horizon switch mid-recompute.
- ✅ S756 — `purchaseTaxSplit.js:42-43` unlinked returns vanish from VAT/Non-VAT (input VAT overstated) → partition + named banner.
- ✅ S756 — `VatReport.js:297` on-screen per-line VAT pre-discount vs workbook post-discount.
- ✅ S756 — `PurchaseOneLakhAboveReport.js` no letterhead/scope; `:46` infinite Loading with no periods; `:67` error before isCurrent.
- ✅ S756 — `AssetCard.jsx:32` disposal gain/loss from dropped read; `FixedAssets.js:43` both reads drop errors (Post from zeros).
- ✅ S756 — `Overheads.js:93,110,520` Save during load deletes the wrong period's rows; no `useLatestRequest`.
- ✅ S756 — `Overheads.js:195` purchases ignore bill discounts; `:406` hardcoded traffic light; `:137` carried-forward draft unlabelled; `:317` blank-category row totalled then dropped; `:196,207` unpaged.
- ✅ S756 — `taxPoolCompute.js:242` AD parsed as UTC → wrong tier abroad; `DepreciationRunTab.js:70` override unbounded; `TaxPoolTab.js:63` repair outside FY.
- ✅ S756 — `GatePasses.jsx:91` reprint never awaited; `:34-62` failed reads/writes dropped; `:48` viewer-clock sweep; `:81` no `exited_by`; `:35` unpaged; `GatePassPrint.jsx:12` locale date.
- ✅ S756 — `ImsCountLogin.jsx:122-130,208` every failure = "Incorrect PIN"; bad secret = "no PINs set up".
- ✅ S756 — `Items.js:593,624`, `Vendors.js:181,230,294,306` zero-row writes report success.

### 2e. Frontend — report hygiene (S728/S616/S754 rules)
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — Export/print not gated on `loading || loadError`: ReorderReport (Export has no `disabled`), TheoreticalVariance, PeriodComparison, AnnualSummary, MonthlySummary, BudgetVsActual, VatReport, NonVatReport, 1L, SupplierContribution, StockAgeing Print.
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — Exports not gated on `biz.error`: VAT, Non-VAT, Vendor, SupplierContribution, 1L, DeadStock, FIFO, StockAgeing.
- ✅ S756 — `ReorderReport.js:455` KPI strip visible during load; `:525` "Stock is healthy" with no pars.
- ✅ S756 — Hand-built sheets without `sheetWithLetterhead`: Variance, TheoreticalVariance, AnnualSummary (money as text), DemandForecast, 1L.
- ✅ S756 (VendorReport/SupplierContribution finished in stage 3) — `provisionalWhenOpen` missing on VatReport, NonVatReport, VendorReport; stale tooltips (# Bills, "Gross"); VAT export disabled on returns-only months.
- ✅ S756 — `counted_by` shown nowhere; `Stock.js:885` retyped `computeUsed`; `Stock.js:1369` locale date.

---

## 3. From the S765 design critique (`/impeccable critique ims module`, 29/40)

Snapshot: `.impeccable/critique/2026-09-16T07-48-04Z__src-modules-ims.md`. Everything in the P0/P1/P2
tiers shipped in S765; what is listed here is only what did not.

- ✅ S765 — The touch stock-count screen was gated on `window.innerWidth < 768`, exactly
  iPad-portrait width, so NO tablet had ever reached it. Now `(pointer: coarse)`.
- ✅ S765 — The count card's "done" cue fired on keystroke, so typed and saved looked identical on a
  shared tablet. Four states now, each carrying a word as well as a colour.
- ✅ S765 — `Tabs`/`FilterChips` (`src/components/Tabs.jsx`): `aria-controls`, `role="tabpanel"` and
  roving `tabIndex` each appeared ZERO times across the module; 15 of 24 chip rows had no
  `aria-pressed`.
- ✅ S765 — Sales Entry's KPI strip rendered 95 lines above its own `loading` guard, so `NPR 0` in the
  accent stayed painted above "could not load" on the revenue denominator for every food-cost figure
  in the product. Overheads' bucket cards claimed "Not entered yet" during every load.
- ✅ S765 — Outstanding Payables' bill drilldown was a frozen `rgba(10,12,18,0.7)`, ~2.0:1 on
  Modernist Light, plus seven sibling literals.
- ✅ S765 — Eight live `window.confirm` and one `alert()`, including the stock-shortfall warning.
- ✅ S765 — `ClosedPeriodBanner`: five copies, four byte-identical and one already drifted.
- ✅ S765 — The `.impeccable/config.json` `26px` ignore carried no `files:` key, so it suppressed that
  size product-wide while its reason named one print template.

**Open after S765:**

- ⚪ **`26px` outside IMS is still off-ramp** — `PosLogin.jsx`, `GuestMenu.jsx`, `Pricing.js` (×3),
  `Settings.js`, `ClientDrawer.js`, `ArrivalAlert.css`. Left deliberately: these are brand-facing
  surfaces where a type size is a design decision, not a cleanup, and they were outside the scope of
  an IMS critique. Note the detector cannot see most of them anyway (next item).
- ⚪ **The design detector reads only a QUOTED font size.** Probed in S765: `fontSize: '26px'` is
  flagged, `fontSize: 26` is not — and this codebase is ~3,450 inline style blocks. Measured across
  1,233 numeric sizes in IMS, exactly one was off-ramp, so IMS is clean behind the blind spot; the
  rest of the product has not been measured this way.
- ⚪ **`tabular-nums` does not reach the 13 hand-rolled `<table>`s**, including the purchase-bill line
  table — the product's most-used money entry form renders in proportional figures. `Layout.css`
  scopes the rule to `table.data-table td` and `.stat-value`.
- ⚪ **Three report pages still have no empty branch at all** — `PaymentReport`, `Overheads`,
  `BudgetVsActual` — and seven more hand-roll one instead of `.empty-state`.
- ⚪ **Stock Count, Overheads and Requisitions still render no closed-period banner**, which
  `closed-periods.md` has flagged since S651. `ClosedPeriodBanner` now exists for them. Stock Count's
  half, and its real consequence, is S792 STOCK-5 (a closed-month correction never reaches next
  month's opening stock).
- 🔵 **The Starter tier's nav deletes locked rows rather than upselling** — raised by the critique as
  an inconsistency with the Crest Suite group, which stays visible with a PRO chip. Settled as
  deliberate (owner decision, 2026-09-16) and recorded in `.impeccable/critique/ignore.md` so a
  future critique does not re-raise it. The group-LABEL question is explicitly left open there: a
  "Costing" group whose only surviving member is a price list is a labelling problem that survives
  the decision.
