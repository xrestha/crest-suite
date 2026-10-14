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

  it('puts the rounding remainder on the last pick (sort, then id)', () => {
    const c = { guest_price: 100, groups: ['c', 'a', 'b'].map(id => ({ id, sort: 0, items: [{ recipe_id: 'coke' }] })) }
    const s = comboShares(c, recipeOf, true)
    expect(s).toEqual({ a: 33.33, b: 33.33, c: 33.34 })
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
