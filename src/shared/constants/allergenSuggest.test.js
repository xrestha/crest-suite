import { suggestAllergens, nearMissText, oneEditApart } from './allergenSuggest'

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
    expect(suggestAllergens('LETTUCE')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null, nearMiss: [] })
    expect(suggestAllergens('')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null, nearMiss: [] })
  })
})

// S877 (owner decision): a misspelt name used to read as "no allergen words found", which Confirm all
// would save as containing none. A word one letter off an allergen word asks for the label instead,
// and never ticks anything.
describe('a near miss asks for the label, never ticks', () => {
  test('ICE CREAN looks like cream: check the label, nothing ticked', () => {
    expect(suggestAllergens('ICE CREAN')).toEqual({
      keys: [], reasons: {}, checkLabel: ['crean'], notFood: null, nearMiss: [{ word: 'crean', like: 'cream' }],
    })
    expect(nearMissText(suggestAllergens('ICE CREAN').nearMiss)).toBe('“crean” looks like “cream”')
  })

  test('each kind of slip: a letter changed, added, removed, or two swapped', () => {
    expect(suggestAllergens('MOZARELLA').nearMiss).toEqual([{ word: 'mozarella', like: 'mozzarella' }])
    expect(suggestAllergens('CHEESEE').nearMiss).toEqual([{ word: 'cheesee', like: 'cheese' }])
    expect(suggestAllergens('SALMAN FILLET').nearMiss).toEqual([{ word: 'salman', like: 'salmon' }])
    expect(suggestAllergens('SQIUD RINGS').nearMiss).toEqual([{ word: 'sqiud', like: 'squid' }])
    // A plural the list does not carry is a near miss too, so it is no longer confirmable as none.
    expect(suggestAllergens('CAKES').checkLabel).toEqual(['cakes'])
  })

  test('a correct name is a match, with no near miss', () => {
    expect(suggestAllergens('ICE CREAM')).toMatchObject({ keys: ['milk'], checkLabel: [], nearMiss: [] })
    expect(suggestAllergens('PANEER').nearMiss).toEqual([])
  })

  test('a word under 5 letters is never a near miss', () => {
    // MILC is one letter from milk, but a four-letter word has too many neighbours to judge.
    expect(suggestAllergens('MILC')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null, nearMiss: [] })
  })

  test('a near miss never adds an allergen beside the ones that matched', () => {
    expect(suggestAllergens('CHEDDER CHEESE')).toMatchObject({
      keys: ['milk'], reasons: { milk: ['cheese'] }, checkLabel: ['chedder'], nearMiss: [{ word: 'chedder', like: 'cheddar' }],
    })
    expect(keysOf('SALMAN WITH CREAN')).toEqual([])
  })

  test('packaging: a packaging word is never a misspelling, and still reads as not food', () => {
    expect(suggestAllergens('8 OZ RIPPLE CUP')).toMatchObject({ notFood: 'cup', checkLabel: [], nearMiss: [] })
    expect(suggestAllergens('FLOOR MOP')).toMatchObject({ notFood: 'mop', checkLabel: [], nearMiss: [] })
    // A near miss outranks packaging, as an allergen word does ("milk carton"): this may be ice cream.
    expect(suggestAllergens('ICE CREAN CUP')).toMatchObject({ keys: [], notFood: null, checkLabel: ['crean'] })
  })

  test('a word Crest already knows is not a misspelling of another', () => {
    // PASTE is a label word one letter from pasta; BATTER is one from butter.
    expect(suggestAllergens('GINGER GARLIC PASTE')).toMatchObject({ keys: [], checkLabel: ['paste'], nearMiss: [] })
    expect(suggestAllergens('TEMPURA BATTER')).toMatchObject({ keys: [], checkLabel: ['batter'], nearMiss: [] })
    // FRIED is one letter from dried, which names no allergen by itself (only in "dried apricot").
    expect(suggestAllergens('FRIED ONION')).toMatchObject({ keys: [], checkLabel: [], nearMiss: [] })
  })

  test('BITTER GOURD is not milk, and not a label question: bitter is a real word', () => {
    expect(suggestAllergens('BITTER GOURD')).toEqual({ keys: [], reasons: {}, checkLabel: [], notFood: null, nearMiss: [] })
    expect(suggestAllergens('BROAD BEANS').nearMiss).toEqual([])
    expect(suggestAllergens('PIZZA CUTTER').nearMiss).toEqual([])
  })
})

// S887: in English the thing a name is comes last, so a packaging word outranks a label word only
// when it comes after it. "BOWL" in a food name was turning sauces and gravies into Not food, and a
// Not food confirm marks the item checked with no allergens.
describe('a label word after the packaging word asks for the label, never Not food', () => {
  test('found in the real item book: a bowl gravy, a bowl sauce, a bowl marination', () => {
    expect(suggestAllergens('KOREAN RICE BOWL GRAVY')).toMatchObject({ keys: [], notFood: null, checkLabel: ['gravy'] })
    expect(suggestAllergens('BOWL SAUCE')).toMatchObject({ keys: [], notFood: null, checkLabel: ['sauce'] })
    expect(suggestAllergens('BOWL MARINATION')).toMatchObject({ keys: [], notFood: null, checkLabel: ['marination'] })
  })
  test('the other food heads that follow a packaging word', () => {
    for (const [name, word] of [
      ['SALAD BOWL DRESSING', 'dressing'], ['POKE BOWL MARINADE', 'marinade'], ['BOWL GARNISH', 'garnish'],
      ['ACAI BOWL TOPPINGS', 'toppings'], ['ACAI BOWL TOPPING', 'topping'], ['BURRITO BOWL FILLING', 'filling'],
      ['BOWL MIX', 'mix'], ['RICE BOWL MASALA', 'masala'], ['BOX BAKING POWDER', 'baking powder'],
    ]) {
      const s = suggestAllergens(name)
      expect([name, s.notFood, s.checkLabel.includes(word)]).toEqual([name, null, true])
    }
  })
  test('packaging stays Not food when its word comes last, or no label word is there', () => {
    expect(suggestAllergens('DIP CUP')).toMatchObject({ notFood: 'cup', checkLabel: [] })
    expect(suggestAllergens('GLEN 2 - 50ML DIP CUP W/ LID (BLACK)')).toMatchObject({ notFood: 'cup', checkLabel: [] })
    expect(suggestAllergens('750 BROWN KRAFT BOWL')).toMatchObject({ notFood: 'kraft', checkLabel: [] })
    expect(suggestAllergens('CERAMIC BOWL 6 INCH')).toMatchObject({ notFood: 'bowl', checkLabel: [] })
    expect(suggestAllergens('PAPER 750ML SALAD BOX WITH LID')).toMatchObject({ notFood: 'paper', checkLabel: [] })
    // A sauce cup holds sauce: the cup comes last, so it is the cup.
    expect(suggestAllergens('BOWL SAUCE CUP')).toMatchObject({ notFood: 'bowl', checkLabel: [] })
    expect(suggestAllergens('SAUCE CONTAINER 100ML')).toMatchObject({ notFood: 'container', checkLabel: [] })
  })
  test('an allergen word still outranks both', () => {
    expect(suggestAllergens('BOWL CHEESE SAUCE')).toMatchObject({ keys: ['milk'], notFood: null, checkLabel: ['sauce'] })
  })
})

describe('oneEditApart', () => {
  test('one change, one added or removed letter, or one swap of neighbours', () => {
    expect(oneEditApart('crean', 'cream')).toBe(true)
    expect(oneEditApart('buttr', 'butter')).toBe(true)
    expect(oneEditApart('cheesee', 'cheese')).toBe(true)
    expect(oneEditApart('sqiud', 'squid')).toBe(true)
    expect(oneEditApart('cream', 'cream')).toBe(false)
    expect(oneEditApart('creamy', 'crem')).toBe(false)
    expect(oneEditApart('sqidu', 'squid')).toBe(false)
  })
})
