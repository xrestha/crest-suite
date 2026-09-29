import fs from 'fs'
import path from 'path'
import { parseImportRows } from './recipeImportParse'
import { markSheetDuplicates, sheetDuplicateNote } from './recipeImportSheetDupes'

// S792 RECIPES-9: two "Chicken Momo" blocks in one sheet both passed the duplicate check (which only
// compares against dishes already saved) and imported as two dishes.

const items = [
  { id: 'i-flour', name: 'Flour', uom: 'GM', item_code: 'ITM-001' },
  { id: 'i-chicken', name: 'Chicken', uom: 'GM', item_code: 'ITM-002' },
  { id: 'i-cabbage', name: 'Cabbage', uom: 'GM', item_code: 'ITM-003' },
]
const block = (name, price, lines, category = 'Food') => [
  [name, category, price, 1, lines[0][0], lines[0][1], 'GM'],
  ...lines.slice(1).map(([ing, qty]) => ['', '', '', '', ing, qty, 'GM']),
]
const parse = rows => parseImportRows(rows, items, [], [{ id: 'old', name: 'Veg Soup', category: 'Food' }])

describe('markSheetDuplicates', () => {
  it('imports a dish typed twice with the same details once, and says so', () => {
    const parsed = parse([
      ...block('Chicken Momo', 300, [['Flour', 50], ['Chicken', 80]]),
      ...block('Buff Momo', 280, [['Flour', 50]]),
      // Same dish, same lines in another order, name in other case.
      ...block('chicken momo', 300, [['Chicken', 80], ['Flour', 50]]),
    ])
    const out = markSheetDuplicates(parsed)
    expect(out).toEqual({ merged: ['Chicken Momo'], skipped: [] })
    expect(parsed.map(r => [r.name, r.willImport, r.sheetDuplicate])).toEqual([
      ['Chicken Momo', true, null],
      ['Buff Momo', true, null],
      ['chicken momo', false, 'merged'],
    ])
  })

  it('holds back every copy when the copies disagree — which is right is not the importer\'s call', () => {
    const parsed = parse([
      ...block('Chicken Momo', 300, [['Flour', 50], ['Chicken', 80]]),
      ...block('Chicken Momo', 320, [['Flour', 50], ['Chicken', 80]]),
      ...block('Veg Momo', 250, [['Flour', 50], ['Cabbage', 60]]),
      ...block('Veg Momo', 250, [['Flour', 50], ['Cabbage', 70]]),
    ])
    const out = markSheetDuplicates(parsed)
    expect(out).toEqual({ merged: [], skipped: ['Chicken Momo', 'Veg Momo'] })
    expect(parsed.every(r => r.willImport === false && r.sheetDuplicate === 'conflict' && r.sheetCopies === 2)).toBe(true)
  })

  it('leaves a dish already saved as "already exists", and a name typed once untouched', () => {
    const parsed = parse([
      ...block('Veg Soup', 200, [['Cabbage', 100]]),
      ...block('Veg Soup', 200, [['Cabbage', 100]]),
      ...block('Thukpa', 260, [['Flour', 90]]),
    ])
    expect(markSheetDuplicates(parsed)).toEqual({ merged: [], skipped: [] })
    expect(parsed.map(r => [r.duplicate, r.sheetDuplicate, r.willImport])).toEqual([
      [true, null, false], [true, null, false], [false, null, true],
    ])
  })
})

describe('sheetDuplicateNote', () => {
  it('names what was merged and what was skipped, in words an owner can act on', () => {
    expect(sheetDuplicateNote({ merged: ['Chicken Momo'], skipped: ['Veg Momo', 'Thukpa'] })).toBe(
      '"Chicken Momo" was listed more than once with the same details and imported once. '
      + '"Veg Momo", "Thukpa" were listed more than once with different details and not imported — keep one block per dish in the sheet and import it again.')
    expect(sheetDuplicateNote({ merged: [], skipped: [] })).toBe('')
    expect(sheetDuplicateNote()).toBe('')
  })
})

// The importer issues a Product Code for every dish, from the one generator (RECIPES-9).
describe('RecipeImportButton source', () => {
  const src = fs.readFileSync(path.join(__dirname, 'RecipeImportButton.jsx'), 'utf8')
  it('writes recipe_code through nextProductCode and marks sheet duplicates before the preview', () => {
    expect(src).toMatch(/recipe_code: nextProductCode\(productCodePrefix\(category\), codesInUse\)/)
    expect(src).toMatch(/markSheetDuplicates\(parsed\)/)
  })
})
