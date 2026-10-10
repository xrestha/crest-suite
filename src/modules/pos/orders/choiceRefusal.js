import { selectionProblems } from '../../../shared/optionPricing'
import { offeredPicks, goneChoicesText, andList } from '../../../shared/offeredPicks'
import { lineOptionIds } from './posOrdersConstants'

// A choice the menu no longer offers, on the till (S809 3o, CUSTOMIZATION-2). Pure, so the order
// screen's two uses (the refusal sentence and the mark on the cart line) are tested here.
//
// save_pos_order_items checks the choices of every NEW line only (a line key not already on the
// order): each pick must still be offered on that dish (option_not_on_menu), and each group the
// dish offers must get a number of picks its rule allows (option_count). A line already saved keeps
// its exemption, so the till marks only the lines the next save will check.

/**
 * What is wrong with a cart line's choices against the menu on screen, as the next save would see
 * it, or null. A pick the dish no longer offers comes first: Change takes it off (the choice window
 * starts from the offered picks only), and with nothing offered the line goes plain.
 * @param {object} line  a cart line (option_ids / selection_key, options, selection_key)
 * @param {Array|undefined} dishGroups  groupsForDish for the line's dish; undefined = offers none
 * @param {Record<string, { name }>} optionsById  the till's option catalog, hidden options included
 * @returns {null | { gone: string[], text: string }}
 */
export function lineChoiceTrouble(line, dishGroups, optionsById) {
  const ids = lineOptionIds(line || {})
  const { kept, gone } = offeredPicks(ids, dishGroups)
  if (gone.length > 0) {
    const names = goneChoicesText(gone, optionsById, line?.options)
    return { gone, text: `No longer offered: ${names}. Tap Change to take ${gone.length === 1 ? 'it' : 'them'} off.` }
  }
  const problem = selectionProblems(dishGroups || [], kept)[0]
  if (!problem) return null
  const button = line?.selection_key ? 'Change' : 'Choices'
  const short = problem.count < (Number(problem.rule?.min) || 0)
  return {
    gone: [],
    text: short
      ? `Choose ${problem.rule.min - problem.count} more from ${problem.group.name}. Tap ${button} to pick.`
      : `Too many picked in ${problem.group.name}. Tap ${button} to fix it.`,
  }
}

// The two refusal sentences, as save_pos_order_items raises them (live since S809 2h):
//   option_not_on_menu: an option chosen for <dish>[, <dish>…] is no longer offered on it — …
//   option_count: the choices do not fit what the dish allows (<dish>: <group>[; …]) — …
const NOT_OFFERED_RE = /an option chosen for (.+) is no longer offered/
const COUNT_RE = /what the dish allows \((.+)\) — change/

const isCode = (err, code) => err?.hint === code || new RegExp(`^${code}:`).test(String(err?.message || ''))

/**
 * The order screen's whole sentence for a choices refusal, naming the dish(es) the server named;
 * null when the error is not one of the two or its message has no names (the caller then falls
 * back to errorText). "Nothing on this order was saved" is earned: the function raises inside its
 * own transaction, before it writes anything, so the other dishes on the order did not save either.
 */
export function choiceRefusalText(err) {
  const msg = String(err?.message || '')
  if (isCode(err, 'option_not_on_menu')) {
    const m = msg.match(NOT_OFFERED_RE)
    if (!m) return null
    const dishes = m[1].split(', ').map(s => s.trim()).filter(Boolean)
    if (!dishes.length) return null
    const one = dishes.length === 1
    return `${one ? 'A choice on' : 'Choices on'} ${andList(dishes)} ${one ? 'is' : 'are'} no longer offered, so nothing on this order was saved. Tap Change on ${one ? dishes[0] : 'each of them'} to take ${one ? 'it' : 'them'} off, then save again.`
  }
  if (isCode(err, 'option_count')) {
    const m = msg.match(COUNT_RE)
    if (!m) return null
    const pairs = m[1].split('; ').map(s => s.trim()).filter(Boolean)
    if (!pairs.length) return null
    const named = pairs.map(s => {
      const i = s.lastIndexOf(': ')
      return i > 0 ? `${s.slice(0, i)} (${s.slice(i + 2)})` : s
    })
    const one = named.length === 1
    return `${andList(named)} ${one ? 'has' : 'have'} too few or too many choices picked, so nothing on this order was saved. Tap Choices on ${one ? 'that dish' : 'each of those dishes'}, fix the picks, then save again.`
  }
  return null
}
