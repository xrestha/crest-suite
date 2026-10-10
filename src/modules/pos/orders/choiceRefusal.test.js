import { lineChoiceTrouble, choiceRefusalText } from './choiceRefusal'

// S809 3o (CUSTOMIZATION-2): the waiter's 6:55 pm acai bowl, after Granola was hidden at 7 pm.
const dishGroups = [
  { group: { id: 'g-size', name: 'Size' }, rule: { min: 1, max: 1 }, options: [{ id: 'o-reg' }, { id: 'o-large' }] },
  { group: { id: 'g-top', name: 'Toppings' }, rule: { min: 0, max: 3 }, options: [{ id: 'o-banana' }, { id: 'o-mango' }] },
]
const optionsById = {
  'o-granola': { name: 'Granola' }, 'o-banana': { name: 'Banana' }, 'o-large': { name: 'Large' },
}

describe('lineChoiceTrouble', () => {
  test('a hidden choice on the line is named, with the way out', () => {
    const line = { option_ids: ['o-large', 'o-granola', 'o-banana'], selection_key: 'o-banana+o-granola+o-large' }
    const t = lineChoiceTrouble(line, dishGroups, optionsById)
    expect(t.gone).toEqual(['o-granola'])
    expect(t.text).toBe('No longer offered: Granola. Tap Change to take it off.')
  })

  test('a line read back from the bill is judged by its selection key', () => {
    const line = { selection_key: 'o-granola+o-large' }
    expect(lineChoiceTrouble(line, dishGroups, optionsById).gone).toEqual(['o-granola'])
  })

  test('a dish with no group left: every pick is gone, named from the line itself', () => {
    const line = { option_ids: ['o-hot'], selection_key: 'o-hot', options: [{ option_id: 'o-hot', option_name: 'Extra hot' }] }
    expect(lineChoiceTrouble(line, undefined, {}).text).toBe('No longer offered: Extra hot. Tap Change to take it off.')
  })

  test('a pick short in a required group (a group re-ruled, or newly put on the dish)', () => {
    expect(lineChoiceTrouble({ option_ids: ['o-banana'], selection_key: 'o-banana' }, dishGroups, optionsById).text)
      .toBe('Choose 1 more from Size. Tap Change to pick.')
    expect(lineChoiceTrouble({}, dishGroups, optionsById).text).toBe('Choose 1 more from Size. Tap Choices to pick.')
  })

  test('too many picks', () => {
    const groups = [{ ...dishGroups[1], rule: { min: 0, max: 1 } }]
    expect(lineChoiceTrouble({ option_ids: ['o-banana', 'o-mango'], selection_key: 'o-banana+o-mango' }, groups, optionsById).text)
      .toBe('Too many picked in Toppings. Tap Change to fix it.')
  })

  test('a line whose picks are all offered and fit is fine, as is a plain dish with no groups', () => {
    expect(lineChoiceTrouble({ option_ids: ['o-reg', 'o-mango'], selection_key: 'o-mango+o-reg' }, dishGroups, optionsById)).toBeNull()
    expect(lineChoiceTrouble({ recipe_id: 'r-tea' }, undefined, optionsById)).toBeNull()
  })
})

describe('choiceRefusalText', () => {
  test('option_not_on_menu names the dish the server named', () => {
    const err = { hint: 'option_not_on_menu', message: 'option_not_on_menu: an option chosen for Acai Bowl is no longer offered on it — change the choices and save again' }
    expect(choiceRefusalText(err)).toBe('A choice on Acai Bowl is no longer offered, so nothing on this order was saved. Tap Change on Acai Bowl to take it off, then save again.')
  })

  test('several dishes', () => {
    const err = { hint: 'option_not_on_menu', message: 'option_not_on_menu: an option chosen for Acai Bowl, Chicken Momo is no longer offered on it — change the choices and save again' }
    expect(choiceRefusalText(err)).toBe('Choices on Acai Bowl and Chicken Momo are no longer offered, so nothing on this order was saved. Tap Change on each of them to take them off, then save again.')
  })

  test('option_count names the dish and the group', () => {
    const err = { hint: 'option_count', message: 'option_count: the choices do not fit what the dish allows (Acai Bowl: Size) — change the choices and save again' }
    expect(choiceRefusalText(err)).toBe('Acai Bowl (Size) has too few or too many choices picked, so nothing on this order was saved. Tap Choices on that dish, fix the picks, then save again.')
    const two = { hint: 'option_count', message: 'option_count: the choices do not fit what the dish allows (Acai Bowl: Size; Momo (Steam): Spice) — change the choices and save again' }
    expect(choiceRefusalText(two)).toBe('Acai Bowl (Size) and Momo (Steam) (Spice) have too few or too many choices picked, so nothing on this order was saved. Tap Choices on each of those dishes, fix the picks, then save again.')
  })

  test('the code in the message alone is enough (a wrapper that dropped the hint)', () => {
    const err = { message: 'option_not_on_menu: an option chosen for Acai Bowl is no longer offered on it — change the choices and save again' }
    expect(choiceRefusalText(err)).toMatch(/^A choice on Acai Bowl/)
  })

  test('anything else, or a message with no names, falls back (null)', () => {
    expect(choiceRefusalText({ hint: 'order_options_off', message: 'order_options_off: Crest Customization is not switched on' })).toBeNull()
    expect(choiceRefusalText({ hint: 'option_count', message: 'option_count' })).toBeNull()
    expect(choiceRefusalText(null)).toBeNull()
  })
})
