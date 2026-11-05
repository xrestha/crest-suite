import {
  itemNutrition, calcRecipeNutrition, calcLiveNutrition, buildNutritionPayload, mergeNutritionFill, convertQty,
  needsPieceWeight, isNotFood, confirmAllergensPayload, notFoodPayload, isPartialFigure, blankFiguresNote,
} from './nutrition'

// The guest menu hides a dish from a guest filtering out an allergen when any ingredient was never
// checked (S870), so the check has to see through sub-recipes, survive a diamond, and call a cycle,
// a missing sub-recipe or an empty dish incomplete. _nutrition_rollup in SQL follows the same rules.

// The recipes page joins items without their id, so the fixtures leave it off the joined item too.
const item = (id, nutrition, uom = 'GM') => ({ id, name: id, uom, nutrition })
const joined = it => ({ name: it.name, uom: it.uom, nutrition: it.nutrition })
const checked = (extra = {}) => ({ basis_qty: 100, basis_unit: 'GM', energy_kcal: 100, allergens_checked: true, ...extra })
const line = (it, qty) => ({ item_id: it.id, items: joined(it), qty_per_portion: qty })
const subLine = (sub, qty) => ({ sub_recipe_id: sub.id, qty_per_portion: qty })

describe('itemNutrition', () => {
  test('reports the checked flag and the allergens as keys', () => {
    const r = itemNutrition(item('paneer', checked({ allergens: 'milk' })), 50)
    expect(r.checked).toBe(true)
    expect(r.allergens).toEqual(['milk'])
    expect(r.values.energy_kcal).toBe(50)
  })

  test('a record without the flag, or no record, is not checked', () => {
    expect(itemNutrition(item('rice', { energy_kcal: 360 }), 100).checked).toBe(false)
    expect(itemNutrition(item('salt', null), 1).checked).toBe(false)
  })

  test('legacy free text still rolls up as keys', () => {
    expect(itemNutrition(item('ghee', { energy_kcal: 900, allergens: 'Dairy' }), 10).allergens).toEqual(['milk'])
  })

  test('the KG to GM conversion is unchanged', () => {
    expect(convertQty(0.009, 'KG', 'GM')).toBeCloseTo(9)
  })
})

describe('calcRecipeNutrition allergen check', () => {
  const flour = item('flour', checked({ allergens: 'gluten' }))
  const butter = item('butter', checked({ allergens: 'milk' }))
  const sugar = item('sugar', { energy_kcal: 387 }) // filled, never checked

  test('every item checked: complete, with the allergens in list order', () => {
    const r = calcRecipeNutrition({ id: 'r', recipe_ingredients: [line(butter, 10), line(flour, 50)] }, [])
    expect(r.allergenCheck).toEqual({ total: 2, unchecked: [], broken: false, complete: true })
    expect(r.allergens).toEqual(['gluten', 'milk'])
  })

  test('an unchecked item inside a sub-recipe makes the dish incomplete', () => {
    const dough = { id: 'dough', yield_qty: 1, recipe_ingredients: [line(flour, 100), line(sugar, 5)] }
    const r = calcRecipeNutrition({ id: 'r', recipe_ingredients: [subLine(dough, 1), line(butter, 10)] }, [dough])
    expect(r.allergenCheck.complete).toBe(false)
    expect(r.allergenCheck.unchecked).toEqual([{ id: 'sugar', name: 'sugar' }])
    expect(r.allergenCheck.total).toBe(3)
  })

  test('a diamond counts the shared item once but its nutrition on both paths', () => {
    const base = { id: 'base', yield_qty: 1, recipe_ingredients: [line(flour, 100)] }
    const a = { id: 'a', yield_qty: 1, recipe_ingredients: [subLine(base, 1)] }
    const b = { id: 'b', yield_qty: 1, recipe_ingredients: [subLine(base, 1)] }
    const r = calcRecipeNutrition({ id: 'r', recipe_ingredients: [subLine(a, 1), subLine(b, 1)] }, [base, a, b])
    expect(r.allergenCheck).toEqual({ total: 1, unchecked: [], broken: false, complete: true })
    expect(r.perPortion.energy_kcal).toBeCloseTo(200)
  })

  test('a dish with no ingredients is incomplete', () => {
    expect(calcRecipeNutrition({ id: 'r', recipe_ingredients: [] }, []).allergenCheck.complete).toBe(false)
  })

  test('a missing sub-recipe or a cycle is incomplete', () => {
    const missing = calcRecipeNutrition({ id: 'r', recipe_ingredients: [line(flour, 1), { sub_recipe_id: 'gone', qty_per_portion: 1 }] }, [])
    expect(missing.allergenCheck).toMatchObject({ broken: true, complete: false })

    const loopA = { id: 'la', yield_qty: 1, recipe_ingredients: [line(flour, 1), { sub_recipe_id: 'lb', qty_per_portion: 1 }] }
    const loopB = { id: 'lb', yield_qty: 1, recipe_ingredients: [{ sub_recipe_id: 'la', qty_per_portion: 1 }] }
    const cyc = calcRecipeNutrition({ id: 'r', recipe_ingredients: [subLine(loopA, 1)] }, [loopA, loopB])
    expect(cyc.allergenCheck).toMatchObject({ broken: true, complete: false })
  })

  test('the live edit form runs the same check', () => {
    const r = calcLiveNutrition(
      [{ type: 'item', item_id: 'flour', qty_per_portion: 50 }, { type: 'item', item_id: 'sugar', qty_per_portion: 5 }],
      [flour, sugar], [])
    expect(r.allergenCheck.unchecked).toEqual([{ id: 'sugar', name: 'sugar' }])
  })
})

describe('buildNutritionPayload', () => {
  test('saving a blank form still marks the ingredient checked', () => {
    expect(buildNutritionPayload({ basis_qty: 100, basis_unit: 'GM', allergens: [] }, 'GM'))
      .toEqual({ basis_qty: 100, basis_unit: 'GM', allergens_checked: true })
  })

  test('allergens are stored as keys in list order', () => {
    const p = buildNutritionPayload({ basis_qty: 100, basis_unit: 'gm', energy_kcal: '120', allergens: ['milk', 'gluten'] })
    expect(p).toMatchObject({ basis_unit: 'GM', energy_kcal: 120, allergens: 'gluten, milk', allergens_checked: true })
  })

  test('an unmatched word is kept and leaves the ingredient not checked', () => {
    const p = buildNutritionPayload({ basis_qty: 100, basis_unit: 'GM', allergens: 'milk, kiwi' })
    expect(p).toMatchObject({ allergens: 'milk, kiwi', allergens_checked: false })
  })
})

describe('mergeNutritionFill', () => {
  const fill = { basis_qty: 100, basis_unit: 'GM', energy_kcal: 364, allergens: 'gluten', source: 'USDA' }

  test('a fill on an ingredient nobody checked stays not checked', () => {
    expect(mergeNutritionFill(null, fill)).toMatchObject({ allergens: 'gluten', allergens_checked: false })
  })

  test('a fill keeps the allergens and the checked state already there', () => {
    const existing = { allergens: 'sesame', allergens_checked: true }
    expect(mergeNutritionFill(existing, fill)).toMatchObject({ allergens: 'gluten, sesame', allergens_checked: true, energy_kcal: 364 })
  })

  test('a USDA fill with no allergens leaves none and stays not checked', () => {
    const usda = { basis_qty: 100, basis_unit: 'GM', energy_kcal: 50, allergens: '', source: 'USDA FDC' }
    const out = mergeNutritionFill(undefined, usda)
    expect(out.allergens).toBeUndefined()
    expect(out.allergens_checked).toBe(false)
  })
})

describe('items counted in pieces (S870)', () => {
  // Library figures are per 100 g; an egg stocked by the piece used to count as one gram.
  const perHundred = { basis_qty: 100, basis_unit: 'GM', energy_kcal: 155, allergens_checked: true }

  test('with the weight of one piece, a piece converts to grams', () => {
    const egg = item('eggs', { ...perHundred, grams_per_unit: 50 }, 'PCS')
    const r = itemNutrition(egg, 2)
    expect(r.has).toBe(true)
    expect(r.values.energy_kcal).toBeCloseTo(155)
    expect(needsPieceWeight(egg)).toBe(false)
  })

  test('without it, the item counts as missing data instead of one gram a piece', () => {
    const egg = item('eggs', perHundred, 'PCS')
    expect(needsPieceWeight(egg)).toBe(true)
    expect(itemNutrition(egg, 2)).toMatchObject({ has: false, values: { energy_kcal: 0 } })
    const r = calcRecipeNutrition({ id: 'r', recipe_ingredients: [line(egg, 2)] }, [])
    expect(r.coverage).toEqual({ have: 0, total: 1 })
    expect(r.needsWeight).toEqual([{ id: 'eggs', name: 'eggs' }])
  })

  test('figures entered per piece need no weight, and a mass item is unchanged', () => {
    const bun = item('bun', { basis_qty: 1, basis_unit: 'PCS', energy_kcal: 150 }, 'PCS')
    expect(needsPieceWeight(bun)).toBe(false)
    expect(itemNutrition(bun, 2).values.energy_kcal).toBe(300)
    expect(itemNutrition(item('flour', perHundred, 'KG'), 0.1).values.energy_kcal).toBeCloseTo(155)
  })

  test('a millilitre basis takes the weight box as millilitres', () => {
    const bottle = item('juice', { basis_qty: 100, basis_unit: 'ML', energy_kcal: 45, grams_per_unit: 250 }, 'BTL')
    expect(itemNutrition(bottle, 1).values.energy_kcal).toBeCloseTo(112.5)
  })

  test('the form saves the weight, and a bulk fill keeps it', () => {
    expect(buildNutritionPayload({ basis_qty: 100, basis_unit: 'GM', grams_per_unit: '50', allergens: [] }))
      .toMatchObject({ grams_per_unit: 50 })
    expect(mergeNutritionFill({ grams_per_unit: 50 }, { basis_qty: 100, basis_unit: 'GM', energy_kcal: 155 }))
      .toMatchObject({ grams_per_unit: 50, energy_kcal: 155 })
  })
})

describe('not food and the Check allergens list (S870)', () => {
  test('a not-food item is checked and leaves the nutrition data count alone', () => {
    const cup = item('cup', notFoodPayload(), 'PCS')
    const paneer = item('paneer', { basis_qty: 100, basis_unit: 'GM', energy_kcal: 265, allergens: 'milk', allergens_checked: true })
    const r = calcRecipeNutrition({ id: 'r', recipe_ingredients: [line(paneer, 100), line(cup, 1)] }, [])
    expect(isNotFood(cup.nutrition)).toBe(true)
    expect(r.coverage).toEqual({ have: 1, total: 1 })
    expect(r.allergenCheck.complete).toBe(true)
  })

  test('the form saves not food as just that', () => {
    expect(buildNutritionPayload({ not_food: true, energy_kcal: '10', allergens: ['milk'] }))
      .toEqual({ not_food: true, allergens_checked: true })
  })

  test('confirming keeps the figures and replaces the allergens', () => {
    const existing = { basis_qty: 100, basis_unit: 'GM', energy_kcal: 265, allergens: 'kiwi', not_food: true }
    expect(confirmAllergensPayload(existing, ['milk']))
      .toEqual({ basis_qty: 100, basis_unit: 'GM', energy_kcal: 265, allergens: 'milk', allergens_checked: true })
    expect(confirmAllergensPayload(null, [])).toEqual({ allergens_checked: true })
  })
})

describe('a blank sugar or sodium box (S886)', () => {
  // 350 Nepal foods carry no sugar or sodium. A blank is unknown: the walk names the ingredient,
  // keeps the known part, and the guest menu leaves the figure off (_nutrition_rollup).
  const full = { basis_qty: 100, basis_unit: 'GM', energy_kcal: 100, sugar_g: 2, sodium_mg: 50, allergens_checked: true }
  const kukhura = item('kukhura', { basis_qty: 100, basis_unit: 'GM', energy_kcal: 120, allergens_checked: true })
  const maida = item('maida', full)

  test('an ingredient with figures names the boxes it left blank; a typed 0 is a figure', () => {
    expect(itemNutrition(kukhura, 100).blank).toEqual(['sugar_g', 'sodium_mg'])
    expect(itemNutrition(maida, 100).blank).toEqual([])
    const zero = item('water', { basis_qty: 100, basis_unit: 'ML', energy_kcal: 1, sugar_g: 0, sodium_mg: 0 }, 'ML')
    expect(itemNutrition(zero, 100).blank).toEqual([])
    const sugarOnly = item('jaggery', { basis_qty: 100, basis_unit: 'GM', energy_kcal: 380, sugar_g: 85 })
    expect(itemNutrition(sugarOnly, 10).blank).toEqual(['sodium_mg'])
  })

  test('an item with no figures, no quantity or no piece weight is a coverage gap, not a blank', () => {
    expect(itemNutrition(item('salt', null), 1).blank).toEqual([])
    expect(itemNutrition(kukhura, 0).blank).toEqual([])
    expect(itemNutrition(item('eggs', { basis_qty: 100, basis_unit: 'GM', energy_kcal: 155 }, 'PCS'), 2).blank).toEqual([])
  })

  test('the dish keeps the known part and names the ingredient, through a sub-recipe too', () => {
    const filling = { id: 'filling', yield_qty: 1, recipe_ingredients: [line(kukhura, 50)] }
    const momo = { id: 'momo', recipe_ingredients: [line(maida, 100), subLine(filling, 1)] }
    const r = calcRecipeNutrition(momo, [filling])
    expect(r.perPortion.sugar_g).toBeCloseTo(2)
    expect(r.blankFigures).toEqual({ sugar_g: [{ id: 'kukhura', name: 'kukhura' }], sodium_mg: [{ id: 'kukhura', name: 'kukhura' }] })
    expect(isPartialFigure(r, 'sugar_g')).toBe(true)
    expect(isPartialFigure(r, 'energy_kcal')).toBe(false)
    const plain = calcRecipeNutrition({ id: 'roti', recipe_ingredients: [line(maida, 100)] }, [])
    expect(plain.blankFigures).toEqual({ sugar_g: [], sodium_mg: [] })
    expect(isPartialFigure(plain, 'sugar_g')).toBe(false)
  })

  test('the live edit form names it the same way', () => {
    const r = calcLiveNutrition(
      [{ type: 'item', item_id: 'kukhura', qty_per_portion: 100 }, { type: 'item', item_id: 'maida', qty_per_portion: 50 }],
      [kukhura, maida], [])
    expect(r.blankFigures.sugar_g).toEqual([{ id: 'kukhura', name: 'kukhura' }])
  })

  test('the note names the ingredients once when both boxes are blank on the same ones', () => {
    const r = calcRecipeNutrition({ id: 'momo', recipe_ingredients: [line(kukhura, 50), line(maida, 100)] }, [])
    const note = blankFiguresNote(r)
    expect(note).toMatch(/^No sugar or sodium figure on kukhura\. /)
    expect(note).toMatch(/guest menu leaves them off this dish/)
    expect(blankFiguresNote(r, { subRecipe: true })).toMatch(/every dish that uses this sub-recipe/)
    expect(blankFiguresNote(r, { brief: true })).toBe('No sugar or sodium figure on kukhura.')
    const jaggery = item('jaggery', { basis_qty: 100, basis_unit: 'GM', energy_kcal: 380, sugar_g: 85 })
    const split = calcRecipeNutrition({ id: 'r', recipe_ingredients: [line(kukhura, 50), line(jaggery, 10)] }, [])
    expect(blankFiguresNote(split)).toMatch(/^No sugar figure on kukhura\. No sodium figure on kukhura, jaggery\./)
    expect(blankFiguresNote(calcRecipeNutrition({ id: 'roti', recipe_ingredients: [line(maida, 100)] }, []))).toBeNull()
  })
})
