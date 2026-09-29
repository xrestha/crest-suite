// Would saving this ingredient list make a recipe contain itself? (S792, RECIPES-7)
//
// Recipe Costing's save used to answer from the page's in-memory recipe book, which is as old as
// the page. Tab 1 open since 9:00; at 10:00 someone else adds Sauce A into Sauce B; at 11:00 tab 1,
// whose book still says B holds nothing, adds B into A — the check passes and A↔B is saved. Then
// the cost walk quietly costs the back-edge at 0 (Recipe Costing and Menu Pricing under-cost), and
// explodeRecipeTree recurses to its depth cap multiplying quantities (COGS, Variance and Stock
// Report wrong) with only a console.error. So the chain is re-read from the database inside the
// save, one level per round, starting from the sub-recipes the new list names. A trigger on
// recipe_ingredients is the backstop for the seconds between this read and the write; its refusal
// (SQLSTATE 23514, 'recipe_cycle') is recognised by isRecipeCycleError and worded the same way.
//
// Pure apart from the injected reader, so it is tested without Supabase (recipeCycle.test.js).

// Far past any real kitchen (explodeRecipeTree stops at 12). A walk that runs out of rounds before
// running out of recipes is a check that could not finish, and the caller refuses the save.
export const RECIPE_CYCLE_MAX_ROUNDS = 50

/**
 * @param {object} args
 * @param {string} args.recipeId           the recipe being saved
 * @param {string[]} args.subRecipeIds      the sub-recipes its new ingredient list names
 * @param {(ids: string[]) => Promise<{ data: Array<{recipe_id, sub_recipe_id}>, error }>} args.readSubLines
 *        the saved sub-recipe lines of the recipes `ids` (sub_recipe_id not null)
 * @returns {Promise<{ chain: string[]|null, error: object|null }>}  `chain` runs from the sub-recipe
 *        this recipe is about to contain down to the one that already contains this recipe; null
 *        when there is no loop. `error` when the walk could not be completed — never "no loop".
 */
export async function findRecipeCycle({ recipeId, subRecipeIds, readSubLines, maxRounds = RECIPE_CYCLE_MAX_ROUNDS }) {
  const start = [...new Set((subRecipeIds || []).filter(Boolean))]
  if (!recipeId || start.length === 0) return { chain: null, error: null }
  if (start.includes(recipeId)) return { chain: [recipeId], error: null }

  const parentOf = new Map(start.map(id => [id, null]))
  const chainTo = id => {
    const out = []
    for (let at = id; at != null; at = parentOf.get(at)) out.unshift(at)
    return out
  }
  let frontier = start
  for (let round = 0; round < maxRounds && frontier.length > 0; round++) {
    const { data, error } = await readSubLines(frontier)
    if (error) return { chain: null, error }
    const rows = [...(data || [])].sort((a, b) =>
      String(a.recipe_id).localeCompare(String(b.recipe_id)) || String(a.sub_recipe_id).localeCompare(String(b.sub_recipe_id)))
    const next = []
    for (const { recipe_id: parent, sub_recipe_id: child } of rows) {
      if (!child) continue
      if (child === recipeId) return { chain: chainTo(parent), error: null }
      if (parentOf.has(child)) continue
      parentOf.set(child, parent)
      next.push(child)
    }
    frontier = next
  }
  if (frontier.length > 0) {
    return { chain: null, error: { message: `recipe_cycle check stopped after ${maxRounds} levels of sub-recipes` } }
  }
  return { chain: null, error: null }
}

/** The database's own refusal of a loop — the trigger on recipe_ingredients (SQLSTATE 23514). */
export function isRecipeCycleError(err) {
  if (!err || String(err.code) !== '23514') return false
  return [err.message, err.hint, err.details].some(s => /recipe_cycle/i.test(String(s || '')))
}

/**
 * The refusal, naming the dishes: `recipeName` is being saved, `chainNames` runs from the sub-recipe
 * it would contain down to the one that already contains it.
 */
export function recipeCycleText(recipeName, chainNames) {
  const q = s => `"${s}"`
  const names = (chainNames || []).filter(Boolean)
  if (names.length === 0) {
    return `${q(recipeName)} would end up containing itself through one of its sub-recipes, and a recipe can't be made from itself.`
  }
  const [first] = names
  if (names.length === 1 && first === recipeName) {
    return `${q(recipeName)} can't be one of its own ingredients.`
  }
  const path = names.length === 1
    ? `${q(first)} already contains ${q(recipeName)}`
    : `${q(first)} contains ${names.slice(1).map(q).join(', which contains ')}, which contains ${q(recipeName)}`
  return `${q(recipeName)} can't contain ${q(first)}: ${path}, so ${q(recipeName)} would be made from itself. Remove ${q(first)} from its ingredients.`
}
