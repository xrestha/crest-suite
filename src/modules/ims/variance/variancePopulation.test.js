import fs from 'fs'
import path from 'path'
import {
  linkedItemIdsOf, bandPctOf, varianceRowBand, hasVarianceActivity, isUncountedGap, judgedRows,
  isClosingCount, closingCountMap, choiceLinesAsDeltas, choiceLinkedItemIds, loadChoiceLinkedItemIds,
  VARIANCE_FLAG_TEXT,
} from './variancePopulation'
import { varianceBand } from '../../../shared/imsFormulas'

const SETTINGS = { variance_flag_pct: 10 }

// Variance.js's own `bandOfRow`, exactly as it stood before S792 moved it into variancePopulation.js.
// Kept here as the reference the shared verdict must reproduce row for row: Variance.js is the page
// the Owner Report mirrors, so moving its verdict must not move a single flag.
function referenceBandOfRow(row, settings) {
  if (!row.measured) return { ...varianceBand(null, null, settings, { measured: false }), flag: 'unmeasured' }
  if (row.noRecipe) return { ...varianceBand(null, null, settings, { measured: false }), flag: 'no_recipe' }
  const pct = row.theoreticalUsed > 0 ? row.variancePct
    : row.actualUsed === 0 ? 0
    : Math.sign(row.actualUsed) * Number.MAX_SAFE_INTEGER
  const b = varianceBand(pct, row.value, settings, { measured: true })
  return { ...b, flag: b.key === 'over' || b.key === 'under' ? b.key : 'ok' }
}

// A row the way Variance.js builds one.
function row({ theor = 0, actual = 0, rate = 100, measured = true, noRecipe = false, hasCount = true, open = 0, purch = 0 }) {
  const variance = actual - theor
  return {
    measured, noRecipe, hasCount, openQty: open, purchQty: purch,
    theoreticalUsed: theor, actualUsed: actual,
    variancePct: theor > 0 ? (variance / theor) * 100 : null,
    value: variance * rate,
  }
}

describe('varianceRowBand — the one verdict (moved unchanged from Variance.js)', () => {
  test('matches the reference on every combination of the inputs that decide it', () => {
    const theors = [0, 0.5, 10, -2]
    const actuals = [0, 0.4, 10, 11, 15, 30, -3]
    const rates = [1, 100, 5000]
    let checked = 0
    for (const measured of [true, false]) for (const noRecipe of [true, false])
      for (const theor of theors) for (const actual of actuals) for (const rate of rates) {
        const r = row({ theor, actual, rate, measured, noRecipe })
        expect(varianceRowBand(r, SETTINGS)).toEqual(referenceBandOfRow(r, SETTINGS))
        checked++
      }
    expect(checked).toBe(2 * 2 * theors.length * actuals.length * rates.length)
  })

  // D36: the case the two pages used to disagree on.
  test('an ingredient used while its dishes sold nothing is judged Over when material', () => {
    const b = varianceRowBand(row({ theor: 0, actual: 12, rate: 100 }), SETTINGS)   // NPR 1,200 gone
    expect(b.flag).toBe('over')
    expect(b.mark).toBe('▲')
  })

  test('…and reads ≈ (flag ok) when the value is under the NPR floor', () => {
    const b = varianceRowBand(row({ theor: 0, actual: 0.3, rate: 100 }), SETTINGS)  // NPR 30
    expect(b.flag).toBe('ok')
    expect(b.key).toBe('immaterial')
  })

  test('stock that rose with nothing sold reads Under when material', () => {
    expect(varianceRowBand(row({ theor: 0, actual: -8, rate: 100 }), SETTINGS).flag).toBe('under')
  })

  test('no recipe and not counted each get their own grey state, never a verdict', () => {
    expect(varianceRowBand(row({ theor: 0, actual: 50, noRecipe: true }), SETTINGS).flag).toBe('no_recipe')
    expect(varianceRowBand(row({ theor: 10, actual: 50, measured: false }), SETTINGS).flag).toBe('unmeasured')
  })

  test('bandPctOf keeps a real percentage when something sold', () => {
    expect(bandPctOf(row({ theor: 10, actual: 12 }))).toBeCloseTo(20)
    expect(bandPctOf(row({ theor: 0, actual: 0 }))).toBe(0)
    expect(bandPctOf(row({ theor: 0, actual: 2 }))).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// FIGURES-4 / D36. The same month's rows, the way both pages now count them.
describe('one population on both pages (FIGURES-4)', () => {
  const rows = [
    row({ theor: 10, actual: 15, rate: 200 }),                 // sold, over-used
    row({ theor: 0, actual: 6, rate: 200 }),                   // dishes sold nothing, stock fell
    row({ theor: 0, actual: 40, rate: 50, noRecipe: true }),   // gas: no recipe
    row({ theor: 5, actual: 30, rate: 200, measured: false, hasCount: false, open: 30 }),  // not counted
    row({ theor: 0, actual: 0, rate: 200 }),                   // nothing happened at all
  ]

  test('the flagged count includes the unsold ingredient and nothing unjudgeable', () => {
    const flagged = rows.map(r => varianceRowBand(r, SETTINGS)).filter(b => b.flag === 'over' || b.flag === 'under')
    expect(flagged).toHaveLength(2)
  })

  test('the totals cover measured, recipe-linked rows — its whole use is in the loss', () => {
    const judged = judgedRows(rows)
    expect(judged).toHaveLength(3)
    expect(judged.reduce((s, r) => s + r.value, 0)).toBe(5 * 200 + 6 * 200 + 0)
  })

  test('activity decides what is drawn; the quiet row is not', () => {
    expect(rows.filter(hasVarianceActivity)).toHaveLength(4)
  })

  test('an uncounted item with stock or expected use is a named gap; one with neither is not', () => {
    expect(rows.filter(isUncountedGap)).toHaveLength(1)
    expect(isUncountedGap(row({ hasCount: false, measured: false }))).toBe(false)
  })
})

describe('linkedItemIdsOf', () => {
  test('every item in any recipe, sold or not, plus items reached only through a sold option', () => {
    const breakdown = { momo: [{ item_id: 'flour', qty: 0.1 }], unsold: [{ item_id: 'saffron', qty: 0.01 }] }
    const explosion = { itemYield: {}, subPerUnit: { sauce: [{ item_id: 'chilli', qty: 0.2 }] } }
    const depleting = [
      { recipe_id: 'momo', qty_sold: 2, ingredient_deltas: [{ item_id: 'cheese', qty: 30 }, { sub_recipe_id: 'sauce', qty: 1 }] },
      { recipe_id: 'momo', qty_sold: 1, ingredient_deltas: null },
    ]
    expect([...linkedItemIdsOf(breakdown, depleting, explosion)].sort()).toEqual(['cheese', 'chilli', 'flour', 'saffron'])
  })

  test('empty inputs give an empty set', () => {
    expect(linkedItemIdsOf(null, null, null).size).toBe(0)
  })

  // S862 REPORTS-STOCK-3: Oat Milk is on a choice and in no recipe. In a counted month nobody picked
  // it, it is still judged, not greyed as "no recipe linked" with its loss out of the totals.
  test('an item only a choice uses is linked in a month nobody picked that choice', () => {
    const breakdown = { latte: [{ item_id: 'milk', qty: 200 }] }
    const depleting = [{ recipe_id: 'latte', qty_sold: 5, ingredient_deltas: null }]
    expect(linkedItemIdsOf(breakdown, depleting, null).has('oat_milk')).toBe(false)
    expect(linkedItemIdsOf(breakdown, depleting, null, new Set(['oat_milk'])).has('oat_milk')).toBe(true)
  })
})

describe('the client\'s choice stock lines (S862 REPORTS-STOCK-3)', () => {
  const rows = [
    { item_id: 'oat_milk', sub_recipe_id: null, qty_per_portion: 150 },
    { item_id: 'milk', sub_recipe_id: null, qty_per_portion: -150 },   // a take-off still links
    { item_id: null, sub_recipe_id: 'sauce', qty_per_portion: 0.5 },
  ]
  const explosion = { itemYield: {}, subPerUnit: { sauce: [{ item_id: 'chilli', qty: 0.2 }, { item_id: 'garlic', qty: 0.05 }] } }

  test('lines become stored deltas, an item line or a sub-recipe line', () => {
    expect(choiceLinesAsDeltas(rows)).toEqual([
      { item_id: 'oat_milk', qty: 150 }, { item_id: 'milk', qty: -150 }, { sub_recipe_id: 'sauce', qty: 0.5 },
    ])
  })

  test('a sub-recipe line reaches its raw items through the one conversion', () => {
    expect([...choiceLinkedItemIds(rows, explosion)].sort()).toEqual(['chilli', 'garlic', 'milk', 'oat_milk'])
  })

  const builder = result => {
    const b = { order: jest.fn(() => b), range: jest.fn(() => b), then: (ok, bad) => Promise.resolve(result).then(ok, bad) }
    return b
  }

  test('one scoped, paged read of pos_option_ingredients; item lines need no further read', async () => {
    const from = jest.fn(() => builder({ data: rows.slice(0, 2), error: null }))
    const supabase = { from: jest.fn() }
    const ids = await loadChoiceLinkedItemIds(supabase, from)
    expect(from).toHaveBeenCalledWith('pos_option_ingredients', 'item_id, sub_recipe_id, qty_per_portion')
    expect([...ids].sort()).toEqual(['milk', 'oat_milk'])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  test('a failed read THROWS, so the page fails as it does for the recipe walk', async () => {
    const from = jest.fn(() => builder({ data: null, error: { message: 'permission denied' } }))
    await expect(loadChoiceLinkedItemIds({ from: jest.fn() }, from)).rejects.toThrow('permission denied')
  })

  test('the state is named for both links', () => {
    expect(VARIANCE_FLAG_TEXT.no_recipe).toBe('no recipe or choice linked')
  })
})

// Lead note on D36 (S792): a closing_stock row whose physical_qty is NULL is NOT a count. The pages
// read it as 0, so an item nobody counted read as counted-empty and its whole shelf as used.
describe('what a closing count is', () => {
  test('0 is a count; NULL and a missing value are not', () => {
    expect(isClosingCount({ physical_qty: 0 })).toBe(true)
    expect(isClosingCount({ physical_qty: '2.5' })).toBe(true)
    expect(isClosingCount({ physical_qty: null })).toBe(false)
    expect(isClosingCount({})).toBe(false)
  })

  test('closingCountMap holds counts only, so `in` is the per-item measured test', () => {
    const map = closingCountMap([
      { item_id: 'rice', physical_qty: 0 },
      { item_id: 'oil', physical_qty: '4.5' },
      { item_id: 'flour', physical_qty: null },
    ])
    expect(map).toEqual({ rice: 0, oil: 4.5 })
    expect('flour' in map).toBe(false)
  })
})

// A source check, the salesReads.test.js pattern: the defect these pin has no runtime symptom.
describe('the three pages share the population (S792)', () => {
  const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  // Shrinkage's loop lives in shrinkageCalc.js since S792 stage 3 (shared with the Owner Report).
  test.each(['Variance.js', 'TheoreticalVariance.js', 'shrinkageCalc.js'])('%s imports from ./variancePopulation', f => {
    expect(read(f)).toMatch(/from '\.\/variancePopulation'/)
  })

  test('Theoretical vs Actual no longer drops an item because its dishes did not sell', () => {
    expect(read('TheoreticalVariance.js')).not.toMatch(/theoretical\[item\.id\][^\n]*>\s*0\.001/)
  })

  // S835 (owner decision): a dish's choice extras follow the dish, as in stockReportCalc.js —
  // a dish whose month net sold is 0 or less adds no extras to theoretical usage either.
  test('Theoretical vs Actual adds choice extras only for a dish that sold', () => {
    expect(read('TheoreticalVariance.js')).toMatch(/depleting\.forEach\(e => \{\s*if \(!e\.ingredient_deltas\) return\s*if \(\(salesMap\[e\.recipe_id\] \|\| 0\) <= 0\) return/)
  })

  // S862 REPORTS-STOCK-3: every page that judges the population reads the client's choice lines beside
  // the recipe walk and passes them on; the two pure builders take them from their caller.
  test.each(['Variance.js', 'TheoreticalVariance.js'])('%s reads the choice lines and links them', f => {
    expect(read(f)).toMatch(/loadChoiceLinkedItemIds\(supabase, scopedFrom/)
    expect(read(f)).toMatch(/linkedItemIdsOf\([^\n]*, choiceItemIds\)/)
  })
  test('the Owner Report variance section reads them too, and the pure builders pass them on', () => {
    const readFrom = (dir, f) => fs.readFileSync(path.join(__dirname, dir, f), 'utf8')
    expect(readFrom('../../../modules/ownerReport', 'computeInventoryVariance.js')).toMatch(/loadChoiceLinkedItemIds\(supabase, \(t, c\) => scopedFrom\(t, clientId, c\)\)/)
    expect(read('shrinkageCalc.js')).toMatch(/linkedItemIdsOf\([^\n]*, choiceItemIds\)/)
    expect(readFrom('../../../pages/dashboard', 'homeTopVariance.js')).toMatch(/linkedItemIdsOf\(breakdown, depleting, explosion, choiceItemIds\)/)
  })
  test('the pages feeding the pure builders read the choice lines beside their recipe walk', () => {
    const readFrom = (dir, f) => fs.readFileSync(path.join(__dirname, dir, f), 'utf8')
    const shrink = read('ShrinkageReport.js')
    expect(shrink).toMatch(/loadChoiceLinkedItemIds\(supabase, scopedFrom\)/)
    expect(shrink).toMatch(/explosion, transfers, choiceItemIds,/)
    const trend = readFrom('../../../modules/ownerReport', 'computeInventoryShrinkageTrend.js')
    expect(trend).toMatch(/loadChoiceLinkedItemIds\(supabase, \(t, c\) => scopedFrom\(t, clientId, c\)\)/)
    expect(trend).toMatch(/settings, transfers, choiceItemIds \}\)/)
    const dash = readFrom('../../../pages/dashboard', 'ClientDashboard.jsx')
    expect(dash).toMatch(/withTimeout\(loadChoiceLinkedItemIds\(supabase, scopedFrom\), WALK_TIMEOUT_MS/)
    expect(dash).toMatch(/variance: shelfFailed \|\| choiceItemIds === null/)
    expect(dash).toMatch(/transfers: transfersData,\s*choiceItemIds,/)
  })

  test('Shrinkage no longer skips a month before looking at its count when nothing sold', () => {
    expect(read('shrinkageCalc.js')).not.toMatch(/if \(theor <= 0\) return/)
  })

  test('no page reads a NULL physical_qty as a count of 0', () => {
    for (const f of ['Variance.js', 'TheoreticalVariance.js']) {
      expect(read(f)).toMatch(/closingCountMap\(closing\)/)
      expect(read(f)).not.toMatch(/closeMap\[r\.item_id\]\s*=\s*parseFloat\(r\.physical_qty/)
    }
    expect(read('shrinkageCalc.js')).toMatch(/if \(!isClosingCount\(r\)\) return/)
  })
})
