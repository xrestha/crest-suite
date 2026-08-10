import { explodeRecipeIngredients, explodeRecipeTree } from './recipeCost'

// Minimal Supabase stub — only the three queries explodeRecipeTree actually makes:
//   recipe_ingredients .select(...).in('recipe_id', ids)
//   recipes            .select('id, yield_qty').in('id', ids)
// `.in()` resolves directly, which is enough for both the awaited call and the Promise.all pair.
function makeStub({ ingredients = [], recipes = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            in(_col, ids) {
              const set = new Set(ids)
              const data = table === 'recipe_ingredients'
                ? ingredients.filter(r => set.has(r.recipe_id))
                : recipes.filter(r => set.has(r.id))
              return Promise.resolve({ data })
            },
          }
        },
      }
    },
  }
}

const byItem = rows => Object.fromEntries(rows.map(r => [r.item_id, r.qty]))
const bySub = rows => Object.fromEntries(rows.map(r => [r.sub_recipe_id, r]))

describe('explodeRecipeTree — leaf items', () => {
  test('direct ingredient at 100% yield passes through unchanged', async () => {
    const db = makeStub({
      ingredients: [{ recipe_id: 'dish', qty_per_portion: 100, item_id: 'A', sub_recipe_id: null, items: { yield_pct: 100 } }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(byItem(tree.dish.items)).toEqual({ A: 100 })
    expect(tree.dish.subRecipes).toEqual([])
  })

  test('yield_pct is an uplift, not a discount — 80% yield needs 1/0.8 as much raw', async () => {
    const db = makeStub({
      ingredients: [{ recipe_id: 'dish', qty_per_portion: 100, item_id: 'B', sub_recipe_id: null, items: { yield_pct: 80 } }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(tree.dish.items[0].qty).toBeCloseTo(125, 6)
  })

  test('missing yield_pct falls back to 100%', async () => {
    const db = makeStub({
      ingredients: [{ recipe_id: 'dish', qty_per_portion: 40, item_id: 'C', sub_recipe_id: null, items: null }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(tree.dish.items[0].qty).toBeCloseTo(40, 6)
  })
})

describe('explodeRecipeTree — sub-recipe reporting', () => {
  // dish uses 50 units of sauce; sauce yields 2000 units per batch from 1000g of tomato.
  const oneLevel = {
    ingredients: [
      { recipe_id: 'dish',  qty_per_portion: 50,   item_id: null, sub_recipe_id: 'sauce', items: null },
      { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
    ],
    recipes: [{ id: 'sauce', yield_qty: 2000 }],
  }

  test('reports the sub-recipe in output units and batches', async () => {
    const tree = await explodeRecipeTree(makeStub(oneLevel), ['dish'])
    const sauce = bySub(tree.dish.subRecipes).sauce
    expect(sauce.qty).toBeCloseTo(50, 6)          // output units consumed
    expect(sauce.batches).toBeCloseTo(0.025, 6)   // 50 / 2000
  })

  test('still explodes through to the raw item at the correct scale', async () => {
    const tree = await explodeRecipeTree(makeStub(oneLevel), ['dish'])
    expect(byItem(tree.dish.items).tomato).toBeCloseTo(25, 6) // 1000 × 0.025
  })

  test('nested sub-recipe is reported at its OWN output-unit scale, not the parent dish\'s', async () => {
    // dish → 50 of sauce (yield 2000) → sauce uses 100 of base (yield 500) → base is 200g herb
    const db = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 50,  item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base',  items: null },
        { recipe_id: 'base',  qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [{ id: 'sauce', yield_qty: 2000 }, { id: 'base', yield_qty: 500 }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    const subs = bySub(tree.dish.subRecipes)
    expect(subs.sauce.qty).toBeCloseTo(50, 6)
    expect(subs.sauce.batches).toBeCloseTo(0.025, 6)
    expect(subs.base.qty).toBeCloseTo(2.5, 6)       // 100 × 0.025 batches of sauce
    expect(subs.base.batches).toBeCloseTo(0.005, 6) // 2.5 / 500
    expect(byItem(tree.dish.items).herb).toBeCloseTo(1, 6) // 200 × 0.005
  })

  test('the same sub-recipe reached by two paths is aggregated, not listed twice', async () => {
    const db = makeStub({
      ingredients: [
        { recipe_id: 'dish', qty_per_portion: 30, item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'dish', qty_per_portion: 20, item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [{ id: 'sauce', yield_qty: 2000 }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(tree.dish.subRecipes).toHaveLength(1)
    expect(tree.dish.subRecipes[0].qty).toBeCloseTo(50, 6)
  })

  test('an item reached both directly and via a sub-recipe is summed into one row', async () => {
    const db = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 10,   item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
        { recipe_id: 'dish',  qty_per_portion: 50,   item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [{ id: 'sauce', yield_qty: 2000 }],
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(tree.dish.items).toHaveLength(1)
    expect(tree.dish.items[0].qty).toBeCloseTo(35, 6) // 10 direct + 25 via sauce
  })
})

describe('explodeRecipeIngredients — return shape is unchanged', () => {
  // The whole point of the refactor: ~8 stock/cost consumers read this flat array. If this
  // describe block ever fails, Variance / Book Stock / Dashboard usage figures have moved.
  test('returns a flat { [recipeId]: [{item_id, qty}] } with no sub-recipe keys', async () => {
    const db = makeStub({
      ingredients: [
        { recipe_id: 'dish',  qty_per_portion: 50,   item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [{ id: 'sauce', yield_qty: 2000 }],
    })
    const flat = await explodeRecipeIngredients(db, ['dish'])
    expect(flat).toEqual({ dish: [{ item_id: 'tomato', qty: 25 }] })
    expect(Object.keys(flat.dish[0])).toEqual(['item_id', 'qty'])
  })

  test('agrees exactly with explodeRecipeTree(...).items for every recipe', async () => {
    const db = makeStub({
      ingredients: [
        { recipe_id: 'a', qty_per_portion: 10, item_id: 'x', sub_recipe_id: null, items: { yield_pct: 90 } },
        { recipe_id: 'b', qty_per_portion: 50, item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: { yield_pct: 100 } },
      ],
      recipes: [{ id: 'sauce', yield_qty: 2000 }],
    })
    const flat = await explodeRecipeIngredients(db, ['a', 'b'])
    const tree = await explodeRecipeTree(db, ['a', 'b'])
    expect(flat).toEqual({ a: tree.a.items, b: tree.b.items })
  })

  test('empty input returns {}', async () => {
    expect(await explodeRecipeIngredients(makeStub(), [])).toEqual({})
    expect(await explodeRecipeTree(makeStub(), [])).toEqual({})
  })
})
