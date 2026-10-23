import {
  exFromIncl, inclFromEx, effectiveRule, ruleText, countAllowed, optionsPriceDelta, signedPrice,
  describeSelection, groupsForDish, defaultSelection, selectionProblems, lowestDishPrice,
  sizeFactor, scaledDelta, scaledQty, cheapestValidSelection, dishesBelowZero, belowZeroText, groupShortfalls,
  belowZeroLine, sizeEffect,
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
  it('lets a "No …" removal answer the minimum but not use a place under the maximum (S809 4h, D15)', () => {
    // No onion + cheese + egg + bacon in "up to 3": four picks, three of them real.
    expect(countAllowed(4, { min: 0, max: 3 }, 3)).toBe(true)
    expect(countAllowed(4, { min: 0, max: 3 }, 4)).toBe(false)
    // "No sauce" alone answers "pick exactly 1".
    expect(countAllowed(1, { min: 1, max: 1 }, 0)).toBe(true)
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

  it('never spends a free pick on a "No …" removal, even listed first (S809 4h, Q20 a)', () => {
    // Extras, first 2 free: No onion (listed first), Extra cheese +50, Add egg +40 — cheese and egg free.
    const chosen = [{ id: 'no-onion', group_id: 'toppings', sort: 0, price_delta: 0, is_removal: true, name: 'No onion' },
      t('cheese', 1, 50), t('egg', 2, 40)]
    expect(optionsPriceDelta(chosen, groups)).toBe(0)
  })
})

describe('the name order is the server’s, whatever the browser language (S862 PRICING-1)', () => {
  const toppings = { tops: { included_count: 1 } }
  // A browser set to Nepali or Hindi: localeCompare puts Devanagari before Latin there.
  const devanagariFirst = function (other) {
    const dev = s => /[ऀ-ॿ]/.test(s)
    const a = String(this), b = String(other)
    if (dev(a) !== dev(b)) return dev(a) ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  }

  it('frees the Latin name beside a Devanagari one at the same place, as ICU en-US does on the server', () => {
    const cheese = { id: 'z-cheese', group_id: 'tops', name: 'Cheese', price_delta: 40, sort: 2 }
    const egg = { id: 'a-egg', group_id: 'tops', name: 'अण्डा', price_delta: 50, sort: 2 }
    const spy = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(devanagariFirst)
    try {
      // The server frees Cheese and charges the egg: 50. The old sort, in this browser, charged 40.
      expect(optionsPriceDelta([egg, cheese], toppings)).toBe(50)
      const sel = describeSelection(['a-egg', 'z-cheese'], {
        optionsById: { 'a-egg': egg, 'z-cheese': cheese }, groupsById: { tops: { name: 'Toppings', included_count: 1 } },
      })
      expect(sel.delta).toBe(50)
      expect(sel.summary).toBe('Cheese (incl.) · अण्डा')
    } finally {
      spy.mockRestore()
    }
  })

  it('breaks a tie ICU cannot see by the stored characters, as Postgres breaks it by bytes', () => {
    // "Café crumble" typed with é and pasted as e + a combining accent compare equal in every
    // locale; Postgres orders the e + accent one first (bytes 65 cc 81 before c3 a9) and frees it.
    const composed = { id: 'a', group_id: 'tops', name: 'Café crumble', price_delta: 50, sort: 0 }
    const decomposed = { id: 'b', group_id: 'tops', name: 'Café crumble', price_delta: 40, sort: 0 }
    expect(optionsPriceDelta([composed, decomposed], toppings)).toBe(50)
    // A name carrying an invisible zero-width space sorts after the plain one, as its bytes do.
    const plain = { id: 'b', group_id: 'tops', name: 'Cheese', price_delta: 30, sort: 0 }
    const zwsp = { id: 'a', group_id: 'tops', name: 'Che​ese', price_delta: 20, sort: 0 }
    expect(optionsPriceDelta([zwsp, plain], toppings)).toBe(20)
    // Only then the id: two identical names free the lower id.
    expect(optionsPriceDelta([{ ...plain, id: 'b' }, { ...plain, id: 'a', price_delta: 10 }], toppings)).toBe(30)
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

  // S809 4h (CUSTOMIZATION-4): floating point put these a paisa under the server's exact numeric.
  it("matches the server to the paisa where floating point fell a paisa short", () => {
    const g = { size_scaling: "stock_and_price" }
    expect(scaledDelta({ price_delta: 8.85 }, g, 1.5)).toBe(13.28)
    expect(scaledDelta({ price_delta: 17.70 }, g, 0.75)).toBe(13.28)
    expect(scaledDelta({ price_delta: 46.90 }, g, 0.75)).toBe(35.18)
    expect(scaledDelta({ price_delta: -46.90 }, g, 0.75)).toBe(-35.18)
  })

  it("agrees with exact decimal arithmetic on every price from 0.01 to 500 at the usual factors", () => {
    // The server: round(price_delta(12,2) × factor(6 places), 2), half away from zero — exact, so
    // worked here in BigInt paisa × millionths.
    const exact = (paisa, micro) => {
      const prod = BigInt(paisa) * BigInt(micro)
      const q = prod / 1000000n, r = prod % 1000000n
      return Number(q + (r * 2n >= 1000000n ? 1n : 0n)) / 100
    }
    const g = { size_scaling: "stock_and_price" }
    const misses = []
    for (const f of [0.5, 0.75, 1.25, 1.5, 2, 0.333, 1.125]) {
      const micro = Math.round(f * 1e6)
      for (let paisa = 1; paisa <= 50000; paisa++) {
        const got = scaledDelta({ price_delta: paisa / 100 }, g, f)
        const want = exact(paisa, micro)
        if (got !== want) misses.push({ paisa, f, got, want })
        if (misses.length > 5) break
      }
    }
    expect(misses).toEqual([])
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
      // S809 4h: some are "No …" removals (free, and outside the free picks and the maximum).
      for (let i = 0; i < n; i++) {
        const removal = rand() < 0.2
        options.push({ id: `${id}-o${i}`, group_id: id, name: pick(['Apple', 'Banana', 'Cherry', 'Date']) + i, price_delta: removal ? 0 : pick(PRICES), sort: int(0, 2), is_removal: removal })
      }
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
        if (countAllowed(set.length, rule, set.filter(o => !o.is_removal).length)) out.push(set)
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

describe('"No …" removals, free picks and the maximum (S809 4h, Q20 a, D15)', () => {
  const groups = [{ id: 'extras', name: 'Extras', kind: 'addon', min_select: 0, max_select: 2, included_count: 2, sort: 0, is_active: true }]
  const options = [
    { id: 'no-onion', group_id: 'extras', name: 'No onion', price_delta: 0, is_removal: true, sort: 0, is_active: true, is_default: true },
    { id: 'cheese', group_id: 'extras', name: 'Extra cheese', price_delta: 50, sort: 1, is_active: true, is_default: true },
    { id: 'egg', group_id: 'extras', name: 'Add egg', price_delta: 40, sort: 2, is_active: true, is_default: true },
  ]
  const attachments = [{ recipe_id: 'dish', group_id: 'extras', sort: 0 }]
  const dg = groupsForDish('dish', { groups, options, attachments })
  const catalog = {
    optionsById: Object.fromEntries(options.map(o => [o.id, o])),
    groupsById: Object.fromEntries(groups.map(g => [g.id, g])),
  }

  it('frees the cheese and the egg, not the No onion listed above them', () => {
    const d = describeSelection(['no-onion', 'cheese', 'egg'], catalog)
    expect(d.delta).toBe(0)
    expect(d.options.find(o => o.option_id === 'no-onion').included).toBe(false)
    expect(d.options.filter(o => o.included).map(o => o.option_id)).toEqual(['cheese', 'egg'])
  })

  it('lets No onion sit beside the two extras "up to 2" allows', () => {
    expect(selectionProblems(dg, ['no-onion', 'cheese', 'egg'])).toEqual([])
  })

  it('keeps a pre-selected No onion when trimming the defaults to the maximum', () => {
    expect(defaultSelection(dg)).toEqual(['no-onion', 'cheese', 'egg'])
  })

  it('still counts No sauce as the answer to a required group', () => {
    const sauce = groupsForDish('dish', {
      groups: [{ id: 'sauce', name: 'Sauce', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, is_active: true }],
      options: [
        { id: 'none', group_id: 'sauce', name: 'No sauce', price_delta: 0, is_removal: true, sort: 0, is_active: true },
        { id: 'mayo', group_id: 'sauce', name: 'Mayo', price_delta: 0, sort: 1, is_active: true },
      ],
      attachments: [{ recipe_id: 'dish', group_id: 'sauce' }],
    })
    expect(selectionProblems(sauce, ['none'])).toEqual([])
    expect(selectionProblems(sauce, []).map(p => p.count)).toEqual([0])
  })

  it('names the real picks over the maximum', () => {
    const tight = groupsForDish('dish', { groups: [{ ...groups[0], max_select: 1, included_count: 1 }], options, attachments })
    expect(selectionProblems(tight, ['no-onion', 'cheese', 'egg']).map(p => [p.count, p.real])).toEqual([[3, 2]])
  })
})

describe('dishesBelowZero (S809 4h, CUSTOMIZATION-6; whole dish S835)', () => {
  const G = (id, kind, min, max, extra = {}) => ({ id, name: id, kind, min_select: min, max_select: max, included_count: 0, size_scaling: 'none', sort: 0, is_active: true, ...extra })
  const O = (id, group_id, price_delta, extra = {}) => ({ id, group_id, name: id, price_delta, sort: 0, is_active: true, ...extra })
  const on = (recipe_id, ...groupIds) => groupIds.map((group_id, sort) => ({ recipe_id, group_id, sort }))
  const veg = { id: 'veg', name: 'Veg Momo', selling_price: 247.79 }
  const kids = { id: 'kids', name: 'Kids Momo', selling_price: 70.80 }
  const sizes = G('size', 'size', 1, 1)
  const half = O('Half', 'size', -88.50, { sort: 1 })
  const full = O('Full', 'size', 0)

  it('names the dish a cheaper size takes below zero, ex-VAT as the server compares', () => {
    const cat = { groups: [sizes], options: [full, half], attachments: [...on('veg', 'size'), ...on('kids', 'size')] }
    expect(dishesBelowZero([veg, kids], cat).map(x => [x.dish.id, x.price, x.picks])).toEqual([['kids', -17.70, ['Half']]])
  })

  it('passes a dish brought to exactly zero, a hidden option, a hidden group and an unpriced dish', () => {
    const zero = { groups: [sizes], options: [full, O('Tiny', 'size', -70.80)], attachments: on('kids', 'size') }
    expect(dishesBelowZero([kids], zero)).toEqual([])
    expect(dishesBelowZero([kids], { groups: [sizes], options: [full, { ...half, is_active: false }], attachments: on('kids', 'size') })).toEqual([])
    expect(dishesBelowZero([kids], { groups: [{ ...sizes, is_active: false }], options: [full, half], attachments: on('kids', 'size') })).toEqual([])
    expect(dishesBelowZero([{ id: 'new', name: 'New dish', selling_price: 0 }], { groups: [sizes], options: [half], attachments: on('new', 'size') })).toEqual([])
  })

  it('names a dish a choice takes a fraction of a paisa below zero, as the till compares (S862 PRICING-2)', () => {
    // Menu Pricing stores a NPR 80 dish on a VAT outlet as 80 ÷ 1.13 = 70.7965, and a size typed as
    // costing 0 is stored as −70.80. To the paisa that is −0; the till compares the exact −0.0035.
    const kids4 = { ...kids, selling_price: 70.7965, inclPrice: 80 }
    const tiny = O('Tiny', 'size', -70.80)
    const cat = { groups: [sizes], options: [full, tiny], attachments: on('kids', 'size') }
    const found = dishesBelowZero([kids4], cat)
    expect(found.map(x => [x.dish.id, x.picks])).toEqual([['kids', ['Tiny']]])
    expect(belowZeroText(found)).toBe('Kids Momo would cost a few paisa less than nothing with “Tiny”')
    expect(belowZeroLine(found)).toBe('With “Tiny” it would cost a few paisa less than nothing')
    // A paisa dearer lands at +0.0065 and passes.
    const dearer = { ...cat, options: [full, O('Tiny', 'size', -70.79)] }
    expect(dishesBelowZero([kids4], dearer)).toEqual([])
    // `before` compares exactly too: from the dearer size, this change is the one that goes under…
    expect(dishesBelowZero([kids4], cat, { before: dearer }).map(x => x.dish.id)).toEqual(['kids'])
    // …and a rename of a size already a fraction under is not this change's doing.
    expect(dishesBelowZero([kids4], { ...cat, options: [full, { ...tiny, name: 'Tiny plate' }] }, { before: cat })).toEqual([])
    // The guest "From" never reads −0.
    expect(Object.is(lowestDishPrice(70.7965, groupsForDish('kids', cat)), 0)).toBe(true)
    expect(Object.is(lowestDishPrice(70.80, groupsForDish('kids', cat)), 0)).toBe(true)
  })

  it('finds two cheaper choices that only go below zero together, which a per-option check passed', () => {
    // Kids Momo 70.80: Half −50 alone is 20.80, "Less filling" −30 alone is 40.80, both −9.20.
    const less = G('less', 'choice', 0, 1)
    const cat = {
      groups: [sizes, less],
      options: [full, O('Half', 'size', -50, { sort: 1 }), O('Less filling', 'less', -30)],
      attachments: on('kids', 'size', 'less'),
    }
    expect(dishesBelowZero([kids], cat).map(x => [x.price, x.picks])).toEqual([[-9.20, ['Half', 'Less filling']]])
  })

  it('counts negative picks only up to the maximum, and the first free picks in display order cost nothing', () => {
    const cuts = G('cuts', 'addon', 0, 2)
    const opts = [O('a', 'cuts', -30, { sort: 0 }), O('b', 'cuts', -30, { sort: 1 }), O('c', 'cuts', -30, { sort: 2 })]
    // Up to 2 of three −30s: 70.80 − 60 = 10.80, never 70.80 − 90.
    expect(dishesBelowZero([kids], { groups: [cuts], options: opts, attachments: on('kids', 'cuts') })).toEqual([])
    expect(dishesBelowZero([kids], { groups: [{ ...cuts, max_select: 3 }], options: opts, attachments: on('kids', 'cuts') })
      .map(x => x.price)).toEqual([-19.20])
    // First 1 free: the first picked −30 is charged 0, so three picks reach 70.80 − 60.
    expect(dishesBelowZero([kids], { groups: [{ ...cuts, max_select: 3, included_count: 1 }], options: opts, attachments: on('kids', 'cuts') })).toEqual([])
    // A per-dish maximum is the dish's own rule.
    expect(dishesBelowZero([kids], { groups: [{ ...cuts, max_select: 3 }], options: opts,
      attachments: [{ recipe_id: 'kids', group_id: 'cuts', sort: 0, max_override: 2 }] })).toEqual([])
  })

  it('scales a stock-and-price choice by the size picked with it, as the server prices it', () => {
    const big = O('Large', 'size', 0, { sort: 1, portion_factor: 2 })
    const disc = G('disc', 'addon', 0, 1, { size_scaling: 'stock_and_price' })
    const cat = { groups: [sizes, disc], options: [full, big, O('Promo', 'disc', -40)], attachments: on('kids', 'size', 'disc') }
    // Regular: 70.80 − 40 = 30.80. Large scales the −40 to −80: 70.80 − 80 = −9.20.
    expect(dishesBelowZero([kids], cat).map(x => [x.price, x.picks])).toEqual([[-9.20, ['Large', 'Promo']]])
  })

  it('lets a free "No …" removal answer a required group, and names it', () => {
    const sauce = G('sauce', 'choice', 1, 1)
    const opts = [full, O('Half', 'size', -80, { sort: 1 }), O('Mayo', 'sauce', 20, { sort: 1 })]
    const cat = { groups: [sizes, sauce], options: opts, attachments: on('kids', 'size', 'sauce') }
    // A paid sauce is forced: 70.80 − 80 + 20 = 10.80.
    expect(dishesBelowZero([kids], cat)).toEqual([])
    // "No sauce" answers the minimum for nothing, so the Half alone is reachable: −9.20.
    const withNo = { ...cat, options: [...opts, O('No sauce', 'sauce', 0, { is_removal: true })] }
    expect(dishesBelowZero([kids], withNo).map(x => [x.price, x.picks])).toEqual([[-9.20, ['Half', 'No sauce']]])
  })

  it('skips a dish that cannot be ordered at all: the server refuses it before pricing', () => {
    const must = G('must', 'addon', 2, 3)
    expect(dishesBelowZero([kids], { groups: [must], options: [O('only', 'must', -100)], attachments: on('kids', 'must') })).toEqual([])
  })

  it('with `before`, names only a dish the change takes lower', () => {
    const less = G('less', 'choice', 0, 1)
    const base = { groups: [sizes, less], options: [full, O('Half', 'size', -60, { sort: 1 }), O('Less', 'less', -20)], attachments: on('kids', 'size', 'less') }
    // Already at −9.20. Renaming "Less" (no price change) is not this edit's doing.
    const renamed = { ...base, options: [base.options[0], base.options[1], { ...base.options[2], name: 'Less rice' }] }
    expect(dishesBelowZero([kids], renamed, { before: base })).toEqual([])
    // Raising it towards the fix is not refused either; lowering it further is.
    const better = { ...base, options: [base.options[0], base.options[1], O('Less', 'less', -15)] }
    expect(dishesBelowZero([kids], better, { before: base })).toEqual([])
    const worse = { ...base, options: [base.options[0], base.options[1], O('Less', 'less', -25)] }
    expect(dishesBelowZero([kids], worse, { before: base }).map(x => x.price)).toEqual([-14.20])
    // A dish that was fine and is now below zero is named.
    const fine = { ...base, options: [base.options[0], base.options[1], O('Less', 'less', -5)] }
    expect(dishesBelowZero([kids], base, { before: fine }).map(x => x.price)).toEqual([-9.20])
  })

  it('words it as a guest would pay', () => {
    const found = dishesBelowZero([{ ...kids, inclPrice: 80 }], { groups: [sizes], options: [full, half], attachments: on('kids', 'size') })
    expect(belowZeroText(found)).toBe('Kids Momo would cost −NPR 20 with “Half”')
    expect(belowZeroText([...found, ...found, ...found])).toBe('Kids Momo would cost −NPR 20 with “Half”, Kids Momo would cost −NPR 20 with “Half” and 1 more')
    expect(belowZeroText([{ dish: kids, incl: -9.2, picks: ['Half', 'Less', 'No sauce'] }])).toBe('Kids Momo would cost −NPR 9 with “Half”, “Less” and “No sauce”')
    expect(belowZeroLine(found)).toBe('With “Half” it would cost −NPR 20')
    expect(belowZeroLine([{ dish: kids, incl: -9.2, picks: [] }])).toBe('It would cost −NPR 9')
  })
})

describe('sizeEffect: what a new dish price does to its sizes (S809 4h, D16; shared since S862 SETUP-2)', () => {
  const sizes = { id: 'size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, size_scaling: 'none', sort: 0, is_active: true }
  const opt = (id, price_delta, sort) => ({ id, group_id: 'size', name: id, price_delta, sort, is_active: true })
  const cat = { groups: [sizes], options: [opt('Full', 0, 0), opt('Half', -88.50, 1)], attachments: [{ recipe_id: 'kids', group_id: 'size', sort: 0 }] }
  const dish = { id: 'kids', name: 'Kids Momo' }

  it('says what each size costs a guest at the new price, and names a price that goes below zero', () => {
    // 70.80 before VAT: Full NPR 80, Half (70.80 − 88.50) × 1.13 = −NPR 20.
    const low = sizeEffect(dish, { selling_price: 70.80, vat_rate: 0.13 }, cat)
    expect(low.sizesText).toBe('Full NPR 80 · Half −NPR 20')
    expect(belowZeroText(low.below)).toBe('Kids Momo would cost −NPR 20 with “Half”')
    // 300 before VAT on a PAN-bill outlet (no VAT): Full NPR 300, Half NPR 212, nothing below zero.
    expect(sizeEffect(dish, { selling_price: 300, vat_rate: 0 }, cat)).toEqual({ sizesText: 'Full NPR 300 · Half NPR 212', below: [] })
  })

  it('says nothing with no catalog yet, no price or no dish', () => {
    const none = { sizesText: '', below: [] }
    expect(sizeEffect(dish, { selling_price: 70.80, vat_rate: 0.13 }, null)).toEqual(none)
    expect(sizeEffect(dish, null, cat)).toEqual(none)
    expect(sizeEffect({ id: null }, { selling_price: 70.80, vat_rate: 0.13 }, cat)).toEqual(none)
    expect(sizeEffect({ id: 'other', name: 'Other' }, { selling_price: 70.80, vat_rate: 0.13 }, cat)).toEqual(none)
  })

  it('reads a size a fraction under zero as NPR 0 and words the refusal', () => {
    const tiny = { ...cat, options: [opt('Full', 0, 0), opt('Tiny', -70.80, 1)] }
    const eff = sizeEffect(dish, { selling_price: 70.7965, vat_rate: 0.13 }, tiny)
    expect(eff.sizesText).toBe('Full NPR 80 · Tiny NPR 0')
    expect(belowZeroLine(eff.below)).toBe('With “Tiny” it would cost a few paisa less than nothing')
  })
})

describe('groupShortfalls (S809 4h, CUSTOMIZATION-8)', () => {
  const group = { id: 'top', is_active: true, min_select: 2, max_select: 10, included_count: 0 }
  const opts = n => Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, group_id: 'top', is_active: i < n }))
  const attachments = [{ recipe_id: 'bowl', group_id: 'top' }, { recipe_id: 'cup', group_id: 'top', min_override: 1 }]
  it('flags a dish that must pick 2 from a group with 1 left', () => {
    expect(groupShortfalls(group, opts(1), attachments)).toEqual([{ recipe_id: 'bowl', need: 2, offered: 1 }])
  })
  it('is quiet with enough left, with none left (the group drops off) and on a hidden group', () => {
    expect(groupShortfalls(group, opts(2), attachments)).toEqual([])
    expect(groupShortfalls(group, opts(0), attachments)).toEqual([])
    expect(groupShortfalls({ ...group, is_active: false }, opts(1), attachments)).toEqual([])
  })
})

// The S816 fixture, shared with the probe in migration 20261012110000 (S809 4h): the server priced
// these exact plates there, so the till's twin must say the same to the paisa.
describe('the S816 probe fixture (shared with the 4h migration)', () => {
  const groups = [
    { id: 'gs', name: 'S816 probe Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, size_scaling: 'none', sort: 900, is_active: true },
    { id: 'gt', name: 'S816 probe Toppings', kind: 'addon', min_select: 0, max_select: 2, included_count: 1, size_scaling: 'stock_and_price', sort: 901, is_active: true },
  ]
  const options = [
    { id: 'reg', group_id: 'gs', name: 'Regular', price_delta: 0, portion_factor: 1, sort: 0, is_active: true },
    { id: 'large', group_id: 'gs', name: 'Large', price_delta: 8.85, portion_factor: 1.5, sort: 1, is_active: true },
    { id: 'small', group_id: 'gs', name: 'Small', price_delta: -10, portion_factor: 0.75, sort: 2, is_active: true },
    { id: 'half', group_id: 'gs', name: 'Half', price_delta: -88.50, portion_factor: 0.5, sort: 3, is_active: true },
    { id: 'no', group_id: 'gt', name: 'No onion', price_delta: 0, is_removal: true, sort: 0, is_active: true },
    { id: 'egg', group_id: 'gt', name: 'Egg', price_delta: 17.70, sort: 1, is_active: true },
    { id: 'cheese', group_id: 'gt', name: 'Cheese', price_delta: 8.85, sort: 2, is_active: true },
    { id: 'bacon', group_id: 'gt', name: 'Bacon', price_delta: 46.90, sort: 3, is_active: true },
  ]
  const attachments = [{ recipe_id: 'bowl', group_id: 'gs', sort: 0 }, { recipe_id: 'bowl', group_id: 'gt', sort: 1 }]
  const catalog = {
    optionsById: Object.fromEntries(options.map(o => [o.id, o])),
    groupsById: Object.fromEntries(groups.map(g => [g.id, g])),
  }
  const dg = groupsForDish('bowl', { groups, options, attachments })
  const dish = { id: 'bowl', name: 'S816 4h probe bowl', selling_price: 70.80 }

  it('prices the three saved plates as the server did: 8.85, 22.13, 25.18', () => {
    expect(describeSelection(['reg', 'no', 'egg', 'cheese'], catalog).delta).toBe(8.85)
    expect(describeSelection(['large', 'egg', 'cheese'], catalog).delta).toBe(22.13)
    expect(describeSelection(['small', 'egg', 'bacon'], catalog).delta).toBe(25.18)
    expect(selectionProblems(dg, ['reg', 'no', 'egg', 'cheese'])).toEqual([])
  })
  it('refuses three real toppings, and finds the Half below zero', () => {
    expect(selectionProblems(dg, ['reg', 'egg', 'cheese', 'bacon']).map(p => p.group.id)).toEqual(['gt'])
    expect(dishesBelowZero([dish], { groups, options, attachments }).map(x => [x.picks, x.price])).toEqual([[['Half'], -17.70]])
  })
})

// S862 review: an amount a few paisa under zero is never printed as "NPR −0".
describe('belowZeroAmount', () => {
  const { belowZeroAmount } = require('./optionPricing')
  it('prints whole rupees, and words under half a rupee', () => {
    expect(belowZeroAmount(-20.4)).toBe('NPR −20')
    expect(belowZeroAmount(-0.0033)).toBe('a few paisa below NPR 0')
    expect(belowZeroAmount(-0.0033)).not.toMatch(/−0/)
  })
})
