import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

function renderOption({ group, option, dishes = [latte], catalog, ingredients = [], itemChoices = [], imsEnabled = false }) {
  const onSaved = jest.fn()
  render(
    <OptionModal group={{ ...group, options: option ? [option] : [] }} option={option} ingredients={ingredients}
      attachedDishes={dishes} catalog={catalog} vat={VAT} imsEnabled={imsEnabled} itemChoices={itemChoices}
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
  fireEvent.click(screen.getByRole('button', { name: 'Save option' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Save option' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  // (320 − 271.20) / 1.13, where the rupee base gave (320 − 271) / 1.13 = 43.36.
  expect(mockWrites[0].row.price_delta).toBe(43.19)
})

it('SETUP-5: an emptied full-price box is a field error, not a free size', () => {
  renderOption({ group: cupSize, option: null, dishes: [latte, cappuccino], catalog: cupCatalog })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Small' } })
  fireEvent.change(screen.getByLabelText(/Price of this size/), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add option' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Save option' }))
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

it('SETUP-10: a stock line changed on another device is reported, not said to be saved', async () => {
  mockAnswer.pos_option_ingredients = { data: [], error: null }
  const { onSaved } = renderOption({ group: extras, option: extraShot, catalog: extrasCatalog, ingredients: butterLine, itemChoices: choices, imsEnabled: true })
  fireEvent.click(screen.getByRole('button', { name: 'Save option' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const [, opts] = onSaved.mock.calls[0]
  expect(opts.keepOpen).toBe(true)
  expect(opts.error).toMatch(/had changed on another device/)
})
