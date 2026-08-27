---
paths:
  - "src/pages/Recipes.js"
  - "src/utils/recipeCost.js"
  - "src/modules/ims/recipes/**"
  - "src/modules/ims/stockcount/**"
  - "src/shared/salesDepletion.js"
---

# Sub-recipe mirror items, nesting, and the two cost engines

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### Sub-recipe mirror items

Recipes with `type = 'sub_recipe'` auto-create a mirror row in `items` with `is_sub_recipe = true`. Filter these out of Item Master, Purchases, POs, Requisitions, Reorder Report, and Supplier Price Tracker:

```js
.eq('is_sub_recipe', false)
```

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
- **Running out of depth was silent.** `explodeRecipeTree`'s frontier loop stops when its round cap
  is hit and simply returns what it has, so ingredients below the cut vanish from COGS and Variance
  as a believable smaller number. The cap is now `MAX_DEPTH_ROUNDS = 12` (was 5) and an exhausted
  frontier `console.error`s with the unresolved ids and the direction of the error.

**Two different sub-recipe counts exist and both are correct** — a recurring "why don't these match" question. `Recipes.js:177` counts the **master list** (`category === 'Sub-Recipe'` over an unfiltered fetch: no period, no usage, not even `is_active`), while Stock Movements' Sub-Recipes tab counts only what a **period's sales actually consumed**. The difference is prep items nothing sold touched, surfaced explicitly on that tab ("9 of your 57 …") rather than left to a cross-check. The one case where they genuinely cannot reconcile: a recipe referenced via `sub_recipe_id` whose own `category` was never set to `'Sub-Recipe'` — counted by the walk but not by the category filter, so used + unused would exceed the master total. That is a data-entry problem on the recipe, and the tab names the offenders instead of silently producing numbers that don't add up.

---
