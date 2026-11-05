// The Add Item form's rules that a second writer of `items` must share (S885): the Excel import
// mints codes, checks units and works out a pack price exactly as the form does. They lived inside
// Items.js until the import needed them; Items.js re-exports nextCodeAfter for Items.test.js.

export const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

// The category the app files every sub-recipe mirror under, found by this exact name (Recipes.js,
// push_master_data). Nothing typed by a person is ever filed there, and it is never renamed.
export const SUB_RECIPES_CATEGORY = 'Sub-Recipes'

// S756: the code prefix is a free-text setting, and it went into `new RegExp` raw — so "A+" made
// the pattern mean "one or more A", and "V.N" matched "VXN-004" too. A misparse mints off the wrong
// max (a duplicate code); a prefix like "(" throws and takes Add Item down with it.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The next `PREFIX-NNN` after the highest one in `codes`. */
export function nextCodeAfter(rawPrefix, codes) {
  const prefix = String(rawPrefix).toUpperCase()
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`)
  let maxNum = 0
  ;(codes || []).forEach(code => {
    const match = String(code || '').match(re)
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
  })
  return `${prefix}-${String(maxNum + 1).padStart(3, '0')}`
}

// ONE derivation feeds the form's "→ NPR x per uom" preview, the rate the form writes and the rate
// an imported pack row writes (S623: two copies of this division once had different rounding).
// Number(), not parseFloat: a prefix parse of a not-quite-numeric string ("5oo" → 5, "1,200" → 1)
// must never price an item.
export function perUnitOf(qty, total) {
  const q = Number(qty), t = Number(total)
  return q > 0 && t > 0 ? Number((t / q).toFixed(6)) : null
}

/** The key two item names are compared on: case and spacing ignored, as the unique index does case. */
export function itemNameKey(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}
