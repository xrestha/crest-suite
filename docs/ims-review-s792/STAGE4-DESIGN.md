# S792 Stage 4 — designs for D32, D40, D37

Stage 4 is "design first, shown before building" (`IMS_TODO.md` §S792.5). Each section has the
problem, the design, what it touches, and the questions the owner still has to answer. Nothing here is
built yet. **Owner answers (2026-09-29): all seven recommendations accepted** — Q1 (a), Q2 yes, Q3 yes, Q4 (a), Q5 yes, Q6 (a), Q7 yes. Line numbers are as of commit `81d6619`.

---

## D32 — PAN-bill outlet: supplier VAT counts as food cost

### Where things stand
- Every purchase figure in IMS is ex-VAT. `purchase_entries.rate` is the ex-VAT rate; `vat_inclusive`
  means "13% is charged on this line". VAT is always derived (`calcBillTotals`, `purchaseTaxSplit.js`).
- IMS never reads `is_vat_registered` for purchases (only the menu-price screens, via `vatModeOf()` in
  `recipes/menuPriceVat.js`). So on a PAN-bill outlet, food cost reads ~13% low on every VAT-billed
  purchase, and `VatReport.js` calls VAT the outlet can never recover "claimable" (:449, :454, :507, :679).
- Item Master's price comes from the bill's ex-VAT rate (`PurchaseBillPage.jsx:255-271`).

### The trap that shapes the design
COGS = opening + purchases − closing. Opening and closing are valued at `items.per_uom_rate`;
purchases at the bill line. **If only purchases gain the 13%, COGS absorbs the VAT on stock still on
the shelf, and it never flows back through closing stock.** So the VAT must be in the item's price too:
one basis for purchases, stock, wastage, staff meals, recipes and FIFO.

### Design
1. **Per-bill cost basis, stored, not read live.** New column `purchase_entries.vat_is_cost boolean
   NOT NULL DEFAULT false`, set by `save_purchase_bill` from `settings.is_vat_registered` at save time.
   Readers use the row, never the current switch, so flipping the switch does not re-value past bills
   (D29: history does not change).
2. **One helper.** `allocateBillDiscounts` (`supplierAttribution.js:51`) returns `lineCost` beside
   `lineNet`: `lineNet × (vat_inclusive && vat_is_cost ? 1.13 : 1)`. Every cost reader switches from
   `lineNet` to `lineCost`:
   - `periodCost.js`, including its returns, which take the original line's basis;
   - the pages with their own copy: AnnualSummary, PeriodComparison, BudgetVsActual, ClientDashboard,
     OwnerDashboard, Stock.js COGS, SupplierContribution, VendorReport purchasing;
   - FIFO and Stock Ageing;
   - `get_group_pnl` (SQL mirror, by hand).
3. **Item Master price includes VAT on a PAN outlet.** When a VAT-ticked line on a `vat_is_cost` bill
   moves the master price, it writes `rate × 1.13`. Stock value, recipes, variance and requisitions
   then follow with no further change. Price Tracker's typed price is labelled "price you pay, VAT
   included".
4. **Existing items: a one-time review banner**, like `PanPriceBanner`. On a PAN outlet it lists items
   whose latest bill line carried VAT and whose master price is still ex-VAT. "Update to the price you
   paid" re-values stock and recipes, so the D5 confirm names what moves.
5. **Tax reports keep their figures.** The VAT, Non-VAT and 1-lakh reports and payables stay on
   `lineNet` plus the 13% split, because what the supplier billed does not change. On a PAN outlet only
   the wording changes: "VAT paid to suppliers — not claimable, counted in food cost". The "Actual cost
   basis" card and the Purchases.js "excluding VAT" tooltips switch on `vatModeOf`.

### Scale
One migration: the column and backfill, `save_purchase_bill`, and `get_group_pnl`. About 20 source
files. It would be built by parallel agents over disjoint files, as stage 3 was.

### Questions for the owner
- **Q1. Existing bills.** (a) Backfill `vat_is_cost` on bills in the **open month only**. Closed months
  keep ex-VAT purchases, and the Owner Reports already made stay as they are. **Recommended.**
  (b) Backfill every bill, which restates closed months on the live pages so they disagree with the
  frozen Owner Reports. (c) New bills only.
- **Q2. Switch flipped later** (the outlet registers for VAT). New bills follow the new setting, and
  the banner in step 4 runs in reverse ("remove the 13% from Item Master"). Recommended: yes.
- **Q3. Accountant check.** TAX.md recommended asking an accountant before counting VAT as cost. D32
  has decided it, so should Help carry a line saying so, as D10 and Pool E do? Recommended: yes.

---

## D40 — opening pool WDV and "depreciation already taken"

### Where things stand
- There is nowhere to store an opening figure. `TaxPoolTab.js:197` gives
  `openingWdv = prior ? prior.closing_wdv : 0`. With no prior-year run, every pool opens at 0, and
  stage 2 only added a warning (COSTS-5).
- `depreciationCompute.js`: an asset with no posted rows opens at `total_cost`, and the first run
  charges from `acquisition_date`. An asset bought in 2075 depreciates from full cost again (COSTS GAP 1).

### Design — per asset
- Two columns on `assets_register`:
  - `opening_accumulated_depreciation numeric NOT NULL DEFAULT 0` (≥ 0, and plus salvage ≤ cost, by CHECK);
  - `opening_as_of date` (required when the amount is > 0; on or after `acquisition_date`).
- Asset form: an "Already in use before Crest?" section with "Depreciation already taken" and "as of"
  (from last year's books), and a Tip.
- The code:
  - `bookValue()` = cost − opening accumulated − posted charges. This one change fixes the Register,
    the Asset Card, Valuation and the next run's opening together.
  - The per-period charge starts after `opening_as_of`.
  - `computeDisposalDepreciation` treats `opening_as_of` as "charged through".
  - Valuation counts the opening amount only on or after its date.
  - The Overheads memo (`depreciationInWindow`) does **not** count it, because it is not this
    period's expense.
- Edits after a posted run warn, following the D5/COSTS-8 precedent (`depreciationInputChanges` gains
  both fields). Already audited, rank-guarded, exported and restored, because it is the same table.

### Design — per tax pool
- New table `assets_tax_pool_openings`:
  `(client_id, pool A–D, fiscal_year text, opening_wdv, repair_carry_forward default 0, created_by, …)`,
  `UNIQUE (client_id, pool)`, so the value is typed once. The fiscal year is the **first year Crest
  computes**, and the value is last year's closing WDV from the filed return.
- `priorPoolRun` uses the typed opening only when no real run exists for FY−1. A real run always wins,
  and an opening dated before the latest posted year is refused.
- Editable until a run is posted for that year; locked after that. The fix is then a correction run,
  as for any posted year.
- Rank: IMS manager, the same as pool runs.
- New-table checklist:
  - RLS plus the three restrictive staff policies;
  - `ims_rank_guard`, `log_audit` and the grant revoke;
  - `CLIENT_SCOPED_TABLES`, `RESTORE_ORDER` (after `assets_register`), both Danger Zone lists and the
    Audit Log label.
- **Pool E (intangibles) takes no typed opening.** It is already scheduled per asset from
  `acquisition_date`, so a pool figure would double-count. The per-asset "already taken" figure feeds
  its cumulative instead.

### Scale
One migration: the two columns, the new table and its policies. About 8 source files plus
`admin-user-ops`.

### Questions for the owner
- **Q4. Lock or warn** once a posted run has used the pool opening? (a) Lock, and correct with a
  correction run. **Recommended.** (b) Stay editable with a warning naming the posted years that will
  not move.
- **Q5. Pool E** takes per-asset "already taken" only, with no pool figure. Recommended: yes.

---

## D37 — a second count of an already-counted item: "replace, or add yours?"

### Where things stand
- Every count write is a plain PostgREST upsert on `(period_id, item_id)` from `Stock.js`: the single
  cell at `persistValueDirect` :683, and Save All at `persistValuesBulk` :1193. The second tablet
  silently replaces the first.
- The counting tablet is the same page under a PIN login. `counted_at` is the browser's clock; there is
  no `updated_at`.
- With recount protection on (`settings.require_count_attribution`, trigger
  `closing_stock_guard_recount`), a staff counter is refused outright.

### Design
1. **A server RPC does the check and the write together.**
   `save_closing_counts(p_period, p_rows jsonb)`, where each row is
   `{item_id, qty, mode: 'check'|'replace'|'add', seen_qty, seen_by}`.
   - It locks each row `FOR UPDATE`.
   - In `check` mode, if the stored row differs from what this screen saw and was counted by someone
     else, it writes nothing for that item and returns `{item_id, qty, counted_by_name, counted_at}` as
     a conflict.
   - `add` is atomic: `physical_qty = closing_stock.physical_qty + p_qty`, so two tablets adding at once
     both land.
   - It is **SECURITY INVOKER**, so section-scope RLS, the closed-month lock and the counter stamp keep
     applying unchanged.
   - It handles one cell and Save All (conflicts come back as a list). Blank-cell deletes stay as they
     are.
2. **When the prompt shows.** Either the server row changed since this screen loaded it and was
   counted by someone else, or the screen already showed someone else's count and I am typing over it.
   My own recount never asks.
3. **The dialog** (a small `Modal`, because `ConfirmModal` has only two buttons):
   "Ram already counted **12 kg** at 10:42. You counted **8 kg**."
   The buttons are **Add yours (= 20 kg)**, **Replace with 8 kg** and **Cancel**. Save All shows one
   list with a choice per item.
4. **The server stamps `counted_at`** with `now()` in the existing stamp trigger, so "at 10:42" is
   true, not a tablet's clock.
5. **Offline.** A queued count also stores what the screen showed (`seen_qty`, `seen_by`). On replay a
   conflict is **held**, following D38's pattern, in a list with Add / Replace / Discard per figure,
   naming whose figure was queued. Ops queued before this ships carry no baseline and replay as today.
6. **Who counted.** A new `count_parts jsonb` column records `[{by, name, qty, at}]`. A replace resets
   it and an add appends to it. The page shows "Ram 12 + Sita 8". `counted_by` stays the last writer.

### Scale
One migration: the RPC, `count_parts`, the stamp trigger and the guard carve-out. Files:
`Stock.js`, `offlineQueue.js`, a new dialog component, `errorText.js` and Help.

### Questions for the owner
- **Q6. Recount protection on: may a staff counter *add*?** (a) Yes. Adding keeps the first figure
  and names both people, and replace stays refused. **Recommended.** The guard gains a
  transaction-marker carve-out like `crest.po_receipt`. (b) No; staff are refused as today.
- **Q7. Keep both names** (`count_parts`)? Recommended: yes. Otherwise the first counter disappears
  from the row.

---

## Order of building
**D37 → D40 → D32.** D37 is the smallest and self-contained. D40 is self-contained within Fixed Assets.
D32 touches every COGS reader and the group SQL, so it goes last, with its own review pass. Each ships
as its own session entry and migration, after the answers above.
