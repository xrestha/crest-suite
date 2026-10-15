import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import GuestComboSheet, {
  comboPicksOf, comboOrderable, comboCartKey, defaultDishOf, comboOrderItem, pickChoices, comboUnitPrice,
  comboOrderName, comboContents, comboLineProblem, comboCartWithout, comboMatches,
} from './GuestComboSheet'
import { groupsForDish } from '../../../shared/optionPricing'

// S839 (docs/pos-combos.md): the guest QR menu's combo sheet and the helpers GuestMenu builds its
// cart, its order payload and its refusal re-read from.

const MOMO = 'r-momo-chicken', VEG = 'r-momo-veg', COKE = 'r-coke'
const combo = {
  id: 'c1', name: 'Momo Combo', description: 'A plate of momo and a drink', guest_price: 350, sort: 0,
  groups: [
    // Out of order on purpose: picks go by sort.
    { id: 'g-drink', name: 'Drink', sort: 2, share: 100, items: [{ recipe_id: COKE, name: 'Coke', is_veg: true, extra_price: 0, is_default: false, sort: 0 }] },
    { id: 'g-momo', name: 'Pick a momo', sort: 1, share: 250, items: [
      { recipe_id: MOMO, name: 'Chicken Momo', is_veg: false, extra_price: 50, is_default: false, sort: 1 },
      { recipe_id: VEG, name: 'Veg Momo', is_veg: true, extra_price: 0, is_default: false, sort: 0 },
    ] },
  ],
}

// Chicken Momo has a required size (Half −40 ex-VAT, Full 0) and an optional cheese (+20 ex-VAT).
const catalogRaw = {
  groups: [
    { id: 'og-size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
    { id: 'og-add', name: 'Add-ons', kind: 'addon', min_select: 0, max_select: null, included_count: 0, sort: 1, is_active: true },
  ],
  options: [
    { id: 'o-half', group_id: 'og-size', name: 'Half', price_delta: -40, is_default: false, sort: 0, is_active: true },
    { id: 'o-full', group_id: 'og-size', name: 'Full', price_delta: 0, is_default: true, sort: 1, is_active: true },
    { id: 'o-cheese', group_id: 'og-add', name: 'Cheese', price_delta: 20, is_default: false, sort: 0, is_active: true },
  ],
  attachments: [
    { id: 'a1', recipe_id: MOMO, group_id: 'og-size', sort: 0 },
    { id: 'a2', recipe_id: MOMO, group_id: 'og-add', sort: 1 },
  ],
}
const dishGroupsByRecipe = { [MOMO]: groupsForDish(MOMO, catalogRaw) }
const optionMaps = {
  optionsById: Object.fromEntries(catalogRaw.options.map(o => [o.id, o])),
  groupsById: Object.fromEntries(catalogRaw.groups.map(g => [g.id, g])),
}
const vatOf = () => 0.13
const ctx = { optionMaps, dishGroupsByRecipe, vatOf }

describe('combo helpers', () => {
  test('picks go by sort, dishes too', () => {
    const picks = comboPicksOf(combo)
    expect(picks.map(g => g.id)).toEqual(['g-momo', 'g-drink'])
    expect(picks[0].items.map(i => i.recipe_id)).toEqual([VEG, MOMO])
    expect(comboOrderable(combo)).toBe(true)
    expect(comboOrderable({ ...combo, groups: [{ id: 'x', items: [] }] })).toBe(false)
    expect(comboOrderable({ ...combo, groups: [] })).toBe(false)
  })

  test('the cart key ignores pick order and option order, and tells choices apart', () => {
    const a = comboCartKey('c1', [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full', 'o-cheese'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }])
    const b = comboCartKey('c1', [{ group_id: 'g-drink', recipe_id: COKE }, { group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-cheese', 'o-full'] }])
    const c = comboCartKey('c1', [{ group_id: 'g-drink', recipe_id: COKE }, { group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full'] }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('combo:c1|')).toBe(true)
  })

  test('a pick starts on its default dish, else its only dish, else none', () => {
    expect(defaultDishOf(comboPicksOf(combo)[1])).toBe(COKE)
    expect(defaultDishOf(comboPicksOf(combo)[0])).toBeNull()
    expect(defaultDishOf({ items: [{ recipe_id: 'a' }, { recipe_id: 'b', is_default: true }] })).toBe('b')
  })

  test('the order item is the contract shape', () => {
    expect(comboOrderItem({ combo_id: 'c1', qty: 2, picks: [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }] }))
      .toEqual({ combo_id: 'c1', qty: 2, note: null, picks: [
        { group_id: 'g-momo', recipe_id: MOMO, options: ['o-full'] },
        { group_id: 'g-drink', recipe_id: COKE, options: [] },
      ] })
  })

  test('the price is the combo, its extras and each dish’s own choices with VAT', () => {
    const plain = [{ group_id: 'g-momo', recipe_id: VEG, option_ids: [] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }]
    expect(comboUnitPrice(combo, plain, ctx)).toBe(350)
    const chicken = [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full', 'o-cheese'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }]
    // 350 + 50 extra + cheese 20 × 1.13
    expect(comboUnitPrice(combo, chicken, ctx)).toBeCloseTo(422.6, 6)
    const half = [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-half'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }]
    expect(comboUnitPrice(combo, half, ctx)).toBeCloseTo(400 - 45.2, 6)
    expect(pickChoices({ recipe_id: MOMO, option_ids: ['o-half'] }, ctx).summary).toBe('Half')
    // A PAN outlet shows the choice's own price.
    expect(comboUnitPrice(combo, chicken, { ...ctx, vatOf: () => 0 })).toBe(420)
  })

  test('names and contents', () => {
    expect(comboOrderName(combo, [{ group_id: 'g-momo', recipe_id: MOMO }, { group_id: 'g-drink', recipe_id: COKE }])).toBe('Momo Combo (Chicken Momo, Coke)')
    expect(comboContents(combo)).toBe('Pick a momo (2 choices) + Coke')
  })

  test('a cart line is checked against the catalog it would be sent to', () => {
    const byId = { c1: combo }
    const line = { combo_id: 'c1', qty: 1, picks: [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }] }
    expect(comboLineProblem(line, byId, catalogRaw)).toBeNull()
    expect(comboLineProblem(line, {}, catalogRaw)).toBe('gone')
    // The momo left the pick.
    const shrunk = { ...combo, groups: [combo.groups[0], { ...combo.groups[1], items: [combo.groups[1].items[1]] }] }
    expect(comboLineProblem(line, { c1: shrunk }, catalogRaw)).toBe('changed')
    // A pick missing from the line.
    expect(comboLineProblem({ ...line, picks: [line.picks[0]] }, byId, catalogRaw)).toBe('changed')
    // A required size no longer answered (the Full option was withdrawn).
    const noFull = { ...catalogRaw, options: catalogRaw.options.filter(o => o.id !== 'o-full') }
    expect(comboLineProblem(line, byId, noFull)).toBe('choices')
    // Choices on a dish that has none any more.
    expect(comboLineProblem({ ...line, picks: [line.picks[0], { group_id: 'g-drink', recipe_id: COKE, option_ids: ['o-cheese'] }] }, byId, catalogRaw)).toBe('choices')
  })

  test('a combo that reached the restaurant comes off the cart by what it sent', () => {
    const picks = [{ group_id: 'g-momo', recipe_id: VEG, option_ids: [] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }]
    const key = comboCartKey('c1', picks)
    const cart = { [key]: { combo_id: 'c1', qty: 3, picks }, plain: { recipe_id: 'plain', qty: 1, option_ids: [] } }
    expect(comboCartWithout(cart, [{ combo_id: 'c1', qty: 2, picks }, { recipe_id: 'plain', qty: 1 }])).toEqual({
      [key]: { combo_id: 'c1', qty: 1, picks }, plain: cart.plain,
    })
    expect(comboCartWithout(cart, [{ combo_id: 'c1', qty: 3, picks }])).toEqual({ plain: cart.plain })
  })

  test('search and filters', () => {
    expect(comboMatches(combo)).toBe(true)
    expect(comboMatches(combo, { query: 'momo' })).toBe(true)
    expect(comboMatches(combo, { query: 'coke' })).toBe(true)
    expect(comboMatches(combo, { query: 'pizza' })).toBe(false)
    // Every pick offers a veg dish.
    expect(comboMatches(combo, { vegOnly: true })).toBe(true)
    const meaty = { ...combo, groups: [combo.groups[0], { ...combo.groups[1], items: [combo.groups[1].items[0]] }] }
    expect(comboMatches(meaty, { vegOnly: true })).toBe(false)
    const allergensOf = rid => (rid === VEG ? ['gluten'] : rid === MOMO ? ['gluten'] : [])
    expect(comboMatches(combo, { excludedAllergens: ['gluten'], allergensOf })).toBe(false)
    expect(comboMatches(combo, { excludedAllergens: ['dairy'], allergensOf })).toBe(true)
  })
})

describe('GuestComboSheet', () => {
  const renderSheet = props => {
    const onConfirm = jest.fn()
    const onClose = jest.fn()
    render(
      <div className="guest-menu">
        <GuestComboSheet combo={combo} dishGroupsByRecipe={dishGroupsByRecipe} catalog={optionMaps} vatOf={vatOf}
          onConfirm={onConfirm} onClose={onClose} {...props} />
      </div>,
    )
    return { onConfirm, onClose }
  }

  test('one step per question, then Review, then one combo with every pick', () => {
    const { onConfirm } = renderSheet()
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
    // No momo chosen: Next says what is missing instead of moving on.
    fireEvent.click(screen.getByRole('button', { name: /^Next · NPR 350$/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose one from Pick a momo.')
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Chicken Momo/ }))
    // Its own choices appear in the same step, the size preselected at Full.
    expect(screen.getByRole('radio', { name: /Full/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('checkbox', { name: /Cheese/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Next · NPR 423$/ }))

    expect(screen.getByText('Review · step 2 of 2')).toBeInTheDocument()
    expect(screen.getByText('Coke')).toBeInTheDocument()
    expect(screen.getByText('Included')).toBeInTheDocument()
    expect(screen.getByText('+NPR 50')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Add to order · NPR 423$/ }))
    expect(onConfirm).toHaveBeenCalledWith([
      { group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-full', 'o-cheese'] },
      { group_id: 'g-drink', recipe_id: COKE, option_ids: [] },
    ])
  })

  test('a set meal asks nothing and opens on Review', () => {
    const setMeal = { ...combo, groups: [combo.groups[0], { ...combo.groups[1], items: [combo.groups[1].items[1]] }] }
    const { onConfirm } = renderSheet({ combo: setMeal })
    expect(screen.queryByText(/Step 1/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Change/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Add to order · NPR 350$/ }))
    expect(onConfirm).toHaveBeenCalledWith([
      { group_id: 'g-momo', recipe_id: VEG, option_ids: [] },
      { group_id: 'g-drink', recipe_id: COKE, option_ids: [] },
    ])
  })

  test('an edit opens on Review with its picks, and a Change comes back to Review', () => {
    const { onConfirm } = renderSheet({
      editing: true,
      initialPicks: [{ group_id: 'g-momo', recipe_id: MOMO, option_ids: ['o-half'] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }],
    })
    expect(screen.getByText('Review · step 2 of 2')).toBeInTheDocument()
    expect(screen.getByText('Half')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change Pick a momo' }))
    fireEvent.click(screen.getByRole('radio', { name: /Veg Momo/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Back to review · NPR 350$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Update · NPR 350$/ }))
    expect(onConfirm).toHaveBeenCalledWith([
      { group_id: 'g-momo', recipe_id: VEG, option_ids: [] },
      { group_id: 'g-drink', recipe_id: COKE, option_ids: [] },
    ])
  })

  // S842 (owner decision): the phone's Back reaches the sheet through `backRef` (GuestMenu's history
  // guard). It walks back one step and asks before picks are lost; true means the sheet kept it.
  describe("the phone's Back", () => {
    const back = ref => { let kept; act(() => { kept = ref.current.back() }); return kept }

    test('nothing picked on the first step: Back closes as before', () => {
      const backRef = createRef()
      renderSheet({ backRef })
      expect(back(backRef)).toBe(false)
    })

    test('goes back one step, then asks before the picks are lost', () => {
      const backRef = createRef()
      const { onClose } = renderSheet({ backRef })
      fireEvent.click(screen.getByRole('radio', { name: /Veg Momo/ }))
      fireEvent.click(screen.getByRole('button', { name: /^Next · NPR 350$/ }))
      expect(screen.getByText('Review · step 2 of 2')).toBeInTheDocument()

      expect(back(backRef)).toBe(true)
      expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()

      expect(back(backRef)).toBe(true)
      expect(screen.getByText('Leave without adding? Your choices will be lost.')).toBeInTheDocument()
      const keep = screen.getByRole('button', { name: 'Keep choosing' })
      expect(keep).toHaveFocus()
      expect(screen.queryByRole('button', { name: /^Next/ })).not.toBeInTheDocument()

      // Keep choosing: the picks and the step are as they were.
      fireEvent.click(keep)
      expect(screen.queryByText(/Leave without adding/)).not.toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /Veg Momo/ })).toHaveAttribute('aria-checked', 'true')

      // A second Back on the confirm keeps choosing too; only Leave leaves.
      back(backRef)
      expect(back(backRef)).toBe(true)
      expect(screen.queryByText(/Leave without adding/)).not.toBeInTheDocument()
      back(backRef)
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    test('after a Change from Review, Back returns to Review', () => {
      const backRef = createRef()
      renderSheet({
        backRef, editing: true,
        initialPicks: [{ group_id: 'g-momo', recipe_id: VEG, option_ids: [] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }],
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change Pick a momo' }))
      expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
      expect(back(backRef)).toBe(true)
      expect(screen.getByText('Review · step 2 of 2')).toBeInTheDocument()
      // Review is where an edit opened, so it is the first step: unchanged, Back closes.
      expect(back(backRef)).toBe(false)
    })

    test('an edit with a change asks in its own words', () => {
      const backRef = createRef()
      renderSheet({
        backRef, editing: true,
        initialPicks: [{ group_id: 'g-momo', recipe_id: VEG, option_ids: [] }, { group_id: 'g-drink', recipe_id: COKE, option_ids: [] }],
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change Pick a momo' }))
      fireEvent.click(screen.getByRole('radio', { name: /Chicken Momo/ }))
      back(backRef)
      expect(back(backRef)).toBe(true)
      expect(screen.getByText('Leave without updating? Your changes will be lost.')).toBeInTheDocument()
    })
  })
})
