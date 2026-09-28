import { plateExtrasCost, extrasCostByRecipe, extrasItemIds, loadExtrasCosting } from './extrasCost'

// S792 RECIPES-3: the stock cost of the extras a guest adds counts in margin (Recipe Margin, Best
// Sellers). The arithmetic is pure and pinned here; the pages add it to each dish's COGS.
describe('extrasCost', () => {
  // cheese has no trim; onion loses half to prep; one unit of sauce is 0.5 tomato + 0.1 oil.
  const explosion = {
    itemYield: { cheese: 100, onion: 50 },
    subPerUnit: { sauce: [{ item_id: 'tomato', qty: 0.5 }, { item_id: 'oil', qty: 0.1 }] },
  }
  const rateByItem = { cheese: 1.2, onion: 0.1, tomato: 0.2, oil: 0.5 }
  const costing = { explosion, rateByItem }

  it('values one plate’s choices through the stock conversion, at the item rates', () => {
    // 30 g cheese × 1.2 = 36 — the finding's "+30 g cheese ≈ NPR 36 at cost".
    expect(plateExtrasCost([{ item_id: 'cheese', qty: 30 }], explosion, rateByItem)).toBeCloseTo(36)
    // A sub-recipe line explodes per output unit: 20 × (0.5 × 0.2 + 0.1 × 0.5) = 3.
    expect(plateExtrasCost([{ sub_recipe_id: 'sauce', qty: 20 }], explosion, rateByItem)).toBeCloseTo(3)
    // An item line is trimmed by its yield, as the stock posting trims it: 10 g onion at 50% = 20 g.
    expect(plateExtrasCost([{ item_id: 'onion', qty: 10 }], explosion, rateByItem)).toBeCloseTo(2)
  })

  it('is signed and never clamped — a removal or a Half makes the plate cheaper', () => {
    expect(plateExtrasCost([{ item_id: 'cheese', qty: 30 }, { item_id: 'onion', qty: -10 }], explosion, rateByItem))
      .toBeCloseTo(34)
    expect(plateExtrasCost([{ item_id: 'onion', qty: -10 }], explosion, rateByItem)).toBeCloseTo(-2)
  })

  it('costs nothing for a plate with no choices, and 0 for an item with no known rate', () => {
    expect(plateExtrasCost(null, explosion, rateByItem)).toBe(0)
    expect(plateExtrasCost([], explosion, rateByItem)).toBe(0)
    expect(plateExtrasCost([{ item_id: 'saffron', qty: 5 }], explosion, rateByItem)).toBe(0)
  })

  it('sums per dish over the rows given, times the plates on each row', () => {
    const rows = [
      { recipe_id: 'momo', qty_sold: 3, ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] },   // 3 × 36
      { recipe_id: 'momo', qty_sold: 2, ingredient_deltas: null },                               // plain
      { recipe_id: 'momo', qty_sold: 1, ingredient_deltas: [{ sub_recipe_id: 'sauce', qty: 20 }] }, // 1 × 3
      { recipe_id: 'chowmein', qty_sold: 4, ingredient_deltas: [] },
    ]
    const out = extrasCostByRecipe(rows, costing)
    expect(out.momo).toBeCloseTo(111)
    // A dish with no customized sale is absent, not 0 — the caller adds `|| 0` to a real cost.
    expect(out).not.toHaveProperty('chowmein')
  })

  it('a credit note reverses its plate’s extras along with their upcharge', () => {
    const rows = [
      { recipe_id: 'momo', qty_sold: 2, source: 'pos', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] },
      { recipe_id: 'momo', qty_sold: -1, source: 'pos_credit', ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] },
    ]
    expect(extrasCostByRecipe(rows, costing).momo).toBeCloseTo(36)
  })

  it('lists every raw item the choices reach, sub-recipes exploded', () => {
    const ids = extrasItemIds([
      [{ item_id: 'cheese', qty: 30 }],
      null,
      [{ sub_recipe_id: 'sauce', qty: 20 }, { item_id: 'cheese', qty: 5 }],
    ], explosion)
    expect(ids.sort()).toEqual(['cheese', 'oil', 'tomato'])
  })

  describe('loadExtrasCosting', () => {
    // A PostgREST-shaped stub: a chain that resolves at .range(), which is where fetchAllRows pages.
    const table = (rowsByTable, calls, failOn) => name => {
      calls.push(name)
      const chain = {
        select: () => chain, in: () => chain, order: () => chain,
        range: () => Promise.resolve(failOn === name
          ? { data: null, error: { message: 'permission denied' } }
          : { data: rowsByTable[name] || [], error: null }),
      }
      return chain
    }

    it('reads nothing when no row carries choices', async () => {
      const calls = []
      const supabase = { from: table({}, calls) }
      const scopedFrom = table({}, calls)
      const out = await loadExtrasCosting(supabase, scopedFrom, [{ ingredient_deltas: null }, {}])
      expect(calls).toEqual([])
      expect(out.rateByItem).toEqual({})
    })

    it('reads the yields and the rates of what the choices reach', async () => {
      const calls = []
      const rows = { items: [{ id: 'cheese', yield_pct: 100, per_uom_rate: '1.2' }] }
      const out = await loadExtrasCosting({ from: table(rows, calls) }, table(rows, calls),
        [{ recipe_id: 'momo', qty_sold: 1, ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }])
      expect(out.rateByItem).toEqual({ cheese: 1.2 })
      expect(plateExtrasCost([{ item_id: 'cheese', qty: 30 }], out.explosion, out.rateByItem)).toBeCloseTo(36)
    })

    it('throws on a failed rate read rather than costing the extras at 0', async () => {
      const calls = []
      const good = table({ items: [{ id: 'cheese', yield_pct: 100 }] }, calls)
      const bad = table({}, calls, 'items')
      await expect(loadExtrasCosting({ from: good }, bad,
        [{ ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] }])).rejects.toThrow(/permission denied/)
    })
  })
})
