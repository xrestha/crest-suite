// The guest's cart against a fresh read of the menu's choices (S862 TILL-GUEST-4). Pure: no React,
// no Supabase, so the rule is tested on its own (guestCartCheck.test.js).
//
// The cart survives a reload in sessionStorage with its picks. A choice hidden in the meantime then
// dropped out of the order's words and price (describeSelection skips an id it does not know), while
// the line still carried it, so Place Order was refused and the whole dish taken off. The page had
// the exact test, but ran it only after a refusal. It now runs this after every successful read of
// the choices: a pick the dish no longer offers comes off the line (offeredPicks, the till window's
// rule), and a line that then fails the dish's rules (selectionProblems; a combo through
// comboLineProblem) comes off the order. Both are named in one note.

import { groupsForDish, selectionProblems } from '../../../shared/optionPricing'
import { offeredPicks, andList } from '../../../shared/offeredPicks'
import { comboLineProblem, comboCartKey } from './GuestComboSheet'

const MAX_QTY = 50

/**
 * @param {Record<string, object>} cart  lineKey -> { recipe_id, qty, option_ids } or a combo line
 *        { combo_id, qty, picks: [{ group_id, recipe_id, option_ids }] }
 * @param {{ groups, options, attachments, combos }} catalog  a successful get_guest_menu_options read
 * @param {{ keyOf: (recipeId, optionIds) => string, onMenu?: Set<string> }} opts  `keyOf` is the
 *        page's cart key; `onMenu`, when given, is the fresh menu's dishes (a dish not on it goes)
 * @returns {{ cart, changed: boolean,
 *            trimmed: Array<{ recipe_id, combo_id?, gone: string[] }>,
 *            dropped: Array<{ recipe_id?, combo_id?, reason: 'off_menu'|'choices'|'gone'|'changed' }> }}
 */
export function checkGuestCart(cart, catalog, { keyOf, onMenu = null } = {}) {
  const cat = catalog || {}
  const combosById = Object.fromEntries((cat.combos || []).map(c => [c.id, c]))
  const out = {}
  const trimmed = []
  const dropped = []
  let changed = false
  // Two lines can become one once a pick comes off (Large + Oat beside a plain Large).
  const put = (key, line) => {
    const prev = out[key]
    out[key] = prev ? { ...line, qty: Math.min(MAX_QTY, (Number(prev.qty) || 0) + (Number(line.qty) || 0)) } : line
  }

  for (const [key, line] of Object.entries(cart || {})) {
    if (!line) continue
    if (line.combo_id) {
      const gone = []
      const picks = (line.picks || []).map(p => {
        const split = offeredPicks(p.option_ids || [], groupsForDish(p.recipe_id, cat))
        if (split.gone.length) gone.push({ recipe_id: p.recipe_id, gone: split.gone })
        return { ...p, option_ids: split.kept }
      })
      const next = { ...line, picks }
      const problem = comboLineProblem(next, combosById, cat)
      if (problem) { dropped.push({ combo_id: line.combo_id, reason: problem }); changed = true; continue }
      if (gone.length) {
        gone.forEach(g => trimmed.push({ combo_id: line.combo_id, ...g }))
        changed = true
        put(comboCartKey(line.combo_id, picks), next)
      } else put(key, line)
      continue
    }
    if (onMenu && !onMenu.has(line.recipe_id)) { dropped.push({ recipe_id: line.recipe_id, reason: 'off_menu' }); changed = true; continue }
    const dg = groupsForDish(line.recipe_id, cat)
    const { kept, gone } = offeredPicks(line.option_ids || [], dg)
    if (selectionProblems(dg, kept).length) { dropped.push({ recipe_id: line.recipe_id, reason: 'choices' }); changed = true; continue }
    if (gone.length) {
      trimmed.push({ recipe_id: line.recipe_id, gone })
      changed = true
      put(keyOf(line.recipe_id, kept), { ...line, option_ids: kept })
    } else put(key, line)
  }
  return { cart: changed ? out : cart, changed, trimmed, dropped }
}

const capitalise = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
// Names, with the ones not known counted: "Cafe Latte and one more dish", "2 combos".
function nameList(names, noun) {
  const plural = noun === 'combo' ? 'combos' : 'dishes'
  const known = [...new Set(names.filter(Boolean))]
  const unknown = names.filter(n => !n).length
  if (unknown === 1) known.push(known.length ? `one more ${noun}` : `a ${noun}`)
  else if (unknown > 1) known.push(known.length ? `${unknown} more ${plural}` : `${unknown} ${plural}`)
  return andList(known)
}

/**
 * The note for the guest, or '' when nothing changed. `names` gives what the page knows:
 * { dishName(recipeId), comboName(comboId), optionName(optionId) }, each null when not known (a
 * choice hidden before this phone ever read it has no name here).
 */
export function cartCheckNote({ trimmed = [], dropped = [] } = {}, { dishName = () => null, comboName = () => null, optionName = () => null } = {}) {
  const parts = []
  if (trimmed.length) {
    const bits = trimmed.map(t => {
      const named = t.gone.map(optionName).filter(Boolean)
      const unnamed = t.gone.length - named.length
      const rest = unnamed === 1 ? [named.length ? 'one more choice' : 'a choice'] : unnamed > 1 ? [`${unnamed} choices`] : []
      return `${andList([...named, ...rest])} on ${dishName(t.recipe_id) || 'a dish'}`
    })
    const many = trimmed.length > 1 || trimmed[0].gone.length > 1
    parts.push(`${capitalise(andList(bits))} ${many ? 'are' : 'is'} no longer offered, so ${many ? 'they were' : 'it was'} taken off. ${trimmed.length > 1 ? 'The prices in your order are the new ones.' : 'The price in your order is the new one.'}`)
  }
  const off = dropped.filter(d => d.reason === 'off_menu' || d.reason === 'gone')
  const redo = dropped.filter(d => d.reason === 'choices' || d.reason === 'changed')
  const nameOf = d => (d.combo_id ? comboName(d.combo_id) : dishName(d.recipe_id))
  const nounOf = list => (list.every(d => d.combo_id) ? 'combo' : 'dish')
  if (off.length) {
    parts.push(`${capitalise(nameList(off.map(nameOf), nounOf(off)))} ${off.length > 1 ? 'are' : 'is'} no longer on the menu, so ${off.length > 1 ? 'they were' : 'it was'} taken off your order.`)
  }
  if (redo.length) {
    parts.push(`${capitalise(nameList(redo.map(nameOf), nounOf(redo)))} changed on the menu, so ${redo.length > 1 ? 'they were' : 'it was'} taken off your order. Add ${redo.length > 1 ? 'them' : 'it'} again with the new choices.`)
  }
  return parts.join(' ')
}
