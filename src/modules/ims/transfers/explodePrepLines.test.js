import { buildRecipeBook, explodeRecipeTree } from '../../../utils/recipeCost'
import { explodePrep, explodePrepLines, mergeTransferLines, prepLabel, prepProblemText, qtyLabel } from './explodePrepLines'

// A book: Momo filling (yield 5 kg) = 3 kg pork + 1 kg onion + 0.5 kg Masala base (a nested prep,
// yield 1 kg = 0.4 kg chilli + 0.6 kg garlic at 75% yield).
const rows = [
  {
    id: 'r-fill', name: 'Momo filling', yield_qty: 5,
    recipe_ingredients: [
      { id: 1, recipe_id: 'r-fill', qty_per_portion: 3, item_id: 'pork', items: { yield_pct: 100 } },
      { id: 2, recipe_id: 'r-fill', qty_per_portion: 1, item_id: 'onion', items: { yield_pct: 100 } },
      { id: 3, recipe_id: 'r-fill', qty_per_portion: 0.5, item_id: null, sub_recipe_id: 'r-masala' },
    ],
  },
  {
    id: 'r-masala', name: 'Masala base', yield_qty: 1,
    recipe_ingredients: [
      { id: 4, recipe_id: 'r-masala', qty_per_portion: 0.4, item_id: 'chilli', items: { yield_pct: 100 } },
      { id: 5, recipe_id: 'r-masala', qty_per_portion: 0.6, item_id: 'garlic', items: { yield_pct: 75 } },
    ],
  },
  { id: 'r-empty', name: 'Nothing', yield_qty: 2, recipe_ingredients: [] },
]
const book = buildRecipeBook(rows)
const FILL = { id: 'i-fill', name: 'Momo filling', uom: 'kg', is_sub_recipe: true }
const PORK = { id: 'pork', name: 'Pork', uom: 'kg', is_sub_recipe: false }
const qtyOf = (lines, id) => lines.find(l => l.item_id === id)?.qty

let walk
beforeAll(async () => {
  walk = await explodeRecipeTree(null, ['r-fill', 'r-masala', 'r-empty'], { book })
})

describe('explodePrep', () => {
  it('scales by quantity ÷ the sub-recipe\'s yield', () => {
    const r = explodePrep({ prepItem: FILL, qty: 10, recipe: { id: 'r-fill', yield_qty: 5 }, walk })
    expect(r.problem).toBeNull()
    expect(qtyOf(r.lines, 'pork')).toBeCloseTo(6)     // 3 per batch × 2 batches
    expect(qtyOf(r.lines, 'onion')).toBeCloseTo(2)
  })

  it('walks nested prep down to raw items, yield_pct applied', () => {
    const r = explodePrep({ prepItem: FILL, qty: 5, recipe: { id: 'r-fill', yield_qty: 5 }, walk })
    expect(qtyOf(r.lines, 'chilli')).toBeCloseTo(0.2)          // 0.5 kg masala → 0.5 batches × 0.4
    expect(qtyOf(r.lines, 'garlic')).toBeCloseTo(0.3 / 0.75)   // 0.5 × 0.6, as purchased at 75% yield
    expect(r.lines.some(l => l.item_id == null)).toBe(false)
  })

  it('labels every raw line with what it came from', () => {
    const r = explodePrep({ prepItem: FILL, qty: 5, recipe: { id: 'r-fill', yield_qty: 5 }, walk })
    expect(new Set(r.lines.map(l => l.prep_label))).toEqual(new Set(['from 5 kg Momo filling']))
  })

  it('names what stops a prep from going', () => {
    expect(explodePrep({ prepItem: FILL, qty: 5, recipe: null, walk }).problem).toBe('no_recipe')
    expect(explodePrep({ prepItem: FILL, qty: 5, recipe: { id: 'r-fill', yield_qty: 0 }, walk }).problem).toBe('no_yield')
    expect(explodePrep({ prepItem: FILL, qty: 5, recipe: { id: 'r-empty', yield_qty: 2 }, walk }).problem).toBe('empty')
    expect(explodePrep({ prepItem: FILL, qty: 0, recipe: { id: 'r-fill', yield_qty: 5 }, walk }).problem).toBe('qty')
    expect(prepProblemText('no_recipe')).toMatch(/recipe/)
    expect(prepProblemText(null)).toBeNull()
  })
})

describe('mergeTransferLines / explodePrepLines', () => {
  it('merges lines naming one item, joining distinct labels', () => {
    const m = mergeTransferLines([
      { item_id: 'pork', qty: 1, prep_label: null },
      { item_id: 'pork', qty: 2, prep_label: 'from 5 kg Momo filling' },
      { item_id: 'pork', qty: 1, prep_label: 'from 5 kg Momo filling' },
      { item_id: 'onion', qty: 1, prep_label: 'from 1 kg Sauce' },
    ])
    expect(m).toEqual([
      { item_id: 'pork', qty: 4, prep_label: 'from 5 kg Momo filling' },
      { item_id: 'onion', qty: 1, prep_label: 'from 1 kg Sauce' },
    ])
  })

  it('turns picks into raw lines: a raw pick as itself, a prep pick as its ingredients, merged by item', () => {
    const { lines, problems } = explodePrepLines({
      picks: [{ item_id: 'pork', qty: 1 }, { item_id: 'i-fill', qty: 5 }],
      itemsById: new Map([['pork', PORK], ['i-fill', FILL]]),
      recipeByPrep: { 'i-fill': { id: 'r-fill', yield_qty: 5 } },
      walk,
    })
    expect(problems).toEqual([])
    expect(qtyOf(lines, 'pork')).toBeCloseTo(4)        // 1 sent as itself + 3 inside the filling
    expect(lines.find(l => l.item_id === 'pork').prep_label).toBe('from 5 kg Momo filling')
    expect(lines.map(l => l.item_id)).toEqual(['pork', 'onion', 'chilli', 'garlic'])
  })

  it('reports a prep pick it cannot explode instead of dropping it silently', () => {
    const { lines, problems } = explodePrepLines({
      picks: [{ item_id: 'i-fill', qty: 5 }],
      itemsById: { 'i-fill': FILL },
      recipeByPrep: {},
      walk,
    })
    expect(lines).toEqual([])
    expect(problems).toEqual([{ item_id: 'i-fill', problem: 'no_recipe' }])
  })
})

describe('labels', () => {
  it('formats quantities without float noise', () => {
    expect(qtyLabel(0.1 + 0.2, 'kg')).toBe('0.3 kg')
    expect(qtyLabel(5)).toBe('5')
    expect(prepLabel(2.5, { name: 'Sauce', uom: 'ltr' })).toBe('from 2.5 ltr Sauce')
  })
})
