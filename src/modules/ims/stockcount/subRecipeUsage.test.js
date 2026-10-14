import { loadSubRecipeUsage, usageForSource, subRecipeHasIngredient, EMPTY_USAGE } from './subRecipeUsage'
import { loadRecipeBook } from '../../../utils/recipeCost'

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
  //   .select().in(...)                        — recipes / items lookups awaited directly
  //   .select().eq(...).order(...).range(...)  — the paged sales_entries read (fetchAllRows)
  //   .select().in(...).order(...).range(...)  — the recipe walk (fetchAllRowsChunked, S711)
  // .eq() filters are recorded and applied on resolution — the loader relies on
  // .eq('category', 'Sub-Recipe') to build the master list, so a stub that ignored eq would make
  // the unused-diff tests pass for the wrong reason.
  //
  // `.in()` returns a CHAIN rather than resolving, because explodeRecipeTree/computeRecipeCosts
  // now page their `.in()` reads. It stays thenable, so the sites that still await it directly
  // (the recipes/items lookups in loadSubRecipeUsage) are unaffected.
  const chain = (table, eqs = [], inFilter = null) => {
    // A filter on a column the fixture doesn't define is ignored rather than matching nothing —
    // that keeps fixtures minimal (no period_id/client_id boilerplate on every row) while still
    // genuinely enforcing .eq('category', 'Sub-Recipe'), which every recipe fixture does define.
    const apply = rows => rows.filter(r => eqs.every(([col, val]) => r[col] === undefined || r[col] === val))
    const rows = () => apply(inFilter ? rowsFor(table, inFilter[0], inFilter[1]) : rowsFor(table))
    const c = {
      eq: (col, val) => chain(table, [...eqs, [col, val]], inFilter),
      in: (col, ids) => chain(table, eqs, [col, ids]),
      order: () => c,
      range: (from, to) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      then: (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    }
    return c
  }
  const supabase = { from: (table) => ({ select: () => chain(table) }) }
  // The recipe book (S793, loadRecipeBook): every recipe with its ingredient rows embedded, each
  // ingredient's `items` embed carrying the item's name and rate beside its yield — the shape
  // PostgREST returns for RECIPE_BOOK_SELECT. A recipe id that appears only on an ingredient row
  // still gets a recipe row, as the FK guarantees in the real table.
  const bookRows = () => {
    const itemById = new Map(items.map(i => [i.id, i]))
    const ids = [...new Set([...recipes.map(r => r.id), ...ingredients.map(i => i.recipe_id)])]
    return ids.map(id => ({
      ...(recipes.find(r => r.id === id) || { id }),
      recipe_ingredients: ingredients
        .filter(i => i.recipe_id === id)
        .map(i => (i.item_id ? { ...i, items: { ...(i.items || {}), ...(itemById.get(i.item_id) || {}) } } : i)),
    }))
  }
  const bookChain = () => {
    const c = {
      order: () => c,
      range: (from, to) => Promise.resolve({ data: bookRows().slice(from, to + 1), error: null }),
    }
    return c
  }
  // useScopedDb's scopedFrom(table, cols) — client scoping is irrelevant to the arithmetic.
  const scopedFrom = (table, cols = '') =>
    (table === 'recipes' && cols.includes('recipe_ingredients') ? bookChain() : chain(table))
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
    { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
    { id: 'dish',  yield_qty: 1,    yield_uom: 'portion', name: 'Pasta',  category: 'Food', cost_price: null },
  ],
  items: [{ id: 'tomato', name: 'Tomatoes', per_uom_rate: 0.5 }],
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
        { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
        { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   category: 'Sub-Recipe', cost_price: null },
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

  // THE ROWS ARE NOT ADDITIVE, and the page's total used to add them anyway (S721).
  // computeRecipeCosts is fully exploded, so House Sauce's cost per batch (80) already contains
  // the Herb Base inside it; Herb Base's own row is 400/batch. Summing `value` therefore pays for
  // the herb twice — 0.25×80 + 0.05×400 = 40 against a true raw-ingredient value of 20.
  test('topValue counts a nested sub-recipe once, where value counts it twice', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 50,  item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [
        { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
        { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   category: 'Sub-Recipe', cost_price: null },
      ],
      items: [{ id: 'herb', per_uom_rate: 2 }],
      sales: [{ recipe_id: 'dish', qty_sold: 10, bs_day: 1, source: 'pos' }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))

    // Per row: still the full cost of making that much of it. Correct, and unchanged.
    expect(byName['House Sauce'].value).toBeCloseTo(20, 6)   // 0.25 batch × 80
    expect(byName['Herb Base'].value).toBeCloseTo(20, 6)     // 0.05 batch × 400
    expect(rows.reduce((s, r) => s + r.value, 0)).toBeCloseTo(40, 6)  // the old total: 2× the truth

    // Only the outer one is reached directly by the dish, so only it is charged.
    expect(byName['House Sauce'].topBatches).toBeCloseTo(0.25, 6)
    expect(byName['Herb Base'].topBatches).toBeCloseTo(0, 6)
    expect(byName['Herb Base'].topValue).toBeCloseTo(0, 6)

    // The figure every total on the page uses, and it ties to the raw-item tab exactly — which is
    // what the KPI card's tooltip claims it does.
    expect(rows.reduce((s, r) => s + r.topValue, 0)).toBeCloseTo(derivedItemValue, 6)
    expect(derivedItemValue).toBeCloseTo(20, 6)              // 10 g herb × 2
  })

  // A sub-recipe can be BOTH nested and used directly. Only its direct share may be charged, so a
  // simple "is this ever nested?" flag would have been wrong.
  test('a sub-recipe used directly and nested is charged only for the direct part', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [
        { recipe_id: 'dishA', qty_per_portion: 2000, item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 500,  item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'dishB', qty_per_portion: 500,  item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [
        { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
        { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   category: 'Sub-Recipe', cost_price: null },
      ],
      items: [{ id: 'herb', per_uom_rate: 2 }],
      sales: [
        { recipe_id: 'dishA', qty_sold: 1, bs_day: 1, source: 'pos' },
        { recipe_id: 'dishB', qty_sold: 1, bs_day: 1, source: 'pos' },
      ],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))
    // Herb Base: 1 batch nested under House Sauce (dishA) + 1 batch direct (dishB) = 2 batches.
    expect(byName['Herb Base'].batches).toBeCloseTo(2, 6)
    // ...but only dishB's batch is charged here; dishA's is already inside House Sauce's cost.
    expect(byName['Herb Base'].topBatches).toBeCloseTo(1, 6)
    expect(rows.reduce((s, r) => s + r.topValue, 0)).toBeCloseTo(derivedItemValue, 6)
  })

  test('a dish with no sub-recipes yields no rows but still values its raw items', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [{ recipe_id: 'dish', qty_per_portion: 20, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } }],
      recipes: [],
      items: [{ id: 'tomato', name: 'Tomatoes', per_uom_rate: 0.5 }],
      sales: [{ recipe_id: 'dish', qty_sold: 3, bs_day: 1, source: 'pos' }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows).toEqual([])
    expect(derivedItemValue).toBeCloseTo(30, 6) // 60g × 0.5
  })

  test('no period returns the empty shape rather than throwing', async () => {
    const { supabase, scopedFrom } = makeStub()
    expect(await loadSubRecipeUsage(supabase, scopedFrom, null)).toEqual(EMPTY_USAGE)
  })
})

// Crest Customization (S758): a sale's choice stock lines (`ingredient_deltas`, per plate, already
// scaled by size) are usage too — recipe × qty_sold + deltas × qty_sold — and a sub-recipe a choice
// takes belongs on this tab. Until this the tab was recipe-only and said so.
describe('loadSubRecipeUsage — choices on customized dishes', () => {
  // House Sauce (2000 ml / batch) is made from 100 g of Herb Base (500 g / batch), which is 200 g of
  // herb at NPR 2. Pasta's RECIPE takes 50 ml of the sauce; the Acai Bowl has no recipe lines and
  // takes the same 50 ml through a CHOICE.
  const NESTED_CHOICE = {
    ingredients: [
      { recipe_id: 'pasta', qty_per_portion: 50,  item_id: null, sub_recipe_id: 'sauce', items: null },
      { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base',  items: null },
      { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
    ],
    recipes: [
      { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
      { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   category: 'Sub-Recipe', cost_price: null },
      { id: 'pasta', yield_qty: 1, yield_uom: 'portion', name: 'Pasta',     category: 'Food', cost_price: null },
      { id: 'bowl',  yield_qty: 1, yield_uom: 'portion', name: 'Acai Bowl', category: 'Food', cost_price: null },
    ],
    items: [{ id: 'herb', name: 'Fresh Herbs', per_uom_rate: 2 }],
  }

  test('a sub-recipe taken by a choice — nested prep included — counts exactly as the same recipe line', async () => {
    const viaRecipe = makeStub({ ...NESTED_CHOICE, sales: [{ recipe_id: 'pasta', qty_sold: 10, bs_day: 1, source: 'pos' }] })
    const viaChoice = makeStub({
      ...NESTED_CHOICE,
      sales: [{ recipe_id: 'bowl', qty_sold: 10, bs_day: 1, source: 'pos', ingredient_deltas: [{ sub_recipe_id: 'sauce', qty: 50 }] }],
    })
    const r = await loadSubRecipeUsage(viaRecipe.supabase, viaRecipe.scopedFrom, 'p1')
    const c = await loadSubRecipeUsage(viaChoice.supabase, viaChoice.scopedFrom, 'p1')
    const byName = res => Object.fromEntries(res.rows.map(x => [x.name, x]))
    const [R, C] = [byName(r), byName(c)]

    expect(Object.keys(C).sort()).toEqual(['Herb Base', 'House Sauce'])
    for (const name of ['House Sauce', 'Herb Base']) {
      for (const f of ['qty', 'batches', 'topBatches', 'value', 'topValue']) {
        expect(C[name][f]).toBeCloseTo(R[name][f], 6)
      }
    }
    // The figures themselves: 50 ml × 10 plates; the base is reached THROUGH the sauce, so the
    // plate charges none of it directly.
    expect(C['House Sauce'].qty).toBeCloseTo(500, 6)
    expect(C['House Sauce'].batches).toBeCloseTo(0.25, 6)
    expect(C['House Sauce'].topBatches).toBeCloseTo(0.25, 6)
    expect(C['Herb Base'].qty).toBeCloseTo(25, 6)
    expect(C['Herb Base'].batches).toBeCloseTo(0.05, 6)
    expect(C['Herb Base'].topBatches).toBeCloseTo(0, 6)
    // Ties to the raw items, counting each once — 10 g of herb at NPR 2.
    expect(c.derivedItemValue).toBeCloseTo(20, 6)
    expect(c.rows.reduce((s, x) => s + x.topValue, 0)).toBeCloseTo(c.derivedItemValue, 6)
    // And a sub-recipe used only through a choice is no longer "unused this period".
    expect(c.unusedSubRecipes).toEqual([])
  })

  test('a negative (Half) choice line takes its share of the sub-recipe off the plate', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [{ recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos', ingredient_deltas: [{ sub_recipe_id: 'sauce', qty: -25 }] }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(100, 6)          // (50 − 25) × 4
    expect(rows[0].batches).toBeCloseTo(0.05, 6)
    expect(rows[0].topBatches).toBeCloseTo(0.05, 6)
    expect(rows[0].value).toBeCloseTo(25, 6)         // 0.05 batch × 500
    expect(derivedItemValue).toBeCloseTo(25, 6)      // 50 g tomato × 0.5
  })

  test('an item a choice takes reaches the reconciliation value, at its own rate and yield', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      // Cheese is on no recipe, so it is not on the recipe book.
      items: [...BASE.items, { id: 'cheese', name: 'Cheese', per_uom_rate: 1.5, yield_pct: 75 }],
      sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(100, 6)          // the sauce is the recipe's alone: 50 × 2
    // Tomato through the sauce: 2 × 25 g × 0.5 = 25. Cheese: 30 g ÷ 75% yield = 40 g a plate,
    // × 2 plates × 1.5 = 120. Before the extra read it valued at rate 0 and this read 25.
    expect(derivedItemValue).toBeCloseTo(145, 6)
  })

  test('a credit note\'s put-back row comes off, and the put-back source shows it', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [
        { recipe_id: 'dish', qty_sold: 4, bs_day: 3, source: 'pos' },
        { recipe_id: 'dish', qty_sold: -1, bs_day: 3, source: 'pos_credit_restock' },
      ],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(150, 6)          // (4 − 1) × 50
    expect(derivedItemValue).toBeCloseTo(37.5, 6)    // 75 g tomato × 0.5
    // The tab's "Credit Note — put back" filter: it showed nothing at all while `qty_sold > 0`
    // dropped every one of these rows.
    const put = usageForSource(rows[0], 'pos_credit_restock')
    expect(put.qty).toBeCloseTo(-50, 6)
    expect(put.batches).toBeCloseTo(-0.025, 6)
    expect(put.value).toBeCloseTo(-12.5, 6)
    expect(put.topValue).toBeCloseTo(-12.5, 6)
    expect(usageForSource(rows[0], 'pos_sale').qty).toBeCloseTo(200, 6)
  })

  test('a put-back row takes its choices back off with its plates', async () => {
    const deltas = [{ sub_recipe_id: 'sauce', qty: 50 }]
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      sales: [
        { recipe_id: 'dish', qty_sold: 3, bs_day: 3, source: 'pos', ingredient_deltas: deltas },
        { recipe_id: 'dish', qty_sold: -1, bs_day: 4, source: 'pos_credit_restock', ingredient_deltas: deltas },
      ],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(200, 6)          // (50 recipe + 50 choice) × (3 − 1)
    expect(usageForSource(rows[0], 'pos_credit_restock').qty).toBeCloseTo(-100, 6)
  })

  // S835: a choice's lines follow their dish. Where the dish's net sold in the period is 0 or less,
  // neither its recipe nor its choices add usage — as buildUsageMap (stockReportCalc.js) has it.
  test('a dish netted to zero or below by credit notes uses nothing — recipe and choices alike', async () => {
    const deltas = [{ sub_recipe_id: 'sauce', qty: 50 }]
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      ingredients: [
        ...BASE.ingredients,
        { recipe_id: 'soup', qty_per_portion: 100, item_id: null, sub_recipe_id: 'sauce', items: null },
      ],
      sales: [
        // Pasta: sold 2, both put back — net 0.
        { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos', ingredient_deltas: deltas },
        { recipe_id: 'dish', qty_sold: -2, bs_day: 3, source: 'pos_credit_restock', ingredient_deltas: deltas },
        // Soup: sold 1, three put back (two of them sold last month) — net −2, never a negative usage.
        { recipe_id: 'soup', qty_sold: 1, bs_day: 5, source: 'pos' },
        { recipe_id: 'soup', qty_sold: -3, bs_day: 5, source: 'pos_credit_restock' },
      ],
    })
    const usage = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(usage.rows).toEqual([])
    expect(usage.derivedItemValue).toBe(0)
  })

  test('a dish netted to zero does not take another dish\'s usage with it', async () => {
    const deltas = [{ sub_recipe_id: 'sauce', qty: 50 }]
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      ingredients: [
        ...BASE.ingredients,
        { recipe_id: 'soup', qty_per_portion: 100, item_id: null, sub_recipe_id: 'sauce', items: null },
      ],
      sales: [
        { recipe_id: 'dish', qty_sold: 2, bs_day: 3, source: 'pos', ingredient_deltas: deltas },
        { recipe_id: 'dish', qty_sold: -2, bs_day: 3, source: 'pos_credit_restock', ingredient_deltas: deltas },
        { recipe_id: 'soup', qty_sold: 1, bs_day: 5, source: 'pos' },
      ],
    })
    const { rows, derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].qty).toBeCloseTo(100, 6)          // the soup's alone
    expect(derivedItemValue).toBeCloseTo(25, 6)      // 50 g tomato × 0.5
  })
})

describe('ingredient search', () => {
  test('each row carries its own raw ingredients, named and sorted', async () => {
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      ingredients: [
        ...BASE.ingredients,
        { recipe_id: 'sauce', qty_per_portion: 5, item_id: 'basil', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      items: [...BASE.items, { id: 'basil', name: 'Basil', per_uom_rate: 3 }],
      sales: [{ recipe_id: 'dish', qty_sold: 1, bs_day: 1, source: 'pos' }],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows[0].ingredients).toEqual(['Basil', 'Tomatoes'])
  })

  test('a nested sub-recipe\'s ingredients are visible on the parent, not just on itself', async () => {
    const { supabase, scopedFrom } = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 50,  item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [
        { id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Sub-Recipe', cost_price: null },
        { id: 'base',  yield_qty: 500,  yield_uom: 'g',  name: 'Herb Base',   category: 'Sub-Recipe', cost_price: null },
      ],
      items: [{ id: 'herb', name: 'Fresh Herbs', per_uom_rate: 2 }],
      sales: [{ recipe_id: 'dish', qty_sold: 1, bs_day: 1, source: 'pos' }],
    })
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    const sauce = rows.find(r => r.name === 'House Sauce')
    // The sauce contains no raw item directly — only the base — so this is the whole point:
    // searching "herbs" must still surface it.
    expect(sauce.ingredients).toEqual(['Fresh Herbs'])
    expect(subRecipeHasIngredient(sauce, 'herbs')).toBe(true)
  })
})

describe('unused-this-period diff', () => {
  // Two sub-recipes on file, only one reachable from what sold — the shape behind "9 of your 57
  // weren't used this period", which is what the count gap against Recipe Costing actually is.
  const withSpare = {
    ...BASE,
    recipes: [
      ...BASE.recipes,
      { id: 'spare', yield_qty: 100, yield_uom: 'g', name: 'Unused Paste', category: 'Sub-Recipe', cost_price: null },
    ],
    sales: [{ recipe_id: 'dish', qty_sold: 1, bs_day: 1, source: 'pos' }],
  }

  test('names the sub-recipes nothing sold this period touched', async () => {
    const { supabase, scopedFrom } = makeStub(withSpare)
    const { rows, unusedSubRecipes, totalSubRecipes } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows.map(r => r.name)).toEqual(['House Sauce'])
    expect(unusedSubRecipes).toEqual(['Unused Paste'])
    // used + unused ties back to the master total, which is the whole point of showing it.
    expect(rows.length + unusedSubRecipes.length).toBe(totalSubRecipes)
  })

  test('when nothing sold at all, every sub-recipe counts as unused rather than reporting none', async () => {
    const { supabase, scopedFrom } = makeStub({ ...withSpare, sales: [] })
    const { rows, unusedSubRecipes, totalSubRecipes } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows).toEqual([])
    expect(totalSubRecipes).toBe(2)
    expect(unusedSubRecipes).toEqual(['House Sauce', 'Unused Paste'])
  })

  test('flags a recipe used as an ingredient but not categorised as a Sub-Recipe', async () => {
    // House Sauce is referenced via sub_recipe_id but left on the default category, so Recipe
    // Costing would not count it and used+unused could not tie out. That gets named, not hidden.
    const { supabase, scopedFrom } = makeStub({
      ...BASE,
      recipes: [{ id: 'sauce', yield_qty: 2000, yield_uom: 'ml', name: 'House Sauce', category: 'Food', cost_price: null }],
      sales: [{ recipe_id: 'dish', qty_sold: 1, bs_day: 1, source: 'pos' }],
    })
    const { miscategorised } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(miscategorised).toEqual(['House Sauce'])
  })
})

// S793: the loader's whole point on a slow connection is how many round trips it waits on. It
// used to be ~9 in a row (three recipe walks, one per nesting level each, then an items read);
// it is now the period's sales and the recipe book, side by side.
describe('loadSubRecipeUsage — round trips', () => {
  const NESTED = {
    ...BASE,
    ingredients: [
      ...BASE.ingredients,
      { recipe_id: 'sauce', qty_per_portion: 10, item_id: null, sub_recipe_id: 'base', items: null },
      { recipe_id: 'base', qty_per_portion: 100, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
    ],
    recipes: [...BASE.recipes, { id: 'base', yield_qty: 100, yield_uom: 'g', name: 'Base', category: 'Sub-Recipe', cost_price: null }],
    sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos' }],
  }
  function counted(fx) {
    const { supabase, scopedFrom } = makeStub(fx)
    const reads = []
    return {
      reads,
      supabase: { from: table => { reads.push(table); return supabase.from(table) } },
      scopedFrom: (table, cols) => { reads.push(cols && cols.includes('recipe_ingredients') ? 'recipe book' : table); return scopedFrom(table, cols) },
    }
  }

  test('reads the sales and the recipe book, and nothing else, however deep the prep nests', async () => {
    const { reads, supabase, scopedFrom } = counted(NESTED)
    const { rows } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(rows.map(r => r.name).sort()).toEqual(['Base', 'House Sauce'])
    expect(reads.sort()).toEqual(['recipe book', 'sales_entries'])
  })

  test('a book the page already loaded is used as given, and not read again', async () => {
    const { reads, supabase, scopedFrom } = counted(NESTED)
    const book = await loadRecipeBook(makeStub(NESTED).scopedFrom)
    const shared = await loadSubRecipeUsage(supabase, scopedFrom, 'p1', { book: Promise.resolve(book) })
    expect(reads).toEqual(['sales_entries'])
    const own = await loadSubRecipeUsage(makeStub(NESTED).supabase, makeStub(NESTED).scopedFrom, 'p1')
    expect(shared).toEqual(own)
  })

  // The book holds only items some recipe names, so an item only a CHOICE takes is read on its own
  // — one chunked `items` read, and only when such an item exists.
  test('a sub-recipe choice, or an item choice the book already holds, costs no extra read', async () => {
    const { reads, supabase, scopedFrom } = counted({
      ...NESTED,
      sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos',
        ingredient_deltas: [{ sub_recipe_id: 'base', qty: 10 }, { item_id: 'tomato', qty: 10 }] }],
    })
    const { derivedItemValue } = await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(reads.sort()).toEqual(['recipe book', 'sales_entries'])
    expect(derivedItemValue).toBeGreaterThan(0)
  })

  test('an item only a choice takes costs exactly one items read', async () => {
    const { reads, supabase, scopedFrom } = counted({
      ...NESTED,
      items: [...NESTED.items, { id: 'cheese', name: 'Cheese', per_uom_rate: 1.5, yield_pct: 100 }],
      sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }],
    })
    await loadSubRecipeUsage(supabase, scopedFrom, 'p1')
    expect(reads.sort()).toEqual(['items', 'recipe book', 'sales_entries'])
  })

  test('a failed choice-items read rejects rather than valuing the items at zero', async () => {
    const fx = {
      ...NESTED,
      items: [...NESTED.items, { id: 'cheese', name: 'Cheese', per_uom_rate: 1.5 }],
      sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }],
    }
    const { supabase, scopedFrom } = makeStub(fx)
    const failing = (table, cols) => (table === 'items'
      ? { in() { return this }, order() { return this }, range: () => Promise.resolve({ data: null, error: { message: 'items down' } }) }
      : scopedFrom(table, cols))
    await expect(loadSubRecipeUsage(supabase, failing, 'p1')).rejects.toThrow('items down')
  })

  test('the shared book is not changed by the choice-items read', async () => {
    const fx = {
      ...NESTED,
      items: [...NESTED.items, { id: 'cheese', name: 'Cheese', per_uom_rate: 1.5 }],
      sales: [{ recipe_id: 'dish', qty_sold: 2, bs_day: 1, source: 'pos', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }],
    }
    const { supabase, scopedFrom } = makeStub(fx)
    const book = await loadRecipeBook(scopedFrom)
    await loadSubRecipeUsage(supabase, scopedFrom, 'p1', { book })
    expect(book.items.has('cheese')).toBe(false)
  })

  test('a failed book read rejects — it is never an empty, quiet period', async () => {
    const { supabase, scopedFrom } = makeStub(NESTED)
    const failing = (table, cols) => (cols && cols.includes('recipe_ingredients')
      ? { order() { return this }, range: () => Promise.resolve({ data: null, error: { message: 'book down' } }) }
      : scopedFrom(table, cols))
    await expect(loadSubRecipeUsage(supabase, failing, 'p1')).rejects.toThrow('book down')
  })
})

describe('subRecipeHasIngredient', () => {
  const row = { ingredients: ['Acai Powder', 'Banana', 'Honey'] }

  test('an empty query matches everything (no filter applied)', () => {
    expect(subRecipeHasIngredient(row, '')).toBe(true)
  })

  test('matches on a partial, case-insensitive substring', () => {
    expect(subRecipeHasIngredient(row, 'acai')).toBe(true)
    expect(subRecipeHasIngredient(row, 'nan')).toBe(true)
  })

  test('does not match an ingredient that is absent', () => {
    expect(subRecipeHasIngredient(row, 'mango')).toBe(false)
  })

  test('a row with no ingredients never matches a real query, and does not throw', () => {
    expect(subRecipeHasIngredient({}, 'milk')).toBe(false)
    expect(subRecipeHasIngredient({}, '')).toBe(true)
  })
})

describe('usageForSource', () => {
  const row = {
    qty: 200, batches: 0.1, topBatches: 0.1, value: 50, topValue: 50, batchCost: 500,
    bySource: {
      pos_sale: { qty: 150, batches: 0.075, topBatches: 0.075 },
      pos_comp: { qty: 50, batches: 0.025, topBatches: 0.025 },
    },
  }

  test('"all" passes the row through untouched', () => {
    expect(usageForSource(row, 'all')).toBe(row)
  })

  test('a single source carries its own qty, batches and value', () => {
    const comp = usageForSource(row, 'pos_comp')
    expect(comp.qty).toBeCloseTo(50, 6)
    expect(comp.batches).toBeCloseTo(0.025, 6)
    expect(comp.value).toBeCloseTo(12.5, 6)     // 0.025 batch × 500
    expect(comp.topValue).toBeCloseTo(12.5, 6)
  })

  test('a source with no usage collapses to zero rather than NaN', () => {
    const manual = usageForSource(row, 'manual')
    expect(manual.qty).toBe(0)
    expect(manual.batches).toBe(0)
    expect(manual.value).toBe(0)
    expect(manual.topValue).toBe(0)
  })

  // A share of the row's qty could not say this: the row nets to zero, so every share was 0.
  test('a put-back source keeps its own negative figures, even where the row nets to zero', () => {
    const netZero = {
      qty: 0, batches: 0, topBatches: 0, value: 0, topValue: 0, batchCost: 500,
      bySource: {
        pos_sale: { qty: 50, batches: 0.025, topBatches: 0.025 },
        pos_credit_restock: { qty: -50, batches: -0.025, topBatches: -0.025 },
      },
    }
    const put = usageForSource(netZero, 'pos_credit_restock')
    expect(put.qty).toBeCloseTo(-50, 6)
    expect(put.value).toBeCloseTo(-12.5, 6)
    expect(put.topValue).toBeCloseTo(-12.5, 6)
  })

  // topBatches does not split by qty: one source reached the sub-recipe nested, the other directly.
  test('topValue is the source\'s own direct share, not a share of qty', () => {
    const mixed = {
      qty: 200, batches: 0.4, topBatches: 0.2, value: 200, topValue: 100, batchCost: 500,
      bySource: {
        pos_sale: { qty: 100, batches: 0.2, topBatches: 0 },
        pos_comp: { qty: 100, batches: 0.2, topBatches: 0.2 },
      },
    }
    expect(usageForSource(mixed, 'pos_sale').topValue).toBeCloseTo(0, 6)
    expect(usageForSource(mixed, 'pos_comp').topValue).toBeCloseTo(100, 6)
  })
})
