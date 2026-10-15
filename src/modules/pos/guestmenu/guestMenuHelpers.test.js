import {
  tidyName, orderCategories, reorderCategoryList, matchesSearch, filterShowText,
  stageFromProgress, laterStage, guestRuleText,
  newRequestKey, orderSignature, cartWithout,
} from './guestMenuHelpers'

describe('sending an order once (S809 3b, GUEST-2)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('makes a v4 key with randomUUID, or from getRandomValues on an older phone, or none at all', () => {
    expect(newRequestKey({ randomUUID: () => '11111111-2222-4333-8444-555555555555' })).toBe('11111111-2222-4333-8444-555555555555')
    const fill = arr => { arr.fill(0xff); return arr }
    expect(newRequestKey({ getRandomValues: fill })).toMatch(UUID)
    expect(newRequestKey({})).toBeNull()
    expect(newRequestKey(null)).toBeNull()
    expect(newRequestKey({ randomUUID: () => { throw new Error('insecure context') } })).toBeNull()
  })

  it('reads the same order the same way, whatever order its lines and choices were added in', () => {
    const a = [{ recipe_id: 'momo', qty: 2, option_ids: ['b', 'a'] }, { recipe_id: 'lassi', qty: 1, option_ids: [] }]
    const b = [{ recipe_id: 'lassi', qty: 1 }, { recipe_id: 'momo', qty: 2, option_ids: ['a', 'b'] }]
    expect(orderSignature(a, ' no onion ', 3)).toBe(orderSignature(b, 'no onion', 3))
  })

  it('reads a changed quantity, dish, choice, note or covers as a different order', () => {
    const base = [{ recipe_id: 'momo', qty: 2, option_ids: ['a'] }]
    const sig = orderSignature(base, '', 2)
    expect(orderSignature([{ ...base[0], qty: 3 }], '', 2)).not.toBe(sig)
    expect(orderSignature([{ ...base[0], option_ids: ['b'] }], '', 2)).not.toBe(sig)
    expect(orderSignature([...base, { recipe_id: 'brownie', qty: 1 }], '', 2)).not.toBe(sig)
    expect(orderSignature(base, 'less spicy', 2)).not.toBe(sig)
    expect(orderSignature(base, '', 4)).not.toBe(sig)
  })

  it('takes an order that landed out of the cart and keeps what was added after it', () => {
    const keyOf = (rid, ids) => (ids.length ? `${rid}#${[...ids].sort().join('+')}` : rid)
    const cart = {
      lassi: { recipe_id: 'lassi', qty: 3, option_ids: [] },
      'momo#a': { recipe_id: 'momo', qty: 1, option_ids: ['a'] },
      brownie: { recipe_id: 'brownie', qty: 1, option_ids: [] },
    }
    const sent = [{ recipe_id: 'lassi', qty: 2, option_ids: [] }, { recipe_id: 'momo', qty: 1, option_ids: ['a'] }, { recipe_id: 'thukpa', qty: 1 }]
    expect(cartWithout(cart, sent, keyOf)).toEqual({
      lassi: { recipe_id: 'lassi', qty: 1, option_ids: [] },
      brownie: { recipe_id: 'brownie', qty: 1, option_ids: [] },
    })
    expect(cart.lassi.qty).toBe(3) // the cart passed in is not changed
    expect(cartWithout({}, sent, keyOf)).toEqual({})
  })
})

describe('tidyName (owner decision S767: all-caps till names read normally on the guest menu)', () => {
  it('title-cases a name typed entirely in capitals', () => {
    expect(tidyName('PANI POORI')).toBe('Pani Poori')
    expect(tidyName('VEG MOMO')).toBe('Veg Momo')
    expect(tidyName("AMOL'S SPECIAL")).toBe("Amol's Special")
    expect(tidyName('COCA-COLA')).toBe('Coca-Cola')
  })

  it('leaves a name with any lowercase letter exactly as typed', () => {
    expect(tidyName('Chicken choila')).toBe('Chicken choila')
    expect(tidyName('iPhone MOMO')).toBe('iPhone MOMO')
  })

  it('keeps a vowel-less abbreviation loud and lowercases joining words after the first', () => {
    expect(tidyName('BBQ WINGS')).toBe('BBQ Wings')
    expect(tidyName('FISH AND CHIPS')).toBe('Fish and Chips')
    expect(tidyName('A PLATE OF MOMO')).toBe('A Plate of Momo')
  })

  it('does not touch names with no Latin capitals or non-strings', () => {
    expect(tidyName('मोमो')).toBe('मोमो')
    expect(tidyName('7 UP')).toBe('7 Up')
    expect(tidyName(null)).toBe(null)
    expect(tidyName('')).toBe('')
  })
})

describe('orderCategories (owner decision S767: sections follow the Recipe Categories list)', () => {
  const NONE = String.fromCharCode(0) + 'none' // the page's no-category sentinel, built as GuestMenu.jsx builds it (a raw NUL here made git read this file as binary)
  it('follows the stored list, case-insensitively', () => {
    expect(orderCategories(['Beverage', 'Food', 'Snack'], ['food', 'Snack', 'Beverage'])).toEqual(['Food', 'Snack', 'Beverage'])
  })

  it('uses the defaults when the client never saved a list', () => {
    expect(orderCategories(['Beverage', 'Food', 'Other', 'Snack'], null, ['Food', 'Beverage', 'Dessert', 'Snack', 'Other']))
      .toEqual(['Food', 'Beverage', 'Snack', 'Other'])
  })

  it('puts unlisted categories after listed ones in their incoming order, and no-category last', () => {
    expect(orderCategories([NONE, 'Beverage', 'Grill', 'Food', 'Curry'], ['Food', 'Beverage'], [], NONE))
      .toEqual(['Food', 'Beverage', 'Grill', 'Curry', NONE])
  })
})

describe('reorderCategoryList', () => {
  it('moves only the categories on the menu and keeps the rest in place', () => {
    expect(reorderCategoryList(['Food', 'Beverage', 'Dessert', 'Snack'], ['Snack', 'Food', 'Beverage']))
      .toEqual(['Snack', 'Food', 'Dessert', 'Beverage'])
  })

  it('appends a menu category the stored list never had', () => {
    expect(reorderCategoryList(['Food', 'Beverage'], ['Grill', 'Beverage', 'Food'])).toEqual(['Grill', 'Beverage', 'Food'])
  })

  it('never writes a category twice', () => {
    expect(reorderCategoryList(['Food', 'food', 'Beverage'], ['Beverage', 'Food'])).toEqual(['Beverage', 'Food'])
  })
})

describe('matchesSearch', () => {
  const momo = { name: 'Chicken Momo', description: 'Steamed dumplings', category: 'Snack' }
  it('matches name, description or category, ignoring case and accents', () => {
    expect(matchesSearch(momo, 'momo')).toBe(true)
    expect(matchesSearch(momo, 'DUMPLING')).toBe(true)
    expect(matchesSearch(momo, 'snack')).toBe(true)
    expect(matchesSearch({ name: 'Crème brûlée' }, 'creme')).toBe(true)
    expect(matchesSearch(momo, 'thukpa')).toBe(false)
    expect(matchesSearch(momo, '  ')).toBe(true)
  })
})

describe('filterShowText (S844: the filter button counts the combos it will show too)', () => {
  it('names dishes and combos in plain words, and says so when nothing is left', () => {
    expect(filterShowText(12, 2)).toBe('Show 12 dishes and 2 combos')
    expect(filterShowText(1, 1)).toBe('Show 1 dish and 1 combo')
    expect(filterShowText(1, 0)).toBe('Show 1 dish')
    expect(filterShowText(0, 3)).toBe('Show 3 combos')
    expect(filterShowText(0, 0)).toBe('No dish matches · Close')
  })
})

describe('the tracker (S767 critique: wrong stage at the start of a second round and after the bill closed)', () => {
  it('ignores kitchen status until staff accept THIS order', () => {
    expect(stageFromProgress({ requestStatus: 'pending', kotStatus: 'ready' })).toBe('placed')
  })

  it('walks the accepted stages', () => {
    expect(stageFromProgress({ requestStatus: 'accepted' })).toBe('confirmed')
    expect(stageFromProgress({ requestStatus: 'accepted', kotStatus: 'new' })).toBe('kot_sent')
    expect(stageFromProgress({ requestStatus: 'accepted', kotStatus: 'in_progress' })).toBe('preparing')
    expect(stageFromProgress({ requestStatus: 'accepted', kotStatus: 'served' })).toBe('ready')
  })

  it('ends when the bill closes, never back at "confirmed"', () => {
    expect(stageFromProgress({ requestStatus: 'accepted', kotStatus: null, orderClosed: true })).toBe('done')
    expect(stageFromProgress({ requestStatus: 'dismissed', orderClosed: true })).toBe('dismissed')
  })

  it('never moves backwards', () => {
    expect(laterStage('ready', 'confirmed')).toBe('ready')
    expect(laterStage('preparing', 'kot_sent')).toBe('preparing')
    expect(laterStage('ready', 'done')).toBe('done')
    expect(laterStage(null, 'placed')).toBe('placed')
  })
})

describe('guestRuleText', () => {
  it('caps a maximum at the number of choices offered', () => {
    expect(guestRuleText({ min: 2, max: 10 }, 3)).toBe('Pick 2 to 3')
    expect(guestRuleText({ min: 0, max: 10 }, 3)).toBe('Pick any')
    expect(guestRuleText({ min: 0, max: 2 }, 5)).toBe('Pick up to 2')
    expect(guestRuleText({ min: 3, max: 10 }, 3)).toBe('Pick 3')
  })

  it('keeps the plain rules', () => {
    expect(guestRuleText({ min: 1, max: 1 }, 4)).toBe('Pick 1')
    expect(guestRuleText({ min: 1, max: null }, 4)).toBe('Pick at least 1')
    expect(guestRuleText({ min: 0, max: null }, 4)).toBe('Pick any')
  })
})
