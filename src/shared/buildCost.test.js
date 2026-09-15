import { groupsForDish } from './optionPricing'
import { buildCostRange, cheapestSelection, optionsPlateCost, priceBuild, typicalSelections } from './buildCost'

// The Acai Bowl example worked through with the owner (S760 plan): VAT left out, rates per g/ml.
const groups = [
  { id: 'size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, size_scaling: 'none', sort: 0, is_active: true },
  { id: 'base', name: 'Base', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, size_scaling: 'stock', sort: 1, is_active: true },
  { id: 'sauce', name: 'Sauces', kind: 'addon', min_select: 0, max_select: 2, included_count: 1, size_scaling: 'stock', sort: 2, is_active: true },
  { id: 'top', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 2, size_scaling: 'stock_and_price', sort: 3, is_active: true },
]
const options = [
  { id: 's', group_id: 'size', name: 'Small', price_delta: -100, portion_factor: 0.75, sort: 0, is_active: true },
  { id: 'm', group_id: 'size', name: 'Medium', price_delta: 0, portion_factor: null, sort: 1, is_active: true },
  { id: 'l', group_id: 'size', name: 'Large', price_delta: 150, portion_factor: 1.5, sort: 2, is_active: true },
  { id: 'acai', group_id: 'base', name: 'Acai puree', price_delta: 0, sort: 0, is_active: true },
  { id: 'pitaya', group_id: 'base', name: 'Pitaya puree', price_delta: 50, sort: 1, is_active: true },
  { id: 'honey', group_id: 'sauce', name: 'Honey', price_delta: 30, sort: 0, is_active: true },
  { id: 'pb', group_id: 'sauce', name: 'Peanut butter', price_delta: 40, sort: 1, is_active: true },
  { id: 'banana', group_id: 'top', name: 'Banana', price_delta: 40, sort: 0, is_active: true },
  { id: 'granola', group_id: 'top', name: 'Granola', price_delta: 40, sort: 1, is_active: true },
  { id: 'chicken', group_id: 'top', name: 'Chicken popcorn', price_delta: 120, sort: 2, is_active: true },
]
const attachments = groups.map((g, i) => ({ recipe_id: 'bowl', group_id: g.id, sort: i }))
const ingredientsByOption = {
  acai: [{ item_id: 'i-acai', qty_per_portion: 120 }],
  pitaya: [{ item_id: 'i-pitaya', qty_per_portion: 120 }],
  honey: [{ item_id: 'i-honey', qty_per_portion: 15 }],
  pb: [{ item_id: 'i-pb', qty_per_portion: 20 }],
  banana: [{ item_id: 'i-banana', qty_per_portion: 50 }],
  granola: [{ item_id: 'i-granola', qty_per_portion: 30 }],
  chicken: [{ item_id: 'i-chicken', qty_per_portion: 60 }],
}
const rateByItem = { 'i-acai': 1.2, 'i-pitaya': 1.5, 'i-honey': 0.8, 'i-pb': 1, 'i-banana': 0.2, 'i-granola': 0.6, 'i-chicken': 1 }
const ctx = {
  optionsById: Object.fromEntries(options.map(o => [o.id, o])),
  groupsById: Object.fromEntries(groups.map(g => [g.id, g])),
  ingredientsByOption,
  explosion: { itemYield: {}, subPerUnit: {} },
  rateByItem,
}
const dishGroups = groupsForDish('bowl', { groups, options, attachments })

describe('build-your-own cost (S760)', () => {
  it('scales stock with the size before valuing it', () => {
    const at = ids => optionsPlateCost(ids.map(id => ctx.optionsById[id]), ctx)
    expect(at(['m', 'acai'])).toBeCloseTo(144)
    expect(at(['l', 'acai'])).toBeCloseTo(216)
    expect(at(['s', 'acai'])).toBeCloseTo(108)
  })

  it('the cheapest build is the required picks only, at their lowest price', () => {
    expect(cheapestSelection(dishGroups, ctx.optionsById.m, ctx.groupsById)).toEqual(['m', 'acai'])
  })

  it('prices the Large order from the worked example: 600 + peanut butter 40 + chicken 180 = 820', () => {
    const b = priceBuild(['l', 'acai', 'honey', 'pb', 'banana', 'granola', 'chicken'], { basePrice: 450, fixedCost: 20, ...ctx })
    expect(b.price).toBe(820)
  })

  it('gives one row per size with cheapest and typical builds, and the overall range', () => {
    const r = buildCostRange({ dishGroups, basePrice: 450, fixedCost: 20, typicalIds: ['acai', 'honey', 'banana', 'granola'], ctx })
    expect(r.rows.map(x => x.size)).toEqual(['Small', 'Medium', 'Large'])
    const medium = r.rows[1]
    expect(medium.cheapest).toEqual({ price: 450, cost: 164, fcPct: (164 / 450) * 100 })
    expect(medium.typical.cost).toBe(204)
    expect(r.rows[2].typical.cost).toBe(296)
    expect(r.rows[0].cheapest.cost).toBe(128)
    expect(r.lowCost).toBe(128)
    expect(r.highCost).toBe(296)
    expect(r.highFc).toBeCloseTo((296 / 600) * 100)
  })

  it('a dish with no size group is one row', () => {
    const dg = dishGroups.filter(d => d.group.kind !== 'size')
    const r = buildCostRange({ dishGroups: dg, basePrice: 450, fixedCost: 20, typicalIds: [], ctx })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].size).toBeNull()
  })

  it('takes the most-picked non-size build once enough plates exist', () => {
    const sizeIds = new Set(['s', 'm', 'l'])
    const lines = [
      { recipe_id: 'bowl', selection_key: 'acai+banana+m', qty: 6 },
      { recipe_id: 'bowl', selection_key: 'acai+banana+l', qty: 3 },
      { recipe_id: 'bowl', selection_key: 'acai+chicken+m', qty: 2 },
      { recipe_id: 'pizza', selection_key: 'x', qty: 2 },
    ]
    const t = typicalSelections(lines, sizeIds, 10)
    expect(t.bowl.ids).toEqual(['acai', 'banana'])
    expect(t.bowl.plates).toBe(9)
    expect(t.pizza).toBeUndefined()
  })
})
