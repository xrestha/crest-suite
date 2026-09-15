import {
  exFromIncl, inclFromEx, effectiveRule, ruleText, countAllowed, optionsPriceDelta, signedPrice,
  describeSelection, groupsForDish, defaultSelection, selectionProblems, lowestDishPrice,
  sizeFactor, scaledDelta, scaledQty,
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

// S760: the twin of pos_selection_portion_factor and the scaled pricers. The numbers are the ones
// migration 20260920100000 asserts, so the browser and both SQL pricers are pinned to one example.
describe("size scaling (S760)", () => {
  const groups = [
    { id: "g-size", name: "Size", kind: "size", min_select: 1, max_select: 1, included_count: 0, size_scaling: "none", sort: 0, is_active: true },
    { id: "g-top", name: "Toppings", kind: "addon", min_select: 0, max_select: null, included_count: 1, size_scaling: "stock_and_price", sort: 1, is_active: true },
    { id: "g-sauce", name: "Sauces", kind: "addon", min_select: 0, max_select: 2, included_count: 0, size_scaling: "stock", sort: 2, is_active: true },
  ]
  const options = [
    { id: "small", group_id: "g-size", name: "Small", price_delta: -50, portion_factor: 0.75, sort: 0, is_active: true },
    { id: "medium", group_id: "g-size", name: "Medium", price_delta: 0, portion_factor: null, sort: 1, is_active: true },
    { id: "large", group_id: "g-size", name: "Large", price_delta: 150, portion_factor: 1.5, sort: 2, is_active: true },
    { id: "egg", group_id: "g-top", name: "Add egg", price_delta: 40, sort: 0, is_active: true },
    { id: "cheese", group_id: "g-top", name: "Extra cheese", price_delta: 50, sort: 1, is_active: true },
    { id: "honey", group_id: "g-sauce", name: "Honey", price_delta: 20, sort: 0, is_active: true },
  ]
  const attachments = [
    { recipe_id: "bowl", group_id: "g-size", sort: 0 },
    { recipe_id: "bowl", group_id: "g-top", sort: 1 },
    { recipe_id: "bowl", group_id: "g-sauce", sort: 2 },
  ]
  const optionsById = Object.fromEntries(options.map(o => [o.id, o]))
  const groupsById = Object.fromEntries(groups.map(g => [g.id, g]))
  const maps = { optionsById, groupsById, attachByGroup: Object.fromEntries(attachments.map(a => [a.group_id, a])) }

  it("takes the factor from the chosen size only", () => {
    expect(sizeFactor([optionsById.large, optionsById.egg], groupsById)).toBe(1.5)
    expect(sizeFactor([optionsById.egg], groupsById)).toBe(1)
    expect(sizeFactor([optionsById.medium], groupsById)).toBe(1)
    expect(sizeFactor([], groupsById)).toBe(1)
  })

  it("prices Large like the server: +150, egg free, cheese 75, honey 20 (stock only) = 245", () => {
    const d = describeSelection(["cheese", "large", "egg", "honey"], maps)
    expect(d.delta).toBe(245)
    expect(d.portion_factor).toBe(1.5)
    expect(d.options.find(o => o.option_id === "cheese").price_delta).toBe(75)
    expect(d.options.find(o => o.option_id === "egg").price_delta).toBe(0)
    expect(d.options.find(o => o.option_id === "egg").list_price_delta).toBe(60)
    expect(d.options.find(o => o.option_id === "honey").price_delta).toBe(20)
    expect(optionsPriceDelta(["cheese", "large", "egg", "honey"].map(id => optionsById[id]), groupsById)).toBe(245)
  })

  it("scales Small down: -50 + cheese 37.50 = -12.50", () => {
    expect(describeSelection(["small", "egg", "cheese"], maps).delta).toBe(-12.5)
  })

  it("scales stock only where the group says so", () => {
    expect(scaledQty(30, groupsById["g-top"], 1.5)).toBe(45)
    expect(scaledQty(10, groupsById["g-sauce"], 1.5)).toBe(15)
    expect(scaledQty(10, groupsById["g-size"], 1.5)).toBe(10)
    expect(scaledDelta(optionsById.honey, groupsById["g-sauce"], 1.5)).toBe(20)
  })

  it("rounds a half paisa away from zero, as Postgres does", () => {
    expect(scaledDelta({ price_delta: -0.05 }, { size_scaling: "stock_and_price" }, 0.5)).toBe(-0.03)
    expect(scaledDelta({ price_delta: 0.05 }, { size_scaling: "stock_and_price" }, 0.5)).toBe(0.03)
  })

  it("\"From\" tries every size, since a size can reprice a required pick", () => {
    const req = { ...groups[1], id: "g-req", min_select: 1, included_count: 0 }
    const reqOpts = [{ id: "puree", group_id: "g-req", name: "Puree", price_delta: 100, sort: 0, is_active: true }]
    const dg = groupsForDish("bowl", {
      groups: [groups[0], req],
      options: [...options.slice(0, 3), ...reqOpts],
      attachments: [attachments[0], { recipe_id: "bowl", group_id: "g-req", sort: 1 }],
    })
    // Small: 250 - 50 + 75 = 275 ; Medium: 250 + 100 = 350 ; Large: 250 + 150 + 150 = 550
    expect(lowestDishPrice(250, dg)).toBe(275)
  })
})
