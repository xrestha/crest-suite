import {
  exFromIncl, inclFromEx, effectiveRule, ruleText, countAllowed, optionsPriceDelta, signedPrice,
  describeSelection, groupsForDish, defaultSelection, selectionProblems, lowestDishPrice,
} from './optionPricing'

describe('VAT conversion', () => {
  it('stores what a guest pays as ex-VAT and gives it back', () => {
    expect(exFromIncl(50, 0.13)).toBe(44.25)
    expect(Math.round(inclFromEx(44.25, 0.13))).toBe(50)
    expect(exFromIncl(50, 0)).toBe(50)
  })
  it('keeps a negative (a Half plate is cheaper)', () => {
    expect(exFromIncl(-113, 0.13)).toBe(-100)
  })
})

describe('pick rules', () => {
  const group = { min_select: 0, max_select: 3, included_count: 2 }
  it('uses the dish override where set, the group otherwise', () => {
    expect(effectiveRule(group, null)).toEqual({ min: 0, max: 3, included: 2 })
    expect(effectiveRule(group, { min_override: 1, max_override: null })).toEqual({ min: 1, max: 3, included: 2 })
  })
  it('words the rule', () => {
    expect(ruleText({ min: 1, max: 1 })).toBe('Pick exactly 1')
    expect(ruleText({ min: 0, max: 3, included: 2 })).toBe('Optional · up to 3 · first 2 free')
    expect(ruleText({ min: 0, max: null })).toBe('Optional · pick any number')
    expect(ruleText({ min: 0, max: 1 })).toBe('Optional · pick 1')
    expect(ruleText({ min: 2, max: 4 })).toBe('Pick 2 to 4')
  })
  it('checks a count', () => {
    expect(countAllowed(0, { min: 1, max: 1 })).toBe(false)
    expect(countAllowed(1, { min: 1, max: 1 })).toBe(true)
    expect(countAllowed(9, { min: 0, max: null })).toBe(true)
    expect(countAllowed(4, { min: 0, max: 3 })).toBe(false)
  })
})

describe('optionsPriceDelta', () => {
  const groups = { toppings: { included_count: 2 }, size: { included_count: 0 } }
  const t = (id, sort, price) => ({ id, group_id: 'toppings', sort, price_delta: price, name: id })

  it('adds every price when nothing is included', () => {
    expect(optionsPriceDelta([{ id: 'half', group_id: 'size', price_delta: -100 }], groups)).toBe(-100)
  })

  it('makes the first N in display order free, whatever order they were ticked in', () => {
    const chosen = [t('olive', 3, 30), t('corn', 1, 30), t('onion', 2, 30)]
    expect(optionsPriceDelta(chosen, groups)).toBe(30)
  })

  it('sums across groups independently', () => {
    const chosen = [t('corn', 1, 30), t('onion', 2, 30), t('olive', 3, 40), { id: 'large', group_id: 'size', price_delta: 60 }]
    expect(optionsPriceDelta(chosen, groups)).toBe(100)
  })

  it('is 0 for no selection', () => {
    expect(optionsPriceDelta([], groups)).toBe(0)
    expect(optionsPriceDelta(null, groups)).toBe(0)
  })
})

describe('signedPrice', () => {
  it('reads as a guest sees it', () => {
    expect(signedPrice(50)).toBe('+NPR 50')
    expect(signedPrice(-100)).toBe('−NPR 100')
    expect(signedPrice(0)).toBe('')
  })
})

// The till's twin of save_pos_order_items v5 / pos_price_selection: same order, same free picks,
// same "(incl.)" summary — so the price on the choice window is the price the bill will say.
describe('the menu-side selection helpers (S758 stage 5)', () => {
  const groups = [
    { id: 'g-size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
    { id: 'g-extra', name: 'Extras', kind: 'addon', min_select: 0, max_select: 3, included_count: 1, sort: 1, is_active: true },
    { id: 'g-empty', name: 'Empty', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, sort: 2, is_active: true },
  ]
  const options = [
    { id: 'half', group_id: 'g-size', name: 'Half', price_delta: -100, sort: 0, is_active: true },
    { id: 'full', group_id: 'g-size', name: 'Full', price_delta: 0, sort: 1, is_active: true, is_default: true },
    { id: 'egg', group_id: 'g-extra', name: 'Add egg', price_delta: 40, sort: 0, is_active: true },
    { id: 'cheese', group_id: 'g-extra', name: 'Extra cheese', price_delta: 50, sort: 1, is_active: true },
    { id: 'hidden', group_id: 'g-empty', name: 'Hidden', price_delta: 0, sort: 0, is_active: false },
  ]
  const attachments = [
    { recipe_id: 'momo', group_id: 'g-extra', sort: 1 },
    { recipe_id: 'momo', group_id: 'g-size', sort: 0 },
    { recipe_id: 'momo', group_id: 'g-empty', sort: 2 },
  ]
  const catalog = { groups, options, attachments }
  const dg = groupsForDish('momo', catalog)
  const maps = {
    optionsById: Object.fromEntries(options.map(o => [o.id, o])),
    groupsById: Object.fromEntries(groups.map(g => [g.id, g])),
    attachByGroup: Object.fromEntries(attachments.map(a => [a.group_id, a])),
  }

  it('offers only groups with something to pick, in the dish order', () => {
    expect(dg.map(d => d.group.name)).toEqual(['Size', 'Extras'])
  })

  it('prices and summarises like the server: first extra free, marked (incl.)', () => {
    const d = describeSelection(['cheese', 'half', 'egg'], maps)
    expect(d.delta).toBe(-50)
    expect(d.summary).toBe('Half · Add egg (incl.) · Extra cheese')
    expect(d.options.map(o => o.price_delta)).toEqual([-100, 0, 50])
  })

  it('starts from the pre-selected choice and names a missing required pick', () => {
    expect(defaultSelection(dg)).toEqual(['full'])
    expect(selectionProblems(dg, ['egg']).map(p => p.group.name)).toEqual(['Size'])
    expect(selectionProblems(dg, ['half', 'egg'])).toEqual([])
  })

  it('"From" is the cheapest valid version of the dish', () => {
    expect(lowestDishPrice(250, dg)).toBe(150)
  })
})
