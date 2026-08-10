import { loadSubRecipeUsage, usageForSource } from './subRecipeUsage'

// Stub covering every query the loader makes, directly or via explodeRecipeTree /
// computeRecipeCosts. Rows carry all columns any caller might select — the real code picks the
// fields it needs, so one shape per table is enough.
function makeStub({ sales = [], ingredients = [], recipes = [], items = [] } = {}) {
  const rowsFor = (table, col, ids) => {
    const set = ids ? new Set(ids) : null
    if (table === 'recipe_ingredients') return ingredients.filter(r => !set || set.has(r.recipe_id))
    if (table === 'recipes') return recipes.filter(r => !set || set.has(r.id))
    if (table === 'items') return items.filter(r => !set || set.has(r.id))
    if (table === 'sales_entries') return sales
    return []
  }
  // Chainable + thenable, matching the shapes the loader actually builds:
  //   .select().in(...)                        — recipes / items lookups
  //   .select().eq(...).order(...).range(...)  — the paged sales_entries read (fetchAllRows)
  const chain = (table) => {
    const c = {
      eq: () => c,
      order: () => c,
      in: (col, ids) => Promise.resolve({ data: rowsFor(table, col, ids), error: null }),
      range: (from, to) => Promise.resolve({ data: rowsFor(table).slice(from, to + 1), error: null }),
      then: (res, rej) => Promise.resolve({ data: rowsFor(table), error: null }).then(res, rej),
    }
    return c
  }
  const supabase = { from: (table) => ({ select: () => chain(table) }) }
  // useScopedDb's scopedFrom(table, cols) — client scoping is irrelevant to the arithmetic.
  const scopedFrom = (table) => chain(table)
  return { supabase, scopedFrom }
}

// Dish sells for 4; uses 50 units of Sauce; Sauce yields 2000 units per batch from 1000g Tomato
// at NPR 0.5/g. Per portion: sauce 50 units = 0.025 batch -> 25g tomato.
const BASE = {
  ingredients: [
    { recipe_id: 'dish',  qty_per_portion: 50,   item_id: null, sub_recipe_id: 'sauce', items: null },
    { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
  ],
  recipes: [
    { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', cost_price: null },
    { id: 'dish',  yield_qty: 1,    yield_uom: 'portion', name: 'Pasta',  cost_price: null },
  ],
  items: [{ id: 'tomato', per_uom_rate: 0.5 }],
}

describe('loadSubRecipeUsage', () => {
  test('rolls per-portion usage up by qty sold, in output units and batches', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [{ recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' }],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('House Sauce')
    expect(rows[0].qty).toBeCloseTo(200, 6)      // 50 × 4
    expect(rows[0].batches).toBeCloseTo(0.1, 6)  // 200 / 2000
    expect(rows[0].yieldUom).toBe('ml')
  })

  test('values a sub-recipe at batches × whole-batch cost', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [{ recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].batchCost).toBeCloseTo(500, 6) // 1000g × 0.5
    expect(rows[0].value).toBeCloseTo(50, 6)      // 0.1 batch × 500
    // Every raw gram here reaches the dish through the sauce, so the sub-recipe value and the
    // derived raw-item value must agree exactly — this is the tie-out the reconciliation note
    // compares against the ledger.
    expect(derivedItemValue).toBeCloseTo(50, 6)   // 100g tomato × 0.5
  })

  test('POS supersedes a manual row for the same recipe and day — counted once, not twice', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [
        { recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' },
        { recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'manual' },
      ],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(200, 6) // not 400
  })

  test('a manual row on a day POS did not sell still depletes', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [
        { recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' },
        { recipe_id: 'dish', qty_sold: 2, bs_day: 7, source: 'manual' },
      ],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(300, 6) // (4 + 2) × 50
  })

  test('pos_credit rows never restore or add usage', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [
        { recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' },
        { recipe_id: 'dish', qty_sold: -2, bs_day: 3, source: 'pos_credit' },
      ],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(200, 6)
  })

  test('a nested sub-recipe gets its own row at its own scale', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 50,  item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [
        { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', cost_price: null },
        { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   cost_price: null },
      ],
      items: [{ id: 'herb', per_uom_rate: 2 }],
      sales: [{ recipe_id: 'dish', qty_sold: 10, bs_day: 1, source: 'pos' }],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))
    expect(rows).toHaveLength(2)
    expect(byName['House Sauce'].qty).toBeCloseTo(500, 6)  // 50 × 10
    expect(byName['House Sauce'].batches).toBeCloseTo(0.25, 6)
    expect(byName['Herb Base'].qty).toBeCloseTo(25, 6)     // 100 × 0.025 batch × 10
    expect(byName['Herb Base'].batches).toBeCloseTo(0.05, 6)
  })

  test('a dish with no sub-recipes yields no rows but still values its raw items', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [{ recipe_id: 'dish', qty_per_portion: 20, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } }],
      recipes: [],
      items: [{ id: 'tomato', per_uom_rate: 0.5 }],
      sales: [{ recipe_id: 'dish', qty_sold: 3, bs_day: 1, source: 'pos' }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows).toEqual([])
    expect(derivedItemValue).toBeCloseTo(30, 6) // 60g × 0.5
  })

  test('no period returns the empty shape rather than throwing', async () => {
    const { supabase, scopedFrom } = makeStub()
    expect(await loadSubRecipeUsage(supabase, scopedFrom, null)).toEqual({ rows: [], derivedItemValue: 0, salesRowsUsed: 0 })
  })
})

describe('usageForSource', () => {
  const row = { qty: 200, batches: 0.1, value: 50, bySource: { pos_sale: 150, pos_comp: 50 } }

  test('"all" passes the row through untouched', () => {
    expect(usageForSource(row, 'all')).toBe(row)
  })

  test('a single source scales qty, batches and value by that source\'s share', () => {
    const comp = usageForSource(row, 'pos_comp')
    expect(comp.qty).toBeCloseTo(50, 6)
    expect(comp.batches).toBeCloseTo(0.025, 6) // 0.1 × (50/200)
    expect(comp.value).toBeCloseTo(12.5, 6)
  })

  test('a source with no usage collapses to zero rather than NaN', () => {
    const manual = usageForSource(row, 'manual')
    expect(manual.qty).toBe(0)
    expect(manual.batches).toBe(0)
    expect(manual.value).toBe(0)
  })
})
