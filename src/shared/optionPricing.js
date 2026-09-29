// Crest Customization (S758): the one place an option's price and a group's pick rule are worked
// out in the browser. The server (stage 4, pos_options_price_delta) is the authority on what a line
// is billed — this is its twin for the live price on the Option Groups page, the till picker and
// the guest sheet, so the three cannot disagree about "first 2 included".
//
// Money convention, same as recipes.selling_price: `price_delta` is stored EX-VAT and inherits the
// dish's VAT rate. The editor shows and accepts the price a guest actually pays (incl. VAT) when
// the outlet is VAT-registered, and converts at the standard rate — which is exact for every dish
// on 13% and the reason a no-VAT dish is named separately in the editor's note.
import { nprInt } from './nepalMoney'

export const STANDARD_VAT = 0.13

const round2 = n => Math.round((Number(n) || 0) * 100) / 100

// Postgres round(numeric, 2) rounds half AWAY from zero; Math.round rounds half up. A scaled price
// is rounded here the way the server rounds it, so a negative half-paisa lands on the same figure.
const roundMoney = n => { const v = Number(n) || 0; return Math.sign(v) * Math.round(Math.abs(v) * 100) / 100 }

/**
 * S760: how big a plate the chosen size is — the product of the chosen SIZE options'
 * portion_factor (null = 1), to 6 places. Twin of pos_selection_portion_factor.
 * @param {Array<{group_id, portion_factor?}>} chosen
 * @param {Record<string, {kind?: string}>} groupsById
 */
export function sizeFactor(chosen, groupsById) {
  let f = 1
  const seen = new Set()
  for (const o of chosen || []) {
    if (!o || seen.has(o.id)) continue
    seen.add(o.id)
    if (groupsById?.[o.group_id]?.kind !== 'size') continue
    const pf = o.portion_factor == null ? 1 : Number(o.portion_factor)
    if (pf > 0) f *= pf
  }
  return Math.round(f * 1e6) / 1e6
}

/**
 * S760: an option's price at a size — its price × the factor when its group scales price, as is
 * otherwise. A size option itself is never scaled (a size group's size_scaling is always 'none').
 */
export function scaledDelta(option, group, factor = 1) {
  const p = Number(option?.price_delta) || 0
  return group?.size_scaling === 'stock_and_price' ? roundMoney(p * (Number(factor) || 1)) : roundMoney(p)
}

/** S760: a stock line's quantity at a size, scaled when the group scales stock. */
export function scaledQty(qty, group, factor = 1) {
  const q = Number(qty) || 0
  const scales = group?.size_scaling === 'stock' || group?.size_scaling === 'stock_and_price'
  return scales ? Math.round(q * (Number(factor) || 1) * 1e4) / 1e4 : q
}

export const SIZE_SCALING_LABEL = {
  none: 'Same at every size',
  stock: 'Scale stock only',
  stock_and_price: 'Scale stock and price',
}

/** Ex-VAT amount from what the guest pays. */
export function exFromIncl(incl, vat) {
  return round2((Number(incl) || 0) / (1 + (Number(vat) || 0)))
}

/** What the guest pays from the stored ex-VAT amount. */
export function inclFromEx(ex, vat) {
  return (Number(ex) || 0) * (1 + (Number(vat) || 0))
}

/**
 * The pick rule a dish applies to a group: its own override where set, the group's otherwise.
 * max null = no upper limit.
 */
export function effectiveRule(group, attachment) {
  const min = attachment?.min_override ?? group?.min_select ?? 0
  const max = attachment?.max_override ?? group?.max_select ?? null
  return { min, max, included: group?.included_count || 0 }
}

/** "Pick exactly 1", "Optional · up to 3 · first 2 free", "Optional · pick any number". */
export function ruleText({ min, max, included = 0 }) {
  let base
  if (max === 1 && min === 1) base = 'Pick exactly 1'
  else if (max === 1) base = 'Optional · pick 1'
  else if (min > 0 && max != null && min === max) base = `Pick exactly ${min}`
  else if (min > 0 && max != null) base = `Pick ${min} to ${max}`
  else if (min > 0) base = `Pick at least ${min}`
  else if (max != null) base = `Optional · up to ${max}`
  else base = 'Optional · pick any number'
  return included > 0 ? `${base} · first ${included} free` : base
}

/** Whether a count of chosen options satisfies the rule. */
export function countAllowed(count, { min, max }) {
  return count >= (min || 0) && (max == null || count <= max)
}

/**
 * The ex-VAT price change a selection adds to one plate. Within each group the first
 * `included_count` chosen options — in the group's display order (sort, then name) — are free.
 * @param {Array<{id, group_id, price_delta, sort?, name?}>} chosen
 * @param {Record<string, {included_count?: number}>} groupsById
 */
export function optionsPriceDelta(chosen, groupsById) {
  const factor = sizeFactor(chosen, groupsById)
  const byGroup = new Map()
  for (const o of chosen || []) {
    if (!byGroup.has(o.group_id)) byGroup.set(o.group_id, [])
    byGroup.get(o.group_id).push(o)
  }
  let total = 0
  for (const [groupId, opts] of byGroup) {
    const included = groupsById?.[groupId]?.included_count || 0
    const ordered = [...opts].sort((a, b) =>
      (a.sort ?? 0) - (b.sort ?? 0) || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)))
    for (let i = included; i < ordered.length; i++) total += scaledDelta(ordered[i], groupsById?.[groupId], factor)
  }
  return round2(total)
}

const byDisplayOrder = (a, b) =>
  (a.sort ?? 0) - (b.sort ?? 0) || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id))

/**
 * A selection as a cart line carries it before the server has priced it — the same shape
 * save_pos_order_items returns, so the cart, the ticket and the bill read one thing either way.
 * Ordered as the server orders its summary: the dish's group order, then the group's own, then the
 * option's; the first `included_count` of each group are free and marked "(incl.)" when they had a price.
 * @param {string[]} optionIds
 * @param {{ optionsById, groupsById, attachByGroup }} catalog  attachByGroup: this dish's attachments by group id
 * @returns {{ delta: number, summary: string, options: object[] }}
 */
export function describeSelection(optionIds, { optionsById, groupsById, attachByGroup = {} }) {
  const chosen = (optionIds || []).map(id => optionsById?.[id]).filter(Boolean)
  const factor = sizeFactor(chosen, groupsById)
  const byGroup = new Map()
  for (const o of chosen) {
    if (!byGroup.has(o.group_id)) byGroup.set(o.group_id, [])
    byGroup.get(o.group_id).push(o)
  }
  const rows = []
  for (const [groupId, opts] of byGroup) {
    const g = groupsById?.[groupId] || {}
    const included = g.included_count || 0
    ;[...opts].sort(byDisplayOrder).forEach((o, i) => {
      const free = i < included
      const list = scaledDelta(o, g, factor)
      rows.push({
        groupSort: attachByGroup[groupId]?.sort ?? 0, gSort: g.sort ?? 0, oSort: o.sort ?? 0,
        option_id: o.id, group_id: groupId, group_name: g.name || '', group_kind: g.kind || '',
        option_name: o.name, kitchen_name: o.kitchen_name || null, is_removal: !!o.is_removal,
        price_delta: free ? 0 : list, list_price_delta: list, included: free,
      })
    })
  }
  rows.sort((a, b) => a.groupSort - b.groupSort || a.gSort - b.gSort || a.oSort - b.oSort
    || String(a.option_name).localeCompare(String(b.option_name)))
  const options = rows.map(({ groupSort, gSort, oSort, ...r }) => ({ ...r, sort: groupSort * 1000 + oSort }))
  return {
    portion_factor: factor,
    delta: round2(options.reduce((s, o) => s + o.price_delta, 0)),
    summary: options.map(o => o.option_name + (o.included && o.list_price_delta !== 0 ? ' (incl.)' : '')).join(' · '),
    options,
  }
}

/**
 * What a dish offers, in the order a guest sees it: its attached, active groups that have at least
 * one active option, each with its effective rule and options. A group with nothing to pick is left
 * out — the server skips it too, so it can never make a dish unorderable.
 */
export function groupsForDish(recipeId, { groups, options, attachments }) {
  const optsByGroup = new Map()
  for (const o of options || []) {
    if (!o.is_active) continue
    if (!optsByGroup.has(o.group_id)) optsByGroup.set(o.group_id, [])
    optsByGroup.get(o.group_id).push(o)
  }
  const groupById = new Map((groups || []).map(g => [g.id, g]))
  return (attachments || [])
    .filter(a => a.recipe_id === recipeId)
    .map(a => ({ attachment: a, group: groupById.get(a.group_id) }))
    .filter(x => x.group?.is_active && optsByGroup.has(x.group.id))
    .sort((a, b) => (a.attachment.sort ?? 0) - (b.attachment.sort ?? 0) || (a.group.sort ?? 0) - (b.group.sort ?? 0)
      || String(a.group.name).localeCompare(String(b.group.name)))
    .map(({ attachment, group }) => ({
      group, attachment,
      rule: effectiveRule(group, attachment),
      options: [...optsByGroup.get(group.id)].sort(byDisplayOrder),
    }))
}

/**
 * The picks a dish starts with: the dish's own default for a group, else the options marked
 * pre-selected, trimmed to the group's maximum.
 */
export function defaultSelection(dishGroups) {
  const ids = []
  for (const { group, attachment, rule, options } of dishGroups || []) {
    let picks = attachment?.default_option_id && options.some(o => o.id === attachment.default_option_id)
      ? [attachment.default_option_id]
      : options.filter(o => o.is_default).map(o => o.id)
    if (rule.max != null) picks = picks.slice(0, rule.max)
    ids.push(...picks)
    void group
  }
  return ids
}

/** Groups whose pick count breaks the rule — [{ group, count, rule }]. Empty means the selection is valid. */
export function selectionProblems(dishGroups, optionIds) {
  const chosen = new Set(optionIds || [])
  return (dishGroups || [])
    .map(({ group, rule, options }) => ({ group, rule, count: options.filter(o => chosen.has(o.id)).length }))
    .filter(x => !countAllowed(x.count, x.rule))
}

// ── The cheapest valid build (S792, RECIPES-4) ────────────────────────────────────────────────
//
// The pricer (optionsPriceDelta above, and both SQL twins) makes the first `included_count` picks
// of a group free in DISPLAY order (sort, name, id), not the cheapest ones. The two "cheapest"
// helpers each guessed a different rule. The guest menu's "From" freed the cheapest picks and
// charged the dearest of them: Toppings, pick 3, first 2 free — Banana +30 (listed first),
// Granola +20, Honey +10, Nutella +50 — read "From NPR 230" for a dish a guest can order at 210
// (Banana and Granola free, Honey charged). Recipe Costing's cheapest build took the cheapest picks
// whatever their order: pick 2, first 1 free, prices [20, 0, 20, 10, 20] — it picked 0 and 10 and
// charged 10, where the first 20 (free) and the 0 cost nothing. In the review's brute-force check
// the first was wrong on about one random dish in four. One search now serves both, and
// optionPricing.test.js holds it to a brute-force enumeration of every valid selection.
//
// Once the size is chosen, what a group adds depends only on its own picks, so each group is
// minimised on its own. Inside a group the search walks the options in display order, and the one
// thing that decides a pick's charge — whether it is among the first `included_count` picked — is
// how many were picked before it. That makes an exact search over every valid pick set a small
// table (options × picks so far), for any group size, with no subsets listed. Only the size picks
// are enumerated (a size scales other groups' prices, so they are not independent of it), and a
// size group is pick-exactly-one, so that is one pass per size.

// Past this many size combinations the rest are not tried. A guard, not a real menu: a dish has
// one size group of a handful of sizes. Every combination that IS tried is a valid order, so a
// capped search can only ever return a price a guest can actually pay — never one below it.
const SIZE_COMBO_CAP = 256

const pickCountRange = (rule, n) => {
  // A group that asks for more picks than it has cannot be ordered (the server refuses it); take
  // every option, the nearest thing to a price, rather than no answer at all.
  const lo = Math.min(Math.max(Number(rule?.min) || 0, 0), n)
  const max = rule?.max == null ? n : Math.min(Number(rule.max), n)
  return { lo, hi: Math.max(lo, max) }
}

// [paisa, picks, removals], compared in that order: the lowest price, then the fewest picks (an
// optional choice is left off unless it lowers the price), then the fewest "No …" removals (a
// required group is met with a real choice where one costs the same — the plate being costed).
const better = (a, b) => {
  if (!b) return true
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] < b[k]
  return false
}

/** The cheapest picks of one non-size group at a size factor, in display order. */
function cheapestPicksInGroup({ group, rule, options }, factor) {
  const opts = [...(options || [])].sort(byDisplayOrder)
  const n = opts.length
  const { lo, hi } = pickCountRange(rule, n)
  const free = group?.included_count || 0
  const paisa = opts.map(o => Math.round(scaledDelta(o, group, factor) * 100))
  // best[i][c]: the best way to finish from option i when c are already picked (null = cannot).
  const best = Array.from({ length: n + 1 }, () => new Array(hi + 1).fill(null))
  for (let c = 0; c <= hi; c++) best[n][c] = c >= lo ? [0, 0, 0] : null
  const takeFrom = (i, c) => {
    const rest = c < hi ? best[i + 1][c + 1] : null
    return rest && [rest[0] + (c < free ? 0 : paisa[i]), rest[1] + 1, rest[2] + (opts[i].is_removal ? 1 : 0)]
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let c = 0; c <= hi; c++) {
      const skip = best[i + 1][c]
      const take = takeFrom(i, c)
      // A tie goes to taking: of the equally cheap sets, the one listed first is chosen.
      best[i][c] = take && (!skip || !better(skip, take)) ? take : skip
    }
  }
  const picked = []
  for (let i = 0, c = 0; i < n; i++) {
    const take = takeFrom(i, c)
    if (take && best[i][c] && take.every((v, k) => v === best[i][c][k])) { picked.push(opts[i]); c++ }
  }
  return picked
}

/** Every valid pick set of a size group, fewest picks first, up to `cap` of them. */
function sizeGroupChoices({ rule, options }, cap) {
  const opts = [...(options || [])].sort(byDisplayOrder)
  const { lo, hi } = pickCountRange(rule, opts.length)
  const out = []
  const walk = (start, k, acc) => {
    if (out.length >= cap) return
    if (acc.length === k) { out.push([...acc]); return }
    for (let i = start; i < opts.length && out.length < cap; i++) { acc.push(opts[i]); walk(i + 1, k, acc); acc.pop() }
  }
  for (let k = lo; k <= hi && out.length < cap; k++) walk(0, k, [])
  return out
}

/**
 * The lowest-priced valid selection of a dish's choices, priced by the pricer's own rule.
 * @param {Array<{group, rule, options}>} dishGroups   groupsForDish() output
 * @param {{ fixed?: Record<string, string[]> }} opts  picks already decided, by group id — a costing
 *        row that is priced "at Large" fixes the size group to Large
 * @returns {{ ids: string[], delta: number }}  the option ids (size picks first, then the dish's
 *          group order) and the ex-VAT price change they add, exactly as optionsPriceDelta prices it
 */
export function cheapestValidSelection(dishGroups, { fixed = {} } = {}) {
  const list = (dishGroups || []).filter(d => d?.group)
  const groupsById = Object.fromEntries(list.map(d => [d.group.id, d.group]))
  const inGroup = (o, g) => (o.group_id ? o : { ...o, group_id: g.id })
  const fixedPicks = d => {
    const ids = new Set(fixed[d.group.id])
    return (d.options || []).filter(o => ids.has(o.id))
  }
  const sizeGroups = list.filter(d => d.group.kind === 'size')
  const others = list.filter(d => d.group.kind !== 'size')

  let combos = [[]]
  for (const d of sizeGroups) {
    const choices = fixed[d.group.id] ? [fixedPicks(d)] : sizeGroupChoices(d, SIZE_COMBO_CAP)
    const next = []
    for (const c of combos) {
      for (const ch of choices) {
        if (next.length >= SIZE_COMBO_CAP) break
        next.push([...c, ...ch.map(o => inGroup(o, d.group))])
      }
    }
    combos = next.length ? next : combos
  }

  let best = null
  for (const sizePicks of combos) {
    const factor = sizeFactor(sizePicks, groupsById)
    const picks = [...sizePicks]
    for (const d of others) {
      const chosen = fixed[d.group.id] ? fixedPicks(d) : cheapestPicksInGroup(d, factor)
      picks.push(...chosen.map(o => inGroup(o, d.group)))
    }
    const delta = optionsPriceDelta(picks, groupsById)
    if (!best || delta < best.delta || (delta === best.delta && picks.length < best.picks.length)) best = { picks, delta }
  }
  return best ? { ids: best.picks.map(o => o.id), delta: best.delta } : { ids: [], delta: 0 }
}

/**
 * The lowest price a dish can be ordered at, for a "From NPR x" label: the cheapest valid
 * selection (cheapestValidSelection above), every size tried, since a Small that is 50 cheaper can
 * still cost more once a required topping is priced at it.
 */
export function lowestDishPrice(basePrice, dishGroups) {
  return round2((Number(basePrice) || 0) + cheapestValidSelection(dishGroups).delta)
}

/** "+NPR 50", "−NPR 100", "" for zero — what a guest reads beside an option. */
export function signedPrice(amount) {
  const n = Math.round(Number(amount) || 0)
  if (n === 0) return ''
  return `${n > 0 ? '+' : '−'}NPR ${nprInt(Math.abs(n))}`
}
