import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'

// Crest Customization (S758): the reads the Option Groups page and the Menu Pricing "Customize"
// dialog share. One loader so the two cannot select different columns and then disagree about what
// a group allows.
//
// Every read is paged with a unique tiebreaker. These are menu-sized tables, but the ATTACHMENT
// table is dishes × groups and the ingredients table is options × ingredients — the S734 rule is to
// write the rows-per-what down rather than assume "master data is small".

// S760 added size_scaling (groups) and portion_factor (options). The LEGACY lists are what a read
// falls back to when the S760 migration has not reached the database yet: the till loads this
// catalog with its menu, and a failed catalog read is a failed menu read (feedback: never put a
// not-yet-migrated column on a hot path). Writes use the full lists, which is correct — they write
// the new columns and need the migration anyway.
const LEGACY_GROUP_COLS  = 'id, name, kitchen_name, kind, min_select, max_select, included_count, sort, is_active, created_at'
const LEGACY_OPTION_COLS = 'id, group_id, name, kitchen_name, price_delta, is_removal, is_default, diet, allergens, sort, is_active'
export const GROUP_COLS  = LEGACY_GROUP_COLS + ', size_scaling'
export const OPTION_COLS = LEGACY_OPTION_COLS + ', portion_factor'

/** A read that failed because a column this bundle names is not in the database (yet). */
export function isMissingColumn(error) {
  if (!error) return false
  return error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist/i.test(error.message || '')
}
export const ATTACH_COLS = 'id, recipe_id, group_id, min_override, max_override, default_option_id, sort'
export const INGREDIENT_COLS = 'id, option_id, item_id, sub_recipe_id, qty_per_portion'

/**
 * @param {Function} scopedFrom  from useScopedDb()
 * @param {{ withIngredients?: boolean, recipeId?: string }} opts
 * @returns {Promise<{ error: string|null, groups, options, attachments, ingredients }>}
 */
export async function loadOptionCatalog(scopedFrom, { withIngredients = false, recipeId = null } = {}) {
  const readGroups = async () => {
    const r = await fetchAllRows(() => scopedFrom('pos_option_groups', GROUP_COLS).order('sort').order('name').order('id'))
    return isMissingColumn(r.error)
      ? fetchAllRows(() => scopedFrom('pos_option_groups', LEGACY_GROUP_COLS).order('sort').order('name').order('id'))
      : r
  }
  const readOptions = async () => {
    const r = await fetchAllRows(() => scopedFrom('pos_options', OPTION_COLS).order('sort').order('name').order('id'))
    return isMissingColumn(r.error)
      ? fetchAllRows(() => scopedFrom('pos_options', LEGACY_OPTION_COLS).order('sort').order('name').order('id'))
      : r
  }
  // S760: which dishes are build-your-own. Read here rather than on the till's own menu query, so
  // that hot-path read never names a column the database may not have yet; before the migration
  // no dish is marked, which is exactly what the missing column means.
  const readBuildYourOwn = async () => {
    const r = await fetchAllRows(() => scopedFrom('recipes', 'id').eq('is_build_your_own', true).order('id'))
    return isMissingColumn(r.error) ? { data: [], error: null } : r
  }
  const results = await Promise.all([
    readGroups(),
    readOptions(),
    fetchAllRows(() => {
      const q = scopedFrom('pos_recipe_option_groups', ATTACH_COLS)
      return (recipeId ? q.eq('recipe_id', recipeId) : q).order('sort').order('id')
    }),
    withIngredients
      ? fetchAllRows(() => scopedFrom('pos_option_ingredients', INGREDIENT_COLS).order('id'))
      : Promise.resolve({ data: [], error: null }),
    readBuildYourOwn(),
  ])
  const error = firstError(results)
  if (error) return { error, groups: [], options: [], attachments: [], ingredients: [], buildYourOwn: [] }
  const [{ data: groups }, { data: options }, { data: attachments }, { data: ingredients }, { data: byo }] = results
  return {
    error: null, groups: groups || [], options: options || [], attachments: attachments || [], ingredients: ingredients || [],
    buildYourOwn: (byo || []).map(r => r.id),
  }
}

export const KIND_LABEL = { size: 'Size', addon: 'Add-ons', choice: 'Choice' }

export const KIND_HELP = {
  size: 'Half / Full, Small / Large. The guest picks exactly one, and each size can change the price.',
  addon: 'Extra cheese, add egg, no onion. The guest can pick several; each can add to the price.',
  choice: 'Spice level, how it is cooked, which sauce. A pick from a list, usually free.',
}

export const SIZE_SCALING_HELP = {
  none: 'A pick costs and uses the same at every size. Right for a spice level or a free sauce.',
  stock: 'A bigger size uses more of it, at the same price. Right for a free base: a Large bowl gets more acai puree.',
  stock_and_price: 'A bigger size uses more of it and charges more for it. Right for paid toppings: chicken popcorn on a Large bowl.',
}

export const DIET_LABEL = { veg: 'Veg', egg: 'Egg', non_veg: 'Non-veg' }

/** "dairy, Gluten ,, nuts" -> ["dairy","gluten","nuts"] — the rollup's own tag shape. */
export function parseAllergens(text) {
  return Array.from(new Set(String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)))
}
