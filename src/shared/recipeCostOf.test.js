import fs from 'fs'
import path from 'path'
import { recipeCostOf, menuFcPct, unratedReason, fcBand, fcFigure } from './imsFormulas'

/**
 * The zero-cost rule, pinned.
 *
 * S713 fixed it on Menu Pricing, S714/S715 on Menu Engineering, and S724 found it still standing on
 * Recipe Margin, Menu Repricing, Best Sellers and the Dashboard's Menu Health tile — because the
 * decision was two lines of arithmetic re-typed at each site rather than a function. What makes it
 * survive review is that the wrong answer is a real number in the most flattering possible
 * direction: 0% food cost bands GREEN with a ✓, and 100% margin sorts to the top.
 */

describe('recipeCostOf', () => {
  const dish = { id: 'r1', cost_price: null }

  test('prefers the computed cost', () => {
    expect(recipeCostOf({ r1: 120 }, { ...dish, cost_price: 90 })).toBe(120)
  })

  test('falls back to the manually entered cost_price', () => {
    // Menu Pricing's + Add Item writes a recipe with no ingredients and a cost_price. Best
    // Sellers, Recipe Margin and the Menu Health tile had no fallback, so that dish read as
    // costed on the page that created it and free to make on the three that rank it.
    expect(recipeCostOf({}, { ...dish, cost_price: 90 })).toBe(90)
    expect(recipeCostOf({ r1: 0 }, { ...dish, cost_price: 90 })).toBe(90)
  })

  test('returns null — never 0 — when nothing has costed the dish', () => {
    expect(recipeCostOf({}, dish)).toBeNull()
    expect(recipeCostOf({ r1: 0 }, dish)).toBeNull()
    expect(recipeCostOf({ r1: null }, dish)).toBeNull()
    expect(recipeCostOf(undefined, dish)).toBeNull()
    expect(recipeCostOf({}, undefined)).toBeNull()
  })

  test('a negative or unparseable cost is not a cost', () => {
    expect(recipeCostOf({ r1: -5 }, dish)).toBeNull()
    expect(recipeCostOf({ r1: 'abc' }, dish)).toBeNull()
  })
})

describe('the zero a band would have accepted', () => {
  test('fcBand paints a 0 green with a tick — which is why the null must reach it', () => {
    // Not a defect in fcBand: 0% food cost is genuinely healthy IF it is a measurement. The whole
    // rule is that an absent cost must never be turned into that measurement upstream.
    expect(fcBand(0, {}).key).toBe('good')
    expect(fcBand(0, {}).mark).toBe('✓')
    expect(fcBand(null, {}).key).toBe('none')
    expect(fcBand(null, {}).mark).toBe('')
  })

  test('menuFcPct returns null for a zero cost against a real price', () => {
    expect(menuFcPct(0, 400)).toBeNull()
    expect(menuFcPct(null, 400)).toBeNull()
    expect(menuFcPct(140, 0)).toBeNull()
    expect(menuFcPct(140, 400)).toBeCloseTo(35)
  })

  test('fcFigure renders the null as a dash with no band name', () => {
    expect(fcFigure(null, {}).text).toBe('—')
    expect(fcFigure(null, {}).title).toBeUndefined()
    expect(fcFigure(35, {}).text).toBe('35.0% ✓')
  })

  test('unratedReason says which half is missing', () => {
    expect(unratedReason(0, 400)).toMatch(/costed ingredients/)
    expect(unratedReason(140, 0)).toMatch(/selling price/)
    expect(unratedReason(0, 0)).toMatch(/selling price and no costed/)
    expect(unratedReason(140, 400)).toBeNull()
  })
})

/**
 * A source-reading test, the `salesReads.test.js` / `nepalMoney.test.js` pattern. The defect has no
 * runtime symptom on these pages — a wrong figure, not an exception — so nothing else catches the
 * two-line arithmetic coming back. Six files have now had this decision made; a seventh copy is how
 * the same dish comes to cost two different amounts on two screens.
 */
const COST_SITES = [
  ['BestSellers.js', path.join(__dirname, '..', 'modules', 'ims', 'reports', 'BestSellers.js')],
  ['RecipeMargin.js', path.join(__dirname, '..', 'modules', 'ims', 'recipes', 'RecipeMargin.js')],
  ['MenuRepricing.js', path.join(__dirname, '..', 'modules', 'ims', 'recipes', 'MenuRepricing.js')],
  ['MenuEngineering.js', path.join(__dirname, '..', 'modules', 'ims', 'recipes', 'MenuEngineering.js')],
  ['ComboBuilder.js', path.join(__dirname, '..', 'modules', 'ims', 'recipes', 'ComboBuilder.js')],
  ['computeMenuEngineeringSection.js', path.join(__dirname, '..', 'modules', 'ownerReport', 'computeMenuEngineeringSection.js')],
  ['ClientDashboard.jsx', path.join(__dirname, '..', 'pages', 'dashboard', 'ClientDashboard.jsx')],
]

describe.each(COST_SITES)('%s resolves a recipe cost through the shared decision', (_name, file) => {
  const SRC = fs.readFileSync(file, 'utf8')
  const code = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))

  test('imports recipeCostOf', () => {
    expect(/\brecipeCostOf\b/.test(code.join('\n'))).toBe(true)
  })

  test('no private cost-map fallback collapsing the absence to 0', () => {
    // Both live shapes, verified against the pre-S724 source of these files:
    //   const cost = costMap[r.id] || 0                                        (4 sites)
    //   const cost = parseFloat(costMap[r.id]) || parseFloat(r.cost_price) || 0 (MenuRepricing)
    // The second is the more instructive one — S713 added the cost_price fallback to it and left
    // the trailing `|| 0` in place, so the fix landed and the defect it was for did not move.
    const offenders = code.filter(l =>
      /(cost|ing)Map\[[^\]]+\]\s*\|\|\s*0/i.test(l) ||
      /parseFloat\(\s*(cost|ing)Map\[/i.test(l))
    expect(offenders).toEqual([])
  })

  test('the recipes read selects cost_price', () => {
    // Without the column the fallback cannot fire, and the function silently degrades to
    // "computed cost or nothing" — which is the state three of these pages were already in.
    expect(/cost_price/.test(SRC)).toBe(true)
  })
})
