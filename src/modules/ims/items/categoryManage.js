// Item Master's own categories: add, rename and remove (S885, owner decision 2). Pure, pinned by
// categoryManage.test.js; CategoryManagerModal.jsx holds the screen.
//
// Adding and renaming are plain writes on `categories`, whose UNIQUE (client_id, name) is
// case-sensitive, so "dairy" beside "Dairy" is refused here first. Removing goes through
// merge_item_category, one transaction that moves the items (hidden ones too), the monthly budgets
// (two in one month are added together) and the stock counter assignments, then deletes the row.
import { SUB_RECIPES_CATEGORY } from './itemFormRules'

export const CATEGORY_NAME_MAX = 60

export const cleanCategoryName = name => String(name ?? '').replace(/\s+/g, ' ').trim()
const key = name => cleanCategoryName(name).toLowerCase()

/** The sentence under the name box, or null when the name may be saved. */
export function categoryNameProblem(name, categories, { exceptId } = {}) {
  const clean = cleanCategoryName(name)
  if (!clean) return 'Type a name for the category.'
  if (clean.length > CATEGORY_NAME_MAX) return `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`
  if (key(clean) === key(SUB_RECIPES_CATEGORY)) {
    return 'Sub-Recipes is the name Recipe Costing files sub-recipes under, so it cannot be used here. Pick another name.'
  }
  const clash = (categories || []).find(c => c.id !== exceptId && key(c.name) === key(clean))
  if (clash) {
    return clash.name === clean
      ? `There is already a category called "${clash.name}".`
      : `There is already a category called "${clash.name}", which differs only in capitals or spaces. Use that one, or pick a name that tells them apart.`
  }
  return null
}

/**
 * The category the app keeps for sub-recipes: never renamed or removed. Any capitals, as the
 * database guard (categories_guard_protected) reads it with lower(btrim(name)).
 */
export function isProtectedCategory(cat) {
  return cat != null && key(cat.name) === key(SUB_RECIPES_CATEGORY)
}

/** A branch copy of a head-office category: push_master_data sets its name again on every push. */
export function isHeadOfficeCopy(cat, inGroup) {
  return !!(inGroup && cat?.master_id)
}

export const HEAD_OFFICE_REASON = 'This category came from head office, and the next push from head office sets it back. Rename or remove it at head office.'
export const PROTECTED_REASON = 'Sub-Recipes is where Recipe Costing files every sub-recipe, and the app finds it by this name, so it is never renamed or removed.'
export const REMOVE_RANK_REASON = 'Removing a category moves its items and budgets, so it needs the account owner or an inventory manager.'

/**
 * Why Rename / Remove is off for a category, or null when it is on. `canRemove` is the login's
 * rank for removing (the Owner or an IMS manager); renaming needs only the page's own rank.
 */
export function categoryLock(cat, { inGroup = false, canRemove = false } = {}) {
  if (isProtectedCategory(cat)) return { rename: PROTECTED_REASON, remove: PROTECTED_REASON }
  if (isHeadOfficeCopy(cat, inGroup)) return { rename: HEAD_OFFICE_REASON, remove: HEAD_OFFICE_REASON }
  return { rename: null, remove: canRemove ? null : REMOVE_RANK_REASON }
}

/** Where a removed category's contents may go: any other category, never Sub-Recipes. */
export function removeTargets(categories, from) {
  return (categories || []).filter(c => c.id !== from?.id && !isProtectedCategory(c))
}

/** Item counts per category id from the item book (hidden items included): `{ [id]: { all, hidden } }`. */
export function itemCountsByCategory(items) {
  const counts = {}
  ;(items || []).forEach(i => {
    if (!i.category_id) return
    const c = counts[i.category_id] || (counts[i.category_id] = { all: 0, hidden: 0 })
    c.all += 1
    if (i.is_active === false) c.hidden += 1
  })
  return counts
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** "12 items (2 of them hidden)". */
export function itemCountText(n, hidden = 0) {
  if (!n) return 'no items'
  return `${plural(n, 'item', 'items')}${hidden > 0 ? ` (${hidden} of them hidden)` : ''}`
}

/** A target is needed exactly when the database says one is: items or budgets to move. */
export function removeNeedsTarget({ items = 0, budgets = 0 } = {}) {
  return items > 0 || budgets > 0
}

/** The confirm body for removing `from` (into `to`, when it holds anything), naming the counts. */
export function removeConsequence({ from, to, items = 0, hidden = 0, budgets = 0 }) {
  if (!removeNeedsTarget({ items, budgets })) {
    return `"${from.name}" holds no items and no monthly budgets, so it is simply removed from the list. Anyone assigned to count it in Stock Count loses that assignment. This cannot be undone.`
  }
  const what = [
    items > 0 ? itemCountText(items, hidden) : null,
    budgets > 0 ? `${plural(budgets, 'monthly budget', 'monthly budgets')} (in a month where "${to.name}" already has a budget, the two amounts are added together)` : null,
  ].filter(Boolean)
  const verb = what.length > 1 || items > 1 || budgets > 1 ? 'move' : 'moves'
  return `${what.join(' and ')} ${verb} from "${from.name}" to "${to.name}", and anyone assigned to count "${from.name}" in Stock Count is assigned to "${to.name}" instead. Then "${from.name}" is removed. Past purchases, counts and costs keep their figures; only the category they are filed under changes. This cannot be undone.`
}

/** The notice after merge_item_category answered, from the counts it returned. */
export function mergeResultText(fromName, toName, result) {
  const r = result || {}
  const parts = []
  if (r.items_moved > 0) parts.push(`${plural(r.items_moved, 'item', 'items')} moved`)
  if (r.budgets_merged > 0) parts.push(`${plural(r.budgets_merged, 'monthly budget', 'monthly budgets')} added to the ones already there`)
  if (r.budgets_moved > 0) parts.push(`${plural(r.budgets_moved, 'monthly budget', 'monthly budgets')} moved`)
  if (r.assignments_moved > 0) parts.push(`${plural(r.assignments_moved, 'stock counter assignment', 'stock counter assignments')} moved`)
  if (!parts.length || !toName) return `Removed "${fromName}".`
  return `Removed "${fromName}": ${parts.join(', ')} to "${toName}".`
}

/** The sort_order a new category takes: after every one on the list. */
export function nextSortOrder(categories) {
  const orders = (categories || []).filter(c => !isProtectedCategory(c)).map(c => Number(c.sort_order) || 0)
  return orders.length ? Math.max(...orders) + 1 : 0
}
