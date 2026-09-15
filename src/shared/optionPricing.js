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

/**
 * The lowest price a dish can be ordered at, for a "From NPR x" label. Since S760 a size can scale
 * the other groups' prices, so every combination of the REQUIRED sizes is tried and the cheapest
 * wins: a Small that is 50 cheaper can still cost more once a required topping is priced at it.
 */
export function lowestDishPrice(basePrice, dishGroups) {
  const groupsList = dishGroups || []
  const sizeRequired = groupsList.filter(d => d.group?.kind === 'size' && d.rule.min > 0 && d.options.length)
  const rest = groupsList.filter(d => !sizeRequired.includes(d))
  let combos = [[]]
  for (const d of sizeRequired) {
    const next = []
    for (const c of combos) for (const o of d.options) next.push([...c, o])
    combos = next.length ? next : combos
    if (combos.length > 256) break // a guard, not a real menu
  }
  const groupsById = Object.fromEntries(groupsList.map(d => [d.group?.id, d.group]))
  let best = null
  for (const sizes of combos) {
    const factor = sizeFactor(sizes, groupsById)
    let price = (Number(basePrice) || 0) + sizes.reduce((s, o) => s + (Number(o.price_delta) || 0), 0)
    for (const { group, rule, options } of rest) {
      if (!(rule.min > 0)) continue
      const deltas = options.map(o => scaledDelta(o, group, factor)).sort((a, b) => a - b)
      const need = deltas.slice(0, rule.min)
      // Free picks only lower a price when the prices they waive are positive.
      const free = need.every(d => d >= 0) ? (rule.included || 0) : 0
      price += need.slice(free).reduce((s, d) => s + d, 0)
    }
    if (best == null || price < best) best = price
  }
  return round2(best ?? (Number(basePrice) || 0))
}

/** "+NPR 50", "−NPR 100", "" for zero — what a guest reads beside an option. */
export function signedPrice(amount) {
  const n = Math.round(Number(amount) || 0)
  if (n === 0) return ''
  return `${n > 0 ? '+' : '−'}NPR ${nprInt(Math.abs(n))}`
}
