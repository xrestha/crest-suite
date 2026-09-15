import { buildCustomizationReport, withOptionCosts, mostAddedOf } from './customizationReportCalc'
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
