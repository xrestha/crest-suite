import { offeredPicks, andList, goneChoicesText } from './offeredPicks'

// S809 3o (CUSTOMIZATION-2). An acai bowl offers Size (Regular, Large) and Toppings (Banana,
// Mango); Granola was hidden as sold out, so it is in neither group's offered options.
const dishGroups = [
  { group: { id: 'g-size', name: 'Size' }, options: [{ id: 'o-reg' }, { id: 'o-large' }] },
  { group: { id: 'g-top', name: 'Toppings' }, options: [{ id: 'o-banana' }, { id: 'o-mango' }] },
]

describe('offeredPicks', () => {
  test('keeps the offered picks in order and sets the rest aside', () => {
    expect(offeredPicks(['o-large', 'o-granola', 'o-banana'], dishGroups)).toEqual({
      kept: ['o-large', 'o-banana'], gone: ['o-granola'],
    })
  })

  test('a dish that offers nothing keeps no pick (a hidden or detached last group)', () => {
    expect(offeredPicks(['o-spicy'], [])).toEqual({ kept: [], gone: ['o-spicy'] })
    expect(offeredPicks(['o-spicy'], undefined)).toEqual({ kept: [], gone: ['o-spicy'] })
  })

  test('nothing to drop, and blanks are skipped', () => {
    expect(offeredPicks(['o-reg', '', null], dishGroups)).toEqual({ kept: ['o-reg'], gone: [] })
    expect(offeredPicks(null, dishGroups)).toEqual({ kept: [], gone: [] })
  })
})

describe('andList', () => {
  test('one, two and three names', () => {
    expect(andList(['Granola'])).toBe('Granola')
    expect(andList(['Granola', 'Banana'])).toBe('Granola and Banana')
    expect(andList(['Granola', 'Banana', 'Mango'])).toBe('Granola, Banana and Mango')
    expect(andList([])).toBe('')
  })
})

describe('goneChoicesText', () => {
  const optionsById = { 'o-granola': { name: 'Granola' } }   // a hidden option is still in the catalog

  test('a hidden choice is named from the catalog', () => {
    expect(goneChoicesText(['o-granola'], optionsById, null)).toBe('Granola')
  })

  test('a deleted choice is named from the line, or counted when nothing names it', () => {
    const lineOptions = [{ option_id: 'o-nuts', option_name: 'Nuts' }]
    expect(goneChoicesText(['o-granola', 'o-nuts'], optionsById, lineOptions)).toBe('Granola and Nuts')
    expect(goneChoicesText(['o-x'], optionsById, null)).toBe('a choice deleted from the menu')
    expect(goneChoicesText(['o-granola', 'o-x', 'o-y'], optionsById, null)).toBe('Granola and 2 choices deleted from the menu')
  })
})
