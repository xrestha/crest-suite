import { suggestAllergens } from './allergenSuggest'

// A guess a person confirms, so the failures that matter are the confident wrong ones: a plant
// milk read as milk, peanut butter read as dairy, a flour that is not wheat read as gluten.

const keysOf = name => suggestAllergens(name).keys

describe('suggestAllergens', () => {
  test('the obvious ones, with the word each came from', () => {
    expect(suggestAllergens('PANEER').reasons).toEqual({ milk: ['paneer'] })
    expect(keysOf('AATA')).toEqual(['gluten'])
    expect(keysOf('MAIDA FLOUR')).toEqual(['gluten'])
    expect(keysOf('BURGER BUN')).toEqual(['gluten'])
    expect(keysOf('PRAWN - TIGER')).toEqual(['crustaceans'])
    expect(keysOf('TIL (SESAME SEED)')).toEqual(['sesame'])
    expect(keysOf('MUSTARD OIL')).toEqual(['mustard'])
    expect(keysOf('EGGS')).toEqual(['eggs'])
  })

  test('a longer phrase wins: plant milks, peanut butter, flours that are not wheat', () => {
    expect(keysOf('OAT MILK')).toEqual(['gluten'])
    expect(keysOf('COCONUT MILK 400ML')).toEqual([])
    expect(keysOf('ALMOND MILK')).toEqual(['tree nuts'])
    expect(keysOf('PEANUT BUTTER')).toEqual(['peanuts'])
    expect(keysOf('CORN FLOUR')).toEqual([])
    expect(keysOf('GRAM FLOUR (BESAN)')).toEqual([])
    expect(keysOf('NUTMEG POWDER')).toEqual([])
  })

  test('several words add up', () => {
    expect(keysOf('SOY SAUCE')).toEqual(['gluten', 'soy'])
    expect(keysOf('EGG NOODLES')).toEqual(['gluten', 'eggs'])
    expect(keysOf('CHEESE & ALMOND CROISSANT')).toEqual(['gluten', 'milk', 'tree nuts'])
    expect(keysOf('SHELLFISH MIX')).toEqual(['crustaceans', 'molluscs'])
  })

  test('a mixed or branded product asks for its label', () => {
    expect(suggestAllergens('BBQ SAUCE')).toMatchObject({ keys: [], checkLabel: ['sauce'], notFood: null })
    expect(suggestAllergens('CURRY SPICE MIX').checkLabel).toEqual(['mix'])
    expect(suggestAllergens('BISCOFF JAM').checkLabel).toEqual(['biscoff', 'jam'])
    // The phrase used up "sauce", so soy sauce is a known answer, not a label question.
    expect(suggestAllergens('SOY SAUCE').checkLabel).toEqual([])
  })

  test('packaging is not food, unless a food word is there too', () => {
    expect(suggestAllergens('8 OZ RIPPLE CUP').notFood).toBe('cup')
    expect(suggestAllergens('750 BROWN KRAFT BOWL').notFood).toBe('kraft')
    expect(suggestAllergens('MILK CARTON')).toMatchObject({ keys: ['milk'], notFood: null })
    expect(suggestAllergens('GREEN TEA BAG').notFood).toBeNull()
    // Found in the real item book (S870): a dip cup, cleaning supplies, a service, cling wrap.
    expect(suggestAllergens('GLEN 2 - 50ML DIP CUP W/ LID (BLACK)')).toMatchObject({ notFood: 'cup', checkLabel: [] })
    expect(suggestAllergens('FLOOR MOP').notFood).toBe('mop')
    expect(suggestAllergens('LPG CYLINDER').notFood).toBe('lpg')
    expect(suggestAllergens('FOOD WRAP').notFood).toBe('food wrap')
    expect(suggestAllergens('TORTILLA WRAP')).toMatchObject({ keys: ['gluten'], notFood: null })
    expect(suggestAllergens('RICE PAPER').notFood).toBeNull()
  })

  test('a plain ground spice is not a label question, baking powder is', () => {
    expect(suggestAllergens('CUMIN POWDER').checkLabel).toEqual([])
    expect(suggestAllergens('BAKING POWDER').checkLabel).toEqual(['baking powder'])
  })

  test('instant noodles and a few spellings from the real item book', () => {
    expect(keysOf('WAI WAI QUICK')).toEqual(['gluten'])
    expect(keysOf('NONG SHIM SOON VEGGIE RAMEN')).toEqual(['gluten'])
    expect(keysOf('TIRAMISU CAKE')).toEqual(['gluten', 'milk', 'eggs'])
    expect(keysOf('RASINS')).toEqual(['sulphites'])
  })

  test('nothing to go on', () => {
    expect(suggestAllergens('LETTUCE')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null })
    expect(suggestAllergens('')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null })
  })
})
