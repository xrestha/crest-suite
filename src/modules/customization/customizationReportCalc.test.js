import { buildCustomizationReport, withOptionCosts, allDeltaSets, mostAddedOf, sliceByOrders, weeklyDishShares, TREND_MIN_PLATES } from './customizationReportCalc'
import { bsMonthRangeIso, shiftBsMonth } from '../pos/reports/reportRange'

const MOMO = 'r-momo'
const TEA = 'r-tea'

const lines = [
  { id: 'l1', recipe_id: MOMO, name: 'Momo', qty: 2, comped: false, selection_key: 'o-half+o-cheese' },
  { id: 'l2', recipe_id: MOMO, name: 'Momo', qty: 3, comped: false, selection_key: '' },
  { id: 'l3', recipe_id: MOMO, name: 'Momo', qty: 1, comped: true, selection_key: 'o-cheese+o-noonion' },
  { id: 'l4', recipe_id: TEA, name: 'Tea', qty: 4, comped: false, selection_key: '' },
]
const snapshots = [
  { order_item_id: 'l1', option_id: 'o-half', group_name: 'Size', option_name: 'Half', is_removal: false, price_delta: -100 },
  { order_item_id: 'l1', option_id: 'o-cheese', group_name: 'Extras', option_name: 'Extra cheese', is_removal: false, price_delta: 50, ingredient_deltas: [{ item_id: 'cheese', qty: 30 }] },
  { order_item_id: 'l3', option_id: 'o-cheese', group_name: 'Extras', option_name: 'Extra cheese', is_removal: false, price_delta: 50 },
  { order_item_id: 'l3', option_id: 'o-noonion', group_name: 'Remove', option_name: 'No onion', is_removal: true, price_delta: 0 },
]
const kindByOptionId = { 'o-half': 'size', 'o-cheese': 'addon', 'o-noonion': 'addon' }
const listPriceByOptionId = { 'o-half': -100, 'o-cheese': 50, 'o-noonion': 0 }

describe('buildCustomizationReport', () => {
  const r = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set([MOMO]), kindByOptionId, listPriceByOptionId })

  test('counts plates, not lines, and only dishes that can be customized', () => {
    expect(r.customizablePlates).toBe(6)      // Tea has no groups and never sold customized
    expect(r.customizedPlates).toBe(3)        // 2 + 1
    expect(r.customizedShare).toBeCloseTo(0.5)
  })

  test('a comped plate is a pick but adds nothing charged', () => {
    const cheese = r.options.find(o => o.option_id === 'o-cheese')
    expect(cheese.picks).toBe(3)
    expect(cheese.charged).toBe(100)          // only the two paid plates
    expect(r.extraCharged).toBe(-100)         // Half −100×2 + cheese +50×2
  })

  test('extras and size adjustments are split by sign, and still sum to the net', () => {
    expect(r.extrasEarned).toBe(100)          // cheese +50 × 2 paid plates
    expect(r.sizeAdjustments).toBe(-200)      // Half −100 × 2
    expect(r.sizeAdjustments).toBeLessThanOrEqual(0)
    expect(r.extrasEarned + r.sizeAdjustments).toBe(r.extraCharged)
  })

  test('each option carries its group kind and list price from the catalog', () => {
    const half = r.options.find(o => o.option_id === 'o-half')
    expect(half.group_kind).toBe('size')
    expect(half.listPriceDelta).toBe(-100)
    expect(r.options.find(o => o.option_id === 'o-cheese').listPriceDelta).toBe(50)
  })

  test('an option the catalog no longer knows is "unknown" with no list price, not a size or a free one', () => {
    const r2 = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set([MOMO]) })
    const cheese = r2.options.find(o => o.option_id === 'o-cheese')
    expect(cheese.group_kind).toBe('unknown')
    expect(cheese.listPriceDelta).toBeNull()
    const noId = buildCustomizationReport({
      lines: [lines[0]],
      snapshots: [{ order_item_id: 'l1', option_id: null, group_name: 'Extras', option_name: 'Legacy', is_removal: false, price_delta: 10 }],
      attachedRecipeIds: new Set([MOMO]), kindByOptionId, listPriceByOptionId,
    })
    expect(noId.options[0]).toMatchObject({ group_kind: 'unknown', listPriceDelta: null })
  })

  test('removals are listed by option and by dish', () => {
    expect(r.removals.map(o => o.option_name)).toEqual(['No onion'])
    expect(r.removalsByDish[0]).toMatchObject({ dish: 'Momo', option_name: 'No onion', picks: 1, dishPlates: 6 })
  })

  test('a dish whose group was detached still counts for the plates it sold customized', () => {
    const r2 = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set() })
    expect(r2.customizablePlates).toBe(6)
  })

  test('nothing customizable reads as no share at all, not 0%', () => {
    const r3 = buildCustomizationReport({ lines: [lines[3]], snapshots: [], attachedRecipeIds: new Set() })
    expect(r3.customizedShare).toBeNull()
  })
})

describe('mostAddedOf', () => {
  test('skips sizes and removals, keeps the pick order', () => {
    const rows = [
      { option_name: 'Half', is_removal: false, group_kind: 'size', picks: 40 },
      { option_name: 'No onion', is_removal: true, group_kind: 'addon', picks: 30 },
      { option_name: 'Extra cheese', is_removal: false, group_kind: 'addon', picks: 20 },
      { option_name: 'Spicy', is_removal: false, group_kind: 'choice', picks: 10 },
    ]
    expect(mostAddedOf(rows).option_name).toBe('Extra cheese')
  })

  test('an unknown kind still qualifies — only a known size is excluded', () => {
    expect(mostAddedOf([{ option_name: 'Legacy', is_removal: false, group_kind: 'unknown', picks: 1 }]).option_name).toBe('Legacy')
  })

  test('only sizes (or only removals, or nothing) is null', () => {
    expect(mostAddedOf([{ option_name: 'Half', is_removal: false, group_kind: 'size', picks: 5 }])).toBeNull()
    expect(mostAddedOf([{ option_name: 'No onion', is_removal: true, group_kind: 'addon', picks: 5 }])).toBeNull()
    expect(mostAddedOf([])).toBeNull()
  })
})

describe('withOptionCosts', () => {
  test('values stock lines at the given rates; no stock lines is null, not 0', () => {
    const r = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set([MOMO]) })
    const toItems = deltas => deltas.map(d => ({ item_id: d.item_id, qty: d.qty }))
    const costed = withOptionCosts(r.options, toItems, { cheese: 2 })
    expect(costed.find(o => o.option_id === 'o-cheese').costPerPick).toBe(60)
    expect(costed.find(o => o.option_id === 'o-half').costPerPick).toBeNull()
  })
})

// S809 3o. The acai bowl of REPORTS-4: Small ×0.75, Regular ×1, Large ×1.5; Granola is a NPR 60
// add-on in a 'stock' scaling group, 40 g at NPR 1.20/g on a Regular bowl.
describe('a size-scaled choice is costed plate by plate (REPORTS-4)', () => {
  const BOWL = 'r-bowl'
  const toItems = deltas => deltas.map(d => ({ item_id: d.item_id, qty: d.qty }))
  const rates = { granola: 1.2 }
  const bowl = (id, qty) => ({ id, recipe_id: BOWL, name: 'Acai bowl', qty, comped: false, selection_key: 'o-granola' })
  const granola = (order_item_id, grams) => ({
    order_item_id, option_id: 'o-granola', group_name: 'Toppings', group_kind: 'addon', option_name: 'Granola',
    is_removal: false, price_delta: 60, list_price_delta: 60, included: false,
    ingredient_deltas: grams == null ? [] : [{ item_id: 'granola', qty: grams }],
  })
  const costOf = (ls, ss) => withOptionCosts(buildCustomizationReport({ lines: ls, snapshots: ss, attachedRecipeIds: new Set([BOWL]) }).options, toItems, rates)
    .find(o => o.option_id === 'o-granola')

  test('100 Regular and 20 Large bowls cost NPR 52 a plate, whichever bill is read first', () => {
    const ls = [bowl('large', 20), bowl('regular', 100)]
    const ss = [granola('large', 60), granola('regular', 40)]
    const a = costOf(ls, ss)
    const b = costOf([...ls].reverse(), [...ss].reverse())
    expect(a.costPerPick).toBeCloseTo(52, 6)       // (100 × 48 + 20 × 72) ÷ 120
    expect(b.costPerPick).toBeCloseTo(52, 6)
    expect(a.chargedPerPick - a.costPerPick).toBeCloseTo(8, 6)
    expect(a.costedPicks).toBe(120)
  })

  test('identical stock lines are one set to cost, with their plates added up', () => {
    const r = buildCustomizationReport({
      lines: [bowl('a', 3), bowl('b', 4), bowl('c', 1)],
      snapshots: [granola('a', 40), granola('b', 40), granola('c', 60)],
      attachedRecipeIds: new Set([BOWL]),
    })
    const g = r.options.find(o => o.option_id === 'o-granola')
    expect(g.deltaSets).toHaveLength(2)
    expect(g.deltaSets.map(s => s.plates).sort()).toEqual([1, 7])
    expect(allDeltaSets(r.options)).toHaveLength(2)
  })

  test('a first plate with no stock lines yet does not make the choice "no stock lines"', () => {
    const c = costOf([bowl('early', 10), bowl('later', 30)], [granola('early', null), granola('later', 40)])
    expect(c.costPerPick).toBeCloseTo(48, 6)        // the 10 plates with [] are left out, not costed at 0
    expect(c.costedPicks).toBe(30)
    expect(c.picks).toBe(40)
  })

  test('a choice no plate of which carried stock lines is null, not 0', () => {
    expect(costOf([bowl('a', 2)], [granola('a', null)]).costPerPick).toBeNull()
  })
})

describe('kind and list price are taken as billed (REPORTS-12)', () => {
  const DISH = 'r-pizza'
  const line = (id, qty, comped = false) => ({ id, recipe_id: DISH, name: 'Pizza', qty, comped, selection_key: 'x' })
  const pick = (order_item_id, over) => ({
    order_item_id, option_id: 'o-cheese', group_name: 'Extras', group_kind: 'addon', option_name: 'Extra cheese',
    is_removal: false, price_delta: 50, list_price_delta: 50, included: false, ingredient_deltas: [], ...over,
  })
  const build = (ls, ss, catalog = {}) => buildCustomizationReport({ lines: ls, snapshots: ss, attachedRecipeIds: new Set([DISH]), ...catalog })
  const cheeseOf = r => r.options.find(o => o.option_id === 'o-cheese')

  test('a mid-month price rise is an average list price, not "free picks"', () => {
    const r = build([line('a', 100), line('b', 100)], [pick('a'), pick('b', { price_delta: 60, list_price_delta: 60 })],
      { listPriceByOptionId: { 'o-cheese': 60 } })
    const c = cheeseOf(r)
    expect(c.listPriceDelta).toBeCloseTo(55, 6)     // as billed, not today's 60
    expect(c.chargedPerPick).toBeCloseTo(55, 6)
    expect(c.freePicks).toBe(0)
    expect(c.compedPicks).toBe(0)
  })

  test('a choice made free since its sales is not "free by design"', () => {
    const r = build([line('a', 30), line('b', 1)], [pick('a', { price_delta: 30, list_price_delta: 30 }), pick('b', { price_delta: 0, list_price_delta: 0 })],
      { listPriceByOptionId: { 'o-cheese': 0 } })
    expect(cheeseOf(r).freeByDesign).toBe(false)
  })

  test('a choice billed at 0 on every plate is free by design', () => {
    const r = build([line('a', 3)], [pick('a', { price_delta: 0, list_price_delta: 0 })])
    expect(cheeseOf(r).freeByDesign).toBe(true)
    expect(cheeseOf(r).listPriceDelta).toBe(0)
  })

  test('free picks and comped plates are counted, so the note can say which', () => {
    const r = build([line('a', 4), line('b', 2), line('c', 1, true)],
      [pick('a'), pick('b', { price_delta: 0, included: true }), pick('c')])
    const c = cheeseOf(r)
    expect(c.freePicks).toBe(2)
    expect(c.compedPicks).toBe(1)
    expect(c.listPriceDelta).toBe(50)
    expect(c.chargedPerPick).toBeCloseTo(200 / 7, 6)
  })

  test('a size deleted since keeps its billed kind, so it cannot win "Most added"', () => {
    const r = build([line('a', 40), line('b', 5)], [
      { order_item_id: 'a', option_id: 'o-large', group_name: 'Size', group_kind: 'size', option_name: 'Large', is_removal: false, price_delta: 100, list_price_delta: 100, included: false },
      pick('b'),
    ], { kindByOptionId: { 'o-cheese': 'addon' }, listPriceByOptionId: { 'o-cheese': 50 } })   // o-large is not in today's catalog
    expect(r.options.find(o => o.option_id === 'o-large').group_kind).toBe('size')
    expect(mostAddedOf(r.options).option_name).toBe('Extra cheese')
  })

  test('the billed kind wins over today\'s catalog; the catalog only fills a row with none', () => {
    const billed = build([line('a', 2)], [pick('a', { group_kind: 'choice' })], { kindByOptionId: { 'o-cheese': 'size' } })
    expect(cheeseOf(billed).group_kind).toBe('choice')
    const gap = build([line('a', 2)], [pick('a', { group_kind: null, list_price_delta: undefined })],
      { kindByOptionId: { 'o-cheese': 'addon' }, listPriceByOptionId: { 'o-cheese': 45 } })
    expect(cheeseOf(gap).group_kind).toBe('addon')
    expect(cheeseOf(gap).listPriceDelta).toBe(45)
  })

  test('a choice billed under two kinds takes the one most plates had', () => {
    const r = build([line('a', 1), line('b', 9)], [pick('a', { group_kind: 'size' }), pick('b', { group_kind: 'addon' })])
    expect(cheeseOf(r).group_kind).toBe('addon')
  })
})

// The range presets the report offers live in reportRange.js; tested here beside the page that
// introduced them (S759). Anchored on an injected "today" so the assertions never move.
describe('bsMonthRangeIso', () => {
  const today = { year: 2083, month: 5, day: 30 }   // 30 Bhadra 2083 = 2026-09-15

  test('shiftBsMonth wraps across the BS year', () => {
    expect(shiftBsMonth(2083, 1, -1)).toEqual({ year: 2082, month: 12 })
    expect(shiftBsMonth(2083, 12, 1)).toEqual({ year: 2084, month: 1 })
    expect(shiftBsMonth(2083, 5, -2)).toEqual({ year: 2083, month: 3 })
  })

  test('this month runs from the 1st of the BS month to today', () => {
    expect(bsMonthRangeIso(0, 0, today)).toEqual({ from: '2026-08-17', to: '2026-09-15' })
  })

  test('last month is the whole previous BS month, whatever its length', () => {
    expect(bsMonthRangeIso(-1, -1, today)).toEqual({ from: '2026-07-17', to: '2026-08-16' })   // Shrawan 2083, 31 days
  })

  test('last 3 months starts two months back and ends today', () => {
    const r = bsMonthRangeIso(-2, 0, today)
    expect(r.to).toBe('2026-09-15')
    expect(r.from).toBe('2026-06-15')        // 1 Ashadh 2083
  })
})

describe('the period comparison and the weekly trend (S800)', () => {
  // Two orders a week for three weeks; order oN carries one Bowl line of 5 plates.
  const line = (id, order_id, customized) => ({ id, order_id, recipe_id: 'bowl', name: 'Bowl', qty: 5, comped: false, selection_key: customized ? 'x' : '' })
  const snap = (order_item_id) => ({ order_item_id, option_id: 'x', group_name: 'Top', option_name: 'Nuts', is_removal: false, price_delta: 20 })
  const lines = [line('l1', 'o1', true), line('l2', 'o2', true), line('l3', 'o3', true), line('l4', 'o4', false), line('l5', 'o5', false), line('l6', 'o6', false)]
  const snapshots = [snap('l1'), snap('l2'), snap('l3')]

  test('sliceByOrders keeps a set of bills\' lines and only their choices', () => {
    const s = sliceByOrders(lines, snapshots, new Set(['o1', 'o4']))
    expect(s.lines.map(l => l.id)).toEqual(['l1', 'l4'])
    expect(s.snapshots.map(x => x.order_item_id)).toEqual(['l1'])
  })

  test('weekly shares per top dish, and a fall of 10 points or more is flagged', () => {
    const weekOfOrder = new Map([['o1', 0], ['o2', 0], ['o3', 1], ['o4', 1], ['o5', 2], ['o6', 2]])
    const t = weeklyDishShares({ lines, snapshots, weekOfOrder, weekCount: 3, attachedRecipeIds: new Set(['bowl']) })
    expect(t.dishes).toEqual([{ recipe_id: 'bowl', name: 'Bowl' }])
    expect(t.rows.map(r => r.bowl)).toEqual([100, 50, 0])
    expect(t.drops).toEqual([{ recipe_id: 'bowl', name: 'Bowl', from: 50, to: 0 }])
  })

  test(`a week under ${TREND_MIN_PLATES} plates of a dish is a gap, never 0%`, () => {
    const small = [{ ...lines[0], qty: 2 }]
    const t = weeklyDishShares({ lines: small, snapshots: [snapshots[0]], weekOfOrder: new Map([['o1', 1]]), weekCount: 2, attachedRecipeIds: new Set(['bowl']) })
    expect(t.rows.map(r => r.bowl)).toEqual([null, null])
    expect(t.drops).toEqual([])
  })
})
