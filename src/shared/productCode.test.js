import { productCodePrefix, nextProductCode, assignMissingProductCodes } from './productCode'

describe('productCodePrefix', () => {
  test('takes the first three letters of the category, uppercased', () => {
    expect(productCodePrefix('Beverage')).toBe('BEV')
    expect(productCodePrefix('Food')).toBe('FOO')
    expect(productCodePrefix('Dessert')).toBe('DES')
  })

  test('strips punctuation and spaces rather than dragging them into a code', () => {
    expect(productCodePrefix('Veg & Fruits')).toBe('VEG')
    expect(productCodePrefix('Non-Veg')).toBe('NON')
    expect(productCodePrefix('  soups ')).toBe('SOU')
  })

  test('keeps what it has when the category is shorter than three characters', () => {
    expect(productCodePrefix('Ice')).toBe('ICE')
    expect(productCodePrefix('Aa')).toBe('AA')
  })

  test('falls back rather than producing an empty prefix', () => {
    expect(productCodePrefix('')).toBe('GEN')
    expect(productCodePrefix(null)).toBe('GEN')
    expect(productCodePrefix('!!!')).toBe('GEN')
  })
})

describe('nextProductCode', () => {
  test('starts at 001 when nothing is in use', () => {
    expect(nextProductCode('BEV', [])).toBe('BEV-001')
  })

  test('continues from the highest number actually present', () => {
    expect(nextProductCode('BEV', ['BEV-001', 'BEV-007', 'BEV-003'])).toBe('BEV-008')
  })

  test('a deletion leaves a gap instead of reissuing a live code', () => {
    // BEV-002 was deleted; the next code must not be BEV-002 while BEV-003 still exists.
    expect(nextProductCode('BEV', ['BEV-001', 'BEV-003'])).toBe('BEV-004')
  })

  test('ignores other prefixes and unrelated formats', () => {
    expect(nextProductCode('BEV', ['FOO-009', 'SRC-004', 'BEVERAGE-2', 'BEV', 'BEV-01A'])).toBe('BEV-001')
  })

  test('matches case-insensitively so a hand-typed lowercase code still counts', () => {
    expect(nextProductCode('BEV', ['bev-004'])).toBe('BEV-005')
  })

  test('pads past three digits without truncating', () => {
    expect(nextProductCode('BEV', ['BEV-999'])).toBe('BEV-1000')
  })
})

describe('assignMissingProductCodes', () => {
  test('only fills blanks and never renumbers an existing code', () => {
    const out = assignMissingProductCodes([
      { id: 1, name: 'Latte', category: 'Beverage', recipe_code: 'MYOWN-42' },
      { id: 2, name: 'Americano', category: 'Beverage', recipe_code: '' },
    ])
    expect(out).toEqual([{ id: 2, recipe_code: 'BEV-001' }])
  })

  test('continues each prefix past codes already in use', () => {
    const out = assignMissingProductCodes([
      { id: 1, name: 'Latte', category: 'Beverage', recipe_code: 'BEV-005' },
      { id: 2, name: 'Mocha', category: 'Beverage', recipe_code: null },
      { id: 3, name: 'Tea', category: 'Beverage', recipe_code: null },
    ])
    expect(out).toEqual([
      { id: 2, recipe_code: 'BEV-006' },
      { id: 3, recipe_code: 'BEV-007' },
    ])
  })

  test('numbers each category prefix independently', () => {
    const out = assignMissingProductCodes([
      { id: 1, name: 'Momo', category: 'Food' },
      { id: 2, name: 'Cola', category: 'Beverage' },
      { id: 3, name: 'Rice', category: 'Food' },
    ])
    expect(out).toEqual([
      { id: 2, recipe_code: 'BEV-001' },
      { id: 1, recipe_code: 'FOO-001' },
      { id: 3, recipe_code: 'FOO-002' },
    ])
  })

  test('categories sharing a prefix share one sequence, so codes stay unique', () => {
    const out = assignMissingProductCodes([
      { id: 1, name: 'A', category: 'Dessert' },
      { id: 2, name: 'B', category: 'Desserts' },
    ])
    expect(out.map(r => r.recipe_code)).toEqual(['DES-001', 'DES-002'])
    expect(new Set(out.map(r => r.recipe_code)).size).toBe(2)
  })

  test('never issues a duplicate across a whole realistic batch', () => {
    const cats = ['Beverage', 'Food', 'Dessert', 'Veg & Fruits', 'Beverages']
    const recipes = Array.from({ length: 200 }, (_, i) => ({
      id: i, name: `R${i}`, category: cats[i % cats.length],
    }))
    const out = assignMissingProductCodes(recipes)
    expect(out).toHaveLength(200)
    expect(new Set(out.map(r => r.recipe_code)).size).toBe(200)
  })

  test('skips sub-recipes — they own the separate SRC series', () => {
    const out = assignMissingProductCodes([
      { id: 1, name: 'Sauce', category: 'Sub-Recipe' },
      { id: 2, name: 'Momo', category: 'Food' },
    ])
    expect(out).toEqual([{ id: 2, recipe_code: 'FOO-001' }])
  })

  test('is deterministic — a re-run over the same data produces the same codes', () => {
    const recipes = [
      { id: 3, name: 'Zebra', category: 'Food' },
      { id: 1, name: 'Apple', category: 'Food' },
      { id: 2, name: 'Mango', category: 'Food' },
    ]
    expect(assignMissingProductCodes(recipes)).toEqual(assignMissingProductCodes([...recipes].reverse()))
  })

  test('empty input is empty output', () => {
    expect(assignMissingProductCodes([])).toEqual([])
    expect(assignMissingProductCodes(null)).toEqual([])
  })
})
