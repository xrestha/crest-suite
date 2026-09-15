import fs from 'fs'
import path from 'path'
import { render, screen } from '@testing-library/react'
import RecipeCostCardPrint from './RecipeCostCardPrint'

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
