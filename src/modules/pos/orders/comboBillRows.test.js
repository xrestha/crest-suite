// S839 (docs/pos-combos.md): the one rule the bill, the credit note and the Complimentary Slip print a
// combo by: one row at the place of its first dish, its dishes listed under it.
import { groupComboLines, comboLineIdOf } from './comboBillRows'

const L1 = '7f0c2c1e-0000-4000-8000-000000000001'
const G_MOMO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const G_DRINK = 'bbbbbbbb-0000-4000-8000-00000000000b'

const dish = (name, group, sort, extra = {}) => ({
  recipe_id: `r-${name}`, name, qty: 1, unit_price: 100, vat_rate: 0.13,
  combo_line_id: L1, combo_id: 'c1', combo_name: 'Momo Combo', combo_price: 350,
  combo_group_id: group, combo_sort: sort, selection_key: `@${L1}/${group}`, ...extra,
})
const TEA = { recipe_id: 'r-tea', name: 'Tea', qty: 2, unit_price: 40, vat_rate: 0.13 }
const MOMO = dish('Chicken Momo', G_MOMO, 0, { unit_price: 221.24 })
const COKE = dish('Coke', G_DRINK, 1, { unit_price: 88.5 })

describe('groupComboLines', () => {
  test('a bill with no combo is every line as itself, in order', () => {
    const items = [TEA, { ...TEA, name: 'Coffee' }]
    expect(groupComboLines(items)).toEqual(items.map(item => ({ combo: false, item })))
  })

  test('a combo is one row at its first dish\'s place: its name, qty, the sum of its dishes and amount ÷ qty', () => {
    const rows = groupComboLines([TEA, COKE, { ...TEA, name: 'Coffee' }, MOMO])
    expect(rows.map(r => (r.combo ? `combo:${r.name}` : r.item.name))).toEqual(['Tea', 'combo:Momo Combo', 'Coffee'])
    const combo = rows[1]
    expect(combo.qty).toBe(1)
    expect(combo.amount).toBeCloseTo(309.74, 10)
    expect(combo.rate).toBeCloseTo(309.74, 10)
    // The dishes in the order of their picks, not of the bill.
    expect(combo.dishes.map(d => d.name)).toEqual(['Chicken Momo', 'Coke'])
    expect(combo.lines).toHaveLength(2)
  })

  test('two of the same combo: qty 2, amount Σ qty × unit_price, rate per combo', () => {
    const [row] = groupComboLines([{ ...MOMO, qty: 2 }, { ...COKE, qty: 2 }])
    expect(row.qty).toBe(2)
    expect(row.amount).toBeCloseTo(619.48, 10)
    expect(row.rate).toBeCloseTo(309.74, 10)
  })

  test('two combos on one bill stay apart', () => {
    const L2 = '7f0c2c1e-0000-4000-8000-000000000002'
    const other = [MOMO, COKE].map(d => ({ ...d, combo_line_id: L2, selection_key: `@${L2}/${d.combo_group_id}` }))
    const rows = groupComboLines([MOMO, ...other, COKE])
    expect(rows.filter(r => r.combo).map(r => r.id)).toEqual([L1, L2])
  })

  test('a line read with only its key is still grouped, by the key\'s tail; with no name it says Combo', () => {
    const bare = [MOMO, COKE].map(({ recipe_id, name, qty, unit_price, selection_key }) => ({ recipe_id, name, qty, unit_price, selection_key }))
    expect(comboLineIdOf(bare[0])).toBe(L1)
    const [row] = groupComboLines(bare)
    expect(row).toMatchObject({ combo: true, id: L1, name: 'Combo', qty: 1 })
    expect(comboLineIdOf({ selection_key: 'opt1+opt2' })).toBeNull()
  })

  test('a cart line holding its combo as an object groups the same way', () => {
    const cart = [MOMO, COKE].map(({ combo_line_id, combo_group_id, combo_name, combo_sort, selection_key, ...rest }) => ({
      ...rest, combo: { line_id: combo_line_id, group_id: combo_group_id, name: combo_name, sort: combo_sort },
    }))
    const [row] = groupComboLines([cart[1], cart[0]])
    expect(row).toMatchObject({ combo: true, id: L1, name: 'Momo Combo', qty: 1 })
    expect(row.dishes.map(d => d.name)).toEqual(['Chicken Momo', 'Coke'])
  })

  test('a dish split into a comped part and the rest is one dish, and the combo keeps its whole quantity', () => {
    const rows = groupComboLines([
      { ...MOMO, comped: true }, { ...COKE, comped: true }, MOMO, COKE,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].qty).toBe(2)
    expect(rows[0].dishes.map(d => d.name)).toEqual(['Chicken Momo', 'Coke'])
    expect(rows[0].lines).toHaveLength(4)
  })

  test('a combo whose picks disagree on quantity prints line by line, never a quantity that is not true', () => {
    const items = [{ ...MOMO, qty: 2 }, COKE]
    expect(groupComboLines(items)).toEqual(items.map(item => ({ combo: false, item })))
  })

  test('survives no lines', () => {
    expect(groupComboLines(undefined)).toEqual([])
    expect(groupComboLines([])).toEqual([])
  })
})
