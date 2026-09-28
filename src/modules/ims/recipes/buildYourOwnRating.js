import { SUB_RECIPE_CATEGORY } from '../../../shared/productCode'

// S792 RECIPES-1: a build-your-own dish is "Not rated — costed by build" on the menu reports.
//
// A dish marked build-your-own (`recipes.is_build_your_own`, S760) has a FIXED part — the bowl, the
// spoon — and gets most of its cost from what each guest picks. Every recipe cost engine costs it at
// that fixed part only, which is right for what the recipe is (recipes-and-subrecipes.md) and wrong
// as a verdict: an acai bowl at NPR 8 of bowl and spoon against NPR 300 read FC 2.7% ✓, a Star to
// "feature prominently" (written to `recipes.me_class` for the till's suggestions), Recipe Margin's
// Top Contributor and the top of Best Sellers' By Margin. Its real cost is a RANGE
// (`src/shared/buildCost.js`), shown on Recipe Costing and Menu Pricing.
//
// Decided (IMS_TODO.md S792.1, settled by precedent): the menu reports do not rate it. Each report
// still lists the dish and its sales, and leaves it out of every verdict, cost ranking and cost total,
// the way it treats a dish with no cost at all — but says WHY, because that dish's next step ("add a
// recipe or a manual cost") is the wrong one for a dish whose plate is the guest's picks.
//
// Gated on Crest Customization being on, as Recipe Costing's list is (`Recipes.js` `isByo`): with the
// module off the till sells the dish plain and Recipe Costing costs it like any other dish, so a menu
// report rating it the same way keeps one dish at one cost across the screens.

/** The row state, as a label. */
export const BYO_STATUS = 'Not rated — costed by build'

/** The one-line reason a report shows where a verdict would be. */
export const BYO_REASON = 'Build-your-own — costed by build (see its range on Recipe Costing)'

/** The Tip beside the row state. */
export const BYO_TIP = 'A build-your-own dish is not rated on this report. Its recipe holds only the fixed part (the bowl, the spoon), so one food-cost figure for it would be near zero, while what a plate really costs depends on what each guest picks. Recipe Costing shows its cost range: the cheapest build and the typical one.'

/**
 * Whether a menu report must treat this dish as costed by its build rather than by its recipe.
 * @param {{ is_build_your_own?: boolean, category?: string }} recipe
 * @param {boolean} customizationEnabled  from useAuth()
 */
export function isCostedByBuild(recipe, customizationEnabled) {
  return !!customizationEnabled && !!recipe?.is_build_your_own && recipe?.category !== SUB_RECIPE_CATEGORY
}
