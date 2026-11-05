import {
  parseItemRow, parseItemRows, planItemImport, itemInsertRow, readUnit, itemImportColumns, itemPriceHeader,
  itemPriceBasisText, findCategory, isItemHeaderRow,
} from './itemImportPlan'

// Columns: name, category, unit, price, pack size, pack price, purchase unit, factor, yield.
let n = 1
const r = (cells, text = []) => ({ rowNo: ++n, raw: cells, text })
beforeEach(() => { n = 1 })

describe('parseItemRow: the Add Item form, one row at a time', () => {
  test('upper-cases the name and keeps one price per base unit to six decimals', () => {
    expect(parseItemRow(r(['  chicken  breast ', 'Meats', 'gm', 0.6512345678]))).toMatchObject({
      name: 'CHICKEN BREAST', categoryName: 'Meats', uom: 'GM', rate: 0.651235,
      purchase_unit: null, conversion_factor: 1, yield_pct: 100,
    })
  })

  test('a pack is divided with the form division', () => {
    const p = parseItemRow(r(['OIL', '', 'ML', '', 500, 388.5]))
    expect(p.rate).toBe(0.777)
    expect(p.notes[0]).toMatch(/500 ML for NPR 388.5/)
  })

  test('a price and a pack that agree import; ones that disagree are skipped, not guessed', () => {
    expect(parseItemRow(r(['OIL', '', 'ML', 0.777, 500, 388.5])).rate).toBe(0.777)
    expect(parseItemRow(r(['OIL', '', 'ML', 0.78, 500, 388.5])).rate).toBe(0.78) // within half a percent
    expect(parseItemRow(r(['OIL', '', 'ML', 0.9, 500, 388.5])).reason).toMatch(/do not agree/)
  })

  test('half a pack, no price, a zero price and text in a number column are each refused by name', () => {
    expect(parseItemRow(r(['OIL', '', 'ML', '', 500])).reason).toMatch(/both its size in ML and what it cost/)
    expect(parseItemRow(r(['OIL', '', 'ML'])).reason).toMatch(/^No price/)
    expect(parseItemRow(r(['OIL', '', 'ML', 0])).reason).toMatch(/above zero/)
    expect(parseItemRow(r(['OIL', '', 'ML', '5oo'])).reason).toMatch(/"5oo" is not a number/)
  })

  test('the unit must be one Crest counts in; a few spellings are understood', () => {
    expect(readUnit('Litre')).toBe('LTR')
    expect(readUnit('g')).toBe('GM')
    expect(readUnit('pcs.')).toBe('PCS')
    expect(readUnit('tola')).toBeNull()
    expect(parseItemRow(r(['GOLD LEAF', '', 'tola', 5])).reason).toMatch(/"tola" is not a unit/)
    expect(parseItemRow(r(['SALT', '', '', 5])).reason).toMatch(/^No unit/)
  })

  test('a purchase unit needs its factor and the other way round; both are kept like the form', () => {
    expect(parseItemRow(r(['COKE', '', 'BTL', 45, '', '', 'carton', 24]))).toMatchObject({ purchase_unit: 'CTN', conversion_factor: 24 })
    expect(parseItemRow(r(['COKE', '', 'BTL', 45, '', '', 'CTN'])).reason).toMatch(/needs both the unit you buy in/)
    expect(parseItemRow(r(['COKE', '', 'BTL', 45, '', '', '', 24])).reason).toMatch(/needs both the unit you buy in/)
    expect(parseItemRow(r(['COKE', '', 'BTL', 45, '', '', 'CTN', 0])).reason).toMatch(/above zero/)
  })

  test('yield: blank is 100, a percent cell is read as shown, and 0.7 is not taken as seventy percent', () => {
    expect(parseItemRow(r(['CHICKEN', '', 'KG', 420, '', '', '', '', 70])).yield_pct).toBe(70)
    expect(parseItemRow(r(['CHICKEN', '', 'KG', 420, '', '', '', '', 0.7], ['', '', '', '', '', '', '', '', '70%'])).yield_pct).toBe(70)
    expect(parseItemRow(r(['CHICKEN', '', 'KG', 420, '', '', '', '', 0.7])).reason).toMatch(/type 70, not 0.7/)
    expect(parseItemRow(r(['CHICKEN', '', 'KG', 420, '', '', '', '', 500])).reason).toMatch(/from 1 to 100/)
  })

  test('a row with no name is skipped, and the header row is dropped', () => {
    expect(parseItemRow(r(['', 'Dairy', 'ML', 1])).reason).toBe('No item name.')
    expect(isItemHeaderRow(r(['Item Name *']))).toBe(true)
    expect(isItemHeaderRow(r(['NAME TAG']))).toBe(false)
    const parsed = parseItemRows([r(itemImportColumns('vat')), r([null, null]), r(['MILK', '', 'ML', 0.1])])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('MILK')
  })
})

describe('the price basis is stated for the outlet (D32)', () => {
  test('a PAN-bill outlet types the price paid, VAT included; a VAT outlet the price before VAT', () => {
    expect(itemPriceHeader('pan')).toMatch(/VAT paid included/)
    expect(itemPriceHeader('vat')).toMatch(/before VAT/)
    expect(itemPriceHeader(null)).toBe('Price per Unit (NPR)')
    expect(itemPriceBasisText('pan')).toMatch(/price you actually paid, VAT included/)
    expect(itemPriceBasisText('vat')).toMatch(/before VAT/)
  })
})

describe('planItemImport', () => {
  const book = [
    { name: 'MILK', item_code: 'ITM-004', is_sub_recipe: false, is_active: true },
    { name: 'OLD BUTTER', item_code: 'ITM-009', is_sub_recipe: false, is_active: false },
    { name: 'PIZZA SAUCE', item_code: 'SRC-001', is_sub_recipe: true, is_active: true },
  ]
  const categories = [{ id: 'c1', name: 'Dairy' }, { id: 'c2', name: 'Groceries' }, { id: 'sr', name: 'Sub-Recipes' }]
  const plan = rows => planItemImport(parseItemRows(rows), { book, categories, prefix: 'itm', extraCodes: ['ITM-011'] })

  test('a name already on file, in any capitals, hidden items and sub-recipes included, is skipped', () => {
    const { ready, skipped } = plan([
      r(['milk', 'Dairy', 'ML', 0.1]),
      r(['Old  Butter', 'Dairy', 'GM', 1]),
      r(['pizza sauce', '', 'GM', 1]),
      r(['CHEESE', 'Dairy', 'GM', 1.5]),
    ])
    expect(ready.map(x => x.name)).toEqual(['CHEESE'])
    expect(skipped.map(x => x.reason)).toEqual([
      expect.stringMatching(/already has "MILK"\. Nothing about it was changed/),
      expect.stringMatching(/already has "OLD BUTTER" \(hidden\)/),
      expect.stringMatching(/already a sub-recipe/),
    ])
  })

  test('the same name twice in the file: the second is skipped, naming the first row', () => {
    const { ready, skipped } = plan([r(['CHEESE', '', 'GM', 1.5]), r(['cheese', '', 'GM', 2])])
    expect(ready).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ rowNo: 3, reason: expect.stringMatching(/row 2 already has this item/) })
  })

  test('codes follow the book and this visit, one per ready row', () => {
    const { ready } = plan([r(['CHEESE', '', 'GM', 1.5]), r(['milk', '', 'ML', 1]), r(['CREAM', '', 'ML', 0.4])])
    expect(ready.map(x => x.item_code)).toEqual(['ITM-012', 'ITM-013'])
  })

  test('a category matches in any capitals; a new one is created once however it is spelled', () => {
    const { ready, newCategories } = plan([
      r(['CHEESE', 'dairy', 'GM', 1.5]),
      r(['CUMIN', 'Spices', 'GM', 2]),
      r(['CLOVE', 'SPICES', 'GM', 3]),
      r(['WATER', '', 'BTL', 20]),
    ])
    expect(ready[0]).toMatchObject({ category_id: 'c1', categoryResolved: 'Dairy', newCategory: null })
    expect(ready[1]).toMatchObject({ category_id: null, newCategory: 'Spices' })
    expect(ready[2]).toMatchObject({ newCategory: 'Spices' })
    expect(ready[3]).toMatchObject({ category_id: null, newCategory: null })
    expect(newCategories).toEqual(['Spices'])
  })

  test('nothing is ever filed under Sub-Recipes, in any spelling', () => {
    const { ready, skipped, newCategories } = plan([r(['GRAVY', 'sub-recipes', 'GM', 1]), r(['STOCK', 'Sub-Recipes', 'ML', 1])])
    expect(ready).toEqual([])
    expect(newCategories).toEqual([])
    expect(skipped.every(s => /Sub-Recipes holds only the sub-recipes/.test(s.reason))).toBe(true)
  })

  test('findCategory prefers the exact spelling', () => {
    const cats = [{ id: 'a', name: 'dairy' }, { id: 'b', name: 'Dairy' }]
    expect(findCategory('Dairy', cats).id).toBe('b')
    expect(findCategory('DAIRY', cats).id).toBe('a')
    expect(findCategory('', cats)).toBeNull()
  })
})

describe('itemInsertRow: the form payload, nothing more', () => {
  test('purchase_qty 1, base_unit only with a purchase unit, never per_uom_rate', () => {
    const [ready] = planItemImport(parseItemRows([r(['COKE', '', 'BTL', 45, '', '', 'CTN', 24])]), { prefix: 'ITM' }).ready
    const row = itemInsertRow(ready, 'c9')
    expect(row).toEqual({
      name: 'COKE', category_id: 'c9', uom: 'BTL', purchase_qty: 1, rate: 45, purchase_unit: 'CTN',
      base_unit: 'BTL', conversion_factor: 24, yield_pct: 100, item_code: 'ITM-001',
    })
    expect(row).not.toHaveProperty('per_uom_rate')
    const plain = itemInsertRow({ ...ready, purchase_unit: null, conversion_factor: 1 }, null)
    expect(plain).toMatchObject({ base_unit: null, category_id: null, conversion_factor: 1 })
  })
})
