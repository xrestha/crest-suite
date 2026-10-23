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

const capFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s)

// S862 TILL-GUEST-2 (owner CU5 a): a dish the kitchen or bar already made (a line this till printed
// offline and put back as sent, Q2) whose choices the server would now refuse. It is not changed in
// place (a sent line never is), so the way out is to put the menu back, which bills it as made, or to
// take it off. `dish` is "this dish" on the cart line, the dish name in the refusal sentence.
function sentGoneText(gone, optionsById, lineOptions, dish) {
  const names = goneChoicesText(gone, optionsById, lineOptions)
  const one = gone.length === 1
  // Still in the catalog: hidden, or its group hidden or taken off the dish. Option Groups brings it back.
  if (gone.every(id => optionsById?.[id])) {
    return `${names} ${one ? 'is' : 'are'} hidden in Option Groups. Turn ${one ? 'it' : 'them'} back on to bill ${dish} as made, or take the dish off.`
  }
  return `${capFirst(dish)} was made with ${names}, and Option Groups no longer has ${one ? 'it' : 'them'}, so it cannot be billed as made. Take the dish off.`
}
function sentCountText(groupName, dish) {
  return `${groupName} was changed in Option Groups after ${dish} was made, so it cannot be billed as made. Ask a manager to change ${groupName} back, or take the dish off.`
}

/**
 * What is wrong with a cart line's choices against the menu on screen, as the next save would see
 * it, or null. A pick the dish no longer offers comes first: Change takes it off (the choice window
 * starts from the offered picks only), and with nothing offered the line goes plain.
 * `sent` (S862 TILL-GUEST-2): the line is already with the kitchen or bar, so it has no Change and
 * the text gives the way out instead (`dish` names it, "this dish" on the cart).
 * @param {object} line  a cart line (option_ids / selection_key, options, selection_key)
 * @param {Array|undefined} dishGroups  groupsForDish for the line's dish; undefined = offers none
 * @param {Record<string, { name }>} optionsById  the till's option catalog, hidden options included
 * @param {{ sent?: boolean, dish?: string }} [opts]
 * @returns {null | { gone: string[], text: string, sent?: true }}
 */
export function lineChoiceTrouble(line, dishGroups, optionsById, { sent = false, dish = 'this dish' } = {}) {
  const ids = lineOptionIds(line || {})
  const { kept, gone } = offeredPicks(ids, dishGroups)
  if (gone.length > 0) {
    if (sent) return { gone, sent: true, text: sentGoneText(gone, optionsById, line?.options, dish) }
    const names = goneChoicesText(gone, optionsById, line?.options)
    return { gone, text: `No longer offered: ${names}. Tap Change to take ${gone.length === 1 ? 'it' : 'them'} off.` }
  }
  const problem = selectionProblems(dishGroups || [], kept)[0]
  if (!problem) return null
  if (sent) return { gone: [], sent: true, text: sentCountText(problem.group.name, dish) }
  // By the line's OWN choices: a combo's dish (S839) carries a selection key with none of its own.
  const button = lineOptionIds(line || {}).length ? 'Change' : 'Choices'
  const short = problem.count < (Number(problem.rule?.min) || 0)
  return {
    gone: [],
    text: short
      ? `Choose ${problem.rule.min - problem.count} more from ${problem.group.name}. Tap ${button} to pick.`
      : `Too many picked in ${problem.group.name}. Tap ${button} to fix it.`,
  }
}

/**
 * S809 4h (owner, Q3 b): the grey note on a SAVED line not yet sent whose choice the menu no longer
 * offers — "Granola is no longer offered". The save keeps its exemption (the line is already on the
 * order), so it blocks nothing; it only tells the waiter before the guest hears it from the kitchen.
 * @returns {string|null}
 */
export function savedLineGoneNote(line, dishGroups, optionsById) {
  const { gone } = offeredPicks(lineOptionIds(line || {}), dishGroups)
  if (!gone.length) return null
  return `${goneChoicesText(gone, optionsById, line?.options)} ${gone.length === 1 ? 'is' : 'are'} no longer offered.`
}

// The refusal sentences, as save_pos_order_items raises them (live since S809 2h; the third 4h):
//   option_not_on_menu: an option chosen for <dish>[, <dish>…] is no longer offered on it — …
//   option_count: the choices do not fit what the dish allows (<dish>: <group>[; …]) — …
//   option_price_below_zero: <dish>[, <dish>…] would cost less than nothing with the choices picked — …
const NOT_OFFERED_RE = /an option chosen for (.+) is no longer offered/
const COUNT_RE = /what the dish allows \((.+)\) — change/
const BELOW_ZERO_RE = /option_price_below_zero: (.+) would cost less than nothing/

const isCode = (err, code) => err?.hint === code || new RegExp(`^${code}:`).test(String(err?.message || ''))

/**
 * S862 TILL-GUEST-2: the way out for a named dish already made, when the till's menu cannot say which
 * choice the server refused (its catalog is older than the server's).
 */
export function sentDishWayOut(dish) {
  return `${dish} was already made, so its choices cannot be changed here. Ask a manager to turn its choice back on in Option Groups to bill it as made, or take the dish off.`
}

/**
 * S862 TILL-GUEST-1: said once the menu is read again after a refusal that came from Customization
 * being switched on or off (or lapsing) for the outlet while this till was open.
 */
export function customizationSwitchedText(on) {
  return `Customization was switched ${on ? 'on' : 'off'} for this outlet after this till opened; the menu has been updated. Check the marked dishes, then save again.`
}

/**
 * The order screen's whole sentence for a choices refusal, naming the dish(es) the server named;
 * null when the error is not one of the two or its message has no names (the caller then falls
 * back to errorText). "Nothing on this order was saved" is earned: the function raises inside its
 * own transaction, before it writes anything, so the other dishes on the order did not save either.
 * `sentWayOut(dish)` (S862 TILL-GUEST-2) answers, for a named dish whose line is already with the
 * kitchen or bar, the sentence that replaces "Tap Change" for it (it has no Change), else null.
 */
export function choiceRefusalText(err, { sentWayOut = null } = {}) {
  const msg = String(err?.message || '')
  // The named dishes already made, each with its way out, and the rest.
  const splitSent = dishes => {
    const made = sentWayOut ? dishes.map(d => [d, sentWayOut(d)]).filter(([, t]) => t) : []
    return { made: made.map(([, t]) => t), rest: dishes.filter(d => !made.some(([m]) => m === d)) }
  }
  if (isCode(err, 'option_not_on_menu')) {
    const m = msg.match(NOT_OFFERED_RE)
    if (!m) return null
    const dishes = m[1].split(', ').map(s => s.trim()).filter(Boolean)
    if (!dishes.length) return null
    const one = dishes.length === 1
    const head = `${one ? 'A choice on' : 'Choices on'} ${andList(dishes)} ${one ? 'is' : 'are'} no longer offered, so nothing on this order was saved.`
    const { made, rest } = splitSent(dishes)
    if (made.length) {
      const change = rest.length ? ` Tap Change on ${andList(rest)} to take ${rest.length === 1 ? 'its choice' : 'their choices'} off.` : ''
      return `${head} ${made.join(' ')}${change} Then save again.`
    }
    return `${head} Tap Change on ${one ? dishes[0] : 'each of them'} to take ${one ? 'it' : 'them'} off, then save again.`
  }
  if (isCode(err, 'option_count')) {
    const m = msg.match(COUNT_RE)
    if (!m) return null
    const pairs = m[1].split('; ').map(s => s.trim()).filter(Boolean)
    if (!pairs.length) return null
    const split = pairs.map(s => {
      const i = s.lastIndexOf(': ')
      return i > 0 ? { dish: s.slice(0, i), named: `${s.slice(0, i)} (${s.slice(i + 2)})` } : { dish: s, named: s }
    })
    const named = split.map(p => p.named)
    const one = named.length === 1
    const head = `${andList(named)} ${one ? 'has' : 'have'} too few or too many choices picked, so nothing on this order was saved.`
    const { made, rest } = splitSent(split.map(p => p.dish))
    if (made.length) {
      const change = rest.length ? ` Tap Change (or Choices) on ${andList(rest)} and fix the picks.` : ''
      return `${head} ${made.join(' ')}${change} Then save again.`
    }
    // S862 PRICING-3: the cart's button reads Change on a line with picks and Choices on one without.
    return `${head} Tap Change (or Choices) on ${one ? 'that dish' : 'each of those dishes'}, fix the picks, then save again.`
  }
  if (isCode(err, 'option_price_below_zero')) {
    const m = msg.match(BELOW_ZERO_RE)
    if (!m) return null
    const dishes = m[1].split(', ').map(s => s.trim()).filter(Boolean)
    if (!dishes.length) return null
    const one = dishes.length === 1
    return `${andList(dishes)} would cost less than nothing with the choices picked, so nothing on this order was saved. Tap Change on ${one ? 'it' : 'each of them'} to pick other choices, or ask a manager to fix the price in Option Groups.`
  }
  return null
}
