// "What changed in what you pay" (S800 stage F) — pure, pinned by priceMovers.test.js.
//
// For every item bought in BOTH this month and the month before, the average rate paid in each
// (Σ qty × rate ÷ Σ qty, the bill's own rate before any bill-level discount) and what the change
// cost this month: (rate now − rate before) × quantity bought now. Ranked by that rupee impact,
// not by percentage, because a 40% rise on a spice bought once matters less than a 6% rise on the
// chicken bought every day — the one thing the S800 research found only one competitor states.

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

function averageRates(rows) {
  const by = new Map()
  for (const r of rows || []) {
    const qty = num(r.qty), rate = num(r.rate)
    if (!r.item_id || qty <= 0) continue
    const a = by.get(r.item_id) || { qty: 0, value: 0 }
    a.qty += qty
    a.value += qty * rate
    by.set(r.item_id, a)
  }
  return by
}

/**
 * @param {Array<{item_id, qty, rate}>} nowRows    this month's purchase lines
 * @param {Array<{item_id, qty, rate}>} beforeRows the previous month's
 * @param {Record<string, {name, uom}>} itemsById
 * @returns {Array<{ item_id, name, uom, rateNow, rateBefore, changePct, impact, qtyNow }>} by |impact| desc
 */
export function priceMovers(nowRows, beforeRows, itemsById = {}, n = 5) {
  const now = averageRates(nowRows)
  const before = averageRates(beforeRows)
  const out = []
  for (const [itemId, a] of now) {
    const b = before.get(itemId)
    if (!b || b.qty <= 0 || b.value <= 0) continue
    const rateNow = a.value / a.qty, rateBefore = b.value / b.qty
    const impact = (rateNow - rateBefore) * a.qty
    if (Math.abs(impact) < 1) continue // rounding, not a price change
    out.push({
      item_id: itemId, name: itemsById[itemId]?.name || 'Unknown item', uom: itemsById[itemId]?.uom || '',
      rateNow, rateBefore, changePct: ((rateNow - rateBefore) / rateBefore) * 100, impact, qtyNow: a.qty,
    })
  }
  return out.sort((x, y) => Math.abs(y.impact) - Math.abs(x.impact) || x.name.localeCompare(y.name)).slice(0, n)
}
