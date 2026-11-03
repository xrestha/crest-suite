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
// The overlay behind a dialog: what a stray thumb hits.
const backdropOf = dialog => dialog.parentElement // eslint-disable-line testing-library/no-node-access

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
    expect(screen.getByRole('button', { name: 'Change choices for Veg Momo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Choose 1 more from Size for Veg Momo.')

    // The dish's own choices open with no quantity of their own (S840): the dish's quantity is the
    // combo's, so a stepper there would be buttons that do nothing. Scoped to the inner window,
    // since the combo window behind it keeps its own Quantity group.
    // S863: Add takes the waiter to the Choices button of the dish that needs one, not to the
    // section's first chip (a selector list answers in document order).
    expect(screen.getByRole('button', { name: 'Change choices for Veg Momo' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Change choices for Veg Momo' }))
    const inner = screen.getByRole('dialog', { name: /Veg Momo \(in Momo Combo\)/ })
    expect(within(inner).queryByRole('group', { name: 'Quantity' })).not.toBeInTheDocument()
    expect(within(inner).queryByRole('button', { name: /One more/ })).not.toBeInTheDocument()
    // S863: inside a combo the dish is priced by the combo. No figure before the size is picked, a
    // size keeps its extra charge, and the footer says what the choices add, never "NPR 0".
    expect(within(inner).getByTestId('option-picker-total')).toHaveTextContent('Choose a size')
    expect(within(inner).getByRole('radio', { name: /Full/ })).toHaveTextContent('+NPR 45')
    expect(within(inner).getByRole('radio', { name: /Half/ })).not.toHaveTextContent('NPR')
    fireEvent.click(within(inner).getByRole('radio', { name: /Half/ }))
    expect(within(inner).getByTestId('option-picker-total')).toHaveTextContent('No extra charge')
    fireEvent.click(within(inner).getByRole('radio', { name: /Full/ }))
    expect(within(inner).getByTestId('option-picker-total')).toHaveTextContent('Choices add NPR 45')
    expect(within(inner).getByTestId('option-picker-total')).not.toHaveTextContent('NPR 0')
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

describe('ComboPickerModal (S863 till audit)', () => {
  const size = { id: 'grp-size', name: 'Size', kind: 'size', sort: 0, included_count: 0 }
  const sizeGroups = [{
    group: size, attachment: { group_id: 'grp-size', sort: 0 }, rule: { min: 1, max: 1, included: 0 },
    options: [{ id: 'o-half', group_id: 'grp-size', name: 'Half', price_delta: 0, sort: 0 }, { id: 'o-full', group_id: 'grp-size', name: 'Full', price_delta: 40, sort: 1 }],
  }]
  const sizeCatalog = { optionsById: Object.fromEntries(sizeGroups[0].options.map(o => [o.id, o])), groupsById: { 'grp-size': size } }

  test('a stray backdrop tap keeps a changed quantity; an untouched window still closes on one', () => {
    const onClose = jest.fn()
    const { unmount } = render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onConfirm={jest.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'One more Momo Combo' }))
    fireEvent.click(backdropOf(screen.getByRole('dialog', { name: 'Momo Combo' })))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    const onClose2 = jest.fn()
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onConfirm={jest.fn()} onClose={onClose2} />)
    fireEvent.click(backdropOf(screen.getByRole('dialog', { name: 'Momo Combo' })))
    expect(onClose2).toHaveBeenCalledTimes(1)
  })

  test('One fewer at 1 stays pressable and does nothing, so focus is not dropped', () => {
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onConfirm={jest.fn()} onClose={jest.fn()} />)
    const fewer = screen.getByRole('button', { name: 'One fewer Momo Combo' })
    expect(fewer).not.toBeDisabled()
    expect(fewer).toHaveAttribute('aria-disabled', 'true')
    fewer.focus()
    fireEvent.click(fewer)
    expect(fewer).toHaveFocus()
    expect(screen.getByRole('group', { name: 'Quantity' })).toHaveTextContent('1')
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 350')
  })

  test('picking a dish whose required choice has no default opens its choices at once', () => {
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf}
      dishGroupsOf={rid => (rid === 'r-momo-c' ? sizeGroups : undefined)} catalog={sizeCatalog}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    // A dish with nothing to answer opens nothing.
    fireEvent.click(screen.getByRole('radio', { name: /Coke/ }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: /Chicken Momo/ }))
    const inner = screen.getByRole('dialog', { name: /Chicken Momo \(in Momo Combo\)/ })
    fireEvent.click(within(inner).getByRole('radio', { name: /Half/ }))
    fireEvent.click(within(inner).getByRole('button', { name: 'Use these choices' }))
    expect(screen.queryByRole('dialog', { name: /Chicken Momo \(in Momo Combo\)/ })).not.toBeInTheDocument()
    // Tapping the dish already picked does not open it again.
    fireEvent.click(screen.getByRole('radio', { name: /Chicken Momo/ }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  test('a pick with no dish takes the focus to its first dish on Add', () => {
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialPicks={[{ group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-gone', option_ids: [] }]}
      confirmLabel="Swap dish" onConfirm={jest.fn()} onClose={jest.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Swap dish' }))
    expect(screen.getByRole('radio', { name: /Coke/ })).toHaveFocus()
  })

  test('a Swap on a combo of 2 says both get the dish, and shows the total for both', () => {
    const onConfirm = jest.fn()
    const picksNow = [{ group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] }]
    const { unmount } = render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialQty={2} initialPicks={picksNow} confirmLabel="Swap dish" onConfirm={onConfirm} onClose={jest.fn()} />)
    expect(screen.queryByRole('group', { name: 'Quantity' })).not.toBeInTheDocument()
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 700')
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 350 × 2')
    expect(screen.getByText('Both (×2) get this dish')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Coke/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Swap dish' }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ qty: 2 }))
    unmount()

    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialQty={3} initialPicks={picksNow} confirmLabel="Swap dish" onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByText('All 3 (×3) get this dish')).toBeInTheDocument()
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 1,050')
  })

  test('a Swap prices from the bill: the other dishes as rung, the swapped one from its share (S864)', () => {
    const combo = { ...momoCombo, groups: momoCombo.groups.map(g => (g.id === 'g-drink'
      ? { ...g, items: g.items.map(i => (i.recipe_id === 'r-coke' ? { ...i, extra_price: 20 } : i)) } : g)) }
    const picksNow = [{ group_id: 'g-momo', recipe_id: 'r-momo-c', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] }]
    // Rung when Chicken's extra was NPR 60 and the drink's share NPR 90: the bill holds 270 + 90.
    const soldLines = [{ group_id: 'g-momo', incl: 270 }, { group_id: 'g-drink', incl: 90 }]
    render(<ComboPickerModal combo={combo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialQty={1} initialPicks={picksNow} soldLines={soldLines} swapShare={90}
      confirmLabel="Swap dish" onConfirm={jest.fn()} onClose={jest.fn()} />)
    // The dish it holds reads the bill's own figure, not today's 350 plus Chicken's 50.
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 360')
    fireEvent.click(screen.getByRole('radio', { name: /Coke/ }))
    // Coke takes the tea's share (90) and its own extra today (20); the momo stays at 270.
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 380')
    fireEvent.click(screen.getByRole('radio', { name: /Tea/ }))
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 360')
  })

  test('a Swap on one combo keeps its old wording', () => {
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} onlyGroupId="g-drink" showQty={false}
      initialQty={1} initialPicks={[{ group_id: 'g-momo', recipe_id: 'r-momo-v', option_ids: [] }, { group_id: 'g-drink', recipe_id: 'r-tea', option_ids: [] }]}
      confirmLabel="Swap dish" onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByText('The combo with this dish')).toBeInTheDocument()
    expect(screen.getByTestId('combo-picker-total')).not.toHaveTextContent('×')
  })

  test('the total is the sum of the parts on screen, each choice charge rounded as shown', () => {
    // Each extra is NPR 10 before VAT: NPR 11.30 to the guest, shown as +NPR 11. Two of them used to
    // total NPR 372.60, shown as NPR 373 under two lines of +NPR 11.
    const extra = id => ({ id: `grp-${id}`, name: 'Extra', kind: 'addon', sort: 0, included_count: 0 })
    const groupsFor = id => [{
      group: extra(id), attachment: { group_id: `grp-${id}`, sort: 0 }, rule: { min: 0, max: 1, included: 0 },
      options: [{ id: `o-${id}`, group_id: `grp-${id}`, name: `More ${id}`, price_delta: 10, sort: 0, is_default: true }],
    }]
    const dg = { 'r-momo-v': groupsFor('momo'), 'r-tea': groupsFor('tea') }
    const catalog = {
      optionsById: { 'o-momo': dg['r-momo-v'][0].options[0], 'o-tea': dg['r-tea'][0].options[0] },
      groupsById: { 'grp-momo': extra('momo'), 'grp-tea': extra('tea') },
    }
    render(<ComboPickerModal combo={momoCombo} recipeOf={recipeOf} dishGroupsOf={rid => dg[rid]} catalog={catalog}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByText(/Veg Momo: More momo/)).toHaveTextContent('+NPR 11')
    expect(screen.getByText(/Tea: More tea/)).toHaveTextContent('+NPR 11')
    expect(screen.getByTestId('combo-picker-total')).toHaveTextContent('NPR 372')
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
    fireEvent.click(within(qty).getByRole('button', { name: 'One more Veg Momo' }))
    expect(screen.getByText(/× 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }))
    expect(onConfirm).toHaveBeenCalledWith(['o-half'], 2)
  })

  test('S863: the steppers name the dish, and One fewer at 1 stays pressable and does nothing', () => {
    render(<OptionPickerModal recipe={{ id: 'r-momo-v', name: 'Veg Momo', selling_price: 200 }}
      dishGroups={dishGroups} catalog={catalog} initialIds={['o-half']} onConfirm={jest.fn()} onClose={jest.fn()} />)
    const fewer = screen.getByRole('button', { name: 'One fewer Veg Momo' })
    expect(fewer).not.toBeDisabled()
    expect(fewer).toHaveAttribute('aria-disabled', 'true')
    expect(fewer).toHaveClass('till-hit')
    fewer.focus()
    fireEvent.click(fewer)
    expect(fewer).toHaveFocus()
    expect(screen.getByRole('group', { name: 'Quantity' })).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: 'One more Veg Momo' }))
    expect(fewer).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(fewer)
    expect(screen.getByRole('group', { name: 'Quantity' })).toHaveTextContent('1')
  })

  test('S863: a stray backdrop tap keeps a changed quantity or pick; Escape still closes', () => {
    const onClose = jest.fn()
    const twoSizes = [{ ...dishGroups[0], options: [...dishGroups[0].options, { id: 'o-full', group_id: 'grp-size', name: 'Full', price_delta: 40, sort: 1 }] }]
    const cat2 = { optionsById: Object.fromEntries(twoSizes[0].options.map(o => [o.id, o])), groupsById: { 'grp-size': size } }
    const { unmount } = render(<OptionPickerModal recipe={{ id: 'r-momo-v', name: 'Veg Momo', selling_price: 200 }}
      dishGroups={twoSizes} catalog={cat2} initialIds={['o-half']} onConfirm={jest.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'One more Veg Momo' }))
    fireEvent.click(backdropOf(screen.getByRole('dialog', { name: 'Veg Momo' })))
    expect(onClose).not.toHaveBeenCalled()
    // Back to where it started: clean again.
    fireEvent.click(screen.getByRole('button', { name: 'One fewer Veg Momo' }))
    fireEvent.click(backdropOf(screen.getByRole('dialog', { name: 'Veg Momo' })))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    const onClose2 = jest.fn()
    render(<OptionPickerModal recipe={{ id: 'r-momo-v', name: 'Veg Momo', selling_price: 200 }}
      dishGroups={twoSizes} catalog={cat2} initialIds={['o-half']} onConfirm={jest.fn()} onClose={onClose2} />)
    fireEvent.click(screen.getByRole('radio', { name: /Full/ }))
    fireEvent.click(backdropOf(screen.getByRole('dialog', { name: 'Veg Momo' })))
    expect(onClose2).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose2).toHaveBeenCalledTimes(1)
  })
})

describe('OptionPickerModal prices (S863, owner decision)', () => {
  const size = { id: 'grp-size', name: 'Size', kind: 'size', sort: 0, included_count: 0 }
  const sauce = { id: 'grp-sauce', name: 'Sauce', kind: 'choice', sort: 1, included_count: 0 }
  const sizeGroup = {
    group: size, attachment: { group_id: 'grp-size', sort: 0 }, rule: { min: 1, max: 1, included: 0 },
    options: [
      { id: 'o-half', group_id: 'grp-size', name: 'Half', price_delta: -90, sort: 0 },
      { id: 'o-full', group_id: 'grp-size', name: 'Full', price_delta: 0, sort: 1 },
    ],
  }
  const sauceGroup = {
    group: sauce, attachment: { group_id: 'grp-sauce', sort: 1 }, rule: { min: 1, max: 1, included: 0 },
    options: [{ id: 'o-red', group_id: 'grp-sauce', name: 'Red', price_delta: 0, sort: 0 }],
  }
  const catalogOf = groups => ({
    optionsById: Object.fromEntries(groups.flatMap(d => d.options).map(o => [o.id, o])),
    groupsById: Object.fromEntries(groups.map(d => [d.group.id, d.group])),
  })
  const momo = { id: 'r-momo', name: 'Chicken Momo', selling_price: 250 }

  test('a size chip shows the whole dish at that size, never a change from a price not shown', () => {
    render(<OptionPickerModal recipe={momo} dishGroups={[sizeGroup]} catalog={catalogOf([sizeGroup])}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByRole('radio', { name: /Half/ })).toHaveTextContent('NPR 160')
    expect(screen.getByRole('radio', { name: /Half/ })).not.toHaveTextContent('−')
    expect(screen.getByRole('radio', { name: /Full/ })).toHaveTextContent('NPR 250')
  })

  test('with VAT, the size price is what the guest pays', () => {
    render(<OptionPickerModal recipe={momo} dishGroups={[sizeGroup]} catalog={catalogOf([sizeGroup])} vatRate={0.13}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    // 160 × 1.13 = 180.80; 250 × 1.13 = 282.50
    expect(screen.getByRole('radio', { name: /Half/ })).toHaveTextContent('NPR 181')
    expect(screen.getByRole('radio', { name: /Full/ })).toHaveTextContent('NPR 283')
  })

  test('no total is quoted before a required size is picked', () => {
    render(<OptionPickerModal recipe={momo} dishGroups={[sizeGroup]} catalog={catalogOf([sizeGroup])}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    const total = screen.getByTestId('option-picker-total')
    expect(total).toHaveTextContent('Choose a size')
    expect(total).not.toHaveTextContent('NPR')
    fireEvent.click(screen.getByRole('radio', { name: /Half/ }))
    expect(screen.getByTestId('option-picker-total')).toHaveTextContent('NPR 160')
  })

  test('a size is asked for first; then any other required group with nothing picked, by name', () => {
    const groups = [sizeGroup, sauceGroup]
    render(<OptionPickerModal recipe={momo} dishGroups={groups} catalog={catalogOf(groups)}
      onConfirm={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByTestId('option-picker-total')).toHaveTextContent('Choose a size')
    fireEvent.click(screen.getByRole('radio', { name: /Full/ }))
    expect(screen.getByTestId('option-picker-total')).toHaveTextContent('Choose from Sauce')
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }))
    expect(screen.getByTestId('option-picker-total')).toHaveTextContent('NPR 250')
  })

  test('Same as last shows its whole summary on a touch-sized button, with nothing kept in a hover title', () => {
    const groups = [sizeGroup, sauceGroup]
    render(<OptionPickerModal recipe={momo} dishGroups={groups} catalog={catalogOf(groups)}
      initialIds={['o-full', 'o-red']} lastIds={['o-half', 'o-red']} onConfirm={jest.fn()} onClose={jest.fn()} />)
    const same = screen.getByRole('button', { name: 'Same as last: Half · Red' })
    expect(same).toHaveClass('till-hit--row')
    expect(same).not.toHaveAttribute('title')
    fireEvent.click(same)
    expect(screen.getByRole('radio', { name: /Half/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: /Same as last/ })).not.toBeInTheDocument()
  })
})

describe('OptionPickerModal full group (S867)', () => {
  const extras = { id: 'grp-x', name: 'Extras', kind: 'addon', sort: 0, included_count: 0 }
  const groups = [{
    group: extras, attachment: { group_id: 'grp-x', sort: 0 }, rule: { min: 0, max: 2, included: 0 },
    options: [
      { id: 'o-egg', group_id: 'grp-x', name: 'Egg', price_delta: 30, sort: 0 },
      { id: 'o-cheese', group_id: 'grp-x', name: 'Cheese', price_delta: 40, sort: 1 },
      { id: 'o-ham', group_id: 'grp-x', name: 'Ham', price_delta: 50, sort: 2 },
    ],
  }]
  const catalog = {
    optionsById: Object.fromEntries(groups[0].options.map(o => [o.id, o])),
    groupsById: { 'grp-x': extras },
  }

  test('a full chip stays in the Tab order and its press says why nothing was added', () => {
    render(<OptionPickerModal recipe={{ id: 'r-momo-v', name: 'Veg Momo', selling_price: 200 }}
      dishGroups={groups} catalog={catalog} initialIds={['o-egg', 'o-cheese']} onConfirm={jest.fn()} onClose={jest.fn()} />)
    const ham = screen.getByRole('checkbox', { name: /Ham/ })
    expect(ham).not.toBeDisabled()
    expect(ham).toHaveAttribute('aria-disabled', 'true')
    expect(ham).toHaveTextContent('Max 2')
    fireEvent.click(ham)
    expect(ham).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('Up to 2 from Extras. Untick one to choose another.')
    fireEvent.click(screen.getByRole('checkbox', { name: /Egg/ }))
    expect(screen.queryByText(/Untick one to choose another/)).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Ham/ })).not.toHaveAttribute('aria-disabled')
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
