// Combos on the till's order screen (S839, docs/pos-combos.md): the pure half, tested in
// comboCart.test.js. A combo on a bill is not a line of its own. Each picked dish is an ordinary cart
// line carrying a share of the combo's price and the combo's tag (combo_line_id plus its pick), so it
// prints on its own station and takes its own recipe's stock. Everything here keeps the dishes of one
// combo together: built together, shown as one block, and counted, comped and moved as one unit,
// because the server refuses a combo that is not whole (combo_incomplete, combo_comp_whole,
// combo_move_whole). The till never prices a combo dish for the bill: the prices built here are the
// display twin (comboPricing.js) until the save answers with the server's lines.

import { fetchAllRows } from '../../../shared/fetchAllRows'
import { comboShares, comboDishBasePrice } from '../../customization/comboPricing'
import {
  vatOf, selectionKeyOf, comboSuffixOf, optionPartOfKey, isComboLine, comboFieldsOf, lineKeyOf, lineOptionIds,
  sentQtyAfterQtyChange,
} from './posOrdersConstants'

// The menu tab the combos sit in. A key no recipe category can take, with its own label.
export const COMBO_TAB = '__combos'
export const COMBO_TAB_LABEL = 'Combos'

const lower = v => (v == null ? '' : String(v).toLowerCase())
const num = v => Number(v) || 0
const round2 = n => Math.round(n * 100) / 100

// By sort, then id in byte order, as Postgres orders a uuid (the server's combo_sort and its split).
const bySortThenId = (a, b) => (num(a.sort) - num(b.sort)) || (lower(a.id) < lower(b.id) ? -1 : lower(a.id) > lower(b.id) ? 1 : 0)

// ── Reading the outlet's combos ──────────────────────────────────────────────────────────────────

const COMBO_COLS = 'id, name, guest_price, description, sort'
const PICK_COLS = 'id, combo_id, name, sort'
const DISH_COLS = 'id, group_id, recipe_id, extra_price, is_default, sort'
// The till's own menu columns: a combo dish need not be On POS or priced on its own (a side sold only
// in combos), so its name, category (for KOT/BOT routing) and VAT rate are read here by id. Read whether
// active or not: an inactive dish is not offered, but it still weighs in its pick's share of the price,
// as the server's split counts every dish of the pick (pos_combo_shares).
const DISH_RECIPE_COLS = 'id, name, category, recipe_code, selling_price, vat_rate, is_active'

/** A read that failed because the combo tables are not in this database yet (the bundle ran ahead). */
export function isMissingTable(error) {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || /relation .* does not exist|Could not find the table/i.test(error.message || '')
}

/**
 * The outlet's active combos, nested and ready for the till, plus the recipe row of every dish they
 * offer: { error, combos, recipes: { [recipeId]: row } }. A failed read is a failed menu read (the
 * caller keeps its last menu); the tables not deployed yet read as no combos.
 */
export async function loadComboCatalog(scopedFrom) {
  const results = await Promise.all([
    fetchAllRows(() => scopedFrom('pos_combos', COMBO_COLS).eq('is_active', true).order('sort').order('id')),
    fetchAllRows(() => scopedFrom('pos_combo_groups', PICK_COLS).order('sort').order('id')),
    fetchAllRows(() => scopedFrom('pos_combo_items', DISH_COLS).order('sort').order('id')),
  ])
  const failed = results.find(r => r.error)
  if (failed) return isMissingTable(failed.error) ? { error: null, combos: [], recipes: {} } : { error: failed.error, combos: [], recipes: {} }
  const [{ data: combos }, { data: groups }, { data: items }] = results
  const ids = [...new Set((items || []).map(i => i.recipe_id).filter(Boolean))]
  let recipes = {}
  if ((combos || []).length > 0 && ids.length > 0) {
    const r = await fetchAllRows(() => scopedFrom('recipes', DISH_RECIPE_COLS).in('id', ids).order('id'))
    if (r.error) return { error: r.error, combos: [], recipes: {} }
    recipes = Object.fromEntries((r.data || []).map(row => [row.id, row]))
  }
  return { error: null, combos: nestCombos({ combos, groups, items, recipeOf: id => recipes[id] }), recipes }
}

// A dish the till may offer in a combo: readable, active, and not a Sub-Recipe.
const offerable = r => !!r && r.is_active !== false && r.category !== 'Sub-Recipe'

/**
 * Combos with their picks and each pick's dishes, in the server's order. A dish whose recipe is not
 * offerable (inactive since, or unreadable) is left out of `items`, and a combo with a pick left empty
 * is left out whole, since it could never be completed (combo_incomplete). `share_items` keeps every
 * dish of the pick, for the price split (comboSharesOf).
 */
export function nestCombos({ combos, groups, items, recipeOf }) {
  const dishesOf = new Map()
  const allOf = new Map()
  for (const it of items || []) {
    const dish = { id: it.id, recipe_id: it.recipe_id, extra_price: num(it.extra_price), is_default: !!it.is_default, sort: num(it.sort) }
    if (!allOf.has(it.group_id)) allOf.set(it.group_id, [])
    allOf.get(it.group_id).push(dish)
    if (!offerable(recipeOf(it.recipe_id))) continue
    if (!dishesOf.has(it.group_id)) dishesOf.set(it.group_id, [])
    dishesOf.get(it.group_id).push(dish)
  }
  const picksOf = new Map()
  for (const g of groups || []) {
    if (!picksOf.has(g.combo_id)) picksOf.set(g.combo_id, [])
    const dishes = (dishesOf.get(g.id) || []).sort((a, b) => (a.sort - b.sort)
      || String(recipeOf(a.recipe_id)?.name || '').localeCompare(String(recipeOf(b.recipe_id)?.name || '')) || bySortThenId(a, b))
    picksOf.get(g.combo_id).push({ id: g.id, name: g.name, sort: num(g.sort), items: dishes, share_items: allOf.get(g.id) || dishes })
  }
  return (combos || [])
    .map(c => ({
      id: c.id, name: c.name, guest_price: num(c.guest_price), description: c.description || '', sort: num(c.sort),
      groups: (picksOf.get(c.id) || []).sort(bySortThenId),
    }))
    .filter(c => c.groups.length > 0 && c.groups.every(g => g.items.length > 0))
    .sort((a, b) => (a.sort - b.sort) || String(a.name).localeCompare(String(b.name)))
}

// ── Building a combo's lines ─────────────────────────────────────────────────────────────────────

/** Each pick's share of the combo price, over every dish of the pick (offered or not), as the server splits it. */
export function comboSharesOf(combo, recipeOf, vatReg) {
  return comboShares({ ...combo, groups: (combo?.groups || []).map(g => ({ ...g, items: g.share_items || g.items })) }, recipeOf, vatReg)
}

/** The dish a pick starts on: the one the owner marked default, else the first. */
export const defaultDishOf = group => (group?.items || []).find(i => i.is_default) || group?.items?.[0] || null

/** A set meal (every pick one dish) whose dishes need no choice of their own adds in one tap. */
export function comboAddsInOneTap(combo, needsChoice) {
  const groups = combo?.groups || []
  return groups.length > 0 && groups.every(g => g.items.length === 1 && !needsChoice(g.items[0].recipe_id))
}

/** Each pick's default dish with that dish's default choices: [{ group_id, recipe_id, option_ids }]. */
export function defaultComboPicks(combo, defaultIdsOf) {
  return (combo?.groups || []).map(g => {
    const d = defaultDishOf(g)
    return { group_id: g.id, recipe_id: d?.recipe_id || null, option_ids: d ? (defaultIdsOf(d.recipe_id) || []) : [] }
  })
}

/**
 * One combo dish as a cart line. Its selection key is its own choices, then '@<combo_line_id>/<pick>'
 * (the server's key, docs/pos-combos.md), set on the line so every comp, move and match keys it the
 * way the server does. unit_price is the display twin: (share + extra) ex-VAT plus its choices.
 * `describe(recipeId, optionIds)` → { delta, summary, options } prices the dish's own choices.
 */
export function comboDishLine({ combo, group, item, recipe, vatReg, share, qty = 1, lineId, optionIds = [], describe = null }) {
  const vat = vatReg ? vatOf(recipe) : 0
  const ids = (optionIds || []).filter(Boolean).map(String).sort()
  const base = comboDishBasePrice(share, item?.extra_price, vat)
  const desc = ids.length && describe ? describe(recipe.id, ids) : null
  const delta = desc ? num(desc.delta) : 0
  const line = {
    recipe_id: recipe.id, name: recipe.name, category: recipe.category || 'Other',
    qty, unit_price: round2(base + delta), vat_rate: vat,
    sent_to_kot: false, sent_qty: 0, notes: '',
    option_ids: ids,
    ...(ids.length ? { base_unit_price: base, options_delta: delta, option_summary: desc?.summary || '', options: desc?.options || [] } : {}),
    combo_line_id: lower(lineId), combo_id: combo.id, combo_name: combo.name, combo_price: num(combo.guest_price),
    combo_group_id: group.id, combo_group_name: group.name, combo_sort: num(group.sort),
  }
  line.selection_key = selectionKeyOf(ids) + comboSuffixOf(line)
  return line
}

/**
 * Every dish of one combo, one per pick in pick order, at the same quantity; null when a pick has no
 * dish of the combo's (the caller then has nothing whole to add).
 * `picks`: [{ group_id, recipe_id, option_ids }]; `recipeOf(id)` the dish's recipe row.
 */
export function buildComboLines({ combo, picks, recipeOf, vatReg, qty = 1, lineId, describe = null }) {
  const groups = [...(combo?.groups || [])].sort(bySortThenId)
  if (groups.length === 0) return null
  const shares = comboSharesOf(combo, recipeOf, vatReg)
  const out = []
  for (const g of groups) {
    const pick = (picks || []).find(p => p.group_id === g.id)
    const item = pick && g.items.find(i => i.recipe_id === pick.recipe_id)
    const recipe = item && recipeOf(item.recipe_id)
    if (!recipe) return null
    out.push(comboDishLine({ combo, group: g, item, recipe, vatReg, share: shares[g.id], qty, lineId, optionIds: pick.option_ids, describe }))
  }
  return out
}

// ── One combo on the cart ────────────────────────────────────────────────────────────────────────

/** The combo a dish belongs to (its combo_line_id, lowercase), or '' for any other line. */
export function comboIdOf(i) {
  if (!i) return ''
  if (i.combo_line_id || i.combo?.line_id) return lower(i.combo_line_id || i.combo.line_id)
  const key = String(i.selection_key || '')
  const at = key.indexOf('@')
  return at >= 0 ? lower(key.slice(at + 1).split('/')[0]) : ''
}

/** The pick a combo dish fills (its combo_group_id, lowercase). */
export function comboGroupOf(i) {
  if (!i) return ''
  if (i.combo_group_id || i.combo?.group_id) return lower(i.combo_group_id || i.combo.group_id)
  const key = String(i.selection_key || '')
  const at = key.indexOf('@')
  return at >= 0 ? lower(key.slice(at + 1).split('/')[1] || '') : ''
}

const isUnsent = i => !i.sent_to_kot && !(num(i.sent_qty) > 0)
const kitchenQtyOf = i => (i.sent_to_kot ? num(i.qty) : num(i.sent_qty))

/**
 * The cart's combos, by combo_line_id: { id, combo_id, name, price, qty, firstIdx, dishes: [{ item, idx }] },
 * the dishes in pick order. A block shows where its first dish sits in the cart.
 */
export function groupComboBlocks(items) {
  const blocks = new Map()
  ;(items || []).forEach((item, idx) => {
    if (!isComboLine(item)) return
    const id = comboIdOf(item)
    if (!id) return
    let b = blocks.get(id)
    if (!b) {
      b = { id, combo_id: item.combo_id || null, name: item.combo_name || 'Combo', price: item.combo_price ?? null, qty: num(item.qty), firstIdx: idx, dishes: [] }
      blocks.set(id, b)
    }
    if (!b.combo_id && item.combo_id) b.combo_id = item.combo_id
    if (b.name === 'Combo' && item.combo_name) b.name = item.combo_name
    b.dishes.push({ item, idx })
  })
  for (const b of blocks.values()) b.dishes.sort((x, y) => (num(x.item.combo_sort) - num(y.item.combo_sort)) || (x.idx - y.idx))
  return blocks
}

/**
 * The cart as rows to list: a plain line as { kind: 'line', item, idx }, a combo once, at its first
 * dish, as { kind: 'combo', block }. The comp panel and the cart both read this.
 */
export function cartRows(items) {
  const blocks = groupComboBlocks(items)
  const rows = []
  ;(items || []).forEach((item, idx) => {
    if (!isComboLine(item) || !comboIdOf(item)) { rows.push({ kind: 'line', item, idx }); return }
    const b = blocks.get(comboIdOf(item))
    if (b && b.firstIdx === idx) rows.push({ kind: 'combo', block: b })
  })
  return rows
}

// What makes two combos the same order: the combo, and each pick's dish and choices.
const dishSig = i => `${comboGroupOf(i)}:${i.recipe_id}:${optionPartOfKey(i.selection_key || selectionKeyOf(i.option_ids))}`
export function comboSignature(lines) {
  const list = lines || []
  if (list.length === 0) return ''
  return `${lower(list[0].combo_id)}|${list.map(dishSig).sort().join(',')}`
}

/**
 * The cart with a new combo's lines added: onto an identical combo not sent yet (same combo, same
 * dishes, same choices) as more of it, else as a combo of its own at the end.
 */
export function addComboLinesToCart(cart, lines) {
  if (!lines?.length) return cart
  const sig = comboSignature(lines)
  const add = num(lines[0].qty) || 1
  for (const b of groupComboBlocks(cart).values()) {
    const dishes = b.dishes.map(d => d.item)
    if (dishes.length === lines.length && dishes.every(isUnsent) && comboSignature(dishes) === sig) {
      return cart.map(i => (comboIdOf(i) === b.id ? { ...i, qty: num(i.qty) + add } : i))
    }
  }
  return [...cart, ...lines]
}

/**
 * Every dish of one combo set to `qty` together (0 takes the whole combo off), each dish's sent count
 * moving the way a plain line's does (sentQtyAfterQtyChange). `pullSavedOf(item)` as PosOrders' pullIsSaved.
 */
export function setComboQtyIn(items, lineId, qty, pullSavedOf = () => false) {
  const id = lower(lineId)
  if (qty <= 0) return (items || []).filter(i => comboIdOf(i) !== id)
  return (items || []).map(i => (comboIdOf(i) !== id ? i : {
    ...i, qty, sent_to_kot: num(i.qty) === qty ? i.sent_to_kot : false, sent_qty: sentQtyAfterQtyChange(i, qty, pullSavedOf(i)),
  }))
}

/** How many of a combo the kitchen already has beyond `qty`: what setting it to `qty` pulls. */
export function comboUnitsPulled(items, lineId, qty) {
  const id = lower(lineId)
  let pulled = 0
  for (const i of items || []) {
    if (comboIdOf(i) !== id) continue
    pulled = Math.max(pulled, Math.min(kitchenQtyOf(i), num(i.qty)) - Math.max(0, qty))
  }
  return Math.max(0, pulled)
}

/**
 * The cart with one pick of a combo given another dish (a Swap): the new line takes the old one's
 * place, quantity and note. The old dish leaves the cart, sent or not; a sent one is recorded as
 * pulled by the save, and the new dish goes on the next ticket. Unchanged when it is the same dish
 * with the same choices.
 */
export function swapComboDish(items, lineId, groupId, newLine) {
  const id = lower(lineId), gid = lower(groupId)
  const at = (items || []).findIndex(i => comboIdOf(i) === id && comboGroupOf(i) === gid)
  if (at < 0 || !newLine) return items
  const old = items[at]
  if (lineKeyOf(old) === lineKeyOf(newLine)) return items
  const next = { ...newLine, qty: old.qty, notes: old.notes || '' }
  return [...items.slice(0, at), next, ...items.slice(at + 1)]
}

/** The dish a pick of a combo on the cart holds now, as the picker's starting picks. */
export function picksOfCombo(items, lineId) {
  const id = lower(lineId)
  return (items || []).filter(i => comboIdOf(i) === id).map(i => ({
    group_id: i.combo_group_id || comboGroupOf(i), recipe_id: i.recipe_id, option_ids: lineOptionIds(i),
  }))
}

// ── Moves and part bills (S836): a combo moves whole ─────────────────────────────────────────────

/**
 * The bill's stored lines for the move picker, each combo as ONE row (id 'combo:<combo_line_id>',
 * the combo's name and quantity, its dishes listed underneath) so it can only be picked whole. A
 * comped row is left as it is (the picker leaves comped rows out).
 */
export function collapseCombosForMove(lines) {
  const out = []
  const rows = new Map()
  for (const l of lines || []) {
    if (!isComboLine(l) || l.comped || !comboIdOf(l)) { out.push(l); continue }
    const id = comboIdOf(l)
    let row = rows.get(id)
    if (!row) {
      row = { id: `combo:${id}`, combo_line_id: id, name: l.combo_name || 'Combo', combo_dishes: [] }
      rows.set(id, row)
      out.push(row)
    }
    row.combo_dishes.push(l)
  }
  for (const row of rows.values()) {
    const dishes = row.combo_dishes.sort((a, b) => num(a.combo_sort) - num(b.combo_sort))
    row.qty = Math.min(...dishes.map(d => num(d.qty)))
    row.sent_qty = Math.min(...dishes.map(d => Math.min(num(d.sent_qty), num(d.qty))))
    row.option_summary = dishes.map(d => d.name + (d.option_summary ? ` (${d.option_summary})` : '')).join(' · ')
  }
  return out
}

/** The move picker's picks with each combo row turned back into every one of its dishes, same qty. */
export function expandComboPicks(picks, lines) {
  const combos = new Map((lines || []).filter(l => Array.isArray(l.combo_dishes)).map(l => [l.id, l]))
  return (picks || []).flatMap(p => {
    const row = combos.get(p.item_id)
    return row ? row.combo_dishes.map(d => ({ item_id: d.id, qty: p.qty })) : [p]
  })
}

// ── Guest QR orders ──────────────────────────────────────────────────────────────────────────────

/**
 * A guest request item as the cart reads it: a combo dish (it carries `combo`) gets the combo's tag
 * and its full selection key, keeping the request's line_id so its dishes stay one combo. Any other
 * item comes back as it was.
 */
export function guestLineOf(it) {
  if (!it || !(it.combo?.line_id || it.combo_line_id)) return it
  const fields = comboFieldsOf(it)
  const ids = (Array.isArray(it.option_ids) && it.option_ids.length
    ? it.option_ids : optionPartOfKey(it.selection_key).split('+')).filter(Boolean).map(String).sort()
  const out = { ...it, ...fields, combo_line_id: lower(fields.combo_line_id), option_ids: ids }
  out.selection_key = selectionKeyOf(ids) + comboSuffixOf(out)
  return out
}

/** What a guest asked for, as the banner says it: "2× Tea, 1× Momo Combo: Chicken Momo (Extra cheese) + Coke". */
export function guestRequestText(items) {
  const parts = []
  const combos = new Map()
  const dishText = it => `${it.name}${it.option_summary ? ` (${it.option_summary})` : ''}`
  for (const it of items || []) {
    const id = lower(it?.combo?.line_id || it?.combo_line_id)
    if (!id) { parts.push(`${it.qty}× ${dishText(it)}`); continue }
    let c = combos.get(id)
    if (!c) {
      c = { qty: it.qty, name: it.combo?.name || it.combo_name || 'Combo', dishes: [] }
      combos.set(id, c)
      parts.push(c)
    }
    c.dishes.push({ sort: num(it.combo?.sort ?? it.combo_sort), text: dishText(it) })
  }
  return parts.map(p => (typeof p === 'string' ? p
    : `${p.qty}× ${p.name}: ${p.dishes.sort((a, b) => a.sort - b.sort).map(d => d.text).join(' + ')}`)).join(', ')
}
