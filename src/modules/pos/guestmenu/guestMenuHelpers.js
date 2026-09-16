// Pure helpers behind the guest QR menu (S767). No React, no Supabase, so each rule is tested on
// its own (guestMenuHelpers.test.js).

// ── Names ────────────────────────────────────────────────────────────────────────────────────────
// Owner decision (S767): a dish name typed entirely in capitals on the till ("PANI POORI") shows on
// the guest menu as "Pani Poori". A name with ANY lowercase letter is left exactly as the owner
// typed it, and the till, bills and reports never change. Applied to dish, choice and category
// names and to the outlet-name fallback.
//
// A word with no vowel is kept as it is (BBQ, XL, KFC) — those are abbreviations, and title-casing
// them ("Bbq") is worse than leaving them loud. Short joining words go lowercase after the first word.
const MINOR_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])

export function tidyName(value) {
  if (typeof value !== 'string') return value
  if (!/[A-Z]/.test(value) || /[a-z]/.test(value)) return value
  let index = 0
  return value.replace(/[A-Za-z][A-Za-z']*/g, word => {
    const i = index++
    if (word.length > 1 && !/[AEIOUY]/.test(word)) return word
    const lower = word.toLowerCase()
    if (i > 0 && MINOR_WORDS.has(lower)) return lower
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  })
}

// ── Section order ────────────────────────────────────────────────────────────────────────────────
// Owner decision (S767): menu sections follow the Recipe Categories list (settings.recipe_categories,
// or the app's default list when the client never saved one). A category on the menu but not on the
// list keeps its incoming (alphabetical) position after the listed ones; the no-category group is
// always last. Matching is case-insensitive, as the Settings list itself compares.
export function orderCategories(present, categoryOrder, defaults = [], lastKey = null) {
  const list = Array.isArray(categoryOrder) && categoryOrder.length > 0 ? categoryOrder : defaults
  const rank = new Map()
  list.forEach((c, i) => {
    const key = String(c ?? '').trim().toLowerCase()
    if (key && !rank.has(key)) rank.set(key, i)
  })
  const rankOf = c => (c === lastKey ? Infinity : rank.get(String(c ?? '').trim().toLowerCase()) ?? list.length)
  return present
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rankOf(a.c) - rankOf(b.c)) || (a.i - b.i))
    .map(x => x.c)
}

/**
 * The stored category list with a new order for the categories on the menu, leaving every other
 * category where it was. Categories on the menu but missing from the list are appended in their
 * new order. Used by POS Setup → Guest Menu, which reorders sections without seeing the whole list.
 */
export function reorderCategoryList(stored, menuOrder) {
  const base = Array.isArray(stored) ? [...stored] : []
  const lower = s => String(s ?? '').trim().toLowerCase()
  const onMenu = new Set(menuOrder.map(lower))
  const queue = [...menuOrder]
  const result = base.map(c => {
    if (!onMenu.has(lower(c))) return c
    const next = queue.shift()
    return next
  })
  for (const c of queue) result.push(c)
  // A category present in `base` twice would otherwise be written twice.
  const seen = new Set()
  return result.filter(c => {
    const k = lower(c)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────────
// A search box appears once a menu is long enough that scrolling stops being a way to find a dish.
export const SEARCH_THRESHOLD = 30

export function normaliseForSearch(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

export function matchesSearch(item, query) {
  const q = normaliseForSearch(query)
  if (!q) return true
  return [item?.name, item?.description, item?.category].some(v => normaliseForSearch(v).includes(q))
}

// ── The order tracker ────────────────────────────────────────────────────────────────────────────
// Five stages a guest can watch, then one of two endings.
export const STAGES = ['placed', 'confirmed', 'kot_sent', 'preparing', 'ready']
export const STAGE_SHORT = { placed: 'Sent', confirmed: 'Accepted', kot_sent: 'In kitchen', preparing: 'Cooking', ready: 'Ready' }

const STAGE_RANK = { placed: 0, confirmed: 1, kot_sent: 2, preparing: 3, ready: 4, done: 5, dismissed: 5 }

/**
 * The stage of THIS guest's order. `orderClosed` is the bill that took it being closed (paid, void
 * or written off) — the tracker's ending, where it used to fall back to "heading to the kitchen".
 * Kitchen status only counts once staff accepted the request: before that, any ticket on the table
 * belongs to somebody else's round.
 */
export function stageFromProgress({ requestStatus, kotStatus, orderClosed }) {
  if (requestStatus === 'dismissed') return 'dismissed'
  if (requestStatus !== 'accepted') return 'placed'
  if (orderClosed) return 'done'
  if (kotStatus === 'ready' || kotStatus === 'served') return 'ready'
  if (kotStatus === 'in_progress') return 'preparing'
  if (kotStatus === 'new') return 'kot_sent'
  return 'confirmed'
}

/** The later of two stages. The tracker never moves backwards, and never chimes for a step back. */
export function laterStage(previous, next) {
  if (!previous) return next
  if (!next) return previous
  return (STAGE_RANK[next] ?? 0) >= (STAGE_RANK[previous] ?? 0) ? next : previous
}

// ── Choice rules ─────────────────────────────────────────────────────────────────────────────────
// Rule wording for a guest: sentence case, no "Optional ·" prefix. A maximum above the number of
// choices the group actually offers is capped to it — "Pick 2 to 10" for a group of three reads as
// a promise of seven choices nobody can see.
export function guestRuleText({ min, max }, optionCount = Infinity) {
  const cap = Number.isFinite(optionCount) && optionCount > 0 ? optionCount : Infinity
  const hi = max == null ? null : Math.min(max, cap)
  if (hi === 1) return 'Pick 1'
  if (min > 0 && hi != null && min >= hi) return `Pick ${hi}`
  if (min > 0 && hi != null) return `Pick ${min} to ${hi}`
  if (min > 0) return `Pick at least ${min}`
  // No minimum and a maximum that covers every choice: there is no limit worth stating.
  if (hi != null && hi < cap) return `Pick up to ${hi}`
  return 'Pick any'
}
