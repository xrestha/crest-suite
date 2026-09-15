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
    for (let i = included; i < ordered.length; i++) total += Number(ordered[i].price_delta) || 0
  }
  return round2(total)
}

/** "+NPR 50", "−NPR 100", "" for zero — what a guest reads beside an option. */
export function signedPrice(amount) {
  const n = Math.round(Number(amount) || 0)
  if (n === 0) return ''
  return `${n > 0 ? '+' : '−'}NPR ${nprInt(Math.abs(n))}`
}
