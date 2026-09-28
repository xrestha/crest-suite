// S792: two defects in the frozen Menu Engineering matrix.
//   - FIGURES-8: comps were dropped with a server-side `.neq('source', 'pos_comp')`, which also
//     dropped every legacy NULL-source row — and this qty map sets the popularity median.
//   - RECIPES-1: a build-your-own dish was classified on its fixed (bowl-and-spoon) cost, so an
//     acai bowl at NPR 8 of cost against NPR 300 froze as a 2.7% Star.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { buildMenuEngineeringSection } from './computeMenuEngineeringSection'
// eslint-disable-next-line import/first
import { BYO_REASON } from '../ims/recipes/buildYourOwnRating'

const recipe = (id, selling_price, extra = {}) => ({ id, name: `Dish ${id}`, category: 'Food', selling_price, cost_price: null, ...extra })
const recipes = [
  recipe('momo', 300),
  recipe('acai', 300, { is_build_your_own: true }),
  recipe('tea', 100),
]
const costMap = { momo: 90, acai: 8, tea: 20 }
const sale = (recipe_id, qty_sold, source, unit_price = 300) => ({ recipe_id, qty_sold, unit_price, discount: 0, source })

function build(sales, customizationEnabled = true) {
  return buildMenuEngineeringSection({ recipes, sales, costMap, customizationEnabled })
}

describe('buildMenuEngineeringSection', () => {
  const sales = [
    sale('momo', 40, 'pos'), sale('momo', 10, null),      // a legacy NULL-source row still counts
    sale('momo', 5, 'pos_comp'),                          // a comp does not
    sale('acai', 30, 'pos'),
    sale('tea', 20, 'manual', 100),
  ]

  test('a NULL-source row is counted and a comp is not', () => {
    const momo = build(sales).items.find(i => i.recipeId === 'momo')
    expect(momo.qtySold).toBe(50)
    expect(momo.revenue).toBeCloseTo(15000, 9)
  })

  test('a build-your-own dish is Not rated, with the reason, and gets no contribution', () => {
    const s = build(sales)
    const acai = s.items.find(i => i.recipeId === 'acai')
    expect(acai).toMatchObject({ byo: true, quadrant: null, fcPct: null, unrated: BYO_REASON, totalContribution: null })
    expect(acai.qtySold).toBe(30)
    expect(s.quadrantCounts.Unrated).toBe(1)
    expect(s.byoCount).toBe(1)
    expect(s.byoItems).toEqual([{ recipeId: 'acai', name: 'Dish acai', qtySold: 30, revenue: 9000 }])
  })

  test('it stays out of the contribution ranking but keeps its revenue rank', () => {
    const s = build(sales)
    expect(s.topByContribution.map(i => i.recipeId)).not.toContain('acai')
    expect(s.topByRevenue.map(i => i.recipeId)).toContain('acai')
  })

  test('it stays in the popularity median like any unrated dish', () => {
    // qty [50, 30, 20] → median 30; dropping the BYO dish would make it 35.
    expect(build(sales).medianQty).toBe(30)
  })

  test('an ordinary dish is still rated', () => {
    const momo = build(sales).items.find(i => i.recipeId === 'momo')
    expect(momo.quadrant).toBe('Star')
    expect(momo.fcPct).toBeCloseTo(30, 9)
  })

  // The live pages' rule (buildYourOwnRating.js): with Customization off the till sells the dish
  // plain and Recipe Costing costs it like any other, so the frozen matrix rates it too.
  test('with Crest Customization off, a build-your-own dish is rated like any other', () => {
    const s = build(sales, false)
    expect(s.byoCount).toBe(0)
    expect(s.items.find(i => i.recipeId === 'acai').quadrant).not.toBeNull()
  })
})

describe('computeMenuEngineeringSection source', () => {
  const src = fs.readFileSync(path.join(__dirname, 'computeMenuEngineeringSection.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\s+/g, ' ')

  test("reads the CLIENT's module flags with .single(), and the recipe's BYO mark", () => {
    expect(src).toMatch(/from\('clients'\)\.select\('pos_enabled, customization_enabled'\)\.eq\('id', clientId\)\.single\(\)/)
    expect(src).toMatch(/is_build_your_own/)
    expect(src).toMatch(/isCostedByBuild\(r, customizationEnabled\)/)
  })
})
