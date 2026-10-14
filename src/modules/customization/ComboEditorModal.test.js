import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ComboEditorModal from './ComboEditorModal'
import { emptyCombo, prefillFromDishes } from './comboEditor'
import { supabase } from '../../supabaseClient'

jest.mock('../../supabaseClient', () => ({ supabase: { rpc: jest.fn() } }))

const recipes = [
  { id: 'veg', name: 'Veg Momo', category: 'Momo', selling_price: 200, vat_rate: 0.13, is_active: true, pos_enabled: true },
  { id: 'coke', name: 'Coke', category: 'Beverage', selling_price: 100, vat_rate: 0.13, is_active: true, pos_enabled: false },
]
const recipeById = new Map(recipes.map(r => [r.id, r]))
const dishes = recipes.map(r => ({ ...r, guestPrice: r.selling_price * 1.13 }))

function renderEditor(initial, props = {}) {
  const onSaved = jest.fn()
  render(
    <ComboEditorModal initial={initial} isNew prefilled={false} dishes={dishes} recipeById={recipeById}
      vatMode="vat" otherNames={[]} clientId="client-1" onClose={() => {}} onSaved={onSaved} {...props} />,
  )
  return { onSaved }
}

afterEach(() => jest.clearAllMocks())

it('shows each pick\'s part of the price and saves the contract payload', async () => {
  supabase.rpc.mockResolvedValue({ data: 'new-combo-id', error: null })
  const { onSaved } = renderEditor(prefillFromDishes(['veg', 'coke'], 300, recipeById))
  // Weighed 226 : 113 (each dish on its own, VAT included), so two thirds and one third of 300.
  expect(screen.getByText('NPR 200')).toBeInTheDocument()
  expect(screen.getByText('NPR 100')).toBeInTheDocument()
  expect(screen.getByText(/comes to NPR 339/)).toBeInTheDocument()
  expect(screen.getByText(/Set meal/)).toBeInTheDocument()
  expect(screen.getByText(/not sold alone/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'new-combo-id', name: 'Veg Momo + Coke', isNew: true }))
  const [fn, args] = supabase.rpc.mock.calls[0]
  expect(fn).toBe('save_pos_combo')
  expect(args.p_combo).toMatchObject({
    client_id: 'client-1', name: 'Veg Momo + Coke', guest_price: 300,
    groups: [
      { name: 'Momo', sort: 0, items: [{ recipe_id: 'veg', extra_price: 0, is_default: false, sort: 0 }] },
      { name: 'Beverage', sort: 1, items: [{ recipe_id: 'coke', extra_price: 0, is_default: false, sort: 0 }] },
    ],
  })
})

it('refuses to save an empty combo and says what is missing', () => {
  renderEditor(emptyCombo())
  fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(screen.getByText(/Give the combo a name/)).toBeInTheDocument()
  expect(screen.getByText(/Type what the guest pays/)).toBeInTheDocument()
  expect(screen.getByText(/Add at least one pick/)).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveFocus()
})

it('shows a refused save as an action error and stays open', async () => {
  supabase.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'combo name taken', hint: 'combo_name_taken' } })
  const { onSaved } = renderEditor(prefillFromDishes(['veg'], 200, recipeById))
  fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(onSaved).not.toHaveBeenCalled()
})
