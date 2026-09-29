import {
  explodeRecipeIngredients, explodeRecipeTree, computeRecipeCosts,
  buildRecipeBook, loadRecipeBook, RECIPE_BOOK_SELECT,
} from './recipeCost'

// Minimal Supabase stub — only the two queries explodeRecipeTree actually makes:
//   recipe_ingredients .select(...).in('recipe_id', ids).order('id').range(from, to)
//   recipes            .select('id, yield_qty').in('id', ids).order('id').range(from, to)
//
// The `.order().range()` tail is not decoration: both reads go through fetchAllRowsChunked now
// (S711), which pages with `.range()` and requires a uniquely-ordered query to do it safely.
//
// SERVER_MAX_ROWS mirrors Supabase's `db-max-rows`, the cap that made this necessary — the stub
// refuses to return more than that in one response exactly as PostgREST does, silently and with
// no error, so the "pages past 1000 rows" test below is a real reproduction rather than a mock
// that agrees with whatever the code happens to do.
const SERVER_MAX_ROWS = 1000

function makeStub({ ingredients = [], recipes = [], items = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            in(_col, ids) {
              const set = new Set(ids)
              // `items` serves computeRecipeCosts' rate read (S793's equivalence tests).
              const rows = table === 'recipe_ingredients'
                ? ingredients.filter(r => set.has(r.recipe_id))
                : table === 'items'
                  ? items.filter(r => set.has(r.id))
                  : recipes.filter(r => set.has(r.id))
              return {
                order() {
                  return {
                    range(from, to) {
                      // Mirrors PostgREST: an inclusive range, truncated to db-max-rows.
                      const end = Math.min(to, from + SERVER_MAX_ROWS - 1)
                      return Promise.resolve({ data: rows.slice(from, end + 1) })
                    },
                  }
                },
              }
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

describe('explodeRecipeTree — the recursion depth cap (S714)', () => {
  // A chain: dish -> s1 -> s2 -> ... -> s11 -> flour. Twelve levels below the dish, which the
  // frontier loop resolves (MAX_DEPTH_ROUNDS = 12) and which explode() used to refuse to walk at
  // a hardcoded depth > 10 — silently, because the frontier came back empty so the loud
  // "nesting deeper than" console.error could not fire. Every yield_qty is 1 so the expected
  // quantity is exactly the leaf's own, which makes a dropped level unmissable rather than
  // approximately right.
  const CHAIN = 11
  function chainDb() {
    const ingredients = [{ recipe_id: 'dish', qty_per_portion: 1, sub_recipe_id: 's1', item_id: null }]
    for (let i = 1; i < CHAIN; i++) {
      ingredients.push({ recipe_id: `s${i}`, qty_per_portion: 1, sub_recipe_id: `s${i + 1}`, item_id: null })
    }
    ingredients.push({ recipe_id: `s${CHAIN}`, qty_per_portion: 3, item_id: 'flour', sub_recipe_id: null, items: { yield_pct: 100 } })
    const recipes = Array.from({ length: CHAIN }, (_, i) => ({ id: `s${i + 1}`, yield_qty: 1 }))
    return makeStub({ ingredients, recipes })
  }

  test('reaches a leaf eleven sub-recipes down', async () => {
    const tree = await explodeRecipeTree(chainDb(), ['dish'])
    expect(byItem(tree.dish.items)).toEqual({ flour: 3 })
  })

  test('reports every sub-recipe on the way down', async () => {
    const tree = await explodeRecipeTree(chainDb(), ['dish'])
    expect(tree.dish.subRecipes).toHaveLength(CHAIN)
  })

  test('running past the cap is LOUD, never a smaller believable number', async () => {
    // 20 levels: deeper than the fetch loop resolves as well as deeper than explode() walks.
    const ingredients = [{ recipe_id: 'dish', qty_per_portion: 1, sub_recipe_id: 's1', item_id: null }]
    for (let i = 1; i < 20; i++) {
      ingredients.push({ recipe_id: `s${i}`, qty_per_portion: 1, sub_recipe_id: `s${i + 1}`, item_id: null })
    }
    ingredients.push({ recipe_id: 's20', qty_per_portion: 3, item_id: 'flour', sub_recipe_id: null, items: { yield_pct: 100 } })
    const recipes = Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}`, yield_qty: 1 }))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const tree = await explodeRecipeTree(makeStub({ ingredients, recipes }), ['dish'])
    expect(byItem(tree.dish.items)).toEqual({})   // understated, and said so
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('explodeRecipeTree — the 1000-row cap (S711)', () => {
  // THE REGRESSION THIS PAGING EXISTS FOR. Before it, the read was a bare `.select().in()` and
  // PostgREST handed back the first 1000 rows with no error and nothing in the data to say so.
  // The dishes whose ingredient rows fell past the cut exploded to NOTHING — and a missing
  // theoretical usage does not read as missing, it reads as an item that was consumed less than
  // expected, i.e. as over-consumption on Variance and as stock still on hand on Reorder.
  //
  // 200 recipes at 8 ingredients each — a mid-size book once every sub-recipe and inactive dish
  // is counted, and Variance.js seeds the walk with ALL of them.
  //
  // The shape matters: chunking alone would NOT catch this. fetchAllRowsChunked splits at 150
  // ids, and 150 recipes here is 1200 rows — past the cap inside a single chunk, so the row
  // paging has to work as well as the URL chunking. A fixture of 1200 one-ingredient recipes
  // would pass on chunking alone and prove nothing about the cap.
  const PER_RECIPE = 8
  test('resolves every recipe past the 1000-row cap, not just the first page', async () => {
    const N = 200
    const ids = Array.from({ length: N }, (_, i) => `r${i}`)
    const db = makeStub({
      ingredients: ids.flatMap((id, i) => Array.from({ length: PER_RECIPE }, (_, k) => ({
        recipe_id: id, qty_per_portion: 2, item_id: `item-${i}-${k}`, sub_recipe_id: null,
        items: { yield_pct: 100 },
      }))),
    })
    const tree = await explodeRecipeTree(db, ids)
    expect(Object.keys(tree)).toHaveLength(N)
    // Every recipe resolved with its FULL ingredient list — the pre-fix failure was the recipes
    // beyond row 1000 coming back with `items: []`, and the one straddling it coming back short.
    const wrong = ids.filter(id => tree[id].items.length !== PER_RECIPE)
    expect(wrong).toEqual([])
    expect(tree[ids[N - 1]].items).toContainEqual({ item_id: `item-${N - 1}-7`, qty: 2 })
  })

  // The same cap one level down: a single dish whose sub-recipes' own ingredient rows cross it.
  // The frontier loop's read had the identical shape and so had the identical bug.
  test('pages the frontier read too, so deep ingredients are not lost', async () => {
    const N = 1100
    const subIds = Array.from({ length: N }, (_, i) => `sub${i}`)
    const db = makeStub({
      ingredients: [
        ...subIds.map(id => ({ recipe_id: 'dish', qty_per_portion: 1, item_id: null, sub_recipe_id: id, items: null })),
        ...subIds.map((id, i) => ({ recipe_id: id, qty_per_portion: 3, item_id: `leaf-${i}`, sub_recipe_id: null, items: { yield_pct: 100 } })),
      ],
      recipes: subIds.map(id => ({ id, yield_qty: 1 })),
    })
    const tree = await explodeRecipeTree(db, ['dish'])
    expect(tree.dish.subRecipes).toHaveLength(N)
    expect(tree.dish.items).toHaveLength(N)
  })
})

// ── The pre-loaded book (S793) ──────────────────────────────────────────────────────────────────
// loadRecipeBook exists so a page can walk the tree with no network at all — one request instead
// of one per nesting level. It must be a different way of FEEDING the one walk, never a different
// walk: every fixture below runs through both paths and the results must be deep-equal, not merely
// close, because both paths perform the same arithmetic in the same order.

// Fixture → the rows loadRecipeBook reads: every recipe (seed dishes included, which the fetch
// fixtures leave implicit) with its ingredient rows embedded, and each ingredient's `items` embed
// carrying the item's name and rate beside its yield.
function bookRowsOf({ ingredients = [], recipes = [], items = [] } = {}) {
  const itemById = new Map(items.map(i => [i.id, i]))
  const ids = [...new Set([...recipes.map(r => r.id), ...ingredients.map(i => i.recipe_id)])]
  return ids.map(id => ({
    ...(recipes.find(r => r.id === id) || { id }),
    recipe_ingredients: ingredients
      .filter(i => i.recipe_id === id)
      .map(i => (i.item_id ? { ...i, items: { ...(i.items || {}), ...(itemById.get(i.item_id) || {}) } } : i)),
  }))
}
const bookOf = fx => buildRecipeBook(bookRowsOf(fx))

const FULL_YIELD = { yield_pct: 100 }
const BOOK_FIXTURES = {
  'a direct ingredient with a yield': {
    seeds: ['dish'],
    ingredients: [{ recipe_id: 'dish', qty_per_portion: 100, item_id: 'B', sub_recipe_id: null, items: { yield_pct: 80 } }],
  },
  'a missing yield_pct': {
    seeds: ['dish'],
    ingredients: [{ recipe_id: 'dish', qty_per_portion: 40, item_id: 'C', sub_recipe_id: null, items: null }],
  },
  'one level of sub-recipe': {
    seeds: ['dish'],
    ingredients: [
      { recipe_id: 'dish', qty_per_portion: 50, item_id: null, sub_recipe_id: 'sauce', items: null },
      { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: FULL_YIELD },
    ],
    recipes: [{ id: 'sauce', yield_qty: 2000 }],
  },
  'nesting, a diamond and an item reached two ways': {
    // dish -> sauce -> base, dish -> base directly, and tomato both direct and through sauce.
    seeds: ['dish', 'side'],
    ingredients: [
      { recipe_id: 'dish', qty_per_portion: 10, item_id: 'tomato', sub_recipe_id: null, items: FULL_YIELD },
      { recipe_id: 'dish', qty_per_portion: 50, item_id: null, sub_recipe_id: 'sauce', items: null },
      { recipe_id: 'dish', qty_per_portion: 5, item_id: null, sub_recipe_id: 'base', items: null },
      { recipe_id: 'sauce', qty_per_portion: 100, item_id: null, sub_recipe_id: 'base', items: null },
      { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: FULL_YIELD },
      { recipe_id: 'base', qty_per_portion: 200, item_id: 'herb', sub_recipe_id: null, items: { yield_pct: 90 } },
      { recipe_id: 'side', qty_per_portion: 30, item_id: null, sub_recipe_id: 'sauce', items: null },
    ],
    recipes: [{ id: 'sauce', yield_qty: 2000 }, { id: 'base', yield_qty: 500 }],
  },
  'a sub-recipe that is also a seed (the S477 double count)': {
    seeds: ['dish', 'sauce'],
    ingredients: [
      { recipe_id: 'dish', qty_per_portion: 50, item_id: null, sub_recipe_id: 'sauce', items: null },
      { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: FULL_YIELD },
    ],
    recipes: [{ id: 'sauce', yield_qty: 2000 }],
  },
  'a seed with no ingredients': {
    seeds: ['dish', 'empty'],
    ingredients: [{ recipe_id: 'dish', qty_per_portion: 1, item_id: 'x', sub_recipe_id: null, items: FULL_YIELD }],
    recipes: [{ id: 'empty', yield_qty: 1 }],
  },
  'eleven levels deep': (() => {
    const ingredients = [{ recipe_id: 'dish', qty_per_portion: 1, sub_recipe_id: 's1', item_id: null }]
    for (let i = 1; i < 11; i++) ingredients.push({ recipe_id: `s${i}`, qty_per_portion: 1, sub_recipe_id: `s${i + 1}`, item_id: null })
    ingredients.push({ recipe_id: 's11', qty_per_portion: 3, item_id: 'flour', sub_recipe_id: null, items: FULL_YIELD })
    return { seeds: ['dish'], ingredients, recipes: Array.from({ length: 11 }, (_, i) => ({ id: `s${i + 1}`, yield_qty: 1 })) }
  })(),
  'a book past the 1000-row cap': (() => {
    const ids = Array.from({ length: 200 }, (_, i) => `r${i}`)
    return {
      seeds: ids,
      ingredients: ids.flatMap((id, i) => Array.from({ length: 8 }, (_, k) => ({
        recipe_id: id, qty_per_portion: 2, item_id: `item-${i}-${k}`, sub_recipe_id: null, items: FULL_YIELD,
      }))),
    }
  })(),
}

describe('explodeRecipeTree — a pre-loaded book walks identically (S793)', () => {
  test.each(Object.entries(BOOK_FIXTURES))('%s', async (_name, fx) => {
    const viaFetch = await explodeRecipeTree(makeStub(fx), fx.seeds)
    const viaBook = await explodeRecipeTree(null, fx.seeds, { book: bookOf(fx) })
    expect(viaBook).toEqual(viaFetch)
  })

  test('explodeRecipeIngredients passes the book through', async () => {
    const fx = BOOK_FIXTURES['nesting, a diamond and an item reached two ways']
    expect(await explodeRecipeIngredients(null, fx.seeds, { book: bookOf(fx) }))
      .toEqual(await explodeRecipeIngredients(makeStub(fx), fx.seeds))
  })

  test('a cycle is walked to the cap and reported on both paths, never looped', async () => {
    const fx = {
      seeds: ['dish'],
      ingredients: [
        { recipe_id: 'dish', qty_per_portion: 1, item_id: null, sub_recipe_id: 'a', items: null },
        { recipe_id: 'a', qty_per_portion: 1, item_id: null, sub_recipe_id: 'b', items: null },
        { recipe_id: 'b', qty_per_portion: 1, item_id: null, sub_recipe_id: 'a', items: null },
      ],
      recipes: [{ id: 'a', yield_qty: 1 }, { id: 'b', yield_qty: 1 }],
    }
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const viaFetch = await explodeRecipeTree(makeStub(fx), fx.seeds)
    const viaBook = await explodeRecipeTree(null, fx.seeds, { book: bookOf(fx) })
    expect(viaBook).toEqual(viaFetch)
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  test('a sub-recipe missing from the book is LOUD, never a quietly smaller tree', async () => {
    const book = bookOf({
      ingredients: [
        { recipe_id: 'dish', qty_per_portion: 1, item_id: 'x', sub_recipe_id: null, items: FULL_YIELD },
        { recipe_id: 'dish', qty_per_portion: 1, item_id: null, sub_recipe_id: 'gone', items: null },
      ],
    })
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const tree = await explodeRecipeTree(null, ['dish'], { book })
    expect(byItem(tree.dish.items)).toEqual({ x: 1 })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('gone'))
    spy.mockRestore()
  })
})

describe('computeRecipeCosts — a pre-loaded book prices identically (S793)', () => {
  test('ingredient cost, sub-recipe cost and the manual cost_price fallback', async () => {
    const fx = {
      ingredients: [
        { recipe_id: 'dish', qty_per_portion: 50, item_id: null, sub_recipe_id: 'sauce', items: null },
        { recipe_id: 'dish', qty_per_portion: 10, item_id: 'cheese', sub_recipe_id: null, items: { yield_pct: 80 } },
        { recipe_id: 'sauce', qty_per_portion: 1000, item_id: 'tomato', sub_recipe_id: null, items: FULL_YIELD },
      ],
      recipes: [
        { id: 'dish', yield_qty: 1, cost_price: 999 },    // costed from ingredients: 999 must NOT win
        { id: 'sauce', yield_qty: 2000, cost_price: null },
        { id: 'manual', yield_qty: 1, cost_price: 55 },   // no ingredients: the manual figure
        { id: 'nothing', yield_qty: 1, cost_price: null },
      ],
      items: [{ id: 'tomato', per_uom_rate: 0.5 }, { id: 'cheese', per_uom_rate: 2 }],
    }
    const seeds = ['dish', 'sauce', 'manual', 'nothing']
    const viaFetch = await computeRecipeCosts(makeStub(fx), seeds)
    const viaBook = await computeRecipeCosts(null, seeds, { book: bookOf(fx) })
    expect(viaBook).toEqual(viaFetch)
    expect(viaBook.dish).toBeCloseTo(25 * 0.5 + 12.5 * 2, 6)
    expect(viaBook.manual).toBe(55)
    expect(viaBook.nothing).toBe(0)
  })
})

describe('loadRecipeBook', () => {
  const fx = BOOK_FIXTURES['one level of sub-recipe']

  test('one scoped read of the book, ingredient rows ordered by id, paged on the recipes', async () => {
    const calls = []
    const scopedFrom = (table, cols) => {
      calls.push(['from', table, cols])
      const q = {
        order: (col, opts) => { calls.push(['order', col, opts]); return q },
        range: (from, to) => { calls.push(['range', from, to]); return Promise.resolve({ data: bookRowsOf(fx), error: null }) },
      }
      return q
    }
    const book = await loadRecipeBook(scopedFrom)
    expect(calls.filter(c => c[0] === 'from')).toEqual([['from', 'recipes', RECIPE_BOOK_SELECT]])
    expect(calls).toContainEqual(['order', 'id', { referencedTable: 'recipe_ingredients' }])
    expect(calls).toContainEqual(['range', 0, 999])
    expect(book.ingredientsByRecipe.get('dish')).toHaveLength(1)
    expect(book.recipes.get('sauce').yield_qty).toBe(2000)
  })

  test('the embed names its foreign key — recipe_ingredients points at recipes twice', () => {
    expect(RECIPE_BOOK_SELECT).toContain('recipe_ingredients!recipe_ingredients_recipe_id_fkey(')
  })

  test('a failed read throws rather than handing back an empty book', async () => {
    const failing = () => {
      const q = { order: () => q, range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
      return q
    }
    await expect(loadRecipeBook(failing)).rejects.toThrow('boom')
  })
})
