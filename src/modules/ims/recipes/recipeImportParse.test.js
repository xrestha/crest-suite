import { parseImportRows } from './recipeImportParse'

// S792 MASTER-5. Two items added in one Item Master visit both got ITM-010, and Recipe Import looks
// an ingredient up by CODE first — through a Map that kept whichever of the two it read last. A line
// typed "ITM-010" then linked the wrong item, and the preview printed the text typed, not the item.

const items = [
  { id: 'i1', name: 'CHICKEN BREAST', item_code: 'ITM-010', uom: 'GM' },
  { id: 'i2', name: 'PANEER', item_code: 'ITM-010', uom: 'GM' },
  { id: 'i3', name: 'ONION', item_code: 'ITM-011', uom: 'GM' },
  { id: 'i4', name: 'SALT', item_code: null, uom: 'GM' },
]
const subs = [{ id: 's1', name: 'Momo Achar', yield_qty: 1000, yield_uom: 'GM' }]

const sheet = (...lines) => [['Chilli Chicken', 'Food', 400, 1, lines[0][0], lines[0][1], 'GM'],
  ...lines.slice(1).map(([ing, qty]) => ['', '', '', '', ing, qty, 'GM'])]

describe('parseImportRows — ingredient resolution', () => {
  test('a code on one item resolves to it, and the line says which item that was', () => {
    const [r] = parseImportRows(sheet(['itm-011', 50]), items, subs, [])
    expect(r.lines[0]).toMatchObject({ matched: true, type: 'item', item_id: 'i3', resolvedName: 'ONION', byCode: true })
    expect(r.willImport).toBe(true)
  })

  test('a code on two items is refused, naming both, and holds the recipe back', () => {
    const [r] = parseImportRows(sheet(['ITM-010', 200], ['ONION', 50]), items, subs, [])
    const line = r.lines[0]
    expect(line.matched).toBe(false)
    expect(line.item_id).toBeNull()
    expect(line.reason).toMatch(/ITM-010/)
    expect(line.reason).toMatch(/CHICKEN BREAST/)
    expect(line.reason).toMatch(/PANEER/)
    expect(r.ambiguousIngredient).toBe('ITM-010')
    expect(r.willImport).toBe(false)
  })

  test('a name still resolves by name, and is not marked as a code lookup', () => {
    const [r] = parseImportRows(sheet(['chicken breast', 200]), items, subs, [])
    expect(r.lines[0]).toMatchObject({ item_id: 'i1', resolvedName: 'CHICKEN BREAST', byCode: false })
  })

  test('sub-recipes resolve by name; unknown text stays unmatched', () => {
    const [r] = parseImportRows(sheet(['Momo Achar', 20], ['Unicorn', 5]), items, subs, [])
    expect(r.lines[0]).toMatchObject({ type: 'sub_recipe', sub_recipe_id: 's1', resolvedName: 'Momo Achar' })
    expect(r.lines[1]).toMatchObject({ matched: false, reason: 'no matching item or sub-recipe' })
    expect(r.willImport).toBe(true)   // an unmatched NAME is skipped, as before
  })

  test('the duplicate-ingredient guard still holds a recipe back (S714)', () => {
    const [r] = parseImportRows(sheet(['ONION', 20], ['itm-011', 30]), items, subs, [])
    expect(r.duplicateIngredient).toBe('itm-011')
    expect(r.willImport).toBe(false)
  })
})
