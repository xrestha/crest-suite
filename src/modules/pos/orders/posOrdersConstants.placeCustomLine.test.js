import { placeCustomLine, customChangeOf, lineKeyOf, comboFieldsOf, withServerLineFields, menuDrift, OPEN_ORDER_SELECT, cartLineFromStored } from './posOrdersConstants'

// S862 TILL-GUEST-3, -6: a dish with its choices onto the cart, by the key Change opened on.
const regular = { recipe_id: 'r-latte', name: 'Cafe Latte', qty: 1, unit_price: 240, selection_key: 'o-reg', option_ids: ['o-reg'], notes: 'less sugar', sent_to_kot: false, sent_qty: 0 }
const large = { recipe_id: 'r-latte', name: 'Cafe Latte', qty: 1, unit_price: 280, selection_key: 'o-large', option_ids: ['o-large'], notes: '', sent_to_kot: false, sent_qty: 0 }
const tea = { recipe_id: 'r-tea', name: 'Tea', qty: 2, unit_price: 50, notes: '', sent_to_kot: false, sent_qty: 0 }
const asLarge = { recipe_id: 'r-latte', name: 'Cafe Latte', unit_price: 280, selection_key: 'o-large', option_ids: ['o-large'], sent_to_kot: false, sent_qty: 0 }
const asOat = { ...asLarge, unit_price: 380, selection_key: 'o-large+o-oat', option_ids: ['o-large', 'o-oat'] }

describe('placeCustomLine', () => {
  test('Change replaces the line in its place, with its quantity and note', () => {
    const { items, joined } = placeCustomLine([tea, regular], asOat, { replaceKey: lineKeyOf(regular) })
    expect(joined).toBe(false)
    expect(items.map(lineKeyOf)).toEqual(['r-tea', 'r-latte#o-large+o-oat'])
    expect(items[1]).toMatchObject({ qty: 1, notes: 'less sugar', unit_price: 380 })
  })

  test('the line is found by its key, wherever the cart has moved it', () => {
    const { items } = placeCustomLine([regular, tea], asOat, { replaceKey: lineKeyOf(regular), qty: 2 })
    expect(items.map(lineKeyOf)).toEqual(['r-latte#o-large+o-oat', 'r-tea'])
    expect(items[0].qty).toBe(2)
  })

  test('folding into a line with a different note keeps both notes, each with its count (TILL-GUEST-6)', () => {
    const { items, joined } = placeCustomLine([regular, large], asLarge, { replaceKey: lineKeyOf(regular) })
    expect(joined).toBe(true)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ qty: 2, notes: '×1: less sugar' })
    // The other way round: the note on the line folded into is said to be for its own plates only.
    const other = placeCustomLine([{ ...regular, notes: '' }, { ...large, notes: 'extra hot' }], asLarge, { replaceKey: lineKeyOf(regular) })
    expect(other.items[0].notes).toBe('×1: extra hot')
    const both = placeCustomLine([regular, { ...large, qty: 2, notes: 'extra hot' }], asLarge, { replaceKey: lineKeyOf(regular) })
    expect(both.items[0]).toMatchObject({ qty: 3, notes: '×2: extra hot, ×1: less sugar' })
  })

  test('the same note, or none, folds as before', () => {
    const { items, joined } = placeCustomLine([{ ...regular, notes: '' }, large], asLarge, { replaceKey: lineKeyOf(regular) })
    expect(joined).toBe(false)
    expect(items[0]).toMatchObject({ qty: 2, notes: '' })
    // A plain add of the same choices adds to the line and leaves its note alone.
    const add = placeCustomLine([regular], { ...asLarge, selection_key: 'o-reg', option_ids: ['o-reg'] })
    expect(add).toMatchObject({ joined: false })
    expect(add.items[0]).toMatchObject({ qty: 2, notes: 'less sugar' })
  })

  test('a fold into a line the bar already has keeps what it was sent with, for the change ticket', () => {
    const sentLarge = { ...large, sent_to_kot: true, sent_qty: 1 }
    const { items } = placeCustomLine([regular, sentLarge], asLarge, { replaceKey: lineKeyOf(regular) })
    expect(items[0]).toMatchObject({ qty: 2, sent_to_kot: false, sent_qty: 1, notes: '×1: less sugar', note_at_send: '', note_changed: true })
  })

  test('a dish added as its own line carries the note it is given (TILL-GUEST-3)', () => {
    const sentRegular = { ...regular, sent_to_kot: true, sent_qty: 1 }
    const { items, joined } = placeCustomLine([sentRegular], asOat, { qty: 1, note: 'less sugar' })
    expect(joined).toBe(false)
    expect(items).toHaveLength(2)
    expect(items[0]).toBe(sentRegular)
    expect(items[1]).toMatchObject({ qty: 1, notes: 'less sugar', sent_to_kot: false })
  })

  test('a key no longer on the cart is an add, at the end (addCustomLine refuses it first)', () => {
    const { items } = placeCustomLine([tea], asOat, { replaceKey: 'r-latte#o-reg' })
    expect(items.map(lineKeyOf)).toEqual(['r-tea', 'r-latte#o-large+o-oat'])
  })
})

// S862 COMBOS-1 (owner CU2 a): a combo dish carries the share it was priced from.
describe('combo_share on the cart', () => {
  const dish = {
    recipe_id: 'r-coke', name: 'Coke', qty: 1, unit_price: 88.5, vat_rate: 0.13, sent_to_kot: false, sent_qty: 0,
    combo_line_id: 'aaaa', combo_id: 'c-1', combo_group_id: 'g-drink', combo_name: 'Momo Combo', combo_price: 350,
    combo_group_name: 'Pick a drink', combo_sort: 1, selection_key: '@aaaa/g-drink',
  }

  test('the order read selects it, and a stored line keeps it', () => {
    expect(OPEN_ORDER_SELECT).toMatch(/pos_order_items\([^)]*\bcombo_share\b/)
    expect(cartLineFromStored({ ...dish, combo_share: 100 }).combo_share).toBe(100)
  })

  test('a copy of the line carries it; none is null', () => {
    expect(comboFieldsOf({ ...dish, combo_share: 100 }).combo_share).toBe(100)
    expect(comboFieldsOf(dish).combo_share).toBeNull()
  })

  test('the save answer brings the server share onto the cart line, or takes the till one away', () => {
    const mine = { ...dish, combo_share: 99.99 }
    const next = withServerLineFields([mine], [{ ...dish, combo_share: 100 }])
    expect(next[0].combo_share).toBe(100)
    // A server without the column: the cart prices the next swap from today's split, as the server does.
    expect(withServerLineFields([mine], [dish])[0].combo_share).toBeNull()
    // Nothing differs: the same array.
    const same = [{ ...dish, combo_share: 100 }]
    expect(withServerLineFields(same, [{ ...dish, combo_share: 100 }])).toBe(same)
    expect(menuDrift(same, [{ ...dish, combo_share: 100 }])).toBeNull()
  })
})

// S862 TILL-GUEST-3: a Change answered after its line went out (a send in flight, or one settled
// meanwhile) never edits the sent line, and the same choices never add plates.
describe('customChangeOf', () => {
  const key = lineKeyOf(regular)
  test('an unsent line is replaced; one no longer on the cart changes nothing', () => {
    expect(customChangeOf([tea, regular], key, 'r-latte#o-large').kind).toBe('replace')
    expect(customChangeOf([tea, regular], key, key).kind).toBe('replace') // the stepper alone
    expect(customChangeOf([tea], key, 'r-latte#o-large')).toEqual({ kind: 'gone', line: null })
  })
  test('a line sent meanwhile, or in the send on its way: other choices are a dish of their own', () => {
    const sent = { ...regular, sent_to_kot: true, sent_qty: 1 }
    expect(customChangeOf([sent], key, 'r-latte#o-large')).toEqual({ kind: 'own', line: sent })
    expect(customChangeOf([regular], key, 'r-latte#o-large', new Set([key])).kind).toBe('own')
    expect(customChangeOf([{ ...regular, sent_qty: 1 }], key, 'r-latte#o-large').kind).toBe('own')
  })
  test('the same choices on a line that went out change nothing, rather than add plates', () => {
    const sent = { ...regular, sent_to_kot: true, sent_qty: 1 }
    expect(customChangeOf([sent], key, key).kind).toBe('unchanged')
    expect(customChangeOf([regular], key, key, new Set([key])).kind).toBe('unchanged')
  })
})
