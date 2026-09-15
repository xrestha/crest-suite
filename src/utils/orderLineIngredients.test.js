import { lineIngredientDeltas, deltaItems, usageOfSalesRow } from './orderLineIngredients'

// The one place a customized plate's stock lines become raw items (S758). Pure halves only —
// loadDeltaExplosion reads Supabase and is exercised by the pages that call it.
describe('orderLineIngredients', () => {
  const explosion = {
    itemYield: { cheese: 100, onion: 50 },
    subPerUnit: { sauce: [{ item_id: 'tomato', qty: 0.5 }, { item_id: 'oil', qty: 0.1 }] },
  }

  it('flattens a line’s options into stored deltas, and returns null for none', () => {
    expect(lineIngredientDeltas([
      { ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] },
      { ingredient_deltas: [{ sub_recipe_id: 'sauce', qty: 20 }, { item_id: 'x', qty: 0 }] },
      { ingredient_deltas: null },
    ])).toEqual([{ item_id: 'cheese', qty: 30 }, { sub_recipe_id: 'sauce', qty: 20 }])
    expect(lineIngredientDeltas([{ ingredient_deltas: [] }])).toBeNull()
    expect(lineIngredientDeltas(null)).toBeNull()
  })

  it('trims an item line by yield and explodes a sub-recipe line per output unit, signed', () => {
    const out = Object.fromEntries(deltaItems([
      { item_id: 'cheese', qty: 30 }, { item_id: 'onion', qty: -20 }, { sub_recipe_id: 'sauce', qty: 20 },
    ], explosion).map(r => [r.item_id, r.qty]))
    expect(out).toEqual({ cheese: 30, onion: -40, tomato: 10, oil: 2 })
  })

  it('a sales row uses its recipe plus its choices, times the plates sold', () => {
    const breakdown = { momo: [{ item_id: 'onion', qty: 40 }, { item_id: 'flour', qty: 100 }] }
    const usage = Object.fromEntries(usageOfSalesRow(
      { recipe_id: 'momo', qty_sold: 2, ingredient_deltas: [{ item_id: 'onion', qty: -20 }, { item_id: 'cheese', qty: 30 }] },
      breakdown, explosion,
    ).map(r => [r.item_id, r.qty]))
    // onion: 40×2 − (20 ÷ 50% yield)×2 = 0; flour 200; cheese 60
    expect(usage).toEqual({ onion: 0, flour: 200, cheese: 60 })
  })

  it('a plain row is exactly its recipe', () => {
    expect(usageOfSalesRow({ recipe_id: 'momo', qty_sold: 1 }, { momo: [{ item_id: 'flour', qty: 100 }] }, null))
      .toEqual([{ item_id: 'flour', qty: 100 }])
  })
})
