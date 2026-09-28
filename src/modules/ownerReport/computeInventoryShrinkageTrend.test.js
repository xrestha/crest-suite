// S792 (FIGURES-2, SALES-3): the frozen Shrinkage Trend must reach ShrinkageReport.js's verdict for
// the same months. Each fixture is one of the defects the pre-S719 copy froze: an uncounted month
// read as the whole shelf used, `variance > 0.001` as shrinkage, a credit note subtracting usage,
// and the day-keyed depletion rule run across months at once.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { buildShrinkageTrendSection, bandShrinkageItem, shrinkageStatus } from './computeInventoryShrinkageTrend'

const P = (id, m) => ({ id, bs_year: 2082, bs_month: m })
const window = [P('p3', 3), P('p2', 2), P('p1', 1)] // newest first
const items = [
  { id: 'F', name: 'Flour', per_uom_rate: 1000 },
  { id: 'R', name: 'Rice', per_uom_rate: 1000 },
]
const breakdown = { dishA: [{ item_id: 'F', qty: 0.1 }, { item_id: 'R', qty: 0.1 }] }
const sale = (period_id, source, qty_sold, bs_day = 5) => ({ period_id, recipe_id: 'dishA', qty_sold, bs_day, source, ingredient_deltas: null })
const row = (period_id, item_id, field, v) => ({ period_id, item_id, [field]: v })

// Every month: 100 plates → 10 of each item in theory. F: 12 bought, counted 0 → 12 used (+20%,
// NPR 2,000 — over). R: 12 bought, 2 to staff, counted 0 → 10 used, exactly theoretical.
function build(over = {}) {
  const months = ['p1', 'p2', 'p3']
  return buildShrinkageTrendSection({
    window, items,
    opening: [],
    purchases: months.flatMap(p => [row(p, 'F', 'qty', 12), row(p, 'R', 'qty', 12)]),
    returns: [], wastages: [],
    staffMeals: months.map(p => row(p, 'R', 'qty', 2)),
    // p3 has no count for F: that month is not judged for it.
    closing: [row('p1', 'F', 'physical_qty', 0), row('p2', 'F', 'physical_qty', 0), ...months.map(p => row(p, 'R', 'physical_qty', 0))],
    sales: [
      sale('p1', 'pos', 100),
      // p2: the till's 100, the same day typed by hand (superseded), and a credit note for 50.
      sale('p2', 'pos', 100), sale('p2', 'manual', 100), sale('p2', 'pos_credit', -50),
      sale('p3', 'pos', 100),
    ],
    breakdown, explosion: null, settings: null,
    ...over,
  })
}

describe('buildShrinkageTrendSection', () => {
  test('an uncounted month is skipped and counted, never read as the shelf consumed', () => {
    const s = build()
    const f = s.items.find(i => i.itemId === 'F')
    expect(f).toMatchObject({ shrinkCount: 2, coveredPeriods: 2, uncountedPeriods: 1, status: 'Consistent' })
    expect(s).toMatchObject({ uncountedItems: 1, uncountedItemPeriods: 1 })
    expect(f.totalShrinkValue).toBeCloseTo(4000, 6)
    expect(s.totalLossValue).toBeCloseTo(4000, 6)
  })

  test('a credit note and a superseded manual day leave theoretical usage alone', () => {
    // Summed raw, p2's theoretical F was (100 + 100 − 50) × 0.1 = 15, so +20% read as −20%.
    expect(build().items.find(i => i.itemId === 'F').shrinkCount).toBe(2)
  })

  test('staff meals are part of actual usage', () => {
    const s = build()
    expect(s.items.find(i => i.itemId === 'R')).toBeUndefined()
    expect(s.trackedCount).toBe(2)
    expect(build({ staffMeals: [] }).items.find(i => i.itemId === 'R')).toMatchObject({ shrinkCount: 3 })
  })

  test("a period is shrinkage only past the client's tolerance and the NPR floor", () => {
    expect(build({ settings: { variance_flag_pct: 25 } }).anyFlaggedCount).toBe(0)
    expect(build({ settings: { variance_flag_pct: 25 } })).toMatchObject({ tolerancePct: 25, floorValue: 500 })
    // A hair over recipe is not shrinkage: 10.001 used against 10 is +0.01%, worth NPR 1.
    const hair = build({ purchases: ['p1', 'p2', 'p3'].flatMap(p => [row(p, 'F', 'qty', 10.001), row(p, 'R', 'qty', 12)]) })
    expect(hair.items.find(i => i.itemId === 'F')).toBeUndefined()
  })

  test('the depletion rule runs one month at a time', () => {
    // A till sale on the 5th of p1 must not silence a hand-typed sale on the 5th of p2. Across the
    // window at once, p2's only sale was dropped, F had no theoretical use there and the month fell
    // out of the observations.
    const s = build({ sales: [sale('p1', 'pos', 100), sale('p2', 'manual', 100), sale('p3', 'pos', 100)] })
    expect(s.items.find(i => i.itemId === 'F')).toMatchObject({ coveredPeriods: 2, shrinkCount: 2 })
  })

  // S792 (D36, FIGURES-4): ShrinkageReport.js now judges a counted month in which stock moved while
  // none of the item's dishes sold, through the Variance Report's surrogate. The snapshot follows.
  test('a counted month where stock fell but nothing sold is judged, and can be shrinkage', () => {
    const s = build({ sales: [sale('p1', 'pos', 100)] })
    // F: p1 +20% over; p2 nothing sold but 12 gone (NPR 12,000) — over; p3 not counted.
    expect(s.items.find(i => i.itemId === 'F')).toMatchObject({ shrinkCount: 2, coveredPeriods: 2, uncountedPeriods: 1 })
    // R: p1 exactly to recipe; p2 and p3 10 gone with nothing sold. 2 of 3 is 0.667 → Occasional.
    expect(s.items.find(i => i.itemId === 'R')).toMatchObject({ shrinkCount: 2, coveredPeriods: 3, status: 'Occasional' })
  })

  test('a counted month where nothing sold and nothing moved has nothing to judge', () => {
    const s = build({
      sales: [sale('p1', 'pos', 100)],
      purchases: [row('p1', 'F', 'qty', 12), row('p1', 'R', 'qty', 12)],
      staffMeals: [row('p1', 'R', 'qty', 2)],
    })
    expect(s.items.find(i => i.itemId === 'F')).toMatchObject({ coveredPeriods: 1, uncountedPeriods: 0 })
    expect(s.items.find(i => i.itemId === 'R')).toBeUndefined()
    expect(s.trackedCount).toBe(2)
  })

  test('an item in no recipe is not tracked at all (D17)', () => {
    const napkins = { id: 'N', name: 'Napkins', per_uom_rate: 1000 }
    const s = build({
      items: [...items, napkins],
      purchases: ['p1', 'p2', 'p3'].flatMap(p => [row(p, 'F', 'qty', 12), row(p, 'R', 'qty', 12), row(p, 'N', 'qty', 12)]),
      closing: [row('p1', 'F', 'physical_qty', 0), row('p2', 'F', 'physical_qty', 0),
        ...['p1', 'p2', 'p3'].flatMap(p => [row(p, 'R', 'physical_qty', 0), row(p, 'N', 'physical_qty', 0)])],
    })
    expect(s.items.find(i => i.itemId === 'N')).toBeUndefined()
    expect(s.trackedCount).toBe(2)
  })

  test('a NULL physical_qty is not a count', () => {
    const s = build({ closing: [row('p1', 'F', 'physical_qty', null), row('p2', 'F', 'physical_qty', 0), ...['p1', 'p2', 'p3'].map(p => row(p, 'R', 'physical_qty', 0))] })
    expect(s.items.find(i => i.itemId === 'F')).toMatchObject({ coveredPeriods: 1, uncountedPeriods: 2 })
  })

  test('the frozen rows carry the verdict, not the observations', () => {
    const f = build().items[0]
    expect(f.observations).toBeUndefined()
    expect(f).toMatchObject({ itemId: 'F', name: 'Flour', rate: 1000 })
  })
})

describe('shrinkageStatus / bandShrinkageItem', () => {
  test('the live page thresholds', () => {
    expect(shrinkageStatus(3, 4)).toBe('Consistent')
    expect(shrinkageStatus(2, 2)).toBe('Consistent')
    // 2 of 3 is 0.667, just under the page's 0.67 line.
    expect(shrinkageStatus(2, 3)).toBe('Occasional')
    expect(shrinkageStatus(2, 4)).toBe('Occasional')
    expect(shrinkageStatus(1, 6)).toBe('Once')
    expect(shrinkageStatus(0, 6)).toBe('Clear')
  })

  test('an under-used month is not shrinkage', () => {
    const b = bandShrinkageItem({ rate: 1000, observations: [{ variance: -2, theor: 10, actual: 8, rate: 1000 }] }, null)
    expect(b).toMatchObject({ shrinkCount: 0, coveredPeriods: 1, status: 'Clear', totalShrinkValue: 0 })
  })

  test('a no-sales month bands through the surrogate: over when material, quiet when not', () => {
    const over = bandShrinkageItem({ rate: 100, observations: [{ variance: 12, theor: 0, actual: 12, rate: 100 }] }, null)
    expect(over.shrinkCount).toBe(1)
    const trace = bandShrinkageItem({ rate: 100, observations: [{ variance: 0.3, theor: 0, actual: 0.3, rate: 100 }] }, null)
    expect(trace.shrinkCount).toBe(0)
  })
})

describe('computeInventoryShrinkageTrend source', () => {
  const src = fs.readFileSync(path.join(__dirname, 'computeInventoryShrinkageTrend.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\s+/g, ' ')

  test('every multi-period read is paged with a unique tiebreaker', () => {
    for (const read of ["scopedFrom('items'", "from('opening_stock')", "from('closing_stock')", "from('purchase_entries')",
      "scopedFrom('vendor_returns'", "from('wastages')", "from('staff_meals')", "from('sales_entries')"]) {
      const at = src.indexOf(read)
      expect(at).toBeGreaterThan(-1)
      expect(src.slice(Math.max(0, at - 40), at)).toMatch(/fetchAllRows\(\(\) => (supabase\.)?$/)
      expect(src.slice(at, at + 220)).toMatch(/\.order\('id'\)\)/)
    }
  })

  test("reads the client's tolerance, and throws on a failed read", () => {
    expect(src).toMatch(/from\('settings'\)\.select\('variance_flag_pct'\)/)
    expect(src).toContain('throwFirstError(results)')
  })

  test('takes the population, the count test and the surrogate from the live pages\' module', () => {
    expect(src).toMatch(/from '\.\.\/ims\/variance\/variancePopulation'/)
    for (const fn of ['linkedItemIdsOf(', 'bandPctOf(', 'isClosingCount(']) expect(src).toContain(fn)
    expect(src).not.toMatch(/if \(theor <= 0\) return/)
  })
})
