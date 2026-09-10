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

**And neither are the ROWS within the Sub-Recipes tab (S721)** — which is the half that sentence
did not cover, and it shipped as a live 2× error. `computeRecipeCosts` is built on
`explodeRecipeIngredients`, so a sub-recipe's cost per batch is **fully exploded**: a parent's
already contains every child beneath it. `explodeRecipeTree` meanwhile threads ONE `subs` array
down the recursion, so `node.subRecipes` is a flat list of every sub-recipe at every depth. Sum
`batches × batchCost` across those rows and a nested prep item is paid for twice — once inside its
parent and once on its own row. On this file's own nested fixture (House Sauce made from Herb Base)
that is NPR 40 against a true raw-ingredient value of NPR 20.

`explodeRecipeTree` now also reports **`topBatches`** — the part the DISH reaches directly, at
depth 0 — and `subRecipeUsage` carries it through as `topValue`, which is what every TOTAL uses.
The per-row `value` is deliberately unchanged, because "what it cost to make this much of it" is a
real figure; the consequence is that the rows do not sum to their own footer, and the footer says
so. **It has to be a per-OCCURRENCE depth, not an "is this ever nested?" flag**: a sub-recipe can
be used directly by one dish AND nested inside another, and only its direct share may be charged.

The general shape is worth naming, because neither half was wrong and both were correctly
commented: **a fully-exploded cost and a flat all-depths list are each individually correct, and
adding them is what is not.** Before summing a column, ask whether its rows are at one grain.

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

  **And the walk was only half of what was private (S714).** Menu Pricing kept costing a sub-recipe
  at **0** after S713, because the LIST it resolves against was still seeded
  `.eq('category','Sub-Recipe')` — so a recipe reached through `sub_recipe_id` whose own category
  had been changed away was absent from `subIdSet`, absent from `subIngMap`, and fell through
  `subCost[id] || 0`. Every other engine resolves a `sub_recipe_id` without consulting the row's
  category and costs it in full, so the same under-statement survived the fix that was supposed to
  end it — same page, same direction, one layer down. It seeds from the whole book now
  (`scopedFrom('recipes', 'id, yield_qty')`, unfiltered) and costs only the ids something actually
  references. **What a `sub_recipe_id` names is decided by what POINTS at it, never by how it is
  categorised**, so any list used to resolve one must be unfiltered — by category, and by
  `is_active` for the reason `toggleActive` already gives.
- **Running out of depth was silent.** `explodeRecipeTree`'s frontier loop stops when its round cap
  is hit and simply returns what it has, so ingredients below the cut vanish from COGS and Variance
  as a believable smaller number. The cap is now `MAX_DEPTH_ROUNDS = 12` (was 5) and an exhausted
  frontier `console.error`s with the unresolved ids and the direction of the error.

  **Raising one cap and not its twin put the silence straight back (S714).** There are TWO depth
  limits in that function — the fetch loop's `MAX_DEPTH_ROUNDS` and `explode()`'s own recursion
  guard, which stayed at a hardcoded `depth > 10` when the loop went 5 → 12. That is the worst
  available disagreement: the loop resolved levels 12 and 13, so the frontier came back EMPTY and
  the loud error could not fire, while `explode()` quietly dropped exactly those levels — the
  silence the fix existed to end, relocated one function down. The recursion guard reads
  `MAX_DEPTH_ROUNDS` now and sets a flag reported once after the walk. `recipeCost.test.js` covers
  an eleven-deep chain and was verified to fail against the old constant. **When you raise a limit,
  grep the function for the other one**: a cap enforced in two places is one number.
- **A failed READ was silent too, and it is not any more (S695).** Both reads inside
  `explodeRecipeTree` dropped `error` and walked an empty tree, so every consumer's usage came out
  as zero — Stock Report's on-hand climbed to opening + purchases, Variance read as fully
  under-consumed — with no banner anywhere. It now `throwFirstError`s; every page-level caller
  wraps it and routes to its own `setLoadError`, the dashboards flag their section, and the write
  paths already ran it inside a try/catch. A new caller must catch it. Detail in `ims-figures.md`.

**Two different sub-recipe counts exist and both are correct** — a recurring "why don't these match" question. `Recipes.js`'s `subRecipes` memo counts the **master list** (`category === 'Sub-Recipe'` over an unfiltered fetch: no period, no usage, not even `is_active`), while Stock Movements' Sub-Recipes tab counts only what a **period's sales actually consumed**. The difference is prep items nothing sold touched, surfaced explicitly on that tab ("9 of your 57 …") rather than left to a cross-check. The one case where they genuinely cannot reconcile: a recipe referenced via `sub_recipe_id` whose own `category` was never set to `'Sub-Recipe'` — counted by the walk but not by the category filter, so used + unused would exceed the master total. That is a data-entry problem on the recipe, and the tab names the offenders instead of silently producing numbers that don't add up.

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

## Converting a sub-recipe away is a delete of the link, and it needs delete's guard (S714)

`deleteRecipe` refuses while other recipes reference the row through
`recipe_ingredients.sub_recipe_id`. Changing the **category** away from `Sub-Recipe` — same recipe,
same screen, a dropdown instead of a button — refused nothing: it deactivated the mirror item,
nulled `linked_item_id`, and left every parent still pointing at it.

**Nothing broke loudly, which is why it survived, and the quiet damage is spread across pages that
each look correct on their own.** The cost engines resolve a `sub_recipe_id` without consulting the
row's category, so Recipe Costing went on costing the parent right. What stopped working was every
surface that seeds its sub-recipe list BY category: the parents' ingredient picker rendered the row
blank (its value was not in `subRecipeOptions`), and Menu Pricing costed the ingredient at **zero**
— see the S714 note above. This write is what manufactured the state those two fixes had to absorb,
so this is the write that refuses. It names the recipes holding it and points at Hide.

The state still exists in data written before the guard, so **the two readers stay tolerant**:
`subRecipeOptions` resolves an already-used row from the full recipe list and labels it
*"no longer a sub-recipe"*, and Stock Movements' Sub-Recipes tab keeps its `miscategorised` list. A
guard added late has to be paired with tolerance for the rows that predate it.

**The cycle guard was gated on the same condition and is not any more.** It ran only
`if (selectedRecipe && recipeForm.category === 'Sub-Recipe')` — so a recipe already converted away
while still referenced could be edited into an indirect cycle with no check at all. What makes a
cycle possible is being *referenced*, which is independent of how the row is categorised; it runs
for any existing recipe now, and returns immediately for one nothing points at.

## The bulk importer had none of `save()`'s guards (S714)

`RecipeImportButton` writes `recipe_ingredients` with a plain `.insert()`, and every rule `save()`
had accumulated stopped at the page.

- **A duplicate ingredient line is refused, per the same asymmetry.** Two lines naming one item make
  the insert fail with `21000` *after* the recipe row is committed; two lines naming one sub-recipe
  fail at nothing and silently double that ingredient's cost. The silent half is the worse half, and
  neither was visible in the preview. The whole recipe is now held back with its status naming the
  ingredient, rather than the duplicate being summed — same reasoning as `save()`: 200g and 50g of
  one item is as likely a typo in one row, and choosing for the user is not the importer's job.
- **A failed ingredient insert deletes the recipe row it just created.** The two writes cannot be
  reordered (the ingredients need the id), so the compensating delete is the only way to leave the
  sheet re-importable — and an ingredient-less recipe is not a neutral leftover: it costs 0, which
  `fcBand` renders as **0.0% ✓ in green** (the S713 rule in `ims-figures.md`). Deleting it is safe
  precisely because it is seconds old; if the delete also fails, the message names the recipe to
  remove by hand rather than claiming the import was clean.

## The mirror item's rate is a SNAPSHOT; every other sub-recipe cost is live (S714)

Decided rather than fixed, and worth knowing before anyone treats it as a bug:

`items.rate` on a mirror row is written **only** by `Recipes.js`'s save, as
`liveCost / yield_qty` at that moment. Nothing recomputes it — not a purchase, not a rate edit in
Item Master, not a change to the sub-recipe's own ingredients through some other path. Meanwhile
`PurchaseBillPage.jsx` rewrites `items.rate` for every raw ingredient on every bill, so the inputs
move constantly and the mirror does not.

That matters because **Stock Count deliberately counts mirrors** (`Stock.js` filters `is_active`
only) and values them at `per_uom_rate` — so a sub-recipe's WIP valuation, the closing stock it
feeds, and therefore COGS all ride on a cost frozen at the last recipe save, while
`calcSubRecipeCostPerUnit` and `explodeRecipeTree` recompute the same sub-recipe live for Recipe
Costing, Menu Pricing and Variance. The two are allowed to disagree and nothing on screen says so.

The snapshot is defensible — it is the cost the batch was actually made at, which is what a stock
valuation wants — and it is the same reasoning as `requisition_lines.rate` and `purchase_entries`
in `ims-figures.md`'s document-versus-report rule. What is NOT settled is that it happens silently
and by omission rather than by decision: there is no "recost sub-recipes" action, and no indication
on Stock Count that a prep item's rate is older than the ingredients under it. Left as-is
deliberately; if it is ever revisited, it is a product decision about what a WIP valuation means,
not a bug fix.

## Every read on this walk is paged, including the ones that only NAME things (S714)

The S711 sweep covered `explodeRecipeTree` and `computeRecipeCosts`. Two reads on the same walk were
left raw and are not any more:

- **`TheoreticalVariance.js` reimplements the recursion locally** (`expandIngredients`) and read
  `recipe_ingredients` for the client's entire book through a bare `.in()`. Being private is exactly
  why it never received the sweep — the same sentence S713 had to write about the cost walk, about
  the read this time. Its truncation is the dangerous direction: dishes below the cut expand to
  nothing, theoretical usage comes out LOW, and low theoretical reads as **over-consumption** on the
  one report a client uses to chase shrinkage.
- **`subRecipeUsage.js`'s `fetchItemMap`** valued and NAMED at once, over every raw item under every
  sold dish plus every sub-recipe's own ingredients. A missing rate is a zero (the reconciliation
  figure comes out low); a missing name drops the ingredient out of the row's `ingredients` list, so
  the find-an-ingredient search stops matching and reports nothing rather than reporting a failure.
  **A read that only supplies labels still needs paging** — it fails as an absence, not an error.
