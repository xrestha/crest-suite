import {
  exFromIncl, inclFromEx, effectiveRule, ruleText, countAllowed, optionsPriceDelta, signedPrice,
  describeSelection, groupsForDish, defaultSelection, selectionProblems, lowestDishPrice,
  sizeFactor, scaledDelta, scaledQty, cheapestValidSelection,
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

// S792 RECIPES-4. The pricer frees the first `included_count` picks in DISPLAY order, and the
// cheapest build must be found under that rule — not under "the cheapest picks are the free ones"
// (the old "From" price) nor "take the cheapest picks whatever their order" (the old costing
// build). The reviewer's simulation lived in a scratchpad that no longer exists; it is rebuilt
// here: the search against a brute-force enumeration of every valid selection, over seeded random
// dishes, so a failure reproduces.
describe('the cheapest valid build (S792, RECIPES-4)', () => {
  const dishOf = (groups, options, attachments = null) => groupsForDish('dish', {
    groups: groups.map((g, i) => ({ is_active: true, sort: i, included_count: 0, size_scaling: 'none', ...g })),
    options: options.map(o => ({ is_active: true, ...o })),
    attachments: attachments || groups.map((g, i) => ({ recipe_id: 'dish', group_id: g.id, sort: i })),
  })

  it("the review's first counter-example: toppings pick 3, first 2 free, is From 210 not 230", () => {
    const dg = dishOf(
      [{ id: 'top', name: 'Toppings', kind: 'addon', min_select: 3, max_select: 3, included_count: 2 }],
      [
        { id: 'banana', group_id: 'top', name: 'Banana', price_delta: 30, sort: 0 },
        { id: 'granola', group_id: 'top', name: 'Granola', price_delta: 20, sort: 1 },
        { id: 'honey', group_id: 'top', name: 'Honey', price_delta: 10, sort: 2 },
        { id: 'nutella', group_id: 'top', name: 'Nutella', price_delta: 50, sort: 3 },
      ],
    )
    expect(cheapestValidSelection(dg)).toEqual({ ids: ['banana', 'granola', 'honey'], delta: 10 })
    expect(lowestDishPrice(200, dg)).toBe(210)
  })

  it("the review's second: prices [20, 0, 20, 10, 20], pick 2, first 1 free, costs nothing", () => {
    const dg = dishOf(
      [{ id: 'g', name: 'Sides', kind: 'choice', min_select: 2, max_select: 2, included_count: 1 }],
      [20, 0, 20, 10, 20].map((p, i) => ({ id: `o${i}`, group_id: 'g', name: `Side ${i}`, price_delta: p, sort: i })),
    )
    // The first (20) is free and the second (0) is charged nothing; picking 0 and 10 charges 10.
    expect(cheapestValidSelection(dg)).toEqual({ ids: ['o0', 'o1'], delta: 0 })
  })

  it('leaves an optional choice off unless it lowers the price, and takes a cheaper Half', () => {
    const dg = dishOf(
      [
        { id: 'extra', name: 'Extras', kind: 'addon', min_select: 0, max_select: 3, included_count: 1 },
        { id: 'portion', name: 'Portion', kind: 'choice', min_select: 0, max_select: 1 },
      ],
      [
        { id: 'egg', group_id: 'extra', name: 'Egg', price_delta: 40, sort: 0 },
        { id: 'half', group_id: 'portion', name: 'Half plate', price_delta: -60, sort: 0 },
      ],
    )
    expect(cheapestValidSelection(dg)).toEqual({ ids: ['half'], delta: -60 })
  })

  it('meets a required group with a real choice before a free "No …" removal', () => {
    const dg = dishOf(
      [{ id: 'sauce', name: 'Sauce', kind: 'choice', min_select: 1, max_select: 1 }],
      [
        { id: 'none', group_id: 'sauce', name: 'No sauce', price_delta: 0, is_removal: true, sort: 0 },
        { id: 'mayo', group_id: 'sauce', name: 'Mayo', price_delta: 0, sort: 1 },
      ],
    )
    expect(cheapestValidSelection(dg).ids).toEqual(['mayo'])
  })

  it('prices a fixed size row at that size only', () => {
    const dg = dishOf(
      [
        { id: 'size', name: 'Size', kind: 'size', min_select: 1, max_select: 1 },
        { id: 'base', name: 'Base', kind: 'choice', min_select: 1, max_select: 1, size_scaling: 'stock_and_price' },
      ],
      [
        { id: 's', group_id: 'size', name: 'Small', price_delta: -50, portion_factor: 0.5, sort: 0 },
        { id: 'l', group_id: 'size', name: 'Large', price_delta: 100, portion_factor: 2, sort: 1 },
        { id: 'b1', group_id: 'base', name: 'Rice', price_delta: 40, sort: 0 },
        { id: 'b2', group_id: 'base', name: 'Noodles', price_delta: 30, sort: 1 },
      ],
    )
    expect(cheapestValidSelection(dg)).toEqual({ ids: ['s', 'b2'], delta: -35 })
    expect(cheapestValidSelection(dg, { fixed: { size: ['l'] } })).toEqual({ ids: ['l', 'b2'], delta: 160 })
  })

  // ── brute force ────────────────────────────────────────────────────────────────────────────
  // mulberry32: a tiny seeded generator, so every run draws the same dishes.
  const seeded = seed => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const PRICES = [-50, -20, 0, 0, 5, 10, 12.5, 20, 20, 30, 50, 7.25]
  const FACTORS = [0.5, 0.75, null, 1.25, 1.5, 2]
  const SCALING = ['none', 'stock', 'stock_and_price']

  function randomDish(rand, { maxOptions, groupCount }) {
    const pick = arr => arr[Math.floor(rand() * arr.length)]
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
    const groups = [], options = [], attachments = []
    const withSize = rand() < 0.6
    if (withSize) {
      groups.push({ id: 'size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: rand() < 0.1 ? 1 : 0 })
      const n = int(1, 3)
      for (let i = 0; i < n; i++) options.push({ id: `size-${i}`, group_id: 'size', name: `Size ${i}`, price_delta: pick(PRICES) * 2, portion_factor: pick(FACTORS), sort: int(0, 2) })
      // A dish may make its size optional (min_override 0) — the pricer allows it.
      attachments.push({ recipe_id: 'dish', group_id: 'size', sort: 0, min_override: rand() < 0.15 ? 0 : null })
    }
    for (let g = 0; g < groupCount; g++) {
      const id = `g${g}`
      const n = int(1, maxOptions)
      const min = int(0, Math.min(n, 3))
      const max = rand() < 0.25 ? null : int(Math.max(min, 1), n)
      const included = int(0, max == null ? Math.min(n, 3) : max)
      groups.push({ id, name: `Group ${g}`, kind: pick(['addon', 'choice']), min_select: min, max_select: max, included_count: included, size_scaling: pick(SCALING) })
      // Sort ties on purpose, so display order falls through to the name and the id.
      for (let i = 0; i < n; i++) options.push({ id: `${id}-o${i}`, group_id: id, name: pick(['Apple', 'Banana', 'Cherry', 'Date']) + i, price_delta: pick(PRICES), sort: int(0, 2), is_removal: false })
      attachments.push({ recipe_id: 'dish', group_id: id, sort: g + 1 })
    }
    return dishOf(groups, options, attachments)
  }

  function bruteForce(dg) {
    const groupsById = Object.fromEntries(dg.map(d => [d.group.id, d.group]))
    const perGroup = dg.map(({ rule, options }) => {
      const out = []
      for (let mask = 0; mask < (1 << options.length); mask++) {
        const set = options.filter((_, i) => mask & (1 << i))
        if (countAllowed(set.length, rule)) out.push(set)
      }
      return out
    })
    let best = null
    const walk = (i, acc) => {
      if (i === perGroup.length) {
        const p = optionsPriceDelta(acc, groupsById)
        if (best == null || p < best) best = p
        return
      }
      for (const set of perGroup[i]) walk(i + 1, [...acc, ...set])
    }
    walk(0, [])
    return best
  }

  function check(dg) {
    const got = cheapestValidSelection(dg)
    const chosen = dg.flatMap(d => d.options).filter(o => got.ids.includes(o.id))
    const groupsById = Object.fromEntries(dg.map(d => [d.group.id, d.group]))
    // What it returns is a real, valid order, priced exactly as the till would price it…
    expect(selectionProblems(dg, got.ids)).toEqual([])
    expect(optionsPriceDelta(chosen, groupsById)).toBe(got.delta)
    // …and nothing valid is cheaper.
    return { got: got.delta, want: bruteForce(dg) }
  }

  it('matches brute force on 1,500 random dishes of up to three groups', () => {
    const rand = seeded(792)
    const misses = []
    for (let t = 0; t < 1500; t++) {
      const dg = randomDish(rand, { maxOptions: 4, groupCount: 1 + Math.floor(rand() * 2) })
      const { got, want } = check(dg)
      if (got !== want) misses.push({ t, got, want })
    }
    expect(misses).toEqual([])
  })

  it('matches brute force on 1,500 single groups of up to eight options', () => {
    const rand = seeded(4)
    const misses = []
    for (let t = 0; t < 1500; t++) {
      const dg = randomDish(rand, { maxOptions: 8, groupCount: 1 })
      const { got, want } = check(dg)
      if (got !== want) misses.push({ t, got, want })
    }
    expect(misses).toEqual([])
  })
})
