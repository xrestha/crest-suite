// How a combo's price is shared across its dishes (S839, docs/pos-combos.md). The JS twin of the
// server's pos_combo_shares, for display only: the setup screen's preview and the till's and guest
// menu's running total before a save answers. The server prices every line itself.
//
// Each pick's share of the combo's guest price is in proportion to its CHEAPEST dish's standalone
// guest price to the paisa, so a swap within a pick never moves the other dishes' prices (Odoo's
// rule). An unpriced dish weighs 0; if every pick weighs 0 the picks share equally. Shares are whole
// paisa, rounded half up, and the HEAVIEST pick (by weight, then sort, then id) takes the remainder,
// so they always add up to the combo price and a pick that weighs 0 is exactly 0 (S862 COMBOS-2: the
// last pick took it, and could come out at minus one paisa). The sums run in whole paisa, exactly,
// as pos_combo_shares multiplies before it divides (S862 COMBOS-3: float ratios put the till a paisa
// off the server on about one combo in 250). A dish's line is then (share + its extra charge) ÷
// (1 + its VAT rate), ex-VAT, to the paisa.

const paisa = n => Math.round((Number(n) || 0) * 100)

/** What a guest pays for a dish on its own: its price with VAT on a VAT-registered outlet. */
export function standaloneGuestPrice(recipe, vatReg) {
  const price = Number(recipe?.selling_price) || 0
  if (price <= 0) return 0
  if (!vatReg) return price
  const rate = recipe?.vat_rate === null || recipe?.vat_rate === undefined ? 0.13 : Number(recipe.vat_rate) || 0
  return price * (1 + rate)
}

// By sort, then id in byte order, as Postgres orders a uuid (localeCompare would skip the hyphens).
const byPickOrder = (a, b) => {
  const s = (Number(a.sort) || 0) - (Number(b.sort) || 0)
  if (s) return s
  const x = String(a.id).toLowerCase(), y = String(b.id).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

// A dish's weight: its standalone guest price in whole paisa, rounded half up as numeric round()
// does, worked in integers (a price is stored to 4 places and a rate to at most 4) so a half-paisa
// tie lands as the server's does.
function guestWeightPaisa(recipe, vatReg) {
  const price = Number(recipe?.selling_price) || 0
  if (price <= 0) return 0
  const priceE4 = Math.round(price * 1e4)
  if (!vatReg) return Math.floor((priceE4 + 50) / 100)
  const rate = recipe?.vat_rate === null || recipe?.vat_rate === undefined ? 0.13 : Number(recipe.vat_rate) || 0
  const e8 = priceE4 * (1e4 + Math.round(rate * 1e4))
  return (e8 + 5e5 - ((e8 + 5e5) % 1e6)) / 1e6
}

// floor(n / d) for whole numbers held exactly in a double.
const intDiv = (n, d) => (n - (n % d)) / d

/**
 * Each pick's share of the combo price, in rupees: { [group_id]: share }.
 * @param {{ guest_price, groups: Array<{ id, sort, items: Array<{ recipe_id }> }> }} combo
 * @param {(recipeId: string) => object|undefined} recipeOf  the dish's recipe row (selling_price, vat_rate)
 * @param {boolean} vatReg  the outlet adds VAT to its menu prices
 */
export function comboShares(combo, recipeOf, vatReg) {
  const groups = [...(combo?.groups || [])].sort(byPickOrder)
  if (groups.length === 0) return {}
  const weights = groups.map(g => {
    const ws = (g.items || []).map(it => guestWeightPaisa(recipeOf(it.recipe_id), vatReg))
    return ws.length ? Math.min(...ws) : 0
  })
  const total = weights.reduce((s, w) => s + w, 0)
  const price = paisa(combo?.guest_price)
  const n = groups.length
  // round(price × w ÷ total) half up, in whole paisa: floor((2·price·w + total) ÷ (2·total)).
  const raw = weights.map(w => (total > 0 ? intDiv(2 * price * w + total, 2 * total) : intDiv(2 * price + n, 2 * n)))
  // The heaviest pick takes the remainder; groups are already in sort-then-id order, so the first of
  // equal weights wins, as ORDER BY w DESC, sort, id does.
  let heavy = 0
  weights.forEach((w, i) => { if (w > weights[heavy]) heavy = i })
  const others = raw.reduce((s, r, i) => (i === heavy ? s : s + r), 0)
  const out = {}
  groups.forEach((g, i) => { out[g.id] = (i === heavy ? price - others : raw[i]) / 100 })
  return out
}

/** A combo dish's line price before its own choices, ex-VAT: (share + extra) ÷ (1 + VAT rate). */
export function comboDishBasePrice(share, extra, vatRate) {
  const guest = (Number(share) || 0) + (Number(extra) || 0)
  return Math.round((guest / (1 + (Number(vatRate) || 0))) * 100) / 100
}

/** What a guest pays for one combo before any dish's own choices: its price plus the picked extras. */
export function comboGuestTotal(combo, pickedItems) {
  return (Number(combo?.guest_price) || 0) + (pickedItems || []).reduce((s, it) => s + (Number(it?.extra_price) || 0), 0)
}
