import {
  exFromIncl, inclFromEx, effectiveRule, ruleText, countAllowed, optionsPriceDelta, signedPrice,
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
