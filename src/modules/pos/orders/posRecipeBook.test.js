import { bookFromPosRead, deltaIdsOf, loadPosRecipeBook, posFoodCosts, posStockLines } from './posRecipeBook'
import { computeRecipeCosts, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion, deltaItems } from '../../../utils/orderLineIngredients'

// S809 IMS-HANDOFF-3. A till on a Staff PIN cannot read `items` (RESTRICTIVE no_pos_pin_staff), so
// the old reads gave every ingredient a 100% yield and a rate of 0. The till now reads the book
// through pos_recipe_book (SECURITY DEFINER) and feeds it to the one walk. These tests hold:
//   * the read's real shape (READ below is what the migration's function returned for this outlet
//     in a local Postgres copy, 2026-10-09) walks to the right stock lines and costs;
//   * those are EXACTLY what the Owner's own reads give (the fetch path, which a PIN login could
//     not use), so a bill's ledger no longer depends on who held the till;
//   * the old PIN-login reads were wrong in the way the review described.

const CLIENT = 'a4bd5cba-4955-4309-819e-646834c05c7e'
const CHICKEN = '00000000-0000-0000-0000-00000000c001'   // 85% yield, NPR 0.50 a gram
const ONION = '00000000-0000-0000-0000-00000000c002'     // 50% yield, NPR 0.10
const TOMATO = '00000000-0000-0000-0000-00000000c003'    // 100%, NPR 0.20
const CHEESE = '00000000-0000-0000-0000-00000000c004'    // 80%, NPR 2 (a choice line only)
const SAUCE = '00000000-0000-0000-0000-00000000d001'     // sub-recipe: 1,000 g from 800 g tomato + 100 g onion
const MOMO = '00000000-0000-0000-0000-00000000d002'      // 100 g chicken + 20 g sauce, typed Cost Price 0
const COKE = '00000000-0000-0000-0000-00000000d003'      // no ingredients, typed Cost Price 40

// pos_recipe_book(CLIENT, [MOMO, COKE], [CHEESE]), as Postgres returned it.
const READ = {
  items: [{ id: CHEESE, yield_pct: 80.00, per_uom_rate: 2.0 }],
  recipes: [
    { id: SAUCE, yield_qty: 1000, cost_price: null, recipe_ingredients: [
      { id: 'e003', items: { yield_pct: 100.00, per_uom_rate: 0.2 }, item_id: TOMATO, recipe_id: SAUCE, sub_recipe_id: null, qty_per_portion: 800 },
      { id: 'e004', items: { yield_pct: 50.00, per_uom_rate: 0.1 }, item_id: ONION, recipe_id: SAUCE, sub_recipe_id: null, qty_per_portion: 100 },
    ] },
    { id: MOMO, yield_qty: 1, cost_price: 0, recipe_ingredients: [
      { id: 'e001', items: { yield_pct: 85.00, per_uom_rate: 0.5 }, item_id: CHICKEN, recipe_id: MOMO, sub_recipe_id: null, qty_per_portion: 100 },
      { id: 'e002', items: null, item_id: null, recipe_id: MOMO, sub_recipe_id: SAUCE, qty_per_portion: 20 },
    ] },
    { id: COKE, yield_qty: 1, cost_price: 40, recipe_ingredients: [] },
  ],
}

// The same outlet through the plain table reads the walk makes when it is not handed a book. With
// `itemsVisible: false` it is what a PIN login gets: the items embed null and the items table empty,
// with no error (RLS).
const ITEMS = { [CHICKEN]: { yield_pct: 85, per_uom_rate: 0.5 }, [ONION]: { yield_pct: 50, per_uom_rate: 0.1 },
  [TOMATO]: { yield_pct: 100, per_uom_rate: 0.2 }, [CHEESE]: { yield_pct: 80, per_uom_rate: 2 } }
const RECIPES = READ.recipes.map(({ recipe_ingredients, ...r }) => r)
const INGREDIENTS = READ.recipes.flatMap(r => r.recipe_ingredients.map(({ items, ...i }) => i))

function tableStub({ itemsVisible }) {
  const tables = {
    recipe_ingredients: INGREDIENTS.map(i => ({ ...i, items: i.item_id && itemsVisible ? { yield_pct: ITEMS[i.item_id].yield_pct } : null })),
    recipes: RECIPES,
    items: itemsVisible ? Object.entries(ITEMS).map(([id, v]) => ({ id, ...v })) : [],
  }
  return {
    from(table) {
      return {
        select() {
          return {
            in(col, ids) {
              const set = new Set(ids)
              const key = table === 'recipe_ingredients' ? 'recipe_id' : 'id'
              const rows = tables[table].filter(r => set.has(r[key]))
              return { order() { return { range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }) } } } }
            },
          }
        },
      }
    },
  }
}

function rpcStub(answer = { data: READ, error: null }) {
  const calls = []
  return { calls, rpc: (fn, args) => { calls.push([fn, args]); return Promise.resolve(answer) } }
}

const byItem = rows => Object.fromEntries(rows.map(r => [r.item_id, r.qty]))

describe('the till reads the recipe book through pos_recipe_book (S809 IMS-HANDOFF-3)', () => {
  it('a plate of momo takes the chicken off at its 85% yield, and the sauce through its sub-recipe', async () => {
    const book = bookFromPosRead(READ)
    const out = await explodeRecipeIngredients(null, [MOMO], { book })
    const got = byItem(out[MOMO])
    expect(got[CHICKEN]).toBeCloseTo(100 / 0.85, 9)        // 117.65 g, not 100
    expect(got[TOMATO]).toBeCloseTo(16, 9)                 // 20 g of a 1,000 g batch of 800 g
    expect(got[ONION]).toBeCloseTo(100 * 0.02 / 0.5, 9)   // 4 g at 50% yield
  })

  it('a comped momo is valued at its ingredients, a coke at its typed Cost Price', async () => {
    const costs = await computeRecipeCosts(null, [MOMO, COKE], { book: bookFromPosRead(READ) })
    expect(costs[MOMO]).toBeCloseTo((100 / 0.85) * 0.5 + 16 * 0.2 + 4 * 0.1, 9)   // NPR 62.42
    expect(costs[COKE]).toBe(40)
  })

  it('gives a PIN login exactly what the Owner\'s own reads give', async () => {
    const owner = tableStub({ itemsVisible: true })
    const book = bookFromPosRead(READ)
    expect(await explodeRecipeIngredients(null, [MOMO, COKE], { book }))
      .toEqual(await explodeRecipeIngredients(owner, [MOMO, COKE]))
    expect(await computeRecipeCosts(null, [MOMO, COKE], { book }))
      .toEqual(await computeRecipeCosts(owner, [MOMO, COKE]))
    const deltas = [[{ item_id: CHEESE, qty: 30 }, { sub_recipe_id: SAUCE, qty: 20 }]]
    expect(await loadDeltaExplosion(null, deltas, { book }))
      .toEqual(await loadDeltaExplosion(owner, deltas))
  })

  it('the old reads from a PIN login were the bug: every yield 100% and the momo costed at NPR 0', async () => {
    const pin = tableStub({ itemsVisible: false })
    const out = await explodeRecipeIngredients(pin, [MOMO])
    expect(byItem(out[MOMO])[CHICKEN]).toBe(100)
    const costs = await computeRecipeCosts(pin, [MOMO, COKE])
    expect(costs[MOMO]).toBe(0)
    expect(costs[COKE]).toBe(40)
  })
})

describe('posFoodCosts / posStockLines / loadPosRecipeBook', () => {
  it('asks once, for this outlet, with each id once and no blanks', async () => {
    const sb = rpcStub()
    const costs = await posFoodCosts(sb, CLIENT, [MOMO, COKE, MOMO, null, undefined])
    expect(sb.calls).toEqual([['pos_recipe_book', { p_client_id: CLIENT, p_recipe_ids: [MOMO, COKE], p_item_ids: [] }]])
    expect(Object.keys(costs).sort()).toEqual([MOMO, COKE].sort())
  })

  it('asks nothing for a bill with no dishes', async () => {
    const sb = rpcStub()
    expect(await posFoodCosts(sb, CLIENT, [])).toEqual({})
    expect(await posStockLines(sb, CLIENT, [], [])).toEqual({ breakdown: {}, explosion: { itemYield: {}, subPerUnit: {} } })
    expect(sb.calls).toHaveLength(0)
  })

  it('a customized line: the choices\' items and sub-recipes are in the same read, trimmed the same way', async () => {
    const sb = rpcStub()
    const deltas = [[{ item_id: CHEESE, qty: 30 }, { sub_recipe_id: SAUCE, qty: 20 }], null]
    const { breakdown, explosion } = await posStockLines(sb, CLIENT, [MOMO], deltas)
    expect(sb.calls).toEqual([['pos_recipe_book', { p_client_id: CLIENT, p_recipe_ids: [MOMO, SAUCE], p_item_ids: [CHEESE] }]])
    expect(byItem(breakdown[MOMO])[CHICKEN]).toBeCloseTo(100 / 0.85, 9)
    expect(explosion.itemYield[CHEESE]).toBe(80)
    const extra = byItem(deltaItems(deltas[0], explosion))
    expect(extra[CHEESE]).toBeCloseTo(37.5, 9)   // 30 g at 80% yield
    expect(extra[TOMATO]).toBeCloseTo(16, 9)     // 20 g of sauce
    expect(extra[ONION]).toBeCloseTo(4, 9)
  })

  it('a refused read throws, keeping the hint for errorText, never an empty book', async () => {
    const sb = rpcStub({ data: null, error: { code: '42501', hint: 'rank_required', message: 'pos_recipe_book: refused' } })
    await expect(loadPosRecipeBook(sb, CLIENT, { recipeIds: [MOMO] })).rejects.toMatchObject({ hint: 'rank_required', code: '42501' })
    await expect(posFoodCosts(sb, CLIENT, [MOMO])).rejects.toThrow('pos_recipe_book: refused')
    await expect(posStockLines(sb, CLIENT, [MOMO], [])).rejects.toThrow('pos_recipe_book: refused')
  })

  it('deltaIdsOf lists each item and sub-recipe once', () => {
    expect(deltaIdsOf([[{ item_id: CHEESE, qty: 1 }, { sub_recipe_id: SAUCE, qty: 2 }], [{ item_id: CHEESE, qty: 3 }], null]))
      .toEqual({ itemIds: [CHEESE], subRecipeIds: [SAUCE] })
  })
})
