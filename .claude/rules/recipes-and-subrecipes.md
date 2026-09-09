---
paths:
  - "src/utils/recipeCost.js"
  - "src/modules/ims/recipes/**"
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/sales/salesDepletion.js"
---

# Sub-recipe mirror items, nesting, and the two cost engines

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### Sub-recipe mirror items

Recipes with `type = 'sub_recipe'` auto-create a mirror row in `items` with `is_sub_recipe = true`. Filter these out of Item Master, Purchases, POs, Requisitions, Reorder Report, and Supplier Price Tracker:

```js
.eq('is_sub_recipe', false)
```

**A mirror shares one name space with the real item book (S707).** `items` carries
`items_client_name_key` — `UNIQUE (client_id, lower(name))` — and it deliberately covers mirror rows
rather than being scoped to `is_sub_recipe = false`. The reason is the tab below: **Stock Count does
not filter `is_sub_recipe`**, so a mirror and a real item sharing a name are two rows in the same
count, splitting that ingredient's stock between them exactly as two real items would. Item Master's
own duplicate check could never see this — it reads an array `loadItems` has already filtered the
mirrors out of — which is why the constraint had to go in the database.

The cost lands here and is accepted: a mirror's name is **re-derived from the recipe on every save**,
so a mirror the S707 dedupe pass renamed to `…-DUP2` fails its next recipe save until someone
resolves the clash. `Recipes.js` therefore checks both directions before writing and words the
23505 itself (`DUP_MIRROR_MSG`), saying which side already holds the name — an item is renamed in
Item Master, a sub-recipe here. Use `.eq('name', …)` for that pre-check, never `.ilike`: a name is
free text and `%`/`_` in it are LIKE wildcards, so a pattern would match the wrong rows on anything
called `50_KG BAG`.

**A sub-recipe can never appear in `stock_movements`, and that is structural rather than an omission.** `recipe_ingredients` stores a sub-recipe as `sub_recipe_id` with **`item_id` NULL**, so `explode()` in `recipeCost.js` always recurses past it and only emits a row on reaching a real `item_id` at the bottom of the tree — the prep layer is a scaling step that gets discarded, and the table has no column for the path a depletion took. Stock Movements' **Sub-Recipes tab** (S528) therefore *derives* that layer at read time (`subRecipeUsage.js` → `explodeRecipeTree`), filtered through the shared POS-supersedes-manual rule in `salesDepletion.js` so it agrees with the ledger beside it. Do **not** "fix" this by writing sub-recipe rows into `stock_movements`: the mirror item carries its own `per_uom_rate`, so those rows would double-count the page's own Value Depleted KPI against the raw-item rows already there. The two tabs are the same ingredients at different grains and are never additive.

**Sub-recipes nest — a sub-recipe may contain another sub-recipe, to any practical depth (S602).**
This was already true and needed no new feature: the ingredient picker excludes only the recipe
being edited (`Recipes.js`'s `subRecipeOptions`), `calcSubRecipeCostPerUnit()` recurses, and
`explodeRecipeTree()` walks the whole tree. Indirect cycles (A contains B, then B is edited to
contain A) are refused at save time by `Recipes.js`'s `wouldCreateCycle`.

Two things were wrong the moment a third level existed, both fixed:

- **A cycle guard must be a PATH set, not a visited set.** `calcSubRecipeCostPerUnit`'s `seen` only
  ever added, so the second branch of a DIAMOND — `Sauce → Roux → Stock` and `Sauce → Stock` — found
  `Stock` already "seen" and costed it as **0**. A base used by two branches is not a cycle; it is a
  base used twice and must be paid for twice. `seen.delete(id)` on the way out is the whole fix, and
  it is covered by `recipeCostCalc.test.js` ("costs a shared base once per branch") — which returns
  40 instead of 140 if the delete is removed. Note this made the two engines **disagree**:
  `explodeRecipeTree()` has no seen set at all (only a depth cap), so it always counted the shared
  base twice, meaning the printed cost card and the COGS/Variance figures for the same recipe were
  different numbers with nothing on either page saying so.

  **Stating the rule did not stop it recurring — a fourth copy of the walk did (S713).** The fix
  above landed in `recipeCostCalc.js`, and this file said so, while `MenuPricing.js` quietly kept a
  private `subCostPerUnit()` that was still the pre-fix visited-set shape. It was the last private
  copy in `src/`, and being private is precisely why it never received the fix: a rule about how to
  write the guard only reaches the guards someone opens. **There are two sub-recipe cost walks and
  there must never be a third** — `calcSubRecipeCostPerUnit` (pure, sync, hand it the recipes with
  their `recipe_ingredients` attached) and `explodeRecipeTree` (async, reads Supabase). If a page
  has its ingredients in some other shape, reshape the ingredients, not the walk; Menu Pricing now
  stitches its separately-fetched rows back onto the sub-recipes and calls the shared one. Grep
  `subCostPerUnit|function subCost` before adding any recipe-costing page — it should return
  nothing.
- **Running out of depth was silent.** `explodeRecipeTree`'s frontier loop stops when its round cap
  is hit and simply returns what it has, so ingredients below the cut vanish from COGS and Variance
  as a believable smaller number. The cap is now `MAX_DEPTH_ROUNDS = 12` (was 5) and an exhausted
  frontier `console.error`s with the unresolved ids and the direction of the error.
- **A failed READ was silent too, and it is not any more (S695).** Both reads inside
  `explodeRecipeTree` dropped `error` and walked an empty tree, so every consumer's usage came out
  as zero — Stock Report's on-hand climbed to opening + purchases, Variance read as fully
  under-consumed — with no banner anywhere. It now `throwFirstError`s; every page-level caller
  wraps it and routes to its own `setLoadError`, the dashboards flag their section, and the write
  paths already ran it inside a try/catch. A new caller must catch it. Detail in `ims-figures.md`.

**Two different sub-recipe counts exist and both are correct** — a recurring "why don't these match" question. `Recipes.js:177` counts the **master list** (`category === 'Sub-Recipe'` over an unfiltered fetch: no period, no usage, not even `is_active`), while Stock Movements' Sub-Recipes tab counts only what a **period's sales actually consumed**. The difference is prep items nothing sold touched, surfaced explicitly on that tab ("9 of your 57 …") rather than left to a cross-check. The one case where they genuinely cannot reconcile: a recipe referenced via `sub_recipe_id` whose own `category` was never set to `'Sub-Recipe'` — counted by the walk but not by the category filter, so used + unused would exceed the master total. That is a data-entry problem on the recipe, and the tab names the offenders instead of silently producing numbers that don't add up.

## The walk is a PAGED read, and its seed list is the client's whole recipe book (S711)

`explodeRecipeTree`'s two reads and `computeRecipeCosts`' two reads all go through
`fetchAllRowsChunked` with `.order('id')`. They are not optional wrappers on this walk in particular,
because of what seeds it: **`Variance.js` passes every recipe the client has** — `scopedFrom('recipes',
'id')`, unfiltered — so the `recipe_ingredients` read is one row per ingredient across the entire
book. At ~120 recipes averaging 8 ingredients it is already past PostgREST's 1000-row cap, and the
`.in()` id list is past what a proxy accepts not far above that.

**The direction of the error is what makes it dangerous.** Rows past the cut are absent, so the
dishes below them explode to nothing, theoretical usage comes out LOW — and a missing theoretical
usage does not read as missing. It reads as **over-consumption**: false variance flags, overstated
shrinkage, understated reorder need, understated COGS on both dashboards and in the frozen Monthly
Owner Report. Nothing errors and no array looks short.

**Test it with a fixture that crosses the cap inside ONE chunk.** `fetchAllRowsChunked` splits at
150 ids, so 1200 one-ingredient recipes prove only that the chunking works; 200 recipes × 8
ingredients puts 1200 rows in the first chunk and exercises the paging. `recipeCost.test.js`'s stub
truncates at `SERVER_MAX_ROWS` silently, exactly as PostgREST does, so the test reproduces the bug
rather than agreeing with whatever the code happens to do. A stub that resolves at `.in()` will pass
every assertion in the file while the real client truncates.

## Deleting a recipe: what refuses, what cascades, and what does not care (S711)

Seven things reference `recipes` and — as with `items` in S706 — they do not agree on what a delete
means, while the calling code cannot see the difference:

| Reference | On delete | Consequence |
| --- | --- | --- |
| `sales_entries.recipe_id` | plain FK | **refuses** |
| `recipe_ingredients.recipe_id` | CASCADE | ingredient rows go with the recipe |
| `recipe_ingredients.sub_recipe_id` | plain FK | **refuses** (checked by name in `deleteRecipe`) |
| `demand_forecast_daily` | CASCADE | forecast rows go |
| `recipe_suggestions` (both cols) | CASCADE | pairing rows go |
| `pos_kot_removals.recipe_id` | SET NULL | audit row survives, orphaned |
| `pos_order_items.recipe_id` | **no FK at all** | bill lines silently point at nothing |

**Order the delete so nothing irreversible runs before the step that can still be refused.**
`deleteRecipeNow` used to clear `recipe_ingredients`, deactivate the mirror item, and only then
attempt the recipe — so every dish that had ever sold hit the `sales_entries` refusal with its
ingredient list already destroyed, and the recipe stayed on screen looking untouched. The recipe row
goes first now; the CASCADE takes its ingredients in the same transaction, and a refusal leaves
everything intact. Same rule as `PurchaseOrders`' S709 fix: **delete through the cascade rather than
hand-rolling one in two round trips that can stop between them.**

The pre-check counts `sales_entries` and `pos_order_items` up front and points at **Hide** — the
soft path is on the same row and loses nothing, since past sales keep their figures either way.

## A sub-recipe ingredient row always inserts fresh, so a failed prune doubles it (S711)

`save()` upserts the new ingredient list before deleting the old rows (S375, so a failed insert never
leaves the recipe empty), then deletes `not('id','in',(newIds))`. That delete's error was dropped.

Item rows survive a failed prune harmlessly — `onConflict: 'recipe_id,item_id'` updated the existing
row rather than adding one. **A sub-recipe row has `item_id` NULL, never matches that conflict
target, and therefore always inserts a new row**, so a silent failure leaves the recipe holding both
copies and costing twice as much, on this page and in COGS, with the save having reported success.
The message names that state and says saving again clears it, which is true because the next
successful prune removes the extras.

**The same asymmetry is why duplicates are refused before the write.** Two rows with the same
`item_id` make the single upsert statement fail with `21000` (*ON CONFLICT DO UPDATE command cannot
affect row a second time*), and two rows with the same `sub_recipe_id` do not fail at all — they
save and double-count. Neither is caught by the picker, which lists every item regardless of what
the recipe already holds.

## `calcLiveCost` resolves against the `items` array, so what that array excludes costs nothing (S711)

`items` is loaded WITHOUT an `is_active` filter, and the filter lives on `itemOptions` instead. The
filter used to be on the read, and `calcLiveCost` returns 0 for any ingredient it cannot find in the
array — so an ingredient whose item had been hidden in Item Master cost **nothing** in the edit form
while the detail view, which reads the joined `ri.items` row and applies no filter, cost it in full.
Two numbers for one recipe on two screens one click apart, with the cheaper one on the screen you
set the price from.

Deactivating an item does not stop recipes consuming it — that is the whole reason Item Master
offers Hide as the safe alternative to Delete. The picker still offers only active items to ADD, and
keeps a hidden one visible and labelled where the recipe already uses it, so the choice to keep or
replace it is the user's rather than being made by a silent zero.

**Generally: when a helper resolves an id against a list and falls back to zero, the list's filter
is part of the arithmetic.** Load the superset and filter at the point of choice.

## `getSuggestedPrice` returns a VAT-INCLUSIVE figure (S711)

`cost / targetFcPct × (1 + vat)`, rounded up to the nearest NPR 5. On the detail view it sits two
tiles from "Selling Price (ex. VAT)", so unlabelled the two read as directly comparable and the
suggestion looks ~13% higher than it is — it is the counterpart of "Menu Price (incl. VAT)" beside
it. Every label that prints it says `(incl. VAT)`: the detail view, the edit form's live panel and
the printed cost card.

**`yield_qty` is NOT part of a dish's cost, and that is correct.** No engine divides by it for a
non-sub-recipe, and the Yield Quantity field renders only on the sub-recipe branch of the form —
where its tooltip's "cost per unit = total cost ÷ yield qty" is exactly what
`calcSubRecipeCostPerUnit` does. A recipe converted away from Sub-Recipe keeps its old batch yield
in the column; it is inert, and resetting it would destroy the value if it were converted back.

---
