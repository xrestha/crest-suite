// How a combo's price is shared across its dishes (S839, docs/pos-combos.md). The JS twin of the
// server's pos_combo_shares, for display only: the setup screen's preview and the till's and guest
// menu's running total before a save answers. The server prices every line itself.
//
// Each pick's share of the combo's guest price is in proportion to its CHEAPEST dish's standalone
// guest price, so a swap within a pick never moves the other dishes' prices (Odoo's rule). An
// unpriced dish weighs 0; if every pick weighs 0 the picks share equally. Shares are whole paisa and
// the LAST pick (by sort, then id) takes the remainder, so they always add up to the combo price.
// A dish's line is then (share + its extra charge) ÷ (1 + its VAT rate), ex-VAT, to the paisa.

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
    const prices = (g.items || []).map(it => standaloneGuestPrice(recipeOf(it.recipe_id), vatReg))
    return prices.length ? Math.min(...prices) : 0
  })
  const total = weights.reduce((s, w) => s + w, 0)
  const shares = total > 0 ? weights.map(w => w / total) : groups.map(() => 1 / groups.length)
  const price = paisa(combo?.guest_price)
  const out = {}
  let given = 0
  groups.forEach((g, n) => {
    const p = n === groups.length - 1 ? price - given : Math.round(price * shares[n])
    given += p
    out[g.id] = p / 100
  })
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
