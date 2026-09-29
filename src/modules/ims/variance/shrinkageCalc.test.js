// shrinkageCalc.js is the one copy of Shrinkage's arithmetic (S792 stage 3): the Shrinkage Report
// and the frozen Owner Report's Shrinkage Trend both call it. The verdict thresholds are pinned in
// ownerReport/computeInventoryShrinkageTrend.test.js; this file pins the observation loop and that
// the page no longer carries a copy of its own.
import fs from 'fs'
import path from 'path'
import { buildShrinkageObservations, bandShrinkageItem, shrinkageStatus } from './shrinkageCalc'

const row = (period_id, item_id, field, v) => ({ period_id, item_id, [field]: v })
const sale = (period_id, source, qty_sold, bs_day = 5) => ({ period_id, recipe_id: 'dish', qty_sold, bs_day, source, ingredient_deltas: null })
const items = [
  { id: 'F', name: 'Flour', per_uom_rate: '1000', categories: { name: 'Dry' } },
  { id: 'N', name: 'Napkins', per_uom_rate: '1000' },   // in no recipe: never judged (D17)
]
const breakdown = { dish: [{ item_id: 'F', qty: 0.1 }] }

function observe(over = {}) {
  return buildShrinkageObservations({
    periodIds: ['p2', 'p1'], items,
    opening: [row('p1', 'F', 'qty', '2')],
    closing: [row('p1', 'F', 'physical_qty', '1'), row('p2', 'F', 'physical_qty', '0'), row('p1', 'N', 'physical_qty', '0')],
    purchases: [row('p1', 'F', 'qty', '10'), row('p2', 'F', 'qty', '12'), row('p1', 'N', 'qty', '5')],
    returns: [row('p2', 'F', 'qty', '1')],
    wastages: [row('p1', 'F', 'qty', '0.5')],
    staffMeals: [row('p2', 'F', 'qty', '0.5')],
    sales: [sale('p1', 'pos', 100), sale('p2', 'pos', 100)],
    breakdown, explosion: null,
    ...over,
  })
}

describe('buildShrinkageObservations', () => {
  test('actual = opening + purchases − returns − closing − wastage − staff meals, per period', () => {
    const { rows } = observe()
    expect(rows).toHaveLength(1)
    const f = rows[0]
    expect(f.item.id).toBe('F')
    expect(f.rate).toBe(1000)
    // p2 (listed first): 0 + 12 − 1 − 0 − 0 − 0.5 = 10.5 against 10. p1: 2 + 10 − 1 − 0.5 − 0 = 10.5.
    expect(f.observations.map(o => o.actual)).toEqual([10.5, 10.5])
    expect(f.observations.map(o => o.theor)).toEqual([10, 10])
    expect(f.observations[0].variance).toBeCloseTo(0.5, 9)
  })

  test('an uncounted month with stock is skipped and counted, never read as the shelf consumed', () => {
    const r = observe({ closing: [row('p1', 'F', 'physical_qty', '1')] })
    expect(r.rows[0]).toMatchObject({ uncountedPeriods: 1 })
    expect(r.rows[0].observations).toHaveLength(1)
    expect(r).toMatchObject({ uncountedItems: 1, uncountedItemPeriods: 1 })
    // A NULL physical_qty is not a count either; a 0 is.
    const nulls = observe({ closing: [row('p1', 'F', 'physical_qty', null), row('p2', 'F', 'physical_qty', '0')] })
    expect(nulls.rows[0]).toMatchObject({ uncountedPeriods: 1 })
  })

  test('the depletion rule runs one month at a time', () => {
    // A till sale on the 5th of p1 must not silence a hand-typed sale on the 5th of p2 (S718).
    const r = observe({ sales: [sale('p1', 'pos', 100), sale('p2', 'manual', 100)] })
    expect(r.rows[0].observations.map(o => o.theor)).toEqual([10, 10])
  })

  test('a counted month where stock fell but nothing sold is observed (D36)', () => {
    const r = observe({ sales: [sale('p1', 'pos', 100)] })
    expect(r.rows[0].observations[0]).toMatchObject({ theor: 0, actual: 10.5, variance: 10.5 })
  })

  test('the page and the frozen report band the same observations the same way', () => {
    const b = bandShrinkageItem({ ...observe().rows[0] }, null)
    // +5% worth NPR 500 in each month: inside the default ±10% tolerance, so not shrinkage.
    expect(b).toMatchObject({ shrinkCount: 0, coveredPeriods: 2, status: 'Clear' })
    expect(shrinkageStatus(b.shrinkCount, b.coveredPeriods)).toBe(b.status)
  })
})

describe('shrinkageCalc.js reaches the shared depletion rule', () => {
  // The page and the frozen trend reach the rule only through this module now, so it is pinned
  // here: buildUsageMap per period, and the across-periods form for the population.
  const code = fs.readFileSync(path.join(__dirname, 'shrinkageCalc.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  test('imports and calls buildUsageMap and selectDepletingSalesAcrossPeriods', () => {
    expect(code).toMatch(/import[^;]*\bbuildUsageMap\b/)
    expect(code).toMatch(/import[^;]*\bselectDepletingSalesAcrossPeriods\b/)
    expect(code).toContain('buildUsageMap(salesByPeriod[pid]')
    expect(code).toContain('selectDepletingSalesAcrossPeriods(sales')
  })
})

describe('ShrinkageReport.js calls the shared code and keeps no copy', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ShrinkageReport.js'), 'utf8')

  test('imports the loop and the verdict', () => {
    expect(src).toMatch(/from '\.\/shrinkageCalc'/)
    expect(src).toContain('buildShrinkageObservations(')
    expect(src).toContain('bandShrinkageItem(')
    expect(src).not.toMatch(/function (bandItem|shrinkageStatus)\b/)
    expect(src).not.toMatch(/observations\.push\(/)
  })

  // S792 (FIGURES-7): the page stays mounted across a client switch, so its load key names the client.
  test('the report load key carries the client', () => {
    expect(src).toMatch(/windowReq\.begin\(`\$\{effectiveClientId\}:\$\{periodCount\}`\)/)
    expect(src).toMatch(/initReq\.begin\(effectiveClientId\)/)
  })
})
