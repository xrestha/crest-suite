import { exFromIncl, inclFromEx, dishesBelowZero, belowZeroText, groupShortfalls } from '../../shared/optionPricing'
import { andList } from '../../shared/offeredPicks'

// S862: the checks the Option Groups page and its dialogs share, so each way of showing, hiding or
// tightening a group says the same thing (SETUP-3), and the price rules of the option editor
// (SETUP-1, SETUP-5) can be tested without Supabase (optionChecks.test.js).

const toPaisa = n => Math.round((Number(n) || 0) * 100) / 100
const quoted = names => andList(names.map(n => `“${n}”`))
const MAX_NAMED = 3
const namedList = names => andList(names.length > MAX_NAMED
  ? [...names.slice(0, MAX_NAMED), `${names.length - MAX_NAMED} more`]
  : names)

// ── Prices (SETUP-1) ─────────────────────────────────────────────────────────────────────────────

/**
 * The one dish price a Size group is entered against as a full price, or null when its dishes
 * differ. Compared to the paisa: grouped to the rupee, 271.20 and 270.80 shared one box, and a
 * typed full price was measured from 271 rather than the dish's real 271.20.
 * @param {Array<{ inclPrice }>} dishes  the dishes the group is on, priced as the guest pays
 */
export function fullPriceBase(dishes) {
  const prices = new Set((dishes || []).map(d => toPaisa(d.inclPrice)))
  return prices.size === 1 ? [...prices][0] : null
}

/** The text the price box opens with: whole rupees, as every screen shows a choice. */
export function priceSeed({ option, base, vat }) {
  const stored = option ? inclFromEx(option.price_delta, vat) : 0
  if (base != null) return String(Math.round(base + stored))
  return option ? String(Math.round(stored)) : ''
}

/**
 * What a save does to an option's price (owner decision CU4 (a)). The box shows whole rupees, so
 * rebuilding the price from it on every save moved a stored 60.00 (67.80 to the guest) to 60.18 on
 * a save that only ticked Pre-selected. An untouched box and an unchanged “No …” now leave the
 * stored price exactly as it is; a new option left at its seed costs nothing extra (the dish price,
 * for a full-price size). A typed full price is measured from the dish price to the paisa, so it
 * bills as typed.
 * @returns {{ changed: boolean, deltaIncl: number, priceDelta: number|undefined, savedDelta: number }}
 *   `deltaIncl` as the guest pays it; `priceDelta` the value to write, undefined to leave the
 *   column out of the update; `savedDelta` what is stored once the save lands
 */
export function priceEntry({ option, seed, price, isRemoval, wasRemoval, base, vat }) {
  const changed = price !== seed || !!isRemoval !== !!wasRemoval
  const typed = price === '' ? 0 : Number(price)
  const deltaIncl = !changed
    ? (option ? inclFromEx(option.price_delta, vat) : 0)
    : (base != null ? typed - base : typed)
  const priceDelta = option && !changed ? undefined : isRemoval ? 0 : exFromIncl(deltaIncl, vat)
  const savedDelta = priceDelta === undefined ? (Number(option?.price_delta) || 0) : priceDelta
  return { changed, deltaIncl, priceDelta, savedDelta }
}

// ── Showing, hiding and tightening (SETUP-3) ─────────────────────────────────────────────────────

/**
 * S809 4h (CUSTOMIZATION-8): what taking an offered option away does to the dishes its group is
 * on, said before it happens. Too few left for a dish's minimum takes the dish off the till and the
 * QR menu (the server refuses it); none left drops the group, and the dish sells without it. Only
 * what THIS change causes is named: a dish already short is flagged on the group's card. Moved here
 * from the page in S862 so the option editor's Shown box asks the same question.
 */
export function optionLossText(o, catalog, nameOf = () => 'a dish') {
  const options = catalog?.options || []
  const attachments = catalog?.attachments || []
  const group = (catalog?.groups || []).find(g => g.id === o.group_id)
  if (!o.is_active || !group?.is_active) return null
  const after = options.map(x => (x.id === o.id ? { ...x, is_active: false } : x))
  const before = new Set(groupShortfalls(group, options, attachments).map(x => x.recipe_id))
  const short = groupShortfalls(group, after, attachments).filter(x => !before.has(x.recipe_id))
  const left = after.filter(x => x.group_id === group.id && x.is_active).length
  if (short.length) {
    return `${andList(short.map(x => `${nameOf(x.recipe_id)} must pick ${x.need}`))} from “${group.name}”, which would have ${left} left to pick. ${short.length === 1 ? 'It' : 'They'} can’t be ordered on the till or the QR menu until you show an option again or lower the rule.`
  }
  const on = attachments.filter(a => a.group_id === group.id)
  if (left === 0 && on.length) {
    return `Nothing would be left to pick in “${group.name}”, so ${andList(on.map(a => nameOf(a.recipe_id)))} would be ordered without it.`
  }
  return null
}

/** S835: Show again refused because a dish would go below zero (the page menu and Edit group). */
export function stillHiddenText(name, found) {
  return `“${name}” is still hidden. ${belowZeroText(found)}, and the till refuses a dish priced below zero. Change the prices with Edit first, or take the group off ${found.length === 1 ? 'that dish' : 'those dishes'}.`
}

/** Hide refused: the hidden group or choice was a paid pick a cheaper size leaned on. */
export function stillShownText(name, found) {
  return `“${name}” is still shown. Without it, ${belowZeroText(found)}, and the till refuses a dish priced below zero. Change the prices with Edit first.`
}

/** Delete refused for the same reason: deleting takes a group or choice away exactly as Hide does. */
export function notDeletedText(name, found) {
  return `“${name}” was not deleted. Without it, ${belowZeroText(found)}, and the till refuses a dish priced below zero. Change the prices with Edit first.`
}

/** The dishes hiding (or deleting) a group (`{ groupId }`) or an option (`{ optionId }`) takes below zero. */
export function hideBelowZero(dishes, catalog, { groupId, optionId }) {
  const off = (rows, id) => (rows || []).map(x => (x.id === id ? { ...x, is_active: false } : x))
  const after = groupId
    ? { ...catalog, groups: off(catalog?.groups, groupId) }
    : { ...catalog, options: off(catalog?.options, optionId) }
  return dishesBelowZero(dishes, after, { before: catalog })
}

/**
 * What saving the Edit group dialog does to the dishes the group is on. `next` is the group as
 * the dialog would save it (kind, min_select, max_select, included_count, is_active, size_scaling).
 * A kind change clears each dish's own rule for the group in the same save
 * (pos_option_group_kind_resets_rules), and a Size never keeps one, so both are priced that way.
 * @returns {{ belowZero: Array, short: Array<{ recipe_id, need, offered }> }}  only what this
 *   change lowers below zero, and only the dishes it newly makes unorderable
 */
export function groupEditEffects(group, next, catalog, dishes) {
  if (!group?.id || !catalog) return { belowZero: [], short: [] }
  const saved = (catalog.groups || []).find(g => g.id === group.id) || group
  const edited = { ...saved, ...next }
  const clearsRules = edited.kind !== saved.kind || edited.kind === 'size'
  const attachments = (catalog.attachments || []).map(a => (a.group_id === group.id && clearsRules
    ? { ...a, min_override: null, max_override: null }
    : a))
  const after = { ...catalog, groups: (catalog.groups || []).map(g => (g.id === group.id ? edited : g)), attachments }
  const was = new Set(groupShortfalls(saved, catalog.options, catalog.attachments).map(x => x.recipe_id))
  return {
    belowZero: dishesBelowZero(dishes, after, { before: catalog }),
    short: groupShortfalls(edited, catalog.options, attachments).filter(x => !was.has(x.recipe_id)),
  }
}

/** Edit group refused for a dish this change takes below zero. */
export function groupEditRefusal(name, found, { showing = false } = {}) {
  if (showing) return stillHiddenText(name, found)
  return `With this change, ${belowZeroText(found)}, and the till refuses a dish priced below zero. Nothing was saved. Change the option prices first, or keep the rule as it was.`
}

/** "Kids Momo must pick 2 from “Toppings”, which offers only 1 option. It cannot be ordered …" */
export function shortfallText(groupName, short, nameOf = () => 'a dish') {
  const offered = short[0]?.offered ?? 0
  return `${andList(short.map(x => `${nameOf(x.recipe_id)} must pick ${x.need}`))} from “${groupName}”, which offers only ${offered} option${offered === 1 ? '' : 's'}. ${short.length === 1 ? 'It' : 'They'} cannot be ordered on the till or the QR menu until the group has more options or a lower rule.`
}

// ── Two Size groups on one dish (SETUP-8) ────────────────────────────────────────────────────────
// The pricers multiply every chosen size's portion (pos_selection_portion_factor), so a dish with
// two Size groups asks for two sizes and a Large + Large scales its toppings by 2.25.

/** The Size groups a dish carries, as group rows. */
export function sizeGroupsOn(recipeId, attachments, groups) {
  const byId = new Map((groups || []).map(g => [g.id, g]))
  return (attachments || [])
    .filter(a => a.recipe_id === recipeId)
    .map(a => byId.get(a.group_id))
    .filter(g => g?.kind === 'size')
}

/** One dish, its ticked Size groups: said when there is more than one. */
export function twoSizesText(dishName, sizeNames) {
  if (sizeNames.length < 2) return null
  return `${dishName} would offer more than one size group, ${quoted(sizeNames)}. The till asks for a size from each and multiplies both portions, so keep one size group per dish.`
}

/** Putting Size group `group` on `dishes`: the ones that already carry another Size group. */
export function otherSizesText(group, dishes, attachments, groups) {
  if (group?.kind !== 'size') return null
  const clashing = []
  const others = new Set()
  for (const d of dishes || []) {
    const names = sizeGroupsOn(d.id, attachments, groups).filter(g => g.id !== group.id).map(g => g.name)
    if (!names.length) continue
    clashing.push(d.name)
    names.forEach(n => others.add(n))
  }
  if (!clashing.length) return null
  const one = clashing.length === 1
  return `${namedList(clashing)} already ${one ? 'offers' : 'offer'} another size group (${quoted([...others])}), so the till would ask for two sizes and multiply both portions. Keep one size group per dish.`
}

/** The build-your-own template on a dish that already offers a size: refused, naming it. */
export function templateSizeClashText(dishName, sizeNames) {
  if (!sizeNames.length) return null
  const one = sizeNames.length === 1
  return `${dishName} already offers a size group, ${quoted(sizeNames)}. The template adds another one, and the till would then ask for two sizes. Take ${one ? 'it' : 'them'} off the dish first with Choices on the Dishes tab. Running the template again adds new groups; it does not rename the ones a dish has.`
}
