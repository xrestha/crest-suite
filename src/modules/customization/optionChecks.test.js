import {
  fullPriceBase, priceSeed, priceEntry, optionLossText, stillHiddenText, stillShownText, notDeletedText, hideBelowZero,
  groupEditEffects, groupEditRefusal, shortfallText, sizeGroupsOn, twoSizesText, otherSizesText, templateSizeClashText,
} from './optionChecks'

const VAT = 0.13

// ── SETUP-1, SETUP-5: the option editor's price ──────────────────────────────────────────────────
describe('fullPriceBase', () => {
  it('is the shared dish price to the paisa, not to the rupee', () => {
    expect(fullPriceBase([{ inclPrice: 240 * 1.13 }, { inclPrice: 240 * 1.13 }])).toBe(271.2)
    // 271.20 and 270.80 shared one full-price box when grouped to the rupee.
    expect(fullPriceBase([{ inclPrice: 271.2 }, { inclPrice: 270.8 }])).toBeNull()
    expect(fullPriceBase([])).toBeNull()
  })
})

describe('priceEntry', () => {
  const extraShot = { id: 'o1', price_delta: 60 }
  const large = { id: 'o2', price_delta: 40 }
  const base = 271.2 // Latte and Cappuccino, NPR 240 before VAT

  it('keeps an untouched price exactly as stored (BLOOM CAFE Extra Shot, 60.00 not 60.18)', () => {
    const seed = priceSeed({ option: extraShot, base: null, vat: VAT })
    expect(seed).toBe('68')
    const r = priceEntry({ option: extraShot, seed, price: seed, isRemoval: false, wasRemoval: false, base: null, vat: VAT })
    expect(r.changed).toBe(false)
    expect(r.priceDelta).toBeUndefined()
    expect(r.savedDelta).toBe(60)
    expect(r.deltaIncl).toBeCloseTo(67.8, 6)
  })

  it('writes a typed price through the VAT rate', () => {
    const r = priceEntry({ option: extraShot, seed: '68', price: '70', isRemoval: false, wasRemoval: false, base: null, vat: VAT })
    expect(r.priceDelta).toBe(61.95)
    expect(r.savedDelta).toBe(61.95)
  })

  it('leaves an untouched full-price size alone, and measures a typed one from the exact dish price', () => {
    const seed = priceSeed({ option: large, base, vat: VAT })
    expect(seed).toBe('316') // the label rounds; the stored 40.00 (316.40 to the guest) stays
    expect(priceEntry({ option: large, seed, price: seed, isRemoval: false, wasRemoval: false, base, vat: VAT }).priceDelta).toBeUndefined()
    expect(priceEntry({ option: large, seed, price: '316.4', isRemoval: false, wasRemoval: false, base, vat: VAT }).priceDelta).toBe(40)
    const typed320 = priceEntry({ option: large, seed, price: '320', isRemoval: false, wasRemoval: false, base, vat: VAT })
    expect(typed320.priceDelta).toBe(43.19)
    // Billed as typed: (240 + 43.19) x 1.13 = 320.00, where the rupee base gave 320.20.
    expect(Math.round((240 + typed320.priceDelta) * 1.13 * 100) / 100).toBe(320)
  })

  it('saves a new size left at its seed as the dish price, not the rounded one', () => {
    const seed = priceSeed({ option: null, base, vat: VAT })
    expect(seed).toBe('271')
    const r = priceEntry({ option: null, seed, price: seed, isRemoval: false, wasRemoval: false, base, vat: VAT })
    expect(r.priceDelta).toBe(0)
    expect(r.deltaIncl).toBe(0)
  })

  it('writes a price when “No …” is switched either way', () => {
    expect(priceEntry({ option: extraShot, seed: '68', price: '', isRemoval: true, wasRemoval: false, base: null, vat: VAT }).priceDelta).toBe(0)
    const removal = { id: 'o3', price_delta: 0, is_removal: true }
    const back = priceEntry({ option: removal, seed: '0', price: '0', isRemoval: false, wasRemoval: true, base: null, vat: VAT })
    expect(back.changed).toBe(true)
    expect(back.priceDelta).toBe(0)
  })

  it('treats a new non-size option with a blank box as free', () => {
    const seed = priceSeed({ option: null, base: null, vat: VAT })
    expect(seed).toBe('')
    expect(priceEntry({ option: null, seed, price: '', isRemoval: false, wasRemoval: false, base: null, vat: VAT }).priceDelta).toBe(0)
  })
})

// ── SETUP-3: showing, hiding and tightening ──────────────────────────────────────────────────────
// Kids Momo NPR 80 before VAT; Portion is a Size with Half at −100; Sauce is a required paid pick.
const kids = { id: 'kids', name: 'Kids Momo', selling_price: 80, inclPrice: 90.4 }
const portion = { id: 'g-size', name: 'Portion', kind: 'size', min_select: 1, max_select: 1, included_count: 0, is_active: true, sort: 0 }
const sauce = { id: 'g-sauce', name: 'Sauce', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, is_active: true, sort: 1 }
const options = [
  { id: 'o-half', group_id: 'g-size', name: 'Half', price_delta: -100, is_active: true, sort: 0 },
  { id: 'o-full', group_id: 'g-size', name: 'Full', price_delta: 0, is_active: true, sort: 1 },
  { id: 'o-sauce', group_id: 'g-sauce', name: 'Chilli', price_delta: 30, is_active: true, sort: 0 },
]
const attachments = [
  { id: 'a1', recipe_id: 'kids', group_id: 'g-size', sort: 0 },
  { id: 'a2', recipe_id: 'kids', group_id: 'g-sauce', sort: 1 },
]
const catalog = { groups: [portion, sauce], options, attachments }

describe('hideBelowZero', () => {
  it('refuses hiding the paid group a cheaper size leans on', () => {
    const found = hideBelowZero([kids], catalog, { groupId: 'g-sauce' })
    expect(found).toHaveLength(1)
    expect(stillShownText('Sauce', found)).toBe('“Sauce” is still shown. Without it, Kids Momo would cost −NPR 23 with “Half”, and the till refuses a dish priced below zero. Change the prices with Edit first.')
  })

  it('refuses deleting that group in the same shape, since a delete takes it away as Hide does', () => {
    const found = hideBelowZero([kids], catalog, { groupId: 'g-sauce' })
    expect(notDeletedText('Sauce', found)).toBe('“Sauce” was not deleted. Without it, Kids Momo would cost −NPR 23 with “Half”, and the till refuses a dish priced below zero. Change the prices with Edit first.')
  })

  it('refuses hiding its last option the same way, and lets a harmless hide through', () => {
    expect(hideBelowZero([kids], catalog, { optionId: 'o-sauce' })).toHaveLength(1)
    expect(hideBelowZero([kids], catalog, { optionId: 'o-full' })).toHaveLength(0)
  })
})

describe('groupEditEffects', () => {
  it('refuses ticking Shown on a hidden group that takes a dish below zero', () => {
    const hidden = { ...portion, is_active: false }
    const cat = { ...catalog, groups: [hidden, { ...sauce, is_active: false }] }
    const { belowZero } = groupEditEffects(hidden, { is_active: true }, cat, [kids])
    expect(belowZero).toHaveLength(1)
    expect(groupEditRefusal('Portion', belowZero, { showing: true })).toBe(stillHiddenText('Portion', belowZero))
    expect(stillHiddenText('Portion', belowZero)).toMatch(/^“Portion” is still hidden\. Kids Momo would cost −NPR 23 with “Half”/)
  })

  it('refuses letting a dish skip the paid pick it needs', () => {
    const { belowZero } = groupEditEffects(sauce, { min_select: 0 }, catalog, [kids])
    expect(belowZero).toHaveLength(1)
    expect(groupEditRefusal('Sauce', belowZero)).toMatch(/^With this change, Kids Momo would cost −NPR 23 .*Nothing was saved\./)
  })

  it('names a dish a raised minimum makes unorderable, and only that one', () => {
    const toppings = { id: 'g-top', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true }
    const bowl = { id: 'bowl', name: 'Test Bowl', selling_price: 300, inclPrice: 339 }
    const cat = {
      groups: [toppings],
      options: [{ id: 't1', group_id: 'g-top', name: 'Granola', price_delta: 20, is_active: true }],
      attachments: [{ id: 'a3', recipe_id: 'bowl', group_id: 'g-top', sort: 0 }],
    }
    const { short } = groupEditEffects(toppings, { min_select: 2 }, cat, [bowl])
    expect(short).toEqual([{ recipe_id: 'bowl', need: 2, offered: 1 }])
    expect(shortfallText('Toppings', short, () => 'Test Bowl')).toBe('Test Bowl must pick 2 from “Toppings”, which offers only 1 option. It cannot be ordered on the till or the QR menu until the group has more options or a lower rule.')
    // Already short before the change: not this save's doing.
    const already = { ...cat, groups: [{ ...toppings, min_select: 2 }] }
    expect(groupEditEffects({ ...toppings, min_select: 2 }, { min_select: 3 }, already, [bowl]).short).toEqual([])
  })

  it('prices a kind change with each dish rule cleared, as the database does', () => {
    const extras = { id: 'g-x', name: 'Extras', kind: 'addon', min_select: 1, max_select: null, included_count: 0, is_active: true }
    const cat = {
      groups: [extras],
      options: [{ id: 'x1', group_id: 'g-x', name: 'Egg', price_delta: 20, is_active: true }],
      attachments: [{ id: 'a4', recipe_id: 'bowl', group_id: 'g-x', min_override: 0, sort: 0 }],
    }
    const dishes = [{ id: 'bowl', name: 'Bowl', selling_price: 300 }]
    // The dish keeps its own "may skip" while the kind stays…
    expect(groupEditEffects(extras, { min_select: 2 }, cat, dishes).short).toEqual([])
    // …and loses it when the kind changes.
    expect(groupEditEffects(extras, { kind: 'choice', min_select: 2, max_select: 2 }, cat, dishes).short)
      .toEqual([{ recipe_id: 'bowl', need: 2, offered: 1 }])
  })

  it('checks nothing for a new group', () => {
    expect(groupEditEffects(null, { is_active: true }, catalog, [kids])).toEqual({ belowZero: [], short: [] })
  })
})

describe('optionLossText (moved from the page)', () => {
  const nameOf = () => 'Kids Momo'
  it('says when hiding the last option drops the group', () => {
    expect(optionLossText(options[2], catalog, nameOf)).toBe('Nothing would be left to pick in “Sauce”, so Kids Momo would be ordered without it.')
  })
  it('says nothing for an option that is already hidden', () => {
    expect(optionLossText({ ...options[2], is_active: false }, catalog, nameOf)).toBeNull()
  })
})

// ── SETUP-8: two Size groups on one dish ─────────────────────────────────────────────────────────
describe('two size groups', () => {
  const cup = { id: 'g-cup', name: 'Cup size', kind: 'size' }
  const size = { id: 'g-s', name: 'Size', kind: 'size' }
  const milk = { id: 'g-m', name: 'Milk', kind: 'addon' }
  const groups = [cup, size, milk]
  const att = [
    { recipe_id: 'latte', group_id: 'g-cup' },
    { recipe_id: 'latte', group_id: 'g-m' },
    { recipe_id: 'americano', group_id: 'g-s' },
  ]

  it('lists the Size groups a dish carries', () => {
    expect(sizeGroupsOn('latte', att, groups).map(g => g.name)).toEqual(['Cup size'])
    expect(sizeGroupsOn('tea', att, groups)).toEqual([])
  })

  it('says when one dish would offer two', () => {
    expect(twoSizesText('Latte', ['Cup size'])).toBeNull()
    expect(twoSizesText('Latte', ['Cup size', 'Size'])).toBe('Latte would offer more than one size group, “Cup size” and “Size”. The till asks for a size from each and multiplies both portions, so keep one size group per dish.')
  })

  it('names the dishes a Size group would land beside another one', () => {
    const dishes = [{ id: 'latte', name: 'Latte' }, { id: 'americano', name: 'Americano' }]
    expect(otherSizesText(size, dishes, att, groups)).toBe('Latte already offers another size group (“Cup size”), so the till would ask for two sizes and multiply both portions. Keep one size group per dish.')
    expect(otherSizesText(milk, dishes, att, groups)).toBeNull()
  })

  it('refuses the template on a dish with a size, and says a second run adds groups', () => {
    expect(templateSizeClashText('Test Bowl', [])).toBeNull()
    const text = templateSizeClashText('Test Bowl', ['Test Bowl · Size'])
    expect(text).toMatch(/^Test Bowl already offers a size group, “Test Bowl · Size”\./)
    expect(text).toContain('it does not rename the ones a dish has')
  })
})

it('adds no straight apostrophe to any sentence (they have broken the build)', () => {
  const found = hideBelowZero([kids], catalog, { groupId: 'g-sauce' })
  const texts = [
    stillShownText('X', found), notDeletedText('X', found), stillHiddenText('X', found), groupEditRefusal('X', found),
    shortfallText('X', [{ recipe_id: 'r', need: 2, offered: 1 }]), twoSizesText('D', ['A', 'B']),
    otherSizesText({ id: 'g', kind: 'size' }, [{ id: 'd', name: 'D' }], [{ recipe_id: 'd', group_id: 'h' }], [{ id: 'h', name: 'H', kind: 'size' }]),
    templateSizeClashText('D', ['A']),
  ]
  texts.forEach(t => expect(t).not.toMatch(/'/))
})
