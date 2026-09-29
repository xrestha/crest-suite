// Which Item Master prices are on the wrong VAT basis for this outlet (S792, owner decision D32).
//
// On a PAN-bill outlet (settings.is_vat_registered === false) the 13% VAT on a VAT bill cannot be
// claimed back, so it is part of what the food cost. Purchase bills saved there carry
// `purchase_entries.vat_is_cost = true`, and a new bill that moves Item Master's price writes
// rate × 1.13 on a VAT-ticked line (PurchaseBillPage). An item whose price was set BEFORE that — from
// the bill's ex-VAT rate — still values stock, wastage, staff meals and recipes 13% low, while
// purchases now come in at the paid price. COGS = opening + purchases − closing, so the gap between
// the two bases would land in COGS and never flow back out. This lists those items once, for the
// owner to update to the price they paid.
//
// The reverse (Q2): an outlet that has since registered for VAT claims the 13% back again, so an
// item still holding a grossed-up price is 13% HIGH against the ex-VAT bills it now receives.
//
// Pure — no React, no Supabase — so the rule is pinned by vatCostPriceReview.test.js.
import { VAT_RATE } from '../reports/supplierAttribution'
import { priceImpactPhrase, priceImpactSentence } from './itemRefTables'

/** How many recent months the review reads for each item's latest bill line. */
export const REVIEW_PERIODS = 3

const round6 = n => Math.round(n * 1e6) / 1e6

/** Equal to within 0.01% (and a millionth of a rupee): the master price is stored to 6 decimals. */
export function samePrice(a, b) {
  const x = Number(a); const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return Math.abs(x - y) <= Math.max(1e-6, Math.abs(y) * 1e-4)
}

/**
 * Each item's LATEST priced bill line: newest period first (`periodRank`: period id → a number that
 * grows with time), then the later day, then the later entry. A free line (rate 0) is a gift, not a
 * price (S698), so it is skipped. → Map item id → line.
 */
export function latestPricedLines(lines, periodRank) {
  const rank = id => (periodRank instanceof Map ? periodRank.get(id) : periodRank?.[id]) ?? -1
  const key = l => [rank(l.period_id), Number(l.bs_day) || 0, String(l.created_at || ''), String(l.id || '')]
  const newer = (a, b) => {
    const ka = key(a); const kb = key(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] > kb[i]) return true
      if (ka[i] < kb[i]) return false
    }
    return false
  }
  const out = new Map()
  for (const l of lines || []) {
    if (!l || !l.item_id || !(Number(l.rate) > 0)) continue
    const cur = out.get(l.item_id)
    if (!cur || newer(l, cur)) out.set(l.item_id, l)
  }
  return out
}

/**
 * The items to review. `mode` is vatModeOf(): 'pan', 'vat', or null (unknown → nothing, since which
 * way to move a price cannot be told). Hidden items are left alone.
 *
 *   'pan'  latest line VAT-ticked on a vat_is_cost bill, master still = its ex-VAT rate
 *          → suggest rate × 1.13 (`direction: 'add'`)
 *   'vat'  latest line VAT-ticked on an ex-VAT bill, master still = rate × 1.13
 *          → suggest the bill's rate (`direction: 'remove'`)
 *
 * Returns `[{ id, name, uom, currentRate, suggestedRate, direction }]`, sorted by name.
 */
export function vatCostPriceReview({ items, lines, periodRank, mode }) {
  if (mode !== 'pan' && mode !== 'vat') return []
  const latest = latestPricedLines(lines, periodRank)
  const out = []
  for (const item of items || []) {
    if (!item || item.is_active === false || item.is_sub_recipe) continue
    const line = latest.get(item.id)
    if (!line || line.vat_inclusive !== true) continue
    const rate = Number(line.rate)
    const master = Number(item.per_uom_rate ?? item.rate)
    const gross = round6(rate * (1 + VAT_RATE))
    if (mode === 'pan' && line.vat_is_cost === true && samePrice(master, rate)) {
      out.push({ id: item.id, name: item.name, uom: item.uom, currentRate: master, suggestedRate: gross, direction: 'add' })
    } else if (mode === 'vat' && line.vat_is_cost !== true && samePrice(master, gross)) {
      out.push({ id: item.id, name: item.name, uom: item.uom, currentRate: master, suggestedRate: round6(rate), direction: 'remove' })
    }
  }
  return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}

/**
 * The D5 sentence for a price update over several items: what past records it re-values.
 * `countsById` is readItemRefCounts() output (`{ [itemId]: { OS: 3, W: 12 } }`), or null when that
 * read failed (`complete` false). One item says it in priceImpactSentence's own words.
 */
export function reviewImpactSentence(countsById, ids, { complete = true } = {}) {
  const list = ids || []
  if (list.length === 1) return priceImpactSentence((countsById || {})[list[0]] || {}, { complete })
  const sum = {}
  for (const id of list) {
    for (const [code, n] of Object.entries((countsById || {})[id] || {})) sum[code] = (sum[code] || 0) + n
  }
  const impact = priceImpactPhrase(sum)
  if (impact) {
    return `Between them, these items' ${impact.text} ${impact.total === 1 ? 'is' : 'are'} valued at their Item Master price wherever a report reads them — including months already closed — so those past figures change the moment you update.`
  }
  if (!complete) {
    return "Crest could not count these items' past records, so it cannot say how many figures change — but stock counts, wastage, staff meals and recipe costs all read Item Master prices live, including months already closed."
  }
  return null
}

/** A stable signature of the list, so a dismissed banner comes back only when the list changes. */
export function reviewSignature(rows) {
  return (rows || []).map(r => `${r.id}:${r.direction}`).sort().join(',')
}
