import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import OptionModal from './OptionModal'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

// Every write the dialog sends, and what each table's update or delete answers with.
const mockWrites = []
const mockAnswer = {}
jest.mock('../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedUpdate: (table, row) => {
      mockWrites.push({ op: 'update', table, row })
      const q = { eq: () => q, select: () => Promise.resolve(mockAnswer[table] || { data: [{ id: 'o1', ...row }], error: null }) }
      return q
    },
    scopedInsert: (table, row) => {
      mockWrites.push({ op: 'insert', table, row })
      return Promise.resolve({ data: { id: 'new-option', ...row }, error: null })
    },
    scopedDelete: table => {
      mockWrites.push({ op: 'delete', table })
      const q = { in: () => q, select: () => Promise.resolve({ data: [], error: null }) }
      return q
    },
  }),
}))

afterEach(() => {
  mockWrites.length = 0
  Object.keys(mockAnswer).forEach(k => delete mockAnswer[k])
})

const VAT = 0.13
const latte = { id: 'latte', name: 'Latte', selling_price: 240, inclPrice: 240 * 1.13 }
const cappuccino = { id: 'capp', name: 'Cappuccino', selling_price: 240, inclPrice: 240 * 1.13 }

function renderOption({ group, option, dishes = [latte], catalog, ingredients = [], itemChoices = [], imsEnabled = false, vatUnknown = false }) {
  const onSaved = jest.fn()
  render(
    <OptionModal group={{ ...group, options: option ? [option] : [] }} option={option} ingredients={ingredients}
      attachedDishes={dishes} catalog={catalog} vat={VAT} vatUnknown={vatUnknown} imsEnabled={imsEnabled} itemChoices={itemChoices}
      onClose={() => {}} onSaved={onSaved} />,
  )
  return { onSaved }
}

const extras = { id: 'g1', name: 'Extras', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true }
const extraShot = { id: 'o1', group_id: 'g1', name: 'Extra Shot', price_delta: 60, is_removal: false, is_default: false, is_active: true, sort: 0, allergens: [] }
const extrasCatalog = { groups: [extras], options: [extraShot], attachments: [{ recipe_id: 'latte', group_id: 'g1', sort: 0 }] }

it('SETUP-1: a save that does not touch the price leaves price_delta out', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog })
  expect(screen.getByLabelText(/Extra charge/)).toHaveValue(68)
  fireEvent.click(screen.getByRole('button', { name: /More details/ }))
  fireEvent.click(screen.getByLabelText(/Pre-selected/))
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const [write] = mockWrites
  expect(write.row.is_default).toBe(true)
  expect(write.row).not.toHaveProperty('price_delta')
})

const cupSize = { id: 'g2', name: 'Cup size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, is_active: true }
const large = { id: 'o2', group_id: 'g2', name: 'Large', price_delta: 40, is_removal: false, is_default: false, is_active: true, sort: 1, allergens: [] }
const cupCatalog = {
  groups: [cupSize], options: [large],
  attachments: [{ recipe_id: 'latte', group_id: 'g2', sort: 0 }, { recipe_id: 'capp', group_id: 'g2', sort: 0 }],
}

it('SETUP-1: a typed full price is measured from the dish price to the paisa', async () => {
  const { onSaved } = renderOption({ group: cupSize, option: large, dishes: [latte, cappuccino], catalog: cupCatalog })
  const box = screen.getByLabelText(/Price of this size/)
  expect(box).toHaveValue(316)
  fireEvent.change(box, { target: { value: '320' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  // (320 − 271.20) / 1.13, where the rupee base gave (320 − 271) / 1.13 = 43.36.
  expect(mockWrites[0].row.price_delta).toBe(43.19)
})

it('SETUP-5: an emptied full-price box is a field error, not a free size', () => {
  renderOption({ group: cupSize, option: null, dishes: [latte, cappuccino], catalog: cupCatalog })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Small' } })
  fireEvent.change(screen.getByLabelText(/Price of this size/), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add choice' }))
  expect(screen.getByText('Type what this size costs.')).toBeInTheDocument()
  expect(mockWrites).toHaveLength(0)
})

const sauce = { id: 'g3', name: 'Sauce', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, is_active: true }
const chilli = { id: 'o3', group_id: 'g3', name: 'Chilli', price_delta: 0, is_removal: false, is_default: false, is_active: true, sort: 0, allergens: [] }
const sauceCatalog = { groups: [sauce], options: [chilli], attachments: [{ recipe_id: 'latte', group_id: 'g3', sort: 0 }] }

it('SETUP-3: unticking Shown asks first when it leaves a dish with nothing to pick', async () => {
  const { onSaved } = renderOption({ group: sauce, option: chilli, catalog: sauceCatalog })
  fireEvent.click(screen.getByRole('button', { name: /More details/ }))
  fireEvent.click(screen.getByLabelText(/Shown on the till/))
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  expect(await screen.findByText('Nothing would be left to pick in “Sauce”, so Latte would be ordered without it.')).toBeInTheDocument()
  expect(mockWrites).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save and hide it' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites[0].row.is_active).toBe(false)
})

const butterLine = [{ id: 'i1', option_id: 'o1', item_id: 'butter', sub_recipe_id: null, qty_per_portion: 10 }]
const choices = [
  { value: 'item:butter', label: 'BUTTER (GM) — hidden in Item Master', unit: 'GM', hidden: true },
  { value: 'item:cheese', label: 'CHEESE (GM)', unit: 'GM', hidden: false },
]

it('SETUP-7: a stock line on a hidden item shows that item, labelled, with its unit', () => {
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: butterLine, itemChoices: choices, imsEnabled: true })
  expect(screen.getByText('BUTTER (GM) — hidden in Item Master')).toBeInTheDocument()
  expect(screen.getByText('GM')).toBeInTheDocument()
})

// S877: a recipe moved out of Sub-Recipe before the recategorise guard still takes stock through
// its line, so the line names it and says what it takes, and it can still be removed.
const doughLine = [{ id: 'i2', option_id: 'o1', item_id: null, sub_recipe_id: 'dough', qty_per_portion: -0.2 }]
const movedChoices = [
  ...choices,
  { value: 'sub:dough', label: 'Pizza Dough (kg) — no longer a sub-recipe', unit: 'kg', hidden: true, movedOut: true, name: 'Pizza Dough' },
]

it('S877: a stock line on a recipe no longer a sub-recipe shows it and what it takes, not a blank box, and can be removed', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: doughLine, itemChoices: movedChoices, imsEnabled: true })
  expect(screen.getByText('Pizza Dough (kg) — no longer a sub-recipe')).toBeInTheDocument()
  expect(screen.getByText(/Pizza Dough is no longer a sub-recipe, so it is not offered for a new line, but this line still takes off 0\.2 kg of it on every plate sold\./)).toBeInTheDocument()
  expect(screen.getByText('kg')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }))
  expect(screen.queryByText(/no longer a sub-recipe, so it is not offered/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites.some(w => w.op === 'delete' && w.table === 'pos_option_ingredients')).toBe(true)
})

it('S877: an untouched line on a moved recipe saves back unchanged', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: doughLine, itemChoices: movedChoices, imsEnabled: true })
  mockAnswer.pos_option_ingredients = { data: [{ id: 'i2' }], error: null }
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const line = mockWrites.find(w => w.table === 'pos_option_ingredients')
  expect(line.row).toMatchObject({ item_id: null, sub_recipe_id: 'dough', qty_per_portion: -0.2 })
  expect(onSaved.mock.calls[0][1]).toBeUndefined()
})

it('SETUP-10: a stock line changed on another device is reported, not said to be saved', async () => {
  mockAnswer.pos_option_ingredients = { data: [], error: null }
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: butterLine, itemChoices: choices, imsEnabled: true })
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const [, opts] = onSaved.mock.calls[0]
  expect(opts.keepOpen).toBe(true)
  expect(opts.error).toMatch(/had changed on another device/)
})

// S863: the pressed Save stays enabled (a disabled button drops keyboard focus to the page), wears
// aria-busy, and turns a second press away itself.
it('Save stays pressable while it writes, and a second press sends nothing more', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog })
  const save = screen.getByRole('button', { name: 'Save choice' })
  fireEvent.click(save)
  expect(save).toHaveAttribute('aria-busy', 'true')
  expect(save).not.toBeDisabled()
  expect(save).toHaveTextContent('Saving…')
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(mockWrites.filter(w => w.table === 'pos_options')).toHaveLength(1)
})

it('S877: while the VAT basis is unknown, a choice whose price is untouched still saves, without a price', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, vatUnknown: true })
  const save = screen.getByRole('button', { name: 'Save choice' })
  expect(save).not.toHaveAttribute('aria-disabled')
  expect(screen.getByRole('note')).toHaveTextContent(/Leave the price as it is for now/)
  expect(screen.getByLabelText(/Extra charge/)).toHaveAccessibleDescription(/Leave the price as it is/)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Double Shot' } })
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites[0].row.name).toBe('Double Shot')
  expect(mockWrites[0].row).not.toHaveProperty('price_delta')
})

it('S877: while the VAT basis is unknown, a changed price makes Save aria-disabled, and its press goes to the note that says why', async () => {
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, vatUnknown: true })
  const save = screen.getByRole('button', { name: 'Save choice' })
  fireEvent.change(screen.getByLabelText(/Extra charge/), { target: { value: '80' } })
  expect(save).not.toBeDisabled()
  expect(save).toHaveAttribute('aria-disabled', 'true')
  expect(save).toHaveAccessibleDescription(/The new price cannot be saved yet/)
  fireEvent.click(save)
  expect(screen.getByRole('note')).toHaveFocus()
  expect(mockWrites).toHaveLength(0)
  // Put back as it was, the rest saves.
  fireEvent.change(screen.getByLabelText(/Extra charge/), { target: { value: '68' } })
  expect(save).not.toHaveAttribute('aria-disabled')
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites[0].row).not.toHaveProperty('price_delta')
})

it('S877: a new choice left free saves while the VAT basis is unknown; one given a price waits', async () => {
  const { onSaved } = renderOption({ group: extras, option: null, catalog: extrasCatalog, vatUnknown: true })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oat milk' } })
  const add = screen.getByRole('button', { name: 'Add choice' })
  fireEvent.change(screen.getByLabelText(/Extra charge/), { target: { value: '40' } })
  expect(add).toHaveAttribute('aria-disabled', 'true')
  fireEvent.change(screen.getByLabelText(/Extra charge/), { target: { value: '' } })
  expect(add).not.toHaveAttribute('aria-disabled')
  fireEvent.click(add)
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites[0]).toMatchObject({ op: 'insert', row: { name: 'Oat milk', price_delta: 0 } })
})

it('adds / takes off is one radio group: one Tab stop, arrow keys move and pick', () => {
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog })
  const group = screen.getByRole('radiogroup', { name: 'Does it add something or take something off?' })
  const [adds, takesOff] = screen.getAllByRole('radio')
  expect(group).toContainElement(adds)
  expect(adds).toHaveAttribute('aria-checked', 'true')
  expect(adds).toHaveAttribute('tabindex', '0')
  expect(takesOff).toHaveAttribute('tabindex', '-1')
  adds.focus()
  fireEvent.keyDown(adds, { key: 'ArrowRight' })
  expect(takesOff).toHaveFocus()
  expect(takesOff).toHaveAttribute('aria-checked', 'true')
  expect(takesOff).toHaveAttribute('tabindex', '0')
  expect(adds).toHaveAttribute('tabindex', '-1')
  // A "No …" is free, so the price box goes.
  expect(screen.queryByLabelText(/Extra charge/)).toBeNull()
})

it('a stock line names its picker, and an item and an amount that are wrong each say so under their own box', () => {
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, itemChoices: choices, imsEnabled: true })
  fireEvent.click(screen.getByRole('button', { name: /Stock per plate/ }))
  fireEvent.click(screen.getByRole('button', { name: '+ Add ingredient line' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  expect(mockWrites).toHaveLength(0)

  const picker = screen.getByRole('button', { name: /^Line 1: ingredient: / })
  expect(picker).toHaveAccessibleDescription('Choose an item.')
  const amount = screen.getByLabelText(/^Line 1: amount/)
  expect(amount).toHaveAttribute('aria-invalid', 'true')
  expect(amount).toHaveAccessibleDescription('Enter an amount above zero.')
})

it('an amount alone is flagged on the amount box, not on the item picker', () => {
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: [{ ...butterLine[0], item_id: 'cheese' }], itemChoices: choices, imsEnabled: true })
  fireEvent.change(screen.getByLabelText(/^Line 1: amount/), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  expect(screen.getByRole('button', { name: /^Line 1: ingredient: CHEESE/ })).not.toHaveAttribute('aria-describedby')
  expect(screen.getByLabelText(/^Line 1: amount/)).toHaveAccessibleDescription('Enter an amount above zero.')
  expect(screen.queryByText('Choose an item.')).toBeNull()
})

it('"none — stock will not change" is a warning only on an option that changes the price', () => {
  renderOption({ group: sauce, option: chilli, catalog: sauceCatalog, imsEnabled: true })
  expect(screen.getByRole('button', { name: /Stock per plate/ })).not.toHaveTextContent('△')
  cleanup()
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, imsEnabled: true })
  expect(screen.getByRole('button', { name: /Stock per plate/ })).toHaveTextContent('△ none — stock will not change')
})

describe('a size result below zero', () => {
  const kids = { id: 'kids', name: 'Kids Momo', selling_price: 80, inclPrice: 90.4 }
  const halfCatalog = {
    groups: [cupSize], options: [],
    attachments: [{ recipe_id: 'latte', group_id: 'g2', sort: 0 }, { recipe_id: 'kids', group_id: 'g2', sort: 0 }],
  }

  it('reads "NPR −10", the form the page and the attach dialogs use', () => {
    renderOption({ group: cupSize, option: null, dishes: [latte, kids], catalog: halfCatalog })
    fireEvent.change(screen.getByLabelText(/Price difference from the dish/), { target: { value: '-100' } })
    expect(screen.getByText(/Kids Momo: NPR 90 → NPR −10/)).toBeInTheDocument()
    expect(screen.queryByText(/−NPR/)).toBeNull()
  })

  it('a few paisa under reads in words, never as NPR 0', () => {
    renderOption({ group: cupSize, option: null, dishes: [latte, kids], catalog: halfCatalog })
    fireEvent.change(screen.getByLabelText(/Price difference from the dish/), { target: { value: '-90.43' } })
    expect(screen.getByText(/Kids Momo: NPR 90 → a few paisa below NPR 0/)).toBeInTheDocument()
    expect(screen.queryByText(/−NPR 0|NPR −0/)).toBeNull()
  })
})

// S867: before a Size group is on a dish its box is a difference from the dish, and an owner
// copying "Full 400" off the menu stored +400. The label and an amber line say which number it wants.
describe('a Size choice in a group on no dish yet', () => {
  const noDishCatalog = { groups: [cupSize], options: [], attachments: [] }

  it('asks for the difference, not the menu price, with a worked example tied to the box', async () => {
    const { onSaved } = renderOption({ group: cupSize, option: null, dishes: [], catalog: noDishCatalog })
    expect(screen.getByRole('dialog', { name: 'New choice in Cup size' })).toBeInTheDocument()
    const box = screen.getByLabelText('Price difference from the dish (incl. VAT), not the menu price')
    const hint = screen.getByText(/^△ This group is on no dish yet, so this box is the difference, not the menu price/)
    expect(hint).toHaveTextContent('for Full at NPR 400 on a NPR 250 dish, type 150. Put the group on its dishes first to type the full menu price of each size instead.')
    expect(box).toHaveAttribute('aria-describedby', 'opt-price-hint')
    expect(box).toHaveAccessibleDescription(/This group is on no dish yet/)
    expect(screen.queryByText(/Put this group on a dish to enter the full price/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Full' } })
    fireEvent.change(box, { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add choice' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Stored as the difference, before VAT: 150 / 1.13.
    expect(mockWrites[0].row.price_delta).toBe(132.74)
  })

  it('is not shown once the group is on a dish', () => {
    renderOption({ group: cupSize, option: large, dishes: [latte, cappuccino], catalog: cupCatalog })
    expect(screen.queryByText(/This group is on no dish yet/)).toBeNull()
    expect(screen.getByLabelText(/Price of this size/)).not.toHaveAttribute('aria-describedby')
  })
})

it('S867: the VAT line reads as a plain label, its explanation in the Tip', () => {
  renderOption({ group: extras, option: extraShot, catalog: extrasCatalog })
  expect(screen.getByRole('dialog', { name: 'Edit choice — Extra Shot' })).toBeInTheDocument()
  expect(screen.getByText('Includes 13% VAT')).toBeInTheDocument()
  expect(screen.queryByText(/how a no-VAT dish charges it/)).toBeNull()
})

// S867: only build-your-own dishes (and groups set to scale with the size) use a size's portion.
describe('the Portion field', () => {
  it('is hidden when nothing scales with the size, and the save sends no portion', async () => {
    const { onSaved } = renderOption({ group: cupSize, option: large, dishes: [latte, cappuccino], catalog: cupCatalog })
    expect(screen.queryByLabelText(/Portion/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mockWrites[0].row).not.toHaveProperty('portion_factor')
  })

  it('shows when the client has a build-your-own dish', () => {
    renderOption({ group: cupSize, option: large, dishes: [latte, cappuccino], catalog: { ...cupCatalog, buildYourOwn: ['latte'] } })
    expect(screen.getByLabelText(/Portion/)).toBeInTheDocument()
  })

  it('shows when a group scales with the size', () => {
    const toppings = { ...extras, size_scaling: 'stock' }
    renderOption({ group: cupSize, option: large, dishes: [latte, cappuccino], catalog: { ...cupCatalog, groups: [cupSize, toppings] } })
    expect(screen.getByLabelText(/Portion/)).toBeInTheDocument()
  })

  it('shows when this size already has a portion, so a saved value is never out of sight', () => {
    renderOption({ group: cupSize, option: { ...large, portion_factor: 1.5 }, dishes: [latte, cappuccino], catalog: cupCatalog })
    expect(screen.getByLabelText(/Portion/)).toHaveValue('1.5')
  })
})
