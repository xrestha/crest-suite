---
paths:
  - "src/shared/imsFormulas.js"
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/reports/**"
  - "src/modules/ims/summary/**"
  - "src/pages/Settings.js"
  - "src/modules/ownerReport/computeMenuEngineeringSection.js"
---

# The IMS figures that must come from one place

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### The IMS figures that must come from one place (S551)

`src/shared/imsFormulas.js` exists because two figures had drifted into several disagreeing copies, and both are figures the product is sold on.

- **COGS / "used".** Nine pages printed the formula nine ways, four of them contradicting the code directly beneath them, and two pages genuinely computed it differently: `AnnualSummary` left Staff Meals out while `MonthlySummary` included them — same month, same column label, two numbers. The decision (2026-08-13) is that **staff meals are in COGS** — the food came out of the same stock. Import `COGS_FORMULA` wherever the formula is *printed* and `computeUsed()` wherever it is *computed*, so the sentence can never drift from the arithmetic again. Any figure that values stock must still carry `.eq('is_active', true)` (S436) — that rule is unaffected.
- **Food cost % banding.** `fcBand(pct, settings)` reads the client's `fc_warning_pct`/`fc_critical_pct` and returns the `*-text` contrast variants. Five files each carried their own hardcoded `≤30 : ≤38 : else` copy, which disagreed with the very filter pills the user had just clicked. **`MenuEngineering.js`'s `FC_CUTOFF = 35` classification is deliberately NOT routed through this** — `computeMenuEngineeringSection.js` mirrors `classify()` verbatim for the frozen Monthly Owner Report, so changing it would silently desync a snapshot from the live page it must agree with. Its colours use `fcBand`; its maths does not.

**A settings field with no reader is worse than no field.** `variance_flag_pct` shipped with a hint saying the Variance Report used it, and nothing read it (the report hardcoded 10). It is wired now; when adding a threshold to `Settings.js`, grep for a consumer before shipping it.

**Stock Count's Summary tab holds two tables that must reconcile, and four separate things had broken that (S567, found auditing before a real month close).** The category rollup and the item-level table are built from *different loops* — the rollup over `categories`, the table over `items` — so any item the rollup's loop cannot claim silently drops out of the Totals a month gets closed on while still appearing below. That was true of every item with `category_id = NULL` or a stale category id; there is now an `Uncategorised` group, rendered only when non-empty. The same class of divergence produced three more: the item row printed wastage as the catch-all only while `getUsed()`, the rollup and the Excel export all use **catch-all + daily** (so the row visibly did not add up wherever Daily Wastage was used); `hasData` tested opening/closing/purchases only, blanking Used/COGS for an item carrying just waste — exactly the shape that goes negative — and skipping it in `saveAll`'s negative-usage guard; and `staff_meals` was read across both `type` values while `persistValueDirect` deletes and reinserts only `type='staff'`, so a single `'comp'` row would have displayed a figure the tab cannot edit and doubled it on the next save. **Before adding a figure to either table, add it to both and check they still tie out** — nothing on the page cross-checks them, and each of these read as a plausible number.

Two standing notes for this page specifically:

- **Every period-scoped read here is now `fetchAllRows`-paged**, not just `purchase_entries` (which is all the S529 sweep had wrapped). The 1000-row cap matters more here than anywhere else in IMS: a truncated read produces a believable COGS rather than an error, and this is the page a period is closed from. `wastages` is the one that realistically crosses it — daily entries are one row per item per day — while `opening_stock`/`closing_stock` are one row per item and would only bite a client past 1000 items.
- **Stock Count includes sub-recipes; `MonthlySummary.js` excludes them** (`.eq('is_sub_recipe', false)`). Both are deliberate — Stock Count physically counts prep — but it means the two pages' COGS for the same month differ by exactly the sub-recipe amount, with nothing on either page saying so. Left as-is; if this is ever reconciled, it is a product decision about which figure "COGS" names, not a bug fix.

**Variance-style reports must default to a CLOSED period.** Closing stock is counted at month end, so on an open period `closeQty` is 0 for every item, "actual used" becomes everything on hand plus everything bought, and the page paints a red "potential loss" figure on a month that structurally cannot have one. `Variance.js`/`TheoreticalVariance.js` now default to the most recent closed period and, if an open one is selected anyway, say the count is missing and render the figures neutral and unflagged rather than hiding them. `ShrinkageReport.js` and `ReorderReport.js` already did their own version of this.
