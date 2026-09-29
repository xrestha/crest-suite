import fs from 'fs'
import path from 'path'
import { render, screen } from '@testing-library/react'
import RecipeCostCardPrint, { printedOnLabel } from './RecipeCostCardPrint'

// S756. A dish with no costed ingredients is not a free dish. The printed cost card showed
// "Food Cost % 0.0%" and "Gross Margin % 100.0%" for one — the most flattering sheet the page can
// print, on the paper someone prices a menu from — and Recipes.js's list painted the same dish
// "0.0% ✓" in green and returned it under the "✓ ≤30%" pill.

const noIngredients = { id: 'r1', name: 'Momo', category: 'Food', selling_price: '442.4779', vat_rate: 0.13, recipe_ingredients: [] }

function valueUnder(label) {
  return screen.getByText(label).nextSibling.textContent
}

describe('RecipeCostCardPrint with an unknown food cost', () => {
  test('prints dashes, never 0.0% / 100.0%', () => {
    render(<RecipeCostCardPrint recipe={noIngredients} recipes={[noIngredients]} settings={{}} overheadData={null} showNutrition={false} />)
    expect(valueUnder('Food Cost %')).toBe('—')
    expect(valueUnder('Gross Margin %')).toBe('—')
    expect(valueUnder('Food Cost')).toBe('— not costed')
  })

  test('a manual cost_price is the cost, and says it is manual', () => {
    const manual = { ...noIngredients, cost_price: 132.74 }
    render(<RecipeCostCardPrint recipe={manual} recipes={[manual]} settings={{}} overheadData={null} showNutrition={false} />)
    expect(valueUnder('Food Cost (manual)')).toBe('NPR 132.74')
    expect(valueUnder('Food Cost %')).toBe('30.0%')
  })
})

// S792 RECIPES-1: a build-your-own dish's recipe is the bowl and the spoon. The card printed
// "Food Cost % 2.7%" and "Gross Margin % 97.3%" for an acai bowl whose plate costs half its price.
describe('RecipeCostCardPrint for a build-your-own dish', () => {
  const bowl = {
    id: 'b1', name: 'Acai Bowl', category: 'Food', selling_price: 300, vat_rate: 0.13, is_build_your_own: true,
    recipe_ingredients: [{ id: 'x', item_id: 'i1', qty_per_portion: 1, items: { name: 'Bowl', uom: 'PCS', per_uom_rate: 8, yield_pct: 100 } }],
  }

  test('reads "Not rated — costed by build", never a food cost % or margin from the fixed part', () => {
    render(<RecipeCostCardPrint recipe={bowl} recipes={[bowl]} settings={{}} overheadData={null} showNutrition={false} buildYourOwn />)
    expect(valueUnder('Food Cost %')).toBe('Not rated — costed by build')
    expect(valueUnder('Gross Margin %')).toBe('Not rated — costed by build')
    expect(valueUnder('Food Cost (by build)')).toBe('— costed by build')
    // The ingredient table still totals the fixed part — that is what the recipe is.
    expect(screen.getByText('NPR 8.00')).toBeTruthy()
  })

  test('prints the cost range when the page has one', () => {
    const range = { empty: false, lowCost: 128, highCost: 296 }
    render(<RecipeCostCardPrint recipe={bowl} recipes={[bowl]} settings={{}} overheadData={null} showNutrition={false} buildYourOwn byoRange={range} />)
    expect(valueUnder('Food Cost (by build)')).toMatch(/128\.00.*296\.00/)
  })

  test('without the flag the same dish is rated as before', () => {
    render(<RecipeCostCardPrint recipe={bowl} recipes={[bowl]} settings={{}} overheadData={null} showNutrition={false} />)
    expect(valueUnder('Food Cost %')).toBe('2.7%')
  })
})

// S792 RECIPES-2 / D31: on a PAN-bill outlet the till adds no VAT, so the card must not print a
// "Menu Price (incl. 13% VAT)" the guest is never charged.
describe('RecipeCostCardPrint on a PAN-bill outlet', () => {
  test('one menu price, no VAT in it, even for a dish still carrying a 13% rate', () => {
    const momo = { ...noIngredients, cost_price: 132.74 }
    render(<RecipeCostCardPrint recipe={momo} recipes={[momo]} settings={{}} overheadData={null} showNutrition={false} vatMode="pan" />)
    expect(valueUnder('Menu Price (no VAT — PAN bill)')).toBe('NPR 442')
    expect(screen.queryByText(/incl\. 13% VAT/)).toBeNull()
    expect(screen.queryByText('Selling Price (ex-VAT)')).toBeNull()
  })

  test('a VAT outlet keeps both prices', () => {
    render(<RecipeCostCardPrint recipe={noIngredients} recipes={[noIngredients]} settings={{}} overheadData={null} showNutrition={false} vatMode="vat" />)
    expect(valueUnder('Menu Price (incl. 13% VAT)')).toBe('NPR 500')
    expect(valueUnder('Selling Price (ex-VAT)')).toBe('NPR 442.48')
  })
})

// S792 RECIPES-6: the card was dated `toLocaleDateString('en-IN')` — "28/9/2026", AD, in the
// browser's own timezone — on a BS product's printed document.
describe('RecipeCostCardPrint date', () => {
  test('is the BS day with the AD date beside it, read in Nepal', () => {
    expect(printedOnLabel(new Date('2026-09-03T06:00:00+05:45'))).toBe('18 Bhadra 2083 BS · 3 September 2026')
    // 00:15 in Kathmandu is already the next day, whatever the machine's clock says.
    expect(printedOnLabel(new Date('2026-08-20T18:30:00Z'))).toMatch(/ BS · 21 August 2026$/)
  })

  test('outside the verified BS table it prints the AD date alone, never a wrong BS one', () => {
    expect(printedOnLabel(new Date('1900-01-01T12:00:00Z'))).toBe('1 January 1900')
  })

  test('the header and the footer both carry it', () => {
    render(<RecipeCostCardPrint recipe={noIngredients} recipes={[noIngredients]} settings={{}} overheadData={null} showNutrition={false} />)
    expect(screen.getAllByText(/ BS · /)).toHaveLength(2)
    expect(screen.queryByText(/\d{1,2}\/\d{1,2}\/\d{4}/)).toBeNull()
  })
})

describe('Recipes.js source', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'Recipes.js'), 'utf8')
  const code = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  test('no zero-defaulted food cost % survives', () => {
    // The S713 shape: a ratio whose zero numerator is banded Healthy.
    expect(code).not.toMatch(/price > 0 \? \(cost \/ price\) \* 100/)
    expect(code).not.toMatch(/recipeCostById\.get\(r\.id\) \|\| 0/)
  })

  test('an edit never re-activates a hidden recipe', () => {
    // is_active may only be written on the insert path; Show/Hide owns it after that.
    const payloadBlock = code.slice(code.indexOf('const payload = {'), code.indexOf('const DUP_CODE_MSG'))
    expect(payloadBlock).not.toMatch(/^\s*is_active: true,/m)
    expect(payloadBlock).toMatch(/if \(!selectedRecipe\) payload\.is_active = true/)
  })

  test('the True Cost revenue read keeps NULL-source rows', () => {
    expect(code).not.toMatch(/\.neq\(\s*['"]source['"]/)
    expect(code).toMatch(/from\('sales_entries'\)\.select\('[^']*\bsource\b/)
  })
})
