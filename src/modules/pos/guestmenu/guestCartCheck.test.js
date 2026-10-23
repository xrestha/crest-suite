import { checkGuestCart, cartCheckNote } from './guestCartCheck'
import { selectionKeyOf } from '../orders/posOrdersConstants'

// S862 TILL-GUEST-4: the guest cart against a fresh read of the choices. BLOOM CAFE's Cafe Latte has a
// required Cup size (Regular 0, Large +40) and optional Milk (Oat +100, Almond +80); the manager
// hides Oat Milk while a guest's Large Oat Latte sits in a reloaded phone's cart.

const keyOf = (rid, ids) => {
  const sel = selectionKeyOf(ids)
  return sel ? `${rid}#${sel}` : rid
}
const LATTE = 'r-latte', MOMO = 'r-momo', COKE = 'r-coke'
const groups = [
  { id: 'g-size', name: 'Cup size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
  { id: 'g-milk', name: 'Milk', kind: 'addon', min_select: 0, max_select: 1, included_count: 0, sort: 1, is_active: true },
]
const allOptions = [
  { id: 'o-reg', group_id: 'g-size', name: 'Regular', price_delta: 0, is_default: true, sort: 0, is_active: true },
  { id: 'o-large', group_id: 'g-size', name: 'Large', price_delta: 40, is_default: false, sort: 1, is_active: true },
  { id: 'o-oat', group_id: 'g-milk', name: 'Oat Milk', price_delta: 100, is_default: false, sort: 0, is_active: true },
  { id: 'o-almond', group_id: 'g-milk', name: 'Almond Milk', price_delta: 80, is_default: false, sort: 1, is_active: true },
]
const attachments = [
  { id: 'a1', recipe_id: LATTE, group_id: 'g-size', sort: 0 },
  { id: 'a2', recipe_id: LATTE, group_id: 'g-milk', sort: 1 },
]
const combo = {
  id: 'c1', name: 'Latte and Momo', guest_price: 500, sort: 0,
  groups: [
    { id: 'p-drink', name: 'Drink', sort: 0, items: [{ recipe_id: LATTE, name: 'Cafe Latte', extra_price: 0, is_default: true, sort: 0 }] },
    { id: 'p-momo', name: 'Momo', sort: 1, items: [{ recipe_id: MOMO, name: 'Veg Momo', extra_price: 0, is_default: true, sort: 0 }] },
  ],
}
// The fresh read: Oat Milk is hidden, so the guest read leaves it out.
const fresh = { groups, options: allOptions.filter(o => o.id !== 'o-oat'), attachments, combos: [combo] }

describe('checkGuestCart', () => {
  it('takes a hidden pick off its dish and keeps the dish when the rest still fits', () => {
    const cart = { [keyOf(LATTE, ['o-large', 'o-oat'])]: { recipe_id: LATTE, qty: 2, option_ids: ['o-large', 'o-oat'] } }
    const r = checkGuestCart(cart, fresh, { keyOf })
    expect(r.changed).toBe(true)
    expect(r.cart).toEqual({ [keyOf(LATTE, ['o-large'])]: { recipe_id: LATTE, qty: 2, option_ids: ['o-large'] } })
    expect(r.trimmed).toEqual([{ recipe_id: LATTE, gone: ['o-oat'] }])
    expect(r.dropped).toEqual([])
    // Running it again finds nothing: the cart it returns is already consistent.
    expect(checkGuestCart(r.cart, fresh, { keyOf }).changed).toBe(false)
  })

  it('merges a trimmed line into the same dish already in the cart, capped at 50', () => {
    const cart = {
      [keyOf(LATTE, ['o-large'])]: { recipe_id: LATTE, qty: 45, option_ids: ['o-large'] },
      [keyOf(LATTE, ['o-large', 'o-oat'])]: { recipe_id: LATTE, qty: 9, option_ids: ['o-large', 'o-oat'] },
    }
    const r = checkGuestCart(cart, fresh, { keyOf })
    expect(Object.keys(r.cart)).toEqual([keyOf(LATTE, ['o-large'])])
    expect(r.cart[keyOf(LATTE, ['o-large'])].qty).toBe(50)
  })

  it('takes a dish off the order when what is left breaks its rules', () => {
    // The size itself is hidden: the required Cup size is then unanswered.
    const noLarge = { ...fresh, options: allOptions.filter(o => o.id !== 'o-large') }
    const cart = { [keyOf(LATTE, ['o-large'])]: { recipe_id: LATTE, qty: 1, option_ids: ['o-large'] } }
    const r = checkGuestCart(cart, noLarge, { keyOf })
    expect(r.cart).toEqual({})
    expect(r.dropped).toEqual([{ recipe_id: LATTE, reason: 'choices' }])
  })

  it('leaves an untouched cart as it is, plain lines and valid choices alike', () => {
    const cart = {
      [MOMO]: { recipe_id: MOMO, qty: 1, option_ids: [] },
      [keyOf(LATTE, ['o-reg', 'o-almond'])]: { recipe_id: LATTE, qty: 1, option_ids: ['o-reg', 'o-almond'] },
    }
    const r = checkGuestCart(cart, fresh, { keyOf })
    expect(r.changed).toBe(false)
    expect(r.cart).toBe(cart)
  })

  it('makes a dish plain when it offers no choices any more', () => {
    const cart = { [keyOf(LATTE, ['o-large'])]: { recipe_id: LATTE, qty: 1, option_ids: ['o-large'] } }
    const r = checkGuestCart(cart, { groups: [], options: [], attachments: [], combos: [] }, { keyOf })
    expect(r.cart).toEqual({ [LATTE]: { recipe_id: LATTE, qty: 1, option_ids: [] } })
    expect(r.trimmed).toEqual([{ recipe_id: LATTE, gone: ['o-large'] }])
  })

  it('trims a combo dish the same way, and takes off a combo no longer offered', () => {
    const picks = [{ group_id: 'p-drink', recipe_id: LATTE, option_ids: ['o-large', 'o-oat'] }, { group_id: 'p-momo', recipe_id: MOMO, option_ids: [] }]
    const cart = { 'combo-key': { combo_id: 'c1', qty: 1, picks } }
    const r = checkGuestCart(cart, fresh, { keyOf })
    const [key] = Object.keys(r.cart)
    expect(key.startsWith('combo:c1|')).toBe(true)
    expect(r.cart[key].picks[0].option_ids).toEqual(['o-large'])
    expect(r.trimmed).toEqual([{ combo_id: 'c1', recipe_id: LATTE, gone: ['o-oat'] }])

    const gone = checkGuestCart(cart, { ...fresh, combos: [] }, { keyOf })
    expect(gone.cart).toEqual({})
    expect(gone.dropped).toEqual([{ combo_id: 'c1', reason: 'gone' }])
  })

  it('takes off a dish the fresh menu no longer carries, only when told the menu', () => {
    const cart = { [COKE]: { recipe_id: COKE, qty: 1, option_ids: [] } }
    expect(checkGuestCart(cart, fresh, { keyOf }).changed).toBe(false)
    const r = checkGuestCart(cart, fresh, { keyOf, onMenu: new Set([LATTE]) })
    expect(r.dropped).toEqual([{ recipe_id: COKE, reason: 'off_menu' }])
  })
})

describe('cartCheckNote', () => {
  const names = {
    dishName: id => ({ [LATTE]: 'Cafe Latte', [MOMO]: 'Veg Momo' }[id] || null),
    comboName: id => (id === 'c1' ? 'Latte and Momo' : null),
    optionName: id => (id === 'o-oat' ? 'Oat Milk' : null),
  }

  it('names the choice and the dish, and says the price shown is the new one', () => {
    expect(cartCheckNote({ trimmed: [{ recipe_id: LATTE, gone: ['o-oat'] }] }, names))
      .toBe('Oat Milk on Cafe Latte is no longer offered, so it was taken off. The price in your order is the new one.')
  })

  it('says "a choice" when this phone never read the hidden one', () => {
    expect(cartCheckNote({ trimmed: [{ recipe_id: LATTE, gone: ['o-x'] }] }, names))
      .toBe('A choice on Cafe Latte is no longer offered, so it was taken off. The price in your order is the new one.')
  })

  it('names what came off the order, apart from what changed', () => {
    const note = cartCheckNote({
      dropped: [{ combo_id: 'c1', reason: 'gone' }, { recipe_id: LATTE, reason: 'choices' }, { recipe_id: 'r-unknown', reason: 'choices' }],
    }, names)
    expect(note).toBe('Latte and Momo is no longer on the menu, so it was taken off your order. '
      + 'Cafe Latte and one more dish changed on the menu, so they were taken off your order. Add them again with the new choices.')
  })

  it('is empty when nothing changed', () => {
    expect(cartCheckNote({ trimmed: [], dropped: [] }, names)).toBe('')
  })
})
