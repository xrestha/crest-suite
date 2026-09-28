# RECIPES — recipe costing, menu pricing/analysis tools, S760 build-your-own cost ranges and size pricers

Files reviewed (21): Recipes.js (by range: init, save, delete, toggle, nutrition auto-fill, list row, edit
form price/VAT, detail view), recipeCostCalc.js, RecipeCostCardPrint.jsx, RecipeImportButton.jsx,
MenuPricing.js (POS-only and IMS branches), MenuRepricing.js (loader/export), MenuEngineering.js
(loader/write-back), RecipeMargin.js, ComboBuilder.js (S765 diff only), dishPhoto.js, DishPhotoField.jsx,
NutritionEditorModal.jsx (writes/fetches), src/shared/{menuEngineering,optionPricing,buildCost,imsFormulas}.js,
src/utils/{recipeCost,nutrition,orderLineIngredients}.js, customization/{useBuildCostRanges.js,BuildCostDetail.jsx},
BestSellers.js (loader), PosOrders.jsx writeSalesEntries (unit_price source); migrations 20260918100000
(guard_recipe_rank, ims_rank_guard), 20260918150000 (dish-photos bucket), 20260919130000 + 20260920100000
(S758/S760 pricers). Skipped: ComboBuilder body (S724-reviewed, S765 change is a11y only), jest runs.

### RECIPES-1 [P1] A build-your-own dish is still priced and judged at its near-zero fixed cost everywhere except two list cells
- Where: Recipes.js:2202-2270 (detail tiles: Food Cost, FC % ✓, "Suggested @30% FC (incl. VAT)", True Cost with Overheads), :1379-1394 (WhatsApp share), :1314-1318 (FC filter pills); RecipeCostCardPrint.jsx:15-20,43-54 (printed card incl. Gross Margin %); RecipeImportButton.jsx:148-158 (export FC%); MenuEngineering.js:212,250,275 (quadrant + me_class write-back to the POS suggestion engine); RecipeMargin.js:119,146-160; MenuRepricing.js:95,119; BestSellers.js:121,153. `grep -rln is_build_your_own src` → only Recipes.js, MenuPricing.js, customization/*, GuestMenu, PosOrders.
- What happens: S760's premise (buildCost.js header) is that a BYO dish's fixed-ingredient figure "reads as a near-zero food cost" and is replaced by a range — but only the Recipe Costing LIST row and the Menu Pricing IMS row were switched. Acai bowl: fixed bowl+spoon NPR 8, price NPR 300 ex-VAT, typical build NPR 150. One click into the dish: Food Cost NPR 8.00, FC 2.7% ✓ green, "Suggested @ 30% FC (incl. VAT) NPR 35" (5x below the plate's cost), True Net Margin on NPR 8. Printed card: FC 2.7%, Gross Margin 97.3%. WhatsApp: "FC 2.7% (NPR 8.00 / NPR 300.00)". The "✓ ≤30%" pill returns it while its own row shows e.g. "38–52% ▲". Menu Engineering: 2.7% → Star/Plowhorse "keep, feature prominently", written to recipes.me_class for the till's "Chef's pick"; Recipe Margin: Top Contributor; Menu Repricing: never underpriced; Best Sellers: top of By Margin. A BYO dish with NO fixed ingredients instead reads "Not rated — No costed ingredients — add a recipe or a manual cost", advice that is wrong for it.
- Evidence: Recipes.js:2202 `const cost = calcRecipeCost(selectedRecipe, recipes)`, :2203 `recipeCostOf(...)`, no BYO branch; :1303 comment ("the choices are the plate") applies only to the list's byoFixedCost.
- Status: NEW (S760). recipes-and-subrecipes.md says other readers "mean the fixed part" — that describes the implementation; the outcome is the S713/S724 flattering-number shape on the page S760 changed.
- Fix: detail/card/share/pills/export render the range (or "costed by build — open the row") and suppress Suggested price and True Cost; the four menu-analysis pages (and computeMenuEngineeringSection) treat BYO as Not rated with reason "Build-your-own: costed by build on Recipe Costing" and write me_class NULL.
- Confidence: Confirmed.

### RECIPES-2 [P1] On a PAN-bill (not VAT-registered) outlet the pricing screens divide the owner's price by 1.13 and the till charges the divided figure
- Where: Recipes.js:1829-1845 (Menu Price box, "incl. 13% VAT", stores price/1.13), :1232; MenuPricing.js:222-224 ("Current Price" = selling_price × 1.13), :344 (saveRow divides by 1+vat), :376 (Add Item); MenuRepricing.js:120-126 (Suggested Menu Price incl. VAT); RecipeImportButton.jsx:246 (vat_rate 0.13). None of src/modules/ims/recipes/* reads `settings.is_vat_registered`.
- What happens: the till and the guest menu both honour `settings.is_vat_registered`: save_pos_order_items writes `vat_rate = CASE WHEN v_vat_reg … ELSE 0` with `unit_price = selling_price` (+options), PosOrders.jsx:577-580 adds VAT only when vatReg, the tile shows `selling_price × (1 + (vatReg ? vat : 0))` (:4475), GuestMenu.jsx:1175 likewise (migration 20260823100000 made the guest menu match the till for exactly this population — "most of the small end of this market"). The pricing screens never read the flag, and every new dish defaults to VAT 13%. A PAN-bill cafe types NPR 500 on Recipe Costing → stores 442.48 → the till bills NPR 442. Menu Pricing keeps showing "Current Price NPR 500"; Menu Repricing's "Suggested Menu Price (incl VAT) — the number to print on the menu" is 13% above what the till will charge once it is entered. Each dish is under-charged ~11.5% unless the owner happens to set every dish to "0% (No VAT)", which no screen tells them to do (the VAT tip speaks only of VAT-exempt dishes). FC% itself is right (ex-VAT = actual revenue there); the price the owner sees and the price the guest pays disagree.
- Status: missed by S756 (pre-existing; D15 covered the toggle, not the outlet flag).
- Fix: pricing screens read `is_vat_registered`; when false, label the box "Menu Price (no VAT — PAN bill)", store the typed price whole (vat 0) and show Current Price = selling_price. Existing PAN-bill dishes need a one-time review — see Owner question 1.
- Confidence: Confirmed (code path read end to end; not click-verified).

### RECIPES-3 [P1] Customization upcharges are counted as revenue, but the choices' stock is never counted as cost, on Recipe Margin and Best Sellers
- Where: RecipeMargin.js:83 (select has no `ingredient_deltas`), :118-160; BestSellers.js:99,138-157. (Menu Engineering classifies on list price vs recipe cost, so only its Revenue column carries upcharges.)
- What happens: a customized line's unit_price includes the options' price (20260919130000:449 `selling_price + delta`; carried to sales_entries.unit_price by PosOrders writeSalesEntries :66). These pages sum that as revenue, while cogs = computeRecipeCosts (recipe only) × qty. "Momo + Extra cheese (+NPR 50, +30 g cheese ≈ NPR 36 at cost)" adds NPR 50 of revenue and NPR 0 of cost: Total Contribution, margin % and the revenue-weighted FC% all read high; a heavily customized dish climbs to Top Contributor. ims-figures.md (S758): "A reader that turns sales into consumption selects ingredient_deltas" — these turn sales into COGS without it.
- Status: NEW (S758/S760).
- Fix: select `ingredient_deltas`, load `loadDeltaExplosion`, add Σ deltaItems×rate×qty to each dish's COGS (Recipe Margin `cogs`, Best Sellers `profit`); or exclude upcharge revenue and say so. See Owner question 3.
- Confidence: Confirmed.

### RECIPES-4 [P3] The two "cheapest build" helpers disagree with each other and with the pricer when a group has free picks
- Where: src/shared/optionPricing.js:224-251 (`lowestDishPrice` → guest menu "From NPR x", GuestMenu.jsx:1175); src/shared/buildCost.js:50-65 (`cheapestSelection` → "Cheapest build · price" on Recipe Costing/Menu Pricing).
- What happens: the pricer (optionsPriceDelta and both SQL twins) frees the first `included_count` picks in DISPLAY order. `lowestDishPrice` frees the cheapest and charges the dearest of the cheapest `min`. Toppings pick 3, first 2 free: Banana +30 (sort 0), Granola +20, Honey +10, Nutella +50 → true lowest +10; lowestDishPrice +30 ("From NPR 230" for a dish orderable at 210); cheapestSelection +10 here. Simulation of the repo's own functions against brute force (3000 random groups): lowestDishPrice wrong in 23.5%, cheapestSelection in 2.3% (prices [20,0,20,10,20], pick 2, first 1 free: true 0, picked 10).
- Status: NEW (S759/S760). Fix: one helper that minimises over valid selections honouring display-order free picks (enumerate small groups). Confidence: Confirmed (node simulation, scratchpad/recipes-sim/t1.mjs, t2.mjs).

### RECIPES-5 [P3] Menu Pricing (IMS branch) Excel stays live after a failed Refresh and exports the previous figures; no letterhead
- Where: MenuPricing.js:845 (`disabled={loading || display.length === 0}`), :160-161/:173 (error path returns without clearing `recipes`), :802-824 (plain json_to_sheet).
- What happens: ↻ Refresh Costs fails → error card replaces the table, `recipes` still holds the last load, ⬇ Excel enabled → stale food costs/FC% leave the building as current (report-pages.md S728: gate exports on loading AND error). Sheet has no sheetWithLetterhead scope line.
- Status: missed by S756. Fix: add `|| !!loadError`; build through sheetWithLetterhead. Confidence: Confirmed.

### RECIPES-6 [P3] Printed Recipe Cost Card is dated with a browser-locale AD date
- Where: RecipeCostCardPrint.jsx:37 `new Date().toLocaleDateString('en-IN')`. Prints "28/9/2026" on a BS product's document (page-layout.md time rule; GatePassPrint's twin fixed in S756). Status: missed by S756. Fix: nepalBs/nepalDateAd. Confidence: Confirmed.

### RECIPES-7 [P3] The cycle check reads the page's in-memory recipe book and nothing in the database refuses a cycle
- Where: Recipes.js:714-727 (`wouldCreateCycle` over `recipes` state); no trigger on recipe_ingredients.
- What happens: tab 1 opened at 9:00; at 10:00 someone else adds Sauce A into Sauce B; at 11:00 tab 1 (stale book, B has no A) adds B into A → check passes → A↔B saved. Then calcSubRecipeCostPerUnit silently costs the back-edge 0 (Recipe Costing/Menu Pricing under-cost), while explodeRecipeTree recurses to depth 12 multiplying quantities (COGS/Variance/Stock Report wrong) with only a console.error.
- Status: missed by S756. Fix: re-read the referencing chain from the DB inside save (one recursive read or an RPC), or a BEFORE INSERT trigger on recipe_ingredients that walks sub_recipe_id. Confidence: Plausible (confirm with two browser tabs).

### RECIPES-8 [P3] Replacing or removing a dish photo can delete another dish's photo when the link was pasted
- Where: DishPhotoField.jsx handleFile (`previousPath` → removeObjectQuietly), handleRemove; dishPhoto.js:58-67.
- What happens: "Paste a link instead" (tip: "Only for a photo already stored in Crest") invites reusing another dish's Crest URL (Veg Momo and Chicken Momo sharing a photo). Replacing or removing it on dish B deletes the file dish A still points to (same client folder, so the policy allows it); dish A shows "Can't show"/no photo on the guest menu, silently.
- Status: NEW (S756 D16 code, unreviewed). Fix: delete the old object only if its file stem is this recipe's id (`<recipeId>-…`), or check no other recipe's image_url references it. Confidence: Plausible.

### RECIPES-9 [P3] Recipe Import issues no Product Code and imports a dish twice when a sheet lists it twice
- Where: RecipeImportButton.jsx:27,41 (duplicate check against the DB only), :242-251 (no recipe_code).
- What happens: every other creator issues a code (Recipes.js, Menu Pricing Add Item); imported dishes have none (not searchable by code on the till, blank on Item Wise). Two "Chicken Momo" blocks in one sheet both import → two dishes. Status: missed by S756. Fix: issue codes via nextProductCode; de-duplicate names within the sheet. Confidence: Confirmed.

### RECIPES-10 [P3] The "typical build" is learned from every order line, including void and still-open bills
- Where: useBuildCostRanges.js:63-64 (`pos_order_items` by recipe_id and created_at only).
- What happens: builds on voided bills, open tables and comps count toward "the most-picked build", and the window is by line creation rather than billing. Small effect on the typical cost. Status: NEW (S760). Fix: join pos_orders close_type='paid' (the house definition, as get_cooccurrence). Confidence: Plausible.

## GAPs
1. **PAN-bill outlets have no "we don't charge VAT" mode on any pricing screen** (RECIPES-2): an owner must know to set every dish to 0% one by one.
2. **No dish cost history**: an owner cannot see how a dish's food cost moved month to month as supplier prices rose (Recipe Costing always shows today's rates); the owner wants "momo cost NPR 95 in Shrawan, 108 now".
3. **Customized sales have no margin view in IMS**: the Customization report counts picks, but no IMS page shows what extras earn after their stock (RECIPES-3).
4. **Sub-recipe stock value is frozen at its last save** (the mirror rate, documented as deliberate) with nothing on Stock Count saying so and no "update sauce costs" button; an owner valuing closing stock sees an old sauce price.
5. **Recipe Import cannot bring sub-recipes or photos** ("Sub-recipe — create in app"), so a multi-outlet owner re-keys every sauce by hand.

## Owner questions
1. **A cafe that gives PAN bills (no VAT): what should the price box mean?** (a) The price you type is the price the guest pays: the pricing screens read the "VAT registered" switch and store it whole; your current dishes will show their real till price (e.g. 442 where you typed 500) so you can re-enter them once. **Recommended.** (b) Keep the 13%/0% choice per dish, and show a banner on PAN-bill outlets telling you to set dishes to 0%. (c) Leave as is.
2. **Build-your-own bowls on Menu Engineering, Recipe Margin, Best Sellers and Menu Repricing:** (a) show them as "Not rated — costed by build" with a link to their range. **Recommended.** (b) Rate them at their typical build's cost (needs 10+ recent orders; otherwise not rated). (c) Keep rating them on the bowl and spoon only.
3. **Extras a guest adds (extra cheese +NPR 50) on the margin reports:** (a) count the cheese's cost too, so the margin is real. **Recommended.** (b) Leave extras out of revenue as well (compare dishes at menu price only). (c) Leave as is and add a note that extras are not costed.

## Checked and fine
- D3 holds: guard_recipe_rank (hide IMS supervisor, delete IMS manager, 15-min empty-recipe import cleanup; COALESCE'd via ims_caller_has_rank), recipe_ingredients ims_rank_guard('supervisor'); Recipes.js page guard supervisor (:1356), Del button manager-only (:116); Menu Pricing guard admin/Owner/POS or IMS manager above both returns (:487).
- D15 holds: Recipe Costing VAT select keeps the guest price, paisa-rounded (:1875-1891); Menu Pricing edit modal keeps the incl-VAT box (saveNewItem :376-387). Selling price stored ex-VAT to 4 dp (`numeric`); FC% on ex-VAT everywhere read.
- D16 holds: dish-photos policies are folder = my_client_id() with COALESCE on every operand, rank mirrors guard_recipe_rank (IMS supervisor+/Owner or caller_can_set_menu_price), SELECT scoped to writers, no UPDATE policy, no upsert; remove() only for this client's own paths (`path.startsWith(clientId/)`); saved-recipe write checks zero rows (`.select('id')`) and removes the upload on refusal. Orphan on cancel is the known ⚪.
- S756 fixes still hold: edit never re-sends is_active (:807); list-view errors render in every view (:1442); recipeCostOf/menuFcPct null on list, detail, card, share, export; mirror-link writes checked (:1011-1056); Recipes.js True Cost read filters source in JS (:238/:265); Menu Pricing null-category save (:385); RecipeImport "Selling Price (ex-VAT)" header + preview of the menu price; import duplicate-ingredient refusal and compensating delete.
- Save/delete ordering: ingredient upsert before prune, prune error surfaced (:894-918); duplicate item/sub-recipe rows refused (:683-700); convert-away refused while referenced (:760-777); committed new recipe re-pointed on later failure (:1069-1072); delete pre-checks fail closed and the recipe row goes first (:1089-1203).
- Sub-recipe walks: calcSubRecipeCostPerUnit path set (diamond costed twice); yield ÷ yield_qty and yield_pct trim identical in calcRecipeCost, calcLiveCost, Menu Pricing's costMap and explodeRecipeTree; explodeRecipeTree paged/chunked, throws on read error, both depth caps tied to MAX_DEPTH_ROUNDS; Menu Pricing resolves sub-recipes against the unfiltered book (:151). Nutrition roll-up recursion is path-safe (copies `seen`).
- S760 pricers agree on everything except free-pick "cheapest" (RECIPES-4): factor = product of chosen size portion_factor to 6 dp (JS sizeFactor ↔ SQL pos_selection_portion_factor, both de-duplicate, size groups only; CHECK 0 < factor ≤ 10); scaled price round-half-away-from-zero to 2 dp (roundMoney ↔ Postgres round); first-N free in (sort, name, id) order before scaling; stock lines ×factor to 4 dp in 'stock'/'stock_and_price' only; size group CHECK-forced to 'none'. buildCost values option stock through deltaItems (yield % + sub-recipe per unit) exactly like the stock posting, fixed part unscaled — matches usageOfSalesRow.
- useBuildCostRanges: catalog/explosion/rate read failures surface as an error ("not checked"), never a range computed without the choices; rate and order-line reads chunked and paged; typical build falls back to defaults and says so.
- Menu Engineering carries null through recipeCostOf→menuFcPct→classify; me_class written only for the live period, per class, chunked, with its own error. Menu Repricing's gap de-VATs the rounded suggested price. S765 edits to ME/RM/MR/ComboBuilder are presentation only.
- Nutrition look-ups (Open Food Facts, USDA) are both in vercel.json connect-src; the modal's save checks its error.
