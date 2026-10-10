// A dish's picks against what the menu offers now (S809 3o, CUSTOMIZATION-2).
//
// Hiding a sold-out choice mid-service is what Option Groups recommends ("To stop offering it for
// now, use Hide"), and save_pos_order_items refuses a NEW line that carries a choice the dish no
// longer offers (option_not_on_menu): one hidden, deleted, or in a group hidden or taken off the
// dish. The choice window used to start from the line's own picks as they were, list only the
// offered ones, and hand every id back on Update dish, so the hidden one stayed on the line, the
// window could neither show nor remove it, and every save of the whole order was refused. The
// window and the cart now both read a selection through `offeredPicks`, and both name what was
// dropped with `goneChoicesText`.
//
// `dishGroups` is groupsForDish's shape (optionPricing.js): only attached, active groups with
// their active options, which is exactly the set the server accepts.

/**
 * A selection split into the picks the dish still offers and the ones it does not. Order is kept,
 * ids compare as strings (a cart line holds them as strings, the catalog as uuids).
 * @param {Array<string>} optionIds
 * @param {Array<{ options: Array<{ id }> }>} dishGroups  [] or null when the dish offers nothing
 * @returns {{ kept: string[], gone: string[] }}
 */
export function offeredPicks(optionIds, dishGroups) {
  const offered = new Set((dishGroups || []).flatMap(d => (d.options || []).map(o => String(o.id))))
  const kept = []
  const gone = []
  for (const id of optionIds || []) {
    if (id == null || id === '') continue
    ;(offered.has(String(id)) ? kept : gone).push(id)
  }
  return { kept, gone }
}

/** "Granola", "Granola and Banana", "Granola, Banana and Mango". */
export function andList(parts) {
  const xs = (parts || []).filter(Boolean)
  if (xs.length <= 1) return xs[0] || ''
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/**
 * The names of picks that were dropped, for a sentence. A hidden option is still in the catalog
 * (loadOptionCatalog reads hidden rows too); a deleted one, or every one while Customization is
 * switched off, is named from the line's own choices (`lineOptions`: the cart line's `options`,
 * from describeSelection or the bill's snapshot). An id neither knows is "a choice deleted from
 * the menu", never left out, so the sentence never says less was taken off than was.
 * @param {string[]} ids
 * @param {Record<string, { name }>} optionsById
 * @param {Array<{ option_id, option_name }>} lineOptions
 * @returns {string}  "Granola and Banana", "Granola and 2 choices deleted from the menu"
 */
export function goneChoicesText(ids, optionsById, lineOptions) {
  const fromLine = new Map((lineOptions || []).map(o => [String(o.option_id), o.option_name]))
  const named = []
  let unknown = 0
  for (const id of ids || []) {
    const name = optionsById?.[id]?.name || fromLine.get(String(id))
    if (name) named.push(name)
    else unknown++
  }
  if (unknown === 1) named.push('a choice deleted from the menu')
  else if (unknown > 1) named.push(`${unknown} choices deleted from the menu`)
  return andList(named)
}
