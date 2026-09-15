import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'

// Crest Customization (S758): the reads the Option Groups page and the Menu Pricing "Customize"
// dialog share. One loader so the two cannot select different columns and then disagree about what
// a group allows.
//
// Every read is paged with a unique tiebreaker. These are menu-sized tables, but the ATTACHMENT
// table is dishes × groups and the ingredients table is options × ingredients — the S734 rule is to
// write the rows-per-what down rather than assume "master data is small".

export const GROUP_COLS  = 'id, name, kitchen_name, kind, min_select, max_select, included_count, sort, is_active, created_at'
export const OPTION_COLS = 'id, group_id, name, kitchen_name, price_delta, is_removal, is_default, diet, allergens, sort, is_active'
export const ATTACH_COLS = 'id, recipe_id, group_id, min_override, max_override, default_option_id, sort'
export const INGREDIENT_COLS = 'id, option_id, item_id, sub_recipe_id, qty_per_portion'

/**
 * @param {Function} scopedFrom  from useScopedDb()
 * @param {{ withIngredients?: boolean, recipeId?: string }} opts
 * @returns {Promise<{ error: string|null, groups, options, attachments, ingredients }>}
 */
export async function loadOptionCatalog(scopedFrom, { withIngredients = false, recipeId = null } = {}) {
  const results = await Promise.all([
    fetchAllRows(() => scopedFrom('pos_option_groups', GROUP_COLS).order('sort').order('name').order('id')),
    fetchAllRows(() => scopedFrom('pos_options', OPTION_COLS).order('sort').order('name').order('id')),
    fetchAllRows(() => {
      const q = scopedFrom('pos_recipe_option_groups', ATTACH_COLS)
      return (recipeId ? q.eq('recipe_id', recipeId) : q).order('sort').order('id')
    }),
    withIngredients
      ? fetchAllRows(() => scopedFrom('pos_option_ingredients', INGREDIENT_COLS).order('id'))
      : Promise.resolve({ data: [], error: null }),
  ])
  const error = firstError(results)
  if (error) return { error, groups: [], options: [], attachments: [], ingredients: [] }
  const [{ data: groups }, { data: options }, { data: attachments }, { data: ingredients }] = results
  return { error: null, groups: groups || [], options: options || [], attachments: attachments || [], ingredients: ingredients || [] }
}

export const KIND_LABEL = { size: 'Size', addon: 'Add-ons', choice: 'Choice' }

export const KIND_HELP = {
  size: 'Half / Full, Small / Large. The guest picks exactly one, and each size can change the price.',
  addon: 'Extra cheese, add egg, no onion. The guest can pick several; each can add to the price.',
  choice: 'Spice level, how it is cooked, which sauce. A pick from a list, usually free.',
}

export const DIET_LABEL = { veg: 'Veg', egg: 'Egg', non_veg: 'Non-veg' }

/** "dairy, Gluten ,, nuts" -> ["dairy","gluten","nuts"] — the rollup's own tag shape. */
export function parseAllergens(text) {
  return Array.from(new Set(String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)))
}
