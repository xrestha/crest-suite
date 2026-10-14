// What still uses a sub-recipe, as the sentence that refuses deleting it or moving it out of the
// Sub-Recipe category.
//
// Two things can hold a sub-recipe, and both are plain foreign keys, so a delete is refused rather
// than cascaded: another recipe's ingredient line (recipe_ingredients.sub_recipe_id) and a Crest
// Customization choice's stock line (pos_option_ingredients.sub_recipe_id, S758 — "Granola adds
// 40 g of House Granola"). Recipe Costing's pre-checks only ever read the first, so the second
// reached the reader as the 23503 fallback: "still used by other records … use Hide instead" —
// and Hide does nothing for a choice. Moving it out of the category was worse: Option Groups only
// offers Sub-Recipe recipes as stock lines, so the choice kept taking it off stock through a line
// nobody could see any more.
//
// Who can clear a choice's line matters to the sentence, because the database decides it
// (guard_pos_option_edit): only the Owner, a POS or IMS manager, or Crest support, and only while
// Customization is live at the outlet — except Crest support, who can edit it either way. Telling
// an Owner to "remove it in Option Groups" on an outlet where Customization is switched off sends
// them to a screen that refuses them.
//
// Pure, so it is tested without Supabase (subRecipeInUse.test.js).

// The choice and its group, embedded by constraint name: pos_recipe_option_groups points at both
// pos_options and pos_option_groups, which would make an unnamed embed ambiguous.
export const CHOICE_LINE_COLS =
  'option_id, pos_options!pos_option_ingredients_option_fkey(name, pos_option_groups!pos_options_group_fkey(name))'

/** recipe_ingredients rows embedding `recipes(name)` → the parent recipes' names, once each. */
export function recipeNamesOf(rows) {
  return [...new Set((rows || []).map(r => r.recipes?.name).filter(Boolean))]
}

/**
 * pos_option_ingredients rows read with CHOICE_LINE_COLS → `Group › Choice`, once each. A row whose
 * names did not come back still counts: a line was found, and a check that found one must refuse.
 */
export function choiceNamesOf(rows) {
  return [...new Set((rows || []).map(r => {
    const option = r.pos_options
    return [option?.pos_option_groups?.name, option?.name].filter(Boolean).join(' › ') || 'an unnamed choice'
  }))]
}

// 'edit'     can change the choices in Option Groups now
// 'operator' Crest support on an outlet where Customization is off: still can (the guard's is_admin pass)
// 'rank'     Customization is live but this login's rank cannot edit choices
// 'off'      Customization is off and this is not Crest support: nobody at the outlet can
function choiceAccessOf({ customizationLive, isAdmin, canEditChoices }) {
  if (!customizationLive && !isAdmin) return 'off'
  if (!canEditChoices && !isAdmin) return 'rank'
  return customizationLive ? 'edit' : 'operator'
}

// The way out, once the reader knows what holds it.
function nextStep(hasRecipes, hasChoices, access) {
  if (!hasChoices) return 'Remove it from those recipes first.'
  const fromBoth = hasRecipes
    ? 'Remove it from those recipes, and from those choices in Option Groups, first.'
    : 'Remove it from those choices in Option Groups first.'
  switch (access) {
    case 'off':
      return `${hasRecipes ? 'Remove it from those recipes first. ' : ''}Crest Customization is switched off at this outlet, so those choices can't be changed here — ask Crest support to remove it from them, then try again.`
    case 'rank':
      return `${hasRecipes ? 'Remove it from those recipes first, and ask' : 'Ask'} the Owner or a manager to remove it from those choices in Option Groups.`
    case 'operator':
      return `${fromBoth} Crest Customization is switched off at this outlet, but as Crest support you can still edit its choices.`
    default:
      return fromBoth
  }
}

/**
 * The refusal, or null when nothing uses the sub-recipe.
 *
 * @param {object} args
 * @param {'delete'|'recategorise'} args.action
 * @param {string}   args.name             the sub-recipe
 * @param {string[]} args.recipeNames      recipes holding it as an ingredient (recipeNamesOf)
 * @param {string[]} args.choiceNames      choices holding it as a stock line (choiceNamesOf)
 * @param {boolean}  args.customizationLive the outlet's Customization switch (customizationEnabled)
 * @param {boolean}  args.isAdmin          the Crest operator
 * @param {boolean}  args.canEditChoices   Owner, a POS or IMS manager, or the operator (canSetMenuPrice)
 */
export function subRecipeInUseText({ action, name, recipeNames = [], choiceNames = [], customizationLive, isAdmin, canEditChoices }) {
  const hasRecipes = recipeNames.length > 0
  const hasChoices = choiceNames.length > 0
  if (!hasRecipes && !hasChoices) return null
  const access = choiceAccessOf({ customizationLive, isAdmin, canEditChoices })
  const recipes = recipeNames.join(', ')
  const choices = choiceNames.join(', ')

  if (action === 'recategorise') {
    // Recipes alone keep the S714 sentence word for word, Hide included. Hide is not offered once a
    // choice holds it: Option Groups lists only active sub-recipes, so hiding it hides the line too.
    if (!hasChoices) {
      return `"${name}" is an ingredient in ${recipes}, so it can't stop being a Sub-Recipe — those recipes would keep consuming it while it disappeared from their ingredient pickers. Remove it from them first, or use Hide if you just want it off the menu.`
    }
    const held = hasRecipes
      ? `an ingredient in ${recipes} and a stock line on these choices: ${choices}`
      : `a stock line on these choices: ${choices}`
    const lost = hasRecipes
      ? 'they would keep consuming it while it disappeared from the recipes\' ingredient pickers and from Option Groups'
      : 'those choices would keep taking it off stock while it disappeared from Option Groups'
    return `"${name}" is ${held}, so it can't stop being a Sub-Recipe — ${lost}. ${nextStep(hasRecipes, hasChoices, access)}`
  }

  const held = [
    hasRecipes && `it's used as an ingredient in: ${recipes}`,
    hasChoices && `it's a stock line on these choices: ${choices}`,
  ].filter(Boolean).join(', and ')
  return `Can't delete "${name}" — ${held}. ${nextStep(hasRecipes, hasChoices, access)}`
}
