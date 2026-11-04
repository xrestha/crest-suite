import fs from 'fs'
import path from 'path'
import { calcSubRecipeCostPerUnit, calcRecipeCost, calcLiveCost, allocateOverhead, vatOf, isValidYield, YIELD_REQUIRED_TEXT } from './recipeCostCalc'

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

// S792 D31: menuPriceVat.js reads a dish's VAT through this, so its NULL rule is pinned here.
describe('vatOf', () => {
  it('reads NULL as 13% and keeps a real 0', () => {
    expect(vatOf({ vat_rate: null })).toBe(0.13)
    expect(vatOf({ vat_rate: 0 })).toBe(0)
    expect(vatOf({ vat_rate: '0.13' })).toBe(0.13)
  })
})

// `recipes.yield_qty` is nullable with no CHECK, so a sub-recipe can arrive with no yield or a yield
// of 0. Both cost as ONE output unit per batch — the same rule as explodeRecipeTree's `|| 1` and the
// server post's COALESCE(NULLIF(yield_qty, 0), 1) — so the cost card, COGS and the till's stock
// lines agree. What it must never do is divide by zero into an Infinity or NaN cost.
describe('calcSubRecipeCostPerUnit — a missing or zero yield', () => {
  const batch = yieldQty => ({ id: 'base', yield_qty: yieldQty, recipe_ingredients: [item(500, 2)] }) // NPR 1,000 a batch

  it.each([[null], [undefined], [0], ['0'], ['']])('yield %p costs the whole batch as one unit, never Infinity or NaN', y => {
    const b = batch(y)
    const perUnit = calcSubRecipeCostPerUnit(b, [b])
    expect(Number.isFinite(perUnit)).toBe(true)
    expect(perUnit).toBeCloseTo(1000, 9)
  })

  it('a yield typed as a string divides like a number', () => {
    const b = batch('250')
    expect(calcSubRecipeCostPerUnit(b, [b])).toBeCloseTo(4, 9)
  })

  it('a dish using a no-yield sub-recipe still has a finite cost', () => {
    const b = batch(null)
    const dish = { id: 'dish', recipe_ingredients: [{ qty_per_portion: 0.5, sub_recipe_id: 'base', sub_recipe: b }] }
    expect(calcRecipeCost(dish, [b, dish])).toBeCloseTo(500, 9)
  })
})

describe('a zero or blank quantity costs nothing and never poisons the total', () => {
  it('calcRecipeCost: a 0-quantity line adds 0', () => {
    const dish = { id: 'dish', recipe_ingredients: [item(0, 50), item(2, 30)] }
    expect(calcRecipeCost(dish, [dish])).toBeCloseTo(60, 9)
  })

  it('calcLiveCost: a row still being typed (blank) or set to 0 is skipped, and the rest is costed', () => {
    const itemsList = [
      { id: 'flour', per_uom_rate: 0.1, yield_pct: 100 },
      { id: 'oil', per_uom_rate: 0.5, yield_pct: 80 },
      { id: 'salt', per_uom_rate: 0.05, yield_pct: 100 },
    ]
    const stock = { id: 'stock', yield_qty: 1000, recipe_ingredients: [item(1000, 2)] }       // NPR 2 a unit
    const rows = [
      { type: 'item', item_id: 'flour', qty_per_portion: 200 },                                // 200 × 0.1 = 20
      { type: 'item', item_id: 'oil', qty_per_portion: 40 },                                   // 40 ÷ 0.8 × 0.5 = 25
      { type: 'item', item_id: 'salt', qty_per_portion: '' },                                  // blank: still typing
      { type: 'item', item_id: 'salt', qty_per_portion: 0 },
      { type: 'item', item_id: 'salt', qty_per_portion: '0' },
      { type: 'sub_recipe', sub_recipe_id: 'stock', qty_per_portion: '' },
      { type: 'sub_recipe', sub_recipe_id: 'stock', qty_per_portion: 10 },                     // 10 × 2 = 20
    ]
    const cost = calcLiveCost(rows, itemsList, [stock])
    expect(Number.isFinite(cost)).toBe(true)
    expect(cost).toBeCloseTo(65, 9)
  })
})

// Overhead per portion: a dish absorbs the share of the period's FIXED overheads that its share of
// revenue says, spread over the plates it sold.
describe('allocateOverhead', () => {
  const oh = {
    totalOverheads: 50000, totalRevenue: 200000,
    revenueByRecipe: { momo: 50000, tea: 0 },
    coversByRecipe: { momo: 250, tea: 0 },
  }
  const NOTHING = { ohPerPortion: 0, revenueSharePct: 0, covers: 0 }

  it('allocates by revenue share, then divides by portions sold', () => {
    const r = allocateOverhead('momo', oh)
    expect(r.revenueSharePct).toBeCloseTo(0.25, 9)
    expect(r.ohPerPortion).toBeCloseTo(50, 9)   // 25% of 50,000 = 12,500 over 250 plates
    expect(r.covers).toBe(250)
  })

  it('a dish that sold nothing carries no overhead and never divides by zero', () => {
    expect(allocateOverhead('tea', oh)).toEqual(NOTHING)
    expect(allocateOverhead('not-on-the-list', oh)).toEqual(NOTHING)
  })

  it('a period with no revenue, or no overhead data, allocates nothing', () => {
    expect(allocateOverhead('momo', { ...oh, totalRevenue: 0 })).toEqual(NOTHING)
    expect(allocateOverhead('momo', null)).toEqual(NOTHING)
  })
})

// S35: overhead allocation must count only the Fixed Overheads bucket. Labor and Tax & Fees rows
// live in the same `overheads` table, and without the bucket filter they inflated every dish's
// overhead per portion on Recipe Costing. The filter is in the page's query, so this reads the
// source: nothing at runtime would notice it going missing — the figure would just be higher.
describe('Recipe Costing allocates only the overhead bucket (S35)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'Recipes.js'), 'utf8')
  const code = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('every read of the overheads table is filtered to bucket = overhead', () => {
    const starts = [...code.matchAll(/(scopedFrom|\.from)\(\s*['"]overheads['"]/g)].map(m => m.index)
    expect(starts.length).toBeGreaterThan(0)
    starts.forEach(start => {
      const rest = code.slice(start)
      const chain = rest.slice(0, rest.search(/,\s*\n/))   // to the end of this element of the read batch
      expect(chain).toMatch(/\.eq\(\s*['"]bucket['"]\s*,\s*['"]overhead['"]\s*\)/)
    })
  })
})

// S879 (owner decision): the form refuses a sub-recipe yield of 0 or blank instead of saving it as 1.
describe('isValidYield — what the sub-recipe form accepts as a yield', () => {
  test.each([['1000', true], ['0.5', true], [2, true], ['0', false], [0, false], ['', false], [null, false], [undefined, false], ['-5', false], ['abc', false]])(
    '%p is %p', (value, ok) => { expect(isValidYield(value)).toBe(ok) })

  test('the message names the fix, in words the screen can show as is', () => {
    expect(YIELD_REQUIRED_TEXT).toMatch(/more than 0/)
    expect(YIELD_REQUIRED_TEXT).not.toMatch(/'/)
  })

  test('Recipe Costing checks it before saving a sub-recipe and shows it under the yield box', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'Recipes.js'), 'utf8')
    expect(src).toMatch(/SUB_RECIPE_CATEGORY && !isValidYield\(recipeForm\.yield_qty\)\) \{ setYieldErr\(YIELD_REQUIRED_TEXT\); return \}/)
    expect(src).toMatch(/<FieldError id="recipe-f3" message=\{yieldErr\} \/>/)
  })
})
