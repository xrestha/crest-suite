// A choice's allergens in the guest's allergen filter (S877, owner decision: hide the CHOICE, not the
// dish).
//
// A choice carries its own allergens (get_guest_menu_options, pos_options.allergens, the 14 keys).
// Until S877 the filter read only the dish's, so a guest hiding milk still met "+ cheese" inside a
// dish they had been shown as safe. Now, while an allergen is hidden:
//   - every choice that carries one is taken out of the dish's choice sheet, and out of a combo's
//     dish, and is never the one picked for the guest by default;
//   - the dish itself leaves the menu only when it cannot be ordered without such a choice: a group
//     that must have a pick has none left, or fewer than its rule needs.
// A choice already on a line being changed stays on the sheet, so Update never drops a pick the guest
// can no longer see. A dish whose own allergen information is incomplete is judged as before (it is
// not offered under any allergen filter); this file only reads the choices.
// The till is not filtered: this is the guest menu only.

/** Whether one choice carries an allergen the guest is hiding. */
export function choiceHidden(option, excludedAllergens) {
  if (!excludedAllergens || excludedAllergens.length === 0) return false
  const own = Array.isArray(option?.allergens) ? option.allergens : []
  return own.some(a => excludedAllergens.includes(a))
}

/**
 * Whether a group's rule can still be met from these choices, the way the guest sheet lets a guest
 * pick: a one-pick group takes one choice; any other takes every "No …" removal (they never count
 * toward the maximum) and up to its maximum of the rest.
 */
export function ruleReachable(rule, options) {
  const min = Number(rule?.min) || 0
  if (min <= 0) return true
  const opts = options || []
  if (rule.max === 1) return min <= 1 && opts.length > 0
  const removals = opts.filter(o => o.is_removal).length
  const real = opts.length - removals
  return removals + (rule.max == null ? real : Math.min(real, rule.max)) >= min
}

/**
 * A dish's choice groups (groupsForDish's shape) as they are offered to a guest hiding these
 * allergens.
 * @param {Array<{ group, attachment, rule, options }>} dishGroups
 * @param {string[]} excludedAllergens
 * @param {{ keep?: string[] }} [opts]  option ids that stay whatever they carry (a line being changed)
 * @returns {{ groups: Array, hidden: number, orderable: boolean }}
 *   `groups`: each group with only its safe choices (and `hiddenCount`, how many went), a group left
 *   with none taken out as groupsForDish takes out an empty one; `hidden`: how many choices went;
 *   `orderable`: false when a group that lost choices can no longer meet its rule. With nothing
 *   hidden, the dish's own groups come back untouched.
 */
export function safeDishGroups(dishGroups, excludedAllergens, { keep = [] } = {}) {
  const groups = dishGroups || []
  if (!excludedAllergens || excludedAllergens.length === 0) return { groups, hidden: 0, orderable: true }
  const kept = new Set((keep || []).map(String))
  let hidden = 0
  let orderable = true
  const out = []
  for (const d of groups) {
    const options = (d.options || []).filter(o => kept.has(String(o.id)) || !choiceHidden(o, excludedAllergens))
    const gone = (d.options || []).length - options.length
    if (gone === 0) { out.push(d); continue }
    hidden += gone
    if (!ruleReachable(d.rule, options)) orderable = false
    if (options.length > 0) out.push({ ...d, options, hiddenCount: gone })
  }
  return { groups: hidden > 0 ? out : groups, hidden, orderable }
}

/** The sentence a sheet shows while the filter took choices out of it. */
export const HIDDEN_CHOICES_NOTE = 'Some choices are hidden because of your allergen filter.'
