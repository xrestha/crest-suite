import { fetchAllRows } from '../../shared/fetchAllRows'
import { andList } from '../../shared/offeredPicks'
import { firstError } from '../../shared/queryError'
import { errorInfo } from '../../shared/errorText'
import { isTimeout } from '../../utils/withTimeout'

// S852: every read and save on the Option Groups page and its dialogs has a time limit, as Combos
// already had. Without one a hung request left the page on Loading… with no Retry, or a dialog on
// Saving… whose `if (saving) return` refused every press after it. A save that ran out of time may
// still land after the clock stopped, and an insert repeated over one that landed is a second row,
// so its message says where to look and never that nothing was saved.
export const CUSTOMIZATION_READ_MS = 20000
export const CUSTOMIZATION_WRITE_MS = 20000
export const DIALOG_CHECK = 'Close this and reload the page to see whether it saved before you save it again.'
export const PAGE_CHECK = 'Reload the page to see whether it went through before you try again.'

/** asActionError's { text, detail } for a failed Customization write. A timeout names where to
 *  check (`check`), because the write may still have landed. */
export function writeFailure(error, check = DIALOG_CHECK) {
  const { text, detail } = errorInfo(error, 'operator')
  if (!isTimeout(error)) return { text, detail }
  return { text: `The server took too long to answer, so this may have saved or may not. ${check}`, detail }
}

const DISH_NAMES_SHOWN = 5
const dishNames = names => andList(names.length > DISH_NAMES_SHOWN
  ? [...names.slice(0, DISH_NAMES_SHOWN), `${names.length - DISH_NAMES_SHOWN} more`]
  : names)

/**
 * The message for an "Offer on…" save whose removals stopped part-way (S852). Removals run in
 * chunks, so some dishes can be off the group while others still offer it; the message names
 * both, never a blanket failure. `off` and `still` are dish names; `error` is the failed chunk.
 * A timed-out chunk may still land, so those dishes "may still" offer it. `retry` is said after a
 * timeout: every write here is keyed, so saving again is safe.
 * S862 SETUP-10: `error` null means every chunk answered but fewer rows came off than were sent —
 * a window whose outlet moved on another device, or a row changed there — so it says to reload.
 */
export function detachFailure({ groupName, added, off, still, error, retry }) {
  const { text, detail } = error ? writeFailure(error) : { text: '', detail: null }
  const lead = added ? `The dishes you ticked now offer “${groupName}”. ` : ''
  const done = off.length ? `It is off ${dishNames(off)}, but ` : ''
  const one = still.length === 1
  if (!error) {
    return {
      text: `${lead}${done}${dishNames(still)} may still offer it: ${one ? 'that dish' : 'those dishes'} may have changed on another device. Reload the page to check before you save again.`,
      detail,
    }
  }
  const rest = isTimeout(error)
    ? `${done ? 'the' : 'The'} server took too long to answer about ${dishNames(still)}, so ${one ? 'that dish' : 'those dishes'} may still offer it. ${retry}`
    : `${dishNames(still)} still ${one ? 'offers' : 'offer'} it. ${text}`
  return { text: `${lead}${done}${rest}`, detail }
}

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
