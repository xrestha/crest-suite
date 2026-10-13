// The recipe walk exists twice since S830 (5f-1, owner decision Q30 a): recipeCost.js here, and the SQL
// copy the database runs when a bill closes (pos_bill_sales_rows / pos_bill_stock_lines, migration
// 20261013160000). This file is the app's half of the check that keeps them one walk. It runs the
// app's own functions over the same fixture the migration's probe builds, and pins the numbers that
// probe asserts. Change the walk, the sales rule or the fixture on either side and the other must be
// changed in the same commit, with a migration whose probe asserts the new numbers.
//
// The fixture covers what the walk can get wrong: a sub-recipe inside a sub-recipe, a sub-recipe used
// directly AND inside another (both occurrences count), a trimmed ingredient (85%), a 0% and a 100%
// yield (both read as untrimmed), a customized plate (an item choice, a sub-recipe choice, a zero
// choice dropped, and choices on a line with no selection ignored), a comped line, a non-recipe line
// inside the discount base, and a Complimentary bill whose stored discount is ignored.
import { billSalesRows, billMovementRows } from './backfillPosToIms'
import { buildRecipeBook, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { lineIngredientDeltas, loadDeltaExplosion } from '../../../utils/orderLineIngredients'

// babel-jest hoists jest.mock above the imports; placed after them only to satisfy import/first.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))

const PERIOD = { id: 'period', bs_year: 2083, bs_month: 6 }
const item = (id, yieldPct) => ({ id, yield_pct: yieldPct, per_uom_rate: 0 })
const ITEMS = {
  chicken: item('chicken', 85),
  flour: item('flour', 100),
  oil: item('oil', 0),
  cheese: item('cheese', 50),
}
const ing = (recipeId, n, qty, { itemId = null, subId = null } = {}) => ({
  id: `${recipeId}-${n}`, recipe_id: recipeId, qty_per_portion: qty,
  item_id: itemId, sub_recipe_id: subId, items: itemId ? ITEMS[itemId] : null,
})
// The recipe book as the till reads it (pos_recipe_book → buildRecipeBook).
const BOOK = buildRecipeBook([
  { id: 'dough', yield_qty: 2, cost_price: null, recipe_ingredients: [
    ing('dough', 1, 0.5, { itemId: 'flour' }), ing('dough', 2, 0.1, { itemId: 'oil' })] },
  { id: 'sauce', yield_qty: 4, cost_price: null, recipe_ingredients: [
    ing('sauce', 1, 1, { subId: 'dough' }), ing('sauce', 2, 0.2, { itemId: 'chicken' })] },
  { id: 'pizza', yield_qty: 1, cost_price: null, recipe_ingredients: [
    ing('pizza', 1, 0.1, { itemId: 'flour' }), ing('pizza', 2, 1, { subId: 'dough' }),
    ing('pizza', 3, 2, { subId: 'sauce' }), ing('pizza', 4, 0.05, { itemId: 'cheese' })] },
  { id: 'wrap', yield_qty: 1, cost_price: null, recipe_ingredients: [
    ing('wrap', 1, 0.3, { itemId: 'chicken' })] },
])

const line = (recipeId, qty, unitPrice, extra = {}) => ({
  recipe_id: recipeId, qty, unit_price: unitPrice, vat_rate: 0.13, comped: false,
  selection_key: '', pos_order_item_options: [], ...extra,
})
const CHOICES = [
  { ingredient_deltas: [{ item_id: 'cheese', qty: 0.02 }, { item_id: 'chicken', qty: 0 }] },
  { ingredient_deltas: [{ sub_recipe_id: 'sauce', qty: 0.5 }] },
]
// B1: a paid bill with a NPR 100 discount over a NPR 1,500 non-comped base.
const B1 = {
  id: 'b1', close_type: 'paid', discount_amount: 100,
  pos_order_items: [
    line('pizza', 2, 500),
    line('wrap', 1, 300, { selection_key: 'probe', pos_order_item_options: CHOICES }),
    line('wrap', 1, 300, { comped: true, pos_order_item_options: CHOICES }),   // no selection: choices ignored
    line(null, 1, 200),                                                       // an open item: in the base, posts nothing
  ],
}
// B2: a Complimentary bill; its stored discount is ignored.
const B2 = { id: 'b2', close_type: 'writeoff', discount_amount: 50, pos_order_items: [line('wrap', 3, 300)] }

async function stockLinesFor(order) {
  const recipeLines = order.pos_order_items.filter(i => i.recipe_id)
  const deltaLists = recipeLines.map(i => (i.selection_key ? lineIngredientDeltas(i.pos_order_item_options) : null)).filter(Boolean)
  const breakdown = await explodeRecipeIngredients(null, [...new Set(recipeLines.map(i => i.recipe_id))], { book: BOOK })
  const explosion = await loadDeltaExplosion(null, deltaLists, { book: BOOK })
  return { breakdown, explosion }
}
const byKey = rows => Object.fromEntries(rows.map(r => [`${r.source}:${r.item_id}`, r.qty]))

// ── The numbers the migration's probe asserts (20261013160000, section 7) ───────────────────────
const B1_SALES = [
  { recipe_id: 'pizza', source: 'pos', qty_sold: 2, unit_price: 466.6666666666667, deltas: null },
  { recipe_id: 'wrap', source: 'pos', qty_sold: 1, unit_price: 280, deltas: [{ item_id: 'cheese', qty: 0.02 }, { sub_recipe_id: 'sauce', qty: 0.5 }] },
  { recipe_id: 'wrap', source: 'pos_comp', qty_sold: 1, unit_price: 300, deltas: null },
]
const B1_STOCK = {
  'pos_sale:flour': -0.98125,
  'pos_sale:oil': -0.15625,
  'pos_sale:chicken': -10.5 / 17,
  'pos_sale:cheese': -0.24,
  'pos_comp:chicken': -6 / 17,
}
const B2_STOCK = { 'pos_comp:chicken': -18 / 17 }

describe('the app half of the server post twin (S830 5f-1)', () => {
  test('B1 sales rows: discount spread over the non-comped base, comp at full price, choices carried', () => {
    const rows = billSalesRows(B1, PERIOD, 1)
    expect(rows).toHaveLength(B1_SALES.length)
    B1_SALES.forEach((want, n) => {
      const got = rows[n]
      expect(got).toMatchObject({ recipe_id: want.recipe_id, source: want.source, qty_sold: want.qty_sold, vat_rate: 0.13, pos_order_id: 'b1', bs_day: 1 })
      expect(got.unit_price).toBeCloseTo(want.unit_price, 9)
      expect(got.ingredient_deltas ?? null).toEqual(want.deltas)
    })
  })

  test('B1 stock lines: nested and shared sub-recipes, trims, choices, comp split', async () => {
    const moves = billMovementRows(B1, PERIOD, 1, await stockLinesFor(B1))
    const got = byKey(moves)
    expect(Object.keys(got).sort()).toEqual(Object.keys(B1_STOCK).sort())
    for (const [k, want] of Object.entries(B1_STOCK)) expect(got[k]).toBeCloseTo(want, 9)
    for (const m of moves) expect(m).toMatchObject({ ref_id: 'b1', period_id: 'period', bs_day: 1 })
  })

  test('B2, a Complimentary bill: every line pos_comp at full price, its discount ignored', async () => {
    expect(billSalesRows(B2, PERIOD, 1)).toEqual([expect.objectContaining({ recipe_id: 'wrap', source: 'pos_comp', qty_sold: 3, unit_price: 300 })])
    const got = byKey(billMovementRows(B2, PERIOD, 1, await stockLinesFor(B2)))
    expect(Object.keys(got)).toEqual(Object.keys(B2_STOCK))
    expect(got['pos_comp:chicken']).toBeCloseTo(B2_STOCK['pos_comp:chicken'], 9)
  })
})
