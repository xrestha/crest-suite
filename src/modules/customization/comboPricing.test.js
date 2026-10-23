import { comboShares, comboDishBasePrice, comboGuestTotal, standaloneGuestPrice } from './comboPricing'

const recipes = {
  vegMomo:     { selling_price: 200, vat_rate: 0.13 },   // guest 226
  chickenMomo: { selling_price: 240, vat_rate: 0.13 },   // guest 271.2
  coke:        { selling_price: 100, vat_rate: 0.13 },   // guest 113
  fanta:       { selling_price: 100, vat_rate: null },   // NULL = 13%
  papad:       { selling_price: null, vat_rate: 0.13 },  // not sold alone
}
const recipeOf = id => recipes[id]

const momoCombo = {
  guest_price: 350,
  groups: [
    { id: 'b-drink', sort: 1, items: [{ recipe_id: 'coke' }, { recipe_id: 'fanta' }] },
    { id: 'a-momo', sort: 0, items: [{ recipe_id: 'chickenMomo' }, { recipe_id: 'vegMomo' }] },
  ],
}

describe('standaloneGuestPrice', () => {
  it('adds VAT on a VAT outlet, NULL as 13%', () => {
    expect(standaloneGuestPrice(recipes.vegMomo, true)).toBeCloseTo(226, 6)
    expect(standaloneGuestPrice(recipes.fanta, true)).toBeCloseTo(113, 6)
  })
  it('is the price itself on a PAN outlet, and 0 for an unpriced dish', () => {
    expect(standaloneGuestPrice(recipes.vegMomo, false)).toBe(200)
    expect(standaloneGuestPrice(recipes.papad, true)).toBe(0)
  })
})

describe('comboShares', () => {
  it('weighs each pick by its cheapest dish, in pick order, and adds up exactly', () => {
    const s = comboShares(momoCombo, recipeOf, true)
    // momo 226, drink 113 → 2/3 and 1/3 of 350
    expect(s['a-momo']).toBe(233.33)
    expect(s['b-drink']).toBe(116.67)
    expect(s['a-momo'] + s['b-drink']).toBeCloseTo(350, 10)
  })

  it('does not depend on which dish is picked', () => {
    const swapped = { ...momoCombo, groups: momoCombo.groups.map(g => ({ ...g, items: [...g.items].reverse() })) }
    expect(comboShares(swapped, recipeOf, true)).toEqual(comboShares(momoCombo, recipeOf, true))
  })

  it('shares equally when no pick has a price', () => {
    const c = { guest_price: 100, groups: [{ id: 'x', sort: 0, items: [{ recipe_id: 'papad' }] }, { id: 'y', sort: 1, items: [] }] }
    expect(comboShares(c, recipeOf, true)).toEqual({ x: 50, y: 50 })
  })

  it('gives a pick of unpriced dishes nothing when another pick has a price', () => {
    const c = { guest_price: 120, groups: [{ id: 'm', sort: 0, items: [{ recipe_id: 'vegMomo' }] }, { id: 'p', sort: 1, items: [{ recipe_id: 'papad' }] }] }
    expect(comboShares(c, recipeOf, true)).toEqual({ m: 120, p: 0 })
  })

  // S862 COMBOS-2: the heaviest pick takes the remainder; among equal weights the first by sort, then id.
  it('puts the rounding remainder on the heaviest pick, the first by sort then id among equals', () => {
    const c = { guest_price: 100, groups: ['c', 'a', 'b'].map(id => ({ id, sort: 0, items: [{ recipe_id: 'coke' }] })) }
    expect(comboShares(c, recipeOf, true)).toEqual({ a: 33.34, b: 33.33, c: 33.33 })
  })

  it('never gives a pick that weighs nothing a share below zero', () => {
    // Tea 100 + Chowmein 220 + an unpriced dip, NPR 350, PAN: 109.375 rounds up, and the last pick
    // used to take 350 − 109.38 − 240.63 = −0.01.
    const r = { tea: { selling_price: 100 }, chow: { selling_price: 220 }, dip: { selling_price: null } }
    const c = { guest_price: 350, groups: [
      { id: 'g1', sort: 0, items: [{ recipe_id: 'tea' }] },
      { id: 'g2', sort: 1, items: [{ recipe_id: 'chow' }] },
      { id: 'g3', sort: 2, items: [{ recipe_id: 'dip' }] },
    ] }
    expect(comboShares(c, id => r[id], false)).toEqual({ g1: 109.38, g2: 240.62, g3: 0 })
  })

  // S862 COMBOS-3: whole-paisa arithmetic, half up, as pos_combo_shares multiplies before it divides.
  it('lands a half-paisa tie as the server does', () => {
    // 450 and 510 at 13% (508.50 and 576.30) at NPR 900: exactly 421.875 → 421.88. The float twin
    // made it 421.87, a paisa off the line the server saved.
    const r = { a: { selling_price: 450, vat_rate: 0.13 }, b: { selling_price: 510, vat_rate: 0.13 } }
    const c = { guest_price: 900, groups: [{ id: 'p1', sort: 0, items: [{ recipe_id: 'a' }] }, { id: 'p2', sort: 1, items: [{ recipe_id: 'b' }] }] }
    expect(comboShares(c, id => r[id], true)).toEqual({ p1: 421.88, p2: 478.12 })
    expect(comboDishBasePrice(421.88, 0, 0.13)).toBe(373.35)
    // 90 + 470 at NPR 455, PAN: exactly 73.125 → 73.13, and the heavier pick takes 381.87.
    const q = { x: { selling_price: 90 }, y: { selling_price: 470 } }
    const d = { guest_price: 455, groups: [{ id: 'x', sort: 0, items: [{ recipe_id: 'x' }] }, { id: 'y', sort: 1, items: [{ recipe_id: 'y' }] }] }
    expect(comboShares(d, id => q[id], false)).toEqual({ x: 73.13, y: 381.87 })
  })

  it('weighs a 4-place menu price by its guest price to the paisa', () => {
    // 265.4867 × 1.13 = 299.999971 → 300.00, the same weight as a dish stored at 265.4867 elsewhere.
    const r = { a: { selling_price: 265.4867, vat_rate: 0.13 }, b: { selling_price: 300, vat_rate: 0 } }
    const c = { guest_price: 400, groups: [{ id: 'p1', sort: 0, items: [{ recipe_id: 'a' }] }, { id: 'p2', sort: 1, items: [{ recipe_id: 'b' }] }] }
    expect(comboShares(c, id => r[id], true)).toEqual({ p1: 200, p2: 200 })
  })
})

describe('comboDishBasePrice and comboGuestTotal', () => {
  it('turns a guest share plus extra into an ex-VAT price', () => {
    expect(comboDishBasePrice(233.33, 50, 0.13)).toBe(250.73)   // 283.33 / 1.13
    expect(comboDishBasePrice(116.67, 0, 0)).toBe(116.67)
  })
  it('adds the picked extras to the combo price', () => {
    expect(comboGuestTotal(momoCombo, [{ extra_price: 50 }, { extra_price: 0 }])).toBe(400)
  })
})
