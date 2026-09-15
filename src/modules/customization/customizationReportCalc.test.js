import { buildCustomizationReport, withOptionCosts } from './customizationReportCalc'

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

describe('buildCustomizationReport', () => {
  const r = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set([MOMO]) })

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

describe('withOptionCosts', () => {
  test('values stock lines at the given rates; no stock lines is null, not 0', () => {
    const r = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: new Set([MOMO]) })
    const toItems = deltas => deltas.map(d => ({ item_id: d.item_id, qty: d.qty }))
    const costed = withOptionCosts(r.options, toItems, { cheese: 2 })
    expect(costed.find(o => o.option_id === 'o-cheese').costPerPick).toBe(60)
    expect(costed.find(o => o.option_id === 'o-half').costPerPick).toBeNull()
  })
})
