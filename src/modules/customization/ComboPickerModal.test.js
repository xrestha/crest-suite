import { render, screen, fireEvent, within } from '@testing-library/react'
import ComboPickerModal from './ComboPickerModal'
import OptionPickerModal from './OptionPickerModal'
import { comboAddsInOneTap, defaultComboPicks, buildComboLines } from '../pos/orders/comboCart'

// Combos (S839, docs/pos-combos.md): the till's window for a combo's picks, and the one-tap set meal.

const recipes = {
  'r-momo-v': { id: 'r-momo-v', name: 'Veg Momo', category: 'Food', selling_price: 200, vat_rate: 0.13 },
  'r-momo-c': { id: 'r-momo-c', name: 'Chicken Momo', category: 'Food', selling_price: 250, vat_rate: 0.13 },
  'r-coke': { id: 'r-coke', name: 'Coke', category: 'Beverage', selling_price: 100, vat_rate: 0.13 },
  'r-tea': { id: 'r-tea', name: 'Tea', category: 'Beverage', selling_price: 50, vat_rate: 0.13 },
}
const recipeOf = id => recipes[id]

const momoCombo = {
  id: 'c-momo', name: 'Momo Combo', guest_price: 350, description: 'A plate of momo and a drink.',
  groups: [
    { id: 'g-momo', name: 'Pick a momo', sort: 0, items: [
      { id: 'i1', recipe_id: 'r-momo-v', extra_price: 0, is_default: true },
      { id: 'i2', recipe_id: 'r-momo-c', extra_price: 50, is_default: false },
    ] },
    { id: 'g-drink', name: 'Pick a drink', sort: 1, items: [
      { id: 'i3', recipe_id: 'r-coke', extra_price: 0, is_default: false },
      { id: 'i4', recipe_id: 'r-tea', extra_price: 0, is_default: true },
    ] },
  ],
}

describe('ComboPickerModal', () => {
  test('one section per pick, each starting on its default dish, at the combo price', () => {
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Momo Combo' })).toBeInTheDocument()
    const momo = screen.getByRole('radiogroup', { name: 'Pick a momo' })
    expect(within(momo).getByRole('radio', { name: /Veg Momo/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(momo).getByRole('radio', { name: /Chicken Momo/ })).toHaveAttribute('aria-checked', 'false')
    expect(within(momo).getByRole('radio', { name: /Chicken Momo/ })).toHaveTextContent('+NPR 50')
    const drink = screen.getByRole('radiogroup', { name: 'Pick a drink' })
    expect(within(drink).getByRole('radio', { name: /Tea/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 350')
  })

  test('picking another dish moves the price by its extra, and Add sends every pick with the quantity', () => {
    const onConfirm = jest.fn()
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onConfirm={onConfirm} onClose={jest.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: /Chicken Momo/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Coke/ }))
    expect(screen.getByRole('radio', { name: /Chicken Momo/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 400')
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo Combo' }))
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 800')
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).toHaveBeenCalledWith({
      qty: 2,
      picks: [
        { group_id: 'g-momo', recipe_id: 'r-momo-c', option_ids: [] },
        { group_id: 'g-drink', recipe_id: 'r-coke', option_ids: [] },
      ],
    })
  })

  test('a pick with no dish chosen says so on Add and sends nothing', () => {
    const onConfirm = jest.fn()
    // A Swap whose current dish the pick no longer offers starts unpicked.
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialPicks={[{ group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-gone', option_ids: [] }]}
      confirmLabel="Swap dish" onConfirm={onConfirm} onClose={jest.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Momo Combo: Pick a drink' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Pick a momo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Quantity' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Swap dish' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Pick one from Pick a drink.')
    fireEvent.click(screen.getByRole('radio', { name: /Coke/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Swap dish' }))
    expect(onConfirm).toHaveBeenCalledWith({
      qty: 1,
      picks: [
        { group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: [] },
        { group_id: 'g-drink', recipe_id: 'r-coke', option_ids: [] },
      ],
    })
  })

  test('a picked dish with choices of its own offers them, and a required one with no default blocks Add', () => {
    const size = { id: 'grp-size', name: 'Size', kind: 'size', sort: 0, included_count: 0 }
    const dishGroups = [{
      group: size, attachment: { group_id: 'grp-size', sort: 0 }, rule: { min: 1, max: 1, included: 0 },
      options: [{ id: 'o-half', group_id: 'grp-size', name: 'Half', price_delta: 0, sort: 0 }, { id: 'o-full', group_id: 'grp-size', name: 'Full', price_delta: 40, sort: 1 }],
    }]
    const onConfirm = jest.fn()
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf}
      dishGroupsOf={rid => (rid === 'r-momo-v' ? dishGroups : undefined)}
      catalog={{ optionsById: Object.fromEntries(dishGroups[0].options.map(o => [o.id, o])), groupsById: { 'grp-size': size } }}
      onConfirm={onConfirm} onClose={jest.fn()} />)
    expect(screen.getByRole('button', { name: 'Choices for Veg Momo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Choose 1 more from Size for Veg Momo.')

    // The dish's own choices open with no quantity of their own (S840): the dish's quantity is the
    // combo's, so a stepper there would be buttons that do nothing. Scoped to the inner window,
    // since the combo window behind it keeps its own Quantity group.
    fireEvent.click(screen.getByRole('button', { name: 'Choices for Veg Momo' }))
    const inner = screen.getByRole('dialog', { name: /Veg Momo \(in Momo Combo\)/ })
    expect(within(inner).queryByRole('group', { name: 'Quantity' })).not.toBeInTheDocument()
    expect(within(inner).queryByRole('button', { name: 'One more' })).not.toBeInTheDocument()
    fireEvent.click(within(inner).getByRole('radio', { name: /Full/ }))
    fireEvent.click(within(inner).getByRole('button', { name: 'Use these choices' }))
    expect(screen.queryByRole('dialog', { name: /Veg Momo \(in Momo Combo\)/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).toHaveBeenCalledWith({
      qty: 1,
      picks: [
        { group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: ['o-full'] },
        { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] },
      ],
    })
  })
})

describe('OptionPickerModal quantity', () => {
  const size = { id: 'grp-size', name: 'Size', kind: 'size', sort: 0, included_count: 0 }
  const dishGroups = [{
    group: size, attachment: { group_id: 'grp-size', sort: 0 }, rule: { min: 1, max: 1, included: 0 },
    options: [{ id: 'o-half', group_id: 'grp-size', name: 'Half', price_delta: 0, sort: 0 }],
  }]
  const catalog = { optionsById: { 'o-half': dishGroups[0].options[0] }, groupsById: { 'grp-size': size } }

  test('a plain dish still shows its stepper, and the total and Add follow it', () => {
    const onConfirm = jest.fn()
    render(<OptionPickerModal recipe={{ id: 'r-momo-v', name: 'Veg Momo', selling_price: 200 }}
      dishGroups={dishGroups} catalog={catalog} initialIds={['o-half']} onConfirm={onConfirm} onClose={jest.fn()} />)
    const qty = screen.getByRole('group', { name: 'Quantity' })
    fireEvent.click(within(qty).getByRole('button', { name: 'One more' }))
    expect(screen.getByText(/× 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).toHaveBeenCalledWith(['o-half'], 2)
  })
})

describe('a set meal adds in one tap', () => {
  const setMeal = {
    id: 'c-set', name: 'Breakfast Set', guest_price: 300, groups: [
      { id: 'g1', name: 'Main', sort: 0, items: [{ id: 's1', recipe_id: 'r-momo-v', extra_price: 0, is_default: true }] },
      { id: 'g2', name: 'Drink', sort: 1, items: [{ id: 's2', recipe_id: 'r-tea', extra_price: 0, is_default: true }] },
    ],
  }
  test('no window: its one dish per pick goes straight on, one line each, one combo', () => {
    expect(comboAddsInOneTap(setMeal, () => false)).toBe(true)
    const lines = buildComboLines({ combo: setMeal, recipeOf, vatReg: true, lineId: 'abcd', picks: defaultComboPicks(setMeal, () => []) })
    expect(lines.map(l => [l.name, l.qty, l.combo_line_id, l.combo_name])).toEqual([
      ['Veg Momo', 1, 'abcd', 'Breakfast Set'],
      ['Tea', 1, 'abcd', 'Breakfast Set'],
    ])
  })
  test('a dish that needs a choice of its own opens the window instead', () => {
    expect(comboAddsInOneTap(setMeal, rid => rid === 'r-momo-v')).toBe(false)
  })
})
