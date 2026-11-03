import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ComboEditorModal from './ComboEditorModal'
import ComboDishPicker from './ComboDishPicker'
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

it('shows the share of the price each part takes, and saves the contract payload', async () => {
  supabase.rpc.mockResolvedValue({ data: 'new-combo-id', error: null })
  const { onSaved } = renderEditor(prefillFromDishes(['veg', 'coke'], 300, recipeById))
  // Weighed 226 : 113 (each dish on its own, VAT included), so two thirds and one third of 300.
  expect(screen.getByText('NPR 200')).toBeInTheDocument()
  expect(screen.getByText('NPR 100')).toBeInTheDocument()
  // 226 + 113 = 339 on their own, against 300 for the combo.
  expect(screen.getByText('A guest who takes the cheapest dish in every part saves NPR 39 against ordering them on their own.')).toBeInTheDocument()
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
  expect(screen.getByText(/Add at least one part/)).toBeInTheDocument()
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

// S863: the pressed Save stays enabled (a disabled button drops keyboard focus to the page), wears
// aria-busy, and turns a second press away itself.
it('Save stays pressable while it writes, and a second press sends nothing more', async () => {
  supabase.rpc.mockResolvedValue({ data: 'new-combo-id', error: null })
  const { onSaved } = renderEditor(prefillFromDishes(['veg'], 200, recipeById))
  const save = screen.getByRole('button', { name: 'Create combo' })
  fireEvent.click(save)
  expect(save).toHaveAttribute('aria-busy', 'true')
  expect(save).not.toBeDisabled()
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(supabase.rpc).toHaveBeenCalledTimes(1)
})

it('the Parts heading is named "Parts", with its Tip beside it rather than inside', () => {
  renderEditor(prefillFromDishes(['veg'], 200, recipeById))
  expect(screen.getByRole('heading', { name: 'Parts' })).toBeInTheDocument()
  expect(screen.getByText('About parts')).toBeInTheDocument()
})

// S867 word list: a slot the guest fills is a part, never a pick.
it('calls each slot a part: its label, its section and the add button', () => {
  renderEditor(prefillFromDishes(['veg', 'coke'], 300, recipeById))
  expect(screen.getByRole('textbox', { name: 'Part 1' })).toHaveValue('Momo')
  expect(screen.getByRole('region', { name: 'Part 2' })).toHaveTextContent('Coke')
  expect(screen.getByRole('button', { name: '+ Add a part' })).toBeInTheDocument()
  expect(screen.queryByText(/\bPick \d|Add a pick|^Picks$/)).toBeNull()
})

// S867: the line under the price says whether the combo is a deal, to the paisa, against the cheapest
// dish of every part ordered on its own (Veg Momo 226 + Coke 113 = 339, VAT included).
describe('whether the combo is a deal', () => {
  const at = price => prefillFromDishes(['veg', 'coke'], price, recipeById)

  it('says what guests save when the combo costs less, with no warning mark', () => {
    renderEditor(at(338.5))
    expect(screen.getByText('A guest who takes the cheapest dish in every part saves NPR 0.50 against ordering them on their own.')).toBeInTheDocument()
    expect(screen.queryByText(/△ A guest/)).toBeNull()
  })

  it('warns with the △ mark when the combo costs more', () => {
    renderEditor(at(350))
    expect(screen.getByText('△ A guest who takes the cheapest dish in every part pays NPR 11 more than ordering them on their own.')).toBeInTheDocument()
  })

  it('says so when the price is the same', () => {
    renderEditor(at(339))
    expect(screen.getByText('Same price as ordering the cheapest dish in every part on its own.')).toBeInTheDocument()
    expect(screen.queryByText(/△ A guest/)).toBeNull()
  })

  it('follows the price as it is typed', () => {
    renderEditor(at(300))
    fireEvent.change(screen.getByLabelText(/Price the guest pays/), { target: { value: '339.01' } })
    expect(screen.getByText(/pays NPR 0\.01 more/)).toBeInTheDocument()
  })

  it('says nothing while a part has no dish with a menu price', () => {
    renderEditor(at(300), { dishes: dishes.map(d => (d.id === 'coke' ? { ...d, guestPrice: 0 } : d)) })
    expect(screen.queryByText(/saves NPR|pays NPR|Same price/)).toBeNull()
  })
})

// S863: ids were built from the category name with [a-z0-9] kept, so every Devanagari category came
// out as "cdp--" and each section was named after the first one.
it('names each category of the dish picker after itself, Devanagari names included', () => {
  const nepali = [
    { id: 'm1', name: 'Buff Momo', category: 'मःम', guestPrice: 226, is_active: true },
    { id: 'p1', name: 'Lassi', category: 'पेय', guestPrice: 113, is_active: true },
  ]
  render(<ComboDishPicker pickName="Pick one" dishes={nepali} chosen={[]} onClose={() => {}} onDone={() => {}} />)
  expect(screen.getByRole('region', { name: 'मःम' })).toHaveTextContent('Buff Momo')
  expect(screen.getByRole('region', { name: 'पेय' })).toHaveTextContent('Lassi')
})

// S867: a dish name wraps rather than being cut off with a title a touch screen never shows.
it('lets a long dish name wrap in the dish picker, and calls an unnamed slot this part', () => {
  const long = 'Chicken Momo (Steamed, with Jhol Achar and Sesame)'
  const list = [{ id: 'm1', name: long, category: 'Momo', guestPrice: 226, is_active: true, pos_enabled: false }]
  render(<ComboDishPicker pickName="" dishes={list} chosen={[]} onClose={() => {}} onDone={() => {}} />)
  const name = screen.getByText(long)
  expect(name).not.toHaveAttribute('title')
  expect(name.style.whiteSpace).not.toBe('nowrap')
  expect(name.style.textOverflow).toBe('')
  expect(screen.getByRole('dialog', { name: 'Dishes in “this part”' })).toBeInTheDocument()
  expect(screen.getByText(/Tick every dish a guest may choose for this part/)).toBeInTheDocument()
  expect(screen.getByText('not sold alone')).toBeInTheDocument()
})
