import {
  nestCombos, comboAddsInOneTap, defaultComboPicks, buildComboLines, comboIdOf, comboGroupOf, groupComboBlocks,
  cartRows, addComboLinesToCart, setComboQtyIn, comboUnitsPulled, swapComboDish, picksOfCombo,
  collapseCombosForMove, expandComboPicks, guestLineOf, guestRequestText, isMissingTable, comboSignature, comboSharesOf,
  swapShareOf, comboAsSold, comboDishLine,
} from './comboCart'
import { lineKeyOf, toItemPayload, lineOptionIds } from './posOrdersConstants'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

// Combos on the till (S839, docs/pos-combos.md).

const recipes = {
  momoV: { id: 'r-momo-v', name: 'Veg Momo', category: 'Food', selling_price: 200, vat_rate: 0.13 },
  momoC: { id: 'r-momo-c', name: 'Chicken Momo', category: 'Food', selling_price: 250, vat_rate: 0.13 },
  coke: { id: 'r-coke', name: 'Coke', category: 'Beverage', selling_price: 100, vat_rate: 0.13 },
  tea: { id: 'r-tea', name: 'Tea', category: 'Beverage', selling_price: 50, vat_rate: null },
}
const byId = Object.fromEntries(Object.values(recipes).map(r => [r.id, r]))
const recipeOf = id => byId[id]

const rows = {
  combos: [{ id: 'c-momo', name: 'Momo Combo', guest_price: '350', description: null, sort: 0 }],
  groups: [
    { id: 'g-drink', combo_id: 'c-momo', name: 'Pick a drink', sort: 1 },
    { id: 'g-momo', combo_id: 'c-momo', name: 'Pick a momo', sort: 0 },
  ],
  items: [
    { id: 'i1', group_id: 'g-momo', recipe_id: 'r-momo-v', extra_price: 0, is_default: true, sort: 0 },
    { id: 'i2', group_id: 'g-momo', recipe_id: 'r-momo-c', extra_price: '50', is_default: false, sort: 1 },
    { id: 'i3', group_id: 'g-drink', recipe_id: 'r-coke', extra_price: 0, is_default: false, sort: 0 },
    { id: 'i4', group_id: 'g-drink', recipe_id: 'r-tea', extra_price: 0, is_default: true, sort: 1 },
  ],
}
const [momoCombo] = nestCombos({ ...rows, recipeOf })
const LINE = '11111111-2222-4333-8444-555555555555'

describe('the combo catalog', () => {
  test('picks and dishes come nested, in order, with numbers as numbers', () => {
    expect(momoCombo.guest_price).toBe(350)
    expect(momoCombo.groups.map(g => g.id)).toEqual(['g-momo', 'g-drink'])
    expect(momoCombo.groups[0].items.map(i => i.recipe_id)).toEqual(['r-momo-v', 'r-momo-c'])
    expect(momoCombo.groups[0].items[1].extra_price).toBe(50)
  })
  test('a dish whose recipe cannot be read is left out, and a pick left empty takes the combo out', () => {
    const noCoke = nestCombos({ ...rows, recipeOf: id => (id === 'r-coke' ? undefined : byId[id]) })
    expect(noCoke[0].groups[1].items.map(i => i.recipe_id)).toEqual(['r-tea'])
    const noDrinks = nestCombos({ ...rows, recipeOf: id => (id === 'r-coke' || id === 'r-tea' ? undefined : byId[id]) })
    expect(noDrinks).toEqual([])
  })
  test('an inactive dish is not offered, but still weighs in its pick\'s share of the price, as the server splits it', () => {
    const inactive = id => (id === 'r-momo-v' ? { ...byId[id], is_active: false } : byId[id])
    const [combo] = nestCombos({ ...rows, recipeOf: inactive })
    expect(combo.groups[0].items.map(i => i.recipe_id)).toEqual(['r-momo-c'])
    expect(combo.groups[0].share_items.map(i => i.recipe_id)).toEqual(['r-momo-v', 'r-momo-c'])
    expect(comboSharesOf(combo, inactive, true)).toEqual(comboSharesOf(momoCombo, recipeOf, true))
  })
  test('the combo tables not deployed yet read as no combos, not a failed menu', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true)
    expect(isMissingTable({ code: 'PGRST205' })).toBe(true)
    expect(isMissingTable({ code: '42501' })).toBe(false)
  })
})

describe('adding a combo', () => {
  const setMeal = { id: 'c-set', name: 'Breakfast Set', guest_price: 300, groups: [
    { id: 'g1', name: 'Main', sort: 0, items: [{ recipe_id: 'r-momo-v', extra_price: 0 }] },
    { id: 'g2', name: 'Drink', sort: 1, items: [{ recipe_id: 'r-tea', extra_price: 0 }] },
  ] }
  test('a set meal whose dishes need no choice adds in one tap; a pick-your-own deal asks', () => {
    expect(comboAddsInOneTap(setMeal, () => false)).toBe(true)
    expect(comboAddsInOneTap(setMeal, id => id === 'r-tea')).toBe(false)
    expect(comboAddsInOneTap(momoCombo, () => false)).toBe(false)
  })
  test('each pick starts on its default dish with that dish\'s default choices', () => {
    expect(defaultComboPicks(momoCombo, id => (id === 'r-momo-v' ? ['o-spicy'] : []))).toEqual([
      { group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: ['o-spicy'] },
      { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] },
    ])
  })

  test('one line per pick, the same quantity on each, keyed and tagged as the server keys them', () => {
    const lines = buildComboLines({
      combo: momoCombo, recipeOf, vatReg: true, qty: 2, lineId: LINE.toUpperCase(),
      picks: [{ group_id: 'g-momo', recipe_id: 'r-momo-c', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-coke', option_ids: [] }],
    })
    expect(lines).toHaveLength(2)
    expect(lines.map(l => l.qty)).toEqual([2, 2])
    expect(lines[0]).toMatchObject({
      recipe_id: 'r-momo-c', combo_line_id: LINE, combo_id: 'c-momo', combo_name: 'Momo Combo', combo_price: 350,
      combo_group_id: 'g-momo', combo_group_name: 'Pick a momo', combo_sort: 0, sent_to_kot: false, sent_qty: 0,
      selection_key: `@${LINE}/g-momo`,
    })
    expect(lineKeyOf(lines[0])).toBe(`r-momo-c#@${LINE}/g-momo`)
    // The payload carries the combo, and no options for a dish with none.
    const payload = toItemPayload(lines[0])
    expect(payload.combo).toMatchObject({ line_id: LINE, combo_id: 'c-momo', group_id: 'g-momo' })
    expect(payload.options).toBeUndefined()
  })

  test('the display price: the share plus the extra, ex-VAT; the dishes add up to the combo price plus extras', () => {
    const lines = buildComboLines({
      combo: momoCombo, recipeOf, vatReg: true, lineId: LINE,
      picks: [{ group_id: 'g-momo', recipe_id: 'r-momo-c', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] }],
    })
    const guest = lines.reduce((s, l) => s + l.unit_price * (1 + l.vat_rate), 0)
    expect(guest).toBeCloseTo(400, 0) // 350 + Chicken's 50
  })

  test('a dish\'s own choices ride in the key before the @, priced on top', () => {
    const describe = (rid, ids) => ({ delta: 30, summary: 'Extra cheese', options: [{ option_id: ids[0], option_name: 'Extra cheese' }] })
    const lines = buildComboLines({
      combo: momoCombo, recipeOf, vatReg: false, lineId: LINE, describe,
      picks: [{ group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: ['o-cheese'] }, { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] }],
    })
    expect(lines[0].selection_key).toBe(`o-cheese@${LINE}/g-momo`)
    expect(lines[0].option_summary).toBe('Extra cheese')
    expect(lines[0].unit_price).toBeCloseTo(lines[0].base_unit_price + 30, 2)
    expect(lineOptionIds(lines[0])).toEqual(['o-cheese'])
    expect(toItemPayload(lines[0]).options).toEqual(['o-cheese'])
  })

  test('a pick with no dish of its own makes nothing', () => {
    expect(buildComboLines({ combo: momoCombo, recipeOf, vatReg: true, lineId: LINE, picks: [{ group_id: 'g-momo', recipe_id: 'r-momo-v' }] })).toBeNull()
  })
})

const comboOf = (lineId, momo = 'r-momo-v', drink = 'r-tea', qty = 1) => buildComboLines({
  combo: momoCombo, recipeOf, vatReg: true, qty, lineId,
  picks: [{ group_id: 'g-momo', recipe_id: momo, option_ids: [] }, { group_id: 'g-drink', recipe_id: drink, option_ids: [] }],
})
const plain = { recipe_id: 'r-coke', name: 'Coke', qty: 1, unit_price: 100, vat_rate: 0.13, sent_to_kot: false, sent_qty: 0 }

describe('a combo on the cart', () => {
  test('an identical combo not sent yet takes more; a different one is its own combo', () => {
    const first = comboOf('aaaa')
    const cart = addComboLinesToCart([plain], first)
    const again = addComboLinesToCart(cart, comboOf('bbbb', 'r-momo-v', 'r-tea', 2))
    expect(again).toHaveLength(3)
    expect(again.filter(i => comboIdOf(i) === 'aaaa').map(i => i.qty)).toEqual([3, 3])
    const other = addComboLinesToCart(cart, comboOf('cccc', 'r-momo-c'))
    expect(other).toHaveLength(5)
  })
  test('a combo already sent is never added to: the new one is its own', () => {
    const sent = comboOf('aaaa').map(l => ({ ...l, sent_to_kot: true, sent_qty: 1 }))
    expect(addComboLinesToCart(sent, comboOf('bbbb'))).toHaveLength(4)
  })
  test('the same picks are the same combo whatever the line id', () => {
    expect(comboSignature(comboOf('aaaa'))).toBe(comboSignature(comboOf('bbbb')))
    expect(comboSignature(comboOf('aaaa'))).not.toBe(comboSignature(comboOf('aaaa', 'r-momo-c')))
  })

  test('the cart lists a combo once, at its first dish, with its dishes in pick order', () => {
    const [momo, tea] = comboOf('aaaa')
    const cart = [tea, plain, momo] // as a server read may return them
    const rowsOut = cartRows(cart)
    expect(rowsOut.map(r => r.kind)).toEqual(['combo', 'line'])
    expect(rowsOut[0].block.dishes.map(d => d.item.name)).toEqual(['Veg Momo', 'Tea'])
    expect(rowsOut[0].block).toMatchObject({ id: 'aaaa', name: 'Momo Combo', qty: 1, firstIdx: 0 })
  })

  test('a dish read with only its key still belongs to its combo and pick', () => {
    const item = { recipe_id: 'r-tea', selection_key: '@AAAA/G-DRINK' }
    expect(comboIdOf(item)).toBe('aaaa')
    expect(comboGroupOf(item)).toBe('g-drink')
    expect(groupComboBlocks([item]).get('aaaa').dishes).toHaveLength(1)
  })

  test('the quantity moves every dish together, and 0 takes the whole combo off', () => {
    const cart = [plain, ...comboOf('aaaa')]
    expect(setComboQtyIn(cart, 'AAAA', 3).filter(i => comboIdOf(i)).map(i => i.qty)).toEqual([3, 3])
    expect(setComboQtyIn(cart, 'aaaa', 0)).toEqual([plain])
  })
  test('cutting a sent combo says how many combos the kitchen already has', () => {
    const cart = comboOf('aaaa', 'r-momo-v', 'r-tea', 3).map(l => ({ ...l, sent_to_kot: true, sent_qty: 3 }))
    expect(comboUnitsPulled(cart, 'aaaa', 1)).toBe(2)
    expect(comboUnitsPulled(cart, 'aaaa', 0)).toBe(3)
    expect(comboUnitsPulled(cart, 'aaaa', 4)).toBe(0)
    // A sent line's count stays at what was sent, as a plain line's does.
    expect(setComboQtyIn(cart, 'aaaa', 1).map(i => i.sent_qty)).toEqual([3, 3])
  })

  test('a swap puts the new dish in the old one\'s place, quantity and note, in the same combo and pick', () => {
    const cart = comboOf('aaaa', 'r-momo-v', 'r-tea', 2).map((l, n) => (n === 0 ? { ...l, notes: 'no onion', sent_to_kot: true, sent_qty: 2 } : l))
    const [chicken] = comboOf('aaaa', 'r-momo-c')
    const swapped = swapComboDish(cart, 'aaaa', 'g-momo', chicken)
    expect(swapped.map(i => i.recipe_id)).toEqual(['r-momo-c', 'r-tea'])
    expect(swapped[0]).toMatchObject({ qty: 2, notes: 'no onion', sent_to_kot: false, sent_qty: 0, combo_line_id: 'aaaa', combo_group_id: 'g-momo' })
    // The same dish again changes nothing.
    expect(swapComboDish(cart, 'aaaa', 'g-momo', comboOf('aaaa')[0])).toBe(cart)
    expect(picksOfCombo(swapped, 'aaaa')).toEqual([
      { group_id: 'g-momo', recipe_id: 'r-momo-c', option_ids: [] },
      { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] },
    ])
  })
})

describe('a combo moves whole (S836 move picker)', () => {
  const stored = [
    { ...plain, id: 'L1' },
    ...comboOf('aaaa', 'r-momo-v', 'r-tea', 2).map((l, n) => ({ ...l, id: `C${n}`, sent_qty: n === 0 ? 2 : 1 })),
  ]
  test('the picker gets the combo as one row, with its dishes listed', () => {
    const rowsOut = collapseCombosForMove(stored)
    expect(rowsOut.map(r => r.id)).toEqual(['L1', 'combo:aaaa'])
    expect(rowsOut[1]).toMatchObject({ name: 'Momo Combo', qty: 2, sent_qty: 1, option_summary: 'Veg Momo · Tea' })
  })
  test('a pick of the combo row sends every dish at that quantity', () => {
    const rowsOut = collapseCombosForMove(stored)
    expect(expandComboPicks([{ item_id: 'combo:aaaa', qty: 1 }, { item_id: 'L1', qty: 1 }], rowsOut)).toEqual([
      { item_id: 'C0', qty: 1 }, { item_id: 'C1', qty: 1 }, { item_id: 'L1', qty: 1 },
    ])
  })
})

describe('guest QR orders', () => {
  const req = [
    { recipe_id: 'r-tea', name: 'Tea', qty: 2, unit_price: 44.25, vat_rate: 0.13 },
    { recipe_id: 'r-momo-c', name: 'Chicken Momo', qty: 1, unit_price: 230, vat_rate: 0.13, option_summary: 'Extra cheese',
      selection_key: 'o-cheese', combo: { line_id: 'GGGG', combo_id: 'c-momo', name: 'Momo Combo', group_id: 'g-momo', group_name: 'Pick a momo', sort: 0, price: 350 } },
    { recipe_id: 'r-coke', name: 'Coke', qty: 1, unit_price: 80, vat_rate: 0.13,
      combo: { line_id: 'GGGG', combo_id: 'c-momo', name: 'Momo Combo', group_id: 'g-drink', group_name: 'Pick a drink', sort: 1, price: 350 } },
  ]
  test('a request\'s combo dish becomes a combo dish of the request\'s own line id', () => {
    const line = guestLineOf(req[1])
    expect(line).toMatchObject({ combo_line_id: 'gggg', combo_id: 'c-momo', combo_group_id: 'g-momo', combo_name: 'Momo Combo', option_ids: ['o-cheese'] })
    expect(line.selection_key).toBe('o-cheese@gggg/g-momo')
    expect(guestLineOf(req[0])).toBe(req[0])
  })
  test('the banner names the combo with its dishes under it', () => {
    expect(guestRequestText(req)).toBe('2× Tea, 1× Momo Combo: Chicken Momo (Extra cheese) + Coke')
  })
})

describe('a bill discount never touches a combo (the till\'s figure is computeOrderAmounts\')', () => {
  test('a percent of the other dishes only; VAT on the combo is whole', () => {
    const items = [{ ...plain, qty: 2 }, ...comboOf('aaaa')]
    const out = computeOrderAmounts({ discount_amount: 20 }, items, true)
    const comboVat = items.slice(1).reduce((s, i) => s + i.qty * i.unit_price * i.vat_rate, 0)
    expect(out.vatAmt).toBeCloseTo(comboVat + (200 - 20) * 0.13, 6)
  })
})

// S862 COMBOS-1 (owner CU2 a): a dish swapped, or given other choices, inside a combo already on the bill
// is priced from the replaced dish's own share, so the combo keeps the price it was ordered at.
describe('a swap keeps the price the combo was ordered at', () => {
  test('every combo dish carries the share it was priced from', () => {
    const shares = comboSharesOf(momoCombo, recipeOf, true)
    const lines = comboOf('aaaa')
    expect(lines.map(l => l.combo_share)).toEqual([shares['g-momo'], shares['g-drink']])
  })

  test('the replaced dish\'s stored share prices the new one, its extra on top', () => {
    const old = { ...comboOf('aaaa')[0], combo_share: 210, combo_price: 350 }
    const share = swapShareOf(old, momoCombo, 'g-momo', recipeOf, true)
    expect(share).toBe(210)
    const group = momoCombo.groups.find(g => g.id === 'g-momo')
    const item = group.items.find(i => i.recipe_id === 'r-momo-c')
    const line = comboDishLine({ combo: momoCombo, group, item, recipe: recipeOf('r-momo-c'), vatReg: true, share, lineId: 'aaaa' })
    // (210 + Chicken's 50) / 1.13, to the paisa, as the server prices it.
    expect(line.unit_price).toBe(Math.round((260 / 1.13) * 100) / 100)
    expect(line.combo_share).toBe(210)
  })

  test('a dish rung before shares were kept is priced from today\'s split, as the server does', () => {
    const old = { ...comboOf('aaaa')[0], combo_share: null }
    expect(swapShareOf(old, momoCombo, 'g-momo', recipeOf, true)).toBe(comboSharesOf(momoCombo, recipeOf, true)['g-momo'])
  })

  test('the swap window shows the combo at the price it was sold at, only when the dish kept its share', () => {
    const priced = comboAsSold(momoCombo, { combo_share: 210, combo_price: 400 })
    expect(priced.guest_price).toBe(400)
    expect(priced.groups).toBe(momoCombo.groups)
    expect(comboAsSold(momoCombo, { combo_share: null, combo_price: 400 })).toBe(momoCombo)
    expect(comboAsSold(momoCombo, { combo_share: 210, combo_price: null })).toBe(momoCombo)
  })
})
