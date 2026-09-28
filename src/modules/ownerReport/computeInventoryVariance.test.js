// S792 (FIGURES-2, SALES-3): the frozen report's Inventory Variance must reach the live Variance
// page's figures for the same closed month. Each fixture below is one of the defects the pre-S719
// copy froze into snapshots: an uncounted item read as counted 0, a fixed ±10% with no floor, a
// credit note subtracting usage, a POS + manual day counted twice, and staff meals left out.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { buildVarianceSection } from './computeInventoryVariance'

const item = (id, per_uom_rate) => ({ id, name: `Item ${id}`, per_uom_rate })
const items = [
  item('F', 1000),   // flour — recipe-linked, counted
  item('R', 50),     // rice — recipe-linked, fed to staff
  item('O', 200),    // oil — recipe-linked, NOT counted this month
  item('N', 5),      // napkins — in no recipe
  item('S', 100),    // sauce base — linked, but its dish sold nothing
]
// Per plate. dishB (the only user of S) sold nothing this month.
const breakdown = {
  dishA: [{ item_id: 'F', qty: 0.1 }, { item_id: 'R', qty: 0.2 }, { item_id: 'O', qty: 0.01 }],
  dishB: [{ item_id: 'S', qty: 0.5 }],
}
const sale = (source, qty_sold, bs_day = 5, recipe_id = 'dishA') => ({ recipe_id, qty_sold, bs_day, source, ingredient_deltas: null })
// 100 plates on the till on the 5th; the same 100 typed by hand for the same day (superseded); and a
// credit note for 10 of them (never depletes — it reverses revenue, not stock).
const sales = [sale('pos', 100), sale('manual', 100), sale('pos_credit', -10)]
const rows = (list, field) => list.map(([item_id, v]) => ({ item_id, [field]: v }))

function build(over = {}) {
  return buildVarianceSection({
    items,
    opening: rows([['O', 5], ['N', 100], ['S', 20]], 'qty'),
    purchases: rows([['F', 12], ['R', 30]], 'qty'),
    returns: [],
    wastages: [],
    staffMeals: rows([['R', 5]], 'qty'),
    // O has stock and no closing row: it was not counted.
    closing: rows([['F', 0], ['R', 5], ['N', 50], ['S', 10]], 'physical_qty'),
    sales, breakdown, explosion: null, settings: null,
    ...over,
  })
}
const flagOf = (section, id) => section.items.find(i => i.itemId === id)?.flag

describe('buildVarianceSection', () => {
  test('a credit note and a superseded manual day do not move theoretical usage', () => {
    // F: 100 plates × 0.1 = 10 — not (100 + 100 − 10) × 0.1 = 19.
    const s = build()
    const f = s.items.find(i => i.itemId === 'F')
    expect(f.theoreticalUsed).toBeCloseTo(10, 9)
    expect(f.actualUsed).toBeCloseTo(12, 9)
  })

  test('an uncounted item is not measured, not flagged and not in the loss total', () => {
    const s = build()
    expect(flagOf(s, 'O')).toBeUndefined()
    expect(s.uncountedCount).toBe(1)
    // Only F is judged Over (+20%, NPR 2,000); O's "whole shelf used" is nowhere in the total.
    expect(s.totalVarianceValue).toBeCloseTo(2000 + 0 + (10 - 0) * 100, 6)
  })

  test("the client's tolerance decides the flag, not a fixed ±10%", () => {
    expect(flagOf(build(), 'F')).toBe('over')                                         // +20% at the default 10
    expect(flagOf(build({ settings: { variance_flag_pct: 25 } }), 'F')).toBeUndefined() // within ±25%
    expect(build({ settings: { variance_flag_pct: 25 } })).toMatchObject({ tolerancePct: 25, floorValue: 500 })
  })

  test('under the NPR 500 floor a big percentage is immaterial, not flagged', () => {
    // F at rate 100: the same +20% is worth NPR 200.
    const s = build({ items: items.map(i => (i.id === 'F' ? { ...i, per_uom_rate: 100 } : i)) })
    expect(flagOf(s, 'F')).toBeUndefined()
  })

  test('staff meals are part of actual usage', () => {
    // R: 30 bought, 5 to staff, 5 counted → 20 used, exactly 100 × 0.2. Without the staff meals
    // it read 25 (+25%, Over).
    const s = build({ items: items.map(i => (i.id === 'R' ? { ...i, per_uom_rate: 1000 } : i)) })
    expect(flagOf(s, 'R')).toBeUndefined()
    const loud = build({ staffMeals: [], items: items.map(i => (i.id === 'R' ? { ...i, per_uom_rate: 1000 } : i)) })
    expect(flagOf(loud, 'R')).toBe('over')
  })

  test('an item in no recipe is its own state, out of the count and the total', () => {
    const s = build()
    expect(flagOf(s, 'N')).toBeUndefined()
    expect(s.noRecipeCount).toBe(1)
  })

  test('stock that fell while its dishes sold nothing is judged (D36), with no percentage', () => {
    const s = build()
    const sauce = s.items.find(i => i.itemId === 'S')
    expect(sauce).toMatchObject({ flag: 'over', variancePct: null, noSales: true, theoreticalUsed: 0 })
    expect(sauce.value).toBeCloseTo(1000, 9)
    // A trace worth under the floor stays quiet.
    const trace = build({ closing: rows([['F', 0], ['R', 5], ['N', 50], ['S', 19.5]], 'physical_qty') })
    expect(flagOf(trace, 'S')).toBeUndefined()
  })

  test('a month with no count at all measures nothing and flags nothing', () => {
    const s = build({ closing: [] })
    expect(s).toMatchObject({ hasClosingRows: false, measuredCount: 0, judgedCount: 0, flaggedCount: 0, totalVarianceValue: 0 })
  })

  test('flagged rows come largest value first, and the counts add up', () => {
    const s = build()
    expect(s.items.map(i => i.itemId)).toEqual(['F', 'S'])
    expect(s).toMatchObject({ flaggedCount: 2, overCount: 2, underCount: 0, measuredCount: 4, judgedCount: 3 })
  })
})

describe('a NULL physical_qty is not a count', () => {
  test('the item is not measured, and is named as a gap', () => {
    const s = build({ closing: rows([['F', null], ['R', 5], ['N', 50], ['S', 10]], 'physical_qty') })
    expect(s.items.find(i => i.itemId === 'F')).toBeUndefined()
    expect(s.uncountedCount).toBe(2)   // F and O
  })
})

describe('computeInventoryVariance source', () => {
  const src = fs.readFileSync(path.join(__dirname, 'computeInventoryVariance.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\s+/g, ' ')

  // The population and the verdict are the live pages' own (variancePopulation.js, S792), never a
  // private twin of them.
  test('takes the population and the verdict from the live pages\' module', () => {
    expect(src).toMatch(/from '\.\.\/ims\/variance\/variancePopulation'/)
    for (const fn of ['closingCountMap(', 'linkedItemIdsOf(', 'varianceRowBand(', 'judgedRows(', 'isUncountedGap']) expect(src).toContain(fn)
    expect(src).not.toMatch(/function varianceRowBand|function closingCountMap/)
  })

  test('every per-item read is paged with a unique tiebreaker', () => {
    for (const read of ["scopedFrom('items'", "from('opening_stock')", "from('closing_stock')", "from('purchase_entries')",
      "scopedFrom('vendor_returns'", "from('wastages')", "from('staff_meals')", "from('sales_entries')"]) {
      const at = src.indexOf(read)
      expect(at).toBeGreaterThan(-1)
      expect(src.slice(Math.max(0, at - 40), at)).toMatch(/fetchAllRows\(\(\) => (supabase\.)?$/)
      expect(src.slice(at, at + 200)).toMatch(/\.order\('id'\)\)/)
    }
  })

  test("reads the client's tolerance, and throws on a failed read", () => {
    expect(src).toMatch(/from\('settings'\)\.select\('variance_flag_pct'\)/)
    expect(src).toContain('throwFirstError(results)')
  })
})
