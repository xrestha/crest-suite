import { calcSubRecipeCostPerUnit, calcRecipeCost } from './recipeCostCalc'

// Helpers — an ingredient row as the Recipes page shapes it (joined `items` for a raw ingredient,
// bare `sub_recipe_id` for a nested sub-recipe).
const item = (qty, rate, yieldPct = 100) =>
  ({ qty_per_portion: qty, item_id: `i-${rate}-${qty}`, items: { per_uom_rate: rate, yield_pct: yieldPct } })
const sub = (qty, id) => ({ qty_per_portion: qty, sub_recipe_id: id })

describe('calcSubRecipeCostPerUnit — nesting', () => {
  it('costs a single level', () => {
    // 1000 GM of something at NPR 2/GM, yielding 1000 GM => NPR 2 per GM out
    const stock = { id: 'stock', yield_qty: 1000, recipe_ingredients: [item(1000, 2)] }
    expect(calcSubRecipeCostPerUnit(stock, [stock])).toBeCloseTo(2, 9)
  })

  it('compounds yields through two levels', () => {
    const stock = { id: 'stock', yield_qty: 1000, recipe_ingredients: [item(1000, 2)] }          // 2/unit
    const roux = { id: 'roux', yield_qty: 100, recipe_ingredients: [sub(200, 'stock')] }          // 200*2/100
    expect(calcSubRecipeCostPerUnit(roux, [stock, roux])).toBeCloseTo(4, 9)
  })

  // THE REGRESSION THIS FIX EXISTS FOR. `seen` used to only ever add, so the second branch to
  // reach `stock` returned 0 and the sauce came out cheaper than it is. A base used by two
  // branches of the same tree is not a cycle — it must be paid for twice.
  it('costs a shared base once per branch (diamond), not once in total', () => {
    const stock = { id: 'stock', yield_qty: 1000, recipe_ingredients: [item(1000, 2)] }           // 2/unit
    const roux = { id: 'roux', yield_qty: 100, recipe_ingredients: [sub(200, 'stock')] }          // 4/unit
    const sauce = {
      id: 'sauce', yield_qty: 1,
      recipe_ingredients: [sub(10, 'roux'), sub(50, 'stock')],                                    // 10*4 + 50*2
    }
    const all = [stock, roux, sauce]
    expect(calcSubRecipeCostPerUnit(sauce, all)).toBeCloseTo(140, 9)
  })

  it('still refuses to recurse forever on a cycle', () => {
    const a = { id: 'a', yield_qty: 1, recipe_ingredients: [item(1, 10), sub(1, 'b')] }
    const b = { id: 'b', yield_qty: 1, recipe_ingredients: [item(1, 5), sub(1, 'a')] }
    const all = [a, b]
    // a = 10 + b, b = 5 + (a re-entered => 0). Terminates, and costs what it can see.
    expect(calcSubRecipeCostPerUnit(a, all)).toBeCloseTo(15, 9)
  })

  it('applies item yield_pct at every depth', () => {
    // 50% yield doubles the raw quantity needed
    const base = { id: 'base', yield_qty: 1, recipe_ingredients: [item(1, 100, 50)] }
    expect(calcSubRecipeCostPerUnit(base, [base])).toBeCloseTo(200, 9)
  })
})

describe('calcRecipeCost — a dish over nested sub-recipes', () => {
  it('reaches through three levels', () => {
    const stock = { id: 'stock', yield_qty: 1000, recipe_ingredients: [item(1000, 2)] }
    const roux = { id: 'roux', yield_qty: 100, recipe_ingredients: [sub(200, 'stock')] }
    const sauce = { id: 'sauce', yield_qty: 10, recipe_ingredients: [sub(10, 'roux')] }           // 40/10 = 4
    const dish = {
      id: 'dish',
      recipe_ingredients: [{ qty_per_portion: 5, sub_recipe_id: 'sauce', sub_recipe: sauce }, item(2, 30)],
    }
    // 5 * 4 (sauce) + 2 * 30 (raw) = 80
    expect(calcRecipeCost(dish, [stock, roux, sauce, dish])).toBeCloseTo(80, 9)
  })
})
