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

// S862 COMBOS-6: a new combo whose Save loses its answer may have been created; a second press is then
// refused as a name taken. The list behind the dialog is re-read, and the dialog says what it shows.
describe('a new combo whose save is unclear', () => {
  const lostAnswer = { data: null, error: { message: 'TypeError: Failed to fetch' } }
  const nameTaken = { data: null, error: { code: 'P0001', message: 'combo name taken', hint: 'combo_name_taken' } }

  it('says the combo is in the list when a save with no answer did land', async () => {
    supabase.rpc.mockResolvedValue(lostAnswer)
    const recheckList = jest.fn().mockResolvedValue(true)
    renderEditor(prefillFromDishes(['veg'], 200, recipeById), { recheckList })
    fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
    expect(await screen.findByText(/is now in the combo list behind this window, so this save most likely went through/)).toBeInTheDocument()
    expect(recheckList).toHaveBeenCalledWith('Veg Momo')
  })

  it('says it is not listed yet when the re-read does not show it, without claiming it did not land', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { name: 'TimeoutError', message: 'Saving the combo timed out after 20s' } })
    renderEditor(prefillFromDishes(['veg'], 200, recipeById), { recheckList: jest.fn().mockResolvedValue(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
    expect(await screen.findByText(/is not in it yet\. Wait a moment, then check the list before saving again/)).toBeInTheDocument()
  })

  it('on a name already taken, says a combo of that name is already listed', async () => {
    supabase.rpc.mockResolvedValue(nameTaken)
    renderEditor(prefillFromDishes(['veg'], 200, recipeById), { recheckList: jest.fn().mockResolvedValue(true) })
    fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
    expect(await screen.findByText(/A combo named “Veg Momo” is already in the list behind this window/)).toBeInTheDocument()
  })

  it('says nothing more when the re-read itself failed', async () => {
    supabase.rpc.mockResolvedValue(lostAnswer)
    const failedRead = jest.fn().mockResolvedValue(null)
    renderEditor(prefillFromDishes(['veg'], 200, recipeById), { recheckList: failedRead })
    fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
    await waitFor(() => expect(failedRead).toHaveBeenCalled())
    expect(screen.queryByText(/behind this window/)).toBeNull()
  })

  it('never re-reads for a plain refusal', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'price', hint: 'combo_price_invalid' } })
    const notCalled = jest.fn()
    renderEditor(prefillFromDishes(['veg'], 200, recipeById), { recheckList: notCalled })
    fireEvent.click(screen.getByRole('button', { name: 'Create combo' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(notCalled).not.toHaveBeenCalled()
  })

  it('never re-reads for an edit of a saved combo', async () => {
    supabase.rpc.mockResolvedValue(lostAnswer)
    const notCalled = jest.fn()
    renderEditor({ ...prefillFromDishes(['veg'], 200, recipeById), id: 'combo-1' }, { recheckList: notCalled, isNew: false })
    fireEvent.click(screen.getByRole('button', { name: 'Save combo' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(notCalled).not.toHaveBeenCalled()
  })
})
