import { lineChoiceTrouble, choiceRefusalText, savedLineGoneNote, sentDishWayOut, customizationSwitchedText } from './choiceRefusal'

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

// S809 4h (owner, Q3 b): the same bowl, saved at 6:55 but not sent when Granola was hidden.
describe('savedLineGoneNote', () => {
  test('names the hidden choice, and only that', () => {
    const line = { option_ids: ['o-large', 'o-granola', 'o-banana'], selection_key: 'o-banana+o-granola+o-large' }
    expect(savedLineGoneNote(line, dishGroups, optionsById)).toBe('Granola is no longer offered.')
  })
  test('two gone read as a list; a deleted one is named from the line', () => {
    const line = { selection_key: 'o-granola+o-hot+o-large', options: [{ option_id: 'o-hot', option_name: 'Extra hot' }] }
    expect(savedLineGoneNote(line, dishGroups, optionsById)).toBe('Granola and Extra hot are no longer offered.')
  })
  test('nothing to say when every pick is still offered, or the line has none', () => {
    expect(savedLineGoneNote({ selection_key: 'o-banana+o-large' }, dishGroups, optionsById)).toBeNull()
    expect(savedLineGoneNote({ recipe_id: 'r-tea' }, undefined, optionsById)).toBeNull()
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
    expect(choiceRefusalText(err)).toBe('Acai Bowl (Size) has too few or too many choices picked, so nothing on this order was saved. Tap Change (or Choices) on that dish, fix the picks, then save again.')
    const two = { hint: 'option_count', message: 'option_count: the choices do not fit what the dish allows (Acai Bowl: Size; Momo (Steam): Spice) — change the choices and save again' }
    expect(choiceRefusalText(two)).toBe('Acai Bowl (Size) and Momo (Steam) (Spice) have too few or too many choices picked, so nothing on this order was saved. Tap Change (or Choices) on each of those dishes, fix the picks, then save again.')
  })

  test('the code in the message alone is enough (a wrapper that dropped the hint)', () => {
    const err = { message: 'option_not_on_menu: an option chosen for Acai Bowl is no longer offered on it — change the choices and save again' }
    expect(choiceRefusalText(err)).toMatch(/^A choice on Acai Bowl/)
  })

  test('option_price_below_zero names the dish (S809 4h)', () => {
    const err = { hint: 'option_price_below_zero', message: 'option_price_below_zero: Kids Momo would cost less than nothing with the choices picked — change the choices, or ask a manager to fix the price in Option Groups' }
    expect(choiceRefusalText(err)).toBe('Kids Momo would cost less than nothing with the choices picked, so nothing on this order was saved. Tap Change on it to pick other choices, or ask a manager to fix the price in Option Groups.')
    const two = { ...err, message: 'option_price_below_zero: Kids Momo, Mini Thali would cost less than nothing with the choices picked — change the choices, or ask a manager to fix the price in Option Groups' }
    expect(choiceRefusalText(two)).toMatch(/^Kids Momo and Mini Thali would cost .* Tap Change on each of them/)
  })

  test('anything else, or a message with no names, falls back (null)', () => {
    expect(choiceRefusalText({ hint: 'order_options_off', message: 'order_options_off: Crest Customization is not switched on' })).toBeNull()
    expect(choiceRefusalText({ hint: 'option_count', message: 'option_count' })).toBeNull()
    expect(choiceRefusalText(null)).toBeNull()
  })
})

// S862 TILL-GUEST-2 (owner CU5 a): the latte the bar made while the till was offline, put back as sent,
// whose Oat Milk the manager hid meanwhile. No Change on it: the way out is the menu, or the dish off.
describe('a dish already made whose choice the menu no longer offers', () => {
  const groups = [
    { group: { id: 'g-size', name: 'Cup size' }, rule: { min: 1, max: 1 }, options: [{ id: 'o-reg' }, { id: 'o-large' }] },
    { group: { id: 'g-milk', name: 'Milk' }, rule: { min: 0, max: 1 }, options: [{ id: 'o-whole' }] },
  ]
  const catalog = { 'o-oat': { name: 'Oat Milk' }, 'o-large': { name: 'Large' } }
  const latte = { name: 'Cafe Latte', option_ids: ['o-large', 'o-oat'], selection_key: 'o-large+o-oat', sent_to_kot: true, sent_qty: 1 }

  test('a hidden choice: turn it back on to bill it as made, or take the dish off', () => {
    const t = lineChoiceTrouble(latte, groups, catalog, { sent: true })
    expect(t).toMatchObject({ gone: ['o-oat'], sent: true })
    expect(t.text).toBe('Oat Milk is hidden in Option Groups. Turn it back on to bill this dish as made, or take the dish off.')
    expect(lineChoiceTrouble(latte, groups, catalog, { sent: true, dish: 'Cafe Latte' }).text)
      .toBe('Oat Milk is hidden in Option Groups. Turn it back on to bill Cafe Latte as made, or take the dish off.')
  })

  test('a deleted choice cannot be turned back on, so only taking it off is offered', () => {
    const line = { ...latte, options: [{ option_id: 'o-oat', option_name: 'Oat Milk' }] }
    expect(lineChoiceTrouble(line, groups, {}, { sent: true }).text)
      .toBe('This dish was made with Oat Milk, and Option Groups no longer has it, so it cannot be billed as made. Take the dish off.')
  })

  test('a group re-ruled since the dish was made', () => {
    const plainMade = { name: 'Cafe Latte', sent_to_kot: true, sent_qty: 1 }
    expect(lineChoiceTrouble(plainMade, groups, catalog, { sent: true }).text)
      .toBe('Cup size was changed in Option Groups after this dish was made, so it cannot be billed as made. Ask a manager to change Cup size back, or take the dish off.')
  })

  test('an unsent line keeps its Change sentence, and a fine sent line has nothing to say', () => {
    expect(lineChoiceTrouble(latte, groups, catalog).text).toBe('No longer offered: Oat Milk. Tap Change to take it off.')
    expect(lineChoiceTrouble({ ...latte, option_ids: ['o-large'], selection_key: 'o-large' }, groups, catalog, { sent: true })).toBeNull()
  })

  test('the refusal sentence gives the same way out for the dish already made', () => {
    const err = { hint: 'option_not_on_menu', message: 'option_not_on_menu: an option chosen for Cafe Latte is no longer offered on it — change the choices and save again' }
    const sentWayOut = dish => (dish === 'Cafe Latte' ? lineChoiceTrouble(latte, groups, catalog, { sent: true, dish }).text : null)
    expect(choiceRefusalText(err, { sentWayOut })).toBe('A choice on Cafe Latte is no longer offered, so nothing on this order was saved. Oat Milk is hidden in Option Groups. Turn it back on to bill Cafe Latte as made, or take the dish off. Then save again.')
    // Another dish named beside it, not yet sent, keeps its Change.
    const two = { ...err, message: 'option_not_on_menu: an option chosen for Acai Bowl, Cafe Latte is no longer offered on it — change the choices and save again' }
    expect(choiceRefusalText(two, { sentWayOut })).toBe('Choices on Acai Bowl and Cafe Latte are no longer offered, so nothing on this order was saved. Oat Milk is hidden in Option Groups. Turn it back on to bill Cafe Latte as made, or take the dish off. Tap Change on Acai Bowl to take its choice off. Then save again.')
    // No dish made: the sentence is as before.
    expect(choiceRefusalText(err, { sentWayOut: () => null })).toMatch(/Tap Change on Cafe Latte to take it off, then save again\.$/)
  })

  test('a count refused on a dish already made', () => {
    const err = { hint: 'option_count', message: 'option_count: the choices do not fit what the dish allows (Cafe Latte: Cup size) — change the choices and save again' }
    const sentWayOut = dish => (dish === 'Cafe Latte' ? sentDishWayOut(dish) : null)
    expect(choiceRefusalText(err, { sentWayOut })).toBe('Cafe Latte (Cup size) has too few or too many choices picked, so nothing on this order was saved. Cafe Latte was already made, so its choices cannot be changed here. Ask a manager to turn its choice back on in Option Groups to bill it as made, or take the dish off. Then save again.')
  })
})

// S862 TILL-GUEST-1: the sentence once the menu is read again after Customization was switched.
describe('customizationSwitchedText', () => {
  test('says which way, and what to do', () => {
    expect(customizationSwitchedText(true)).toBe('Customization was switched on for this outlet after this till opened; the menu has been updated. Check the marked dishes, then save again.')
    expect(customizationSwitchedText(false)).toMatch(/^Customization was switched off for this outlet/)
  })
})
