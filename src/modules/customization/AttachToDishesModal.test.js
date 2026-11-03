import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AttachToDishesModal from './AttachToDishesModal'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

const mockUpserts = []
jest.mock('../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedUpsert: (table, rows) => { mockUpserts.push({ table, rows }); return Promise.resolve({ data: null, error: null }) },
    scopedDelete: () => {
      const q = { in: () => q, select: () => Promise.resolve({ data: [], error: null }) }
      return q
    },
  }),
}))

afterEach(() => { mockUpserts.length = 0 })

const extras = { id: 'g1', name: 'Extras', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true }
const dish = (id, name, category) => ({ id, name, category, selling_price: 200, inclPrice: 226, pos_enabled: true })
const dishes = [
  dish('d1', 'Chicken Momo (Steamed)', 'Momo'),
  dish('d2', 'Chicken Momo (Fried)', 'Momo'),
  dish('d3', 'Veg Momo', 'Momo'),
  dish('d4', 'Coke', 'Drinks'),
  dish('d5', 'Lassi', 'Drinks'),
]

function renderModal() {
  const onSaved = jest.fn()
  const catalog = { groups: [extras], options: [], attachments: [] }
  render(<AttachToDishesModal group={extras} dishes={dishes} attachments={[]} catalog={catalog}
    onClose={() => {}} onSaved={onSaved} />)
  return { onSaved }
}

// A dish's checkbox is named by its whole label: the dish, then its price.
const box = name => screen.getByRole('checkbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')} NPR`) })

it('S863: Select all under a search ticks only the dishes shown, and says how many', () => {
  renderModal()
  fireEvent.change(screen.getByLabelText('Search dishes by name or category'), { target: { value: 'momo' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select all 3 shown' }))
  expect(box('Veg Momo')).toBeChecked()
  expect(box('Chicken Momo (Fried)')).toBeChecked()
  expect(screen.getByRole('button', { name: 'Save (3 changes)' })).toBeInTheDocument()

  // Clearing the search brings the drinks back, still unticked.
  fireEvent.change(screen.getByLabelText('Search dishes by name or category'), { target: { value: '' } })
  expect(box('Coke')).not.toBeChecked()
  expect(box('Lassi')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument()
})

it('S863: Clear all under a search unticks only the dishes shown', () => {
  renderModal()
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Search dishes by name or category'), { target: { value: 'drinks' } })
  fireEvent.click(screen.getByRole('button', { name: 'Clear all 2 shown' }))
  fireEvent.change(screen.getByLabelText('Search dishes by name or category'), { target: { value: '' } })
  expect(box('Coke')).not.toBeChecked()
  expect(box('Veg Momo')).toBeChecked()
  expect(screen.getByRole('button', { name: 'Save (3 changes)' })).toBeInTheDocument()
})

it('S863: a search with no match offers no Select all at all', () => {
  renderModal()
  fireEvent.change(screen.getByLabelText('Search dishes by name or category'), { target: { value: 'pizza' } })
  expect(screen.queryByRole('button', { name: /Select all|Clear all/ })).not.toBeInTheDocument()
})

it('S863: Save with nothing changed stays pressable and says why, and writes nothing', () => {
  renderModal()
  const save = screen.getByRole('button', { name: 'No changes' })
  expect(save).not.toBeDisabled()
  expect(save).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(save)
  expect(screen.getByText('Nothing to save yet. Tick or untick a dish first.')).toBeInTheDocument()
  expect(mockUpserts).toHaveLength(0)
  fireEvent.click(box('Coke'))
  expect(screen.queryByText('Nothing to save yet. Tick or untick a dish first.')).not.toBeInTheDocument()
})

it('S863: a second press while saving writes once', async () => {
  const { onSaved } = renderModal()
  fireEvent.click(box('Coke'))
  const save = screen.getByRole('button', { name: 'Save (1 change)' })
  fireEvent.click(save)
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ added: 1, removed: 0 }))
  expect(mockUpserts).toHaveLength(1)
})

it('S863: a dish name is not cut off with an ellipsis', () => {
  renderModal()
  const name = screen.getByText('Chicken Momo (Steamed)')
  expect(name.style.textOverflow).toBe('')
  expect(name.style.whiteSpace).toBe('')
})

// S867: a Size group put on dishes shows each ticked dish's price at every size, so a full menu
// price typed as a difference (Full at dish + 250 rather than 250) is seen before Save.
describe('a Size group', () => {
  const size = { id: 'g-size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, is_active: true }
  const sizes = [
    { id: 's1', group_id: 'g-size', name: 'Half', price_delta: -50, is_removal: false, is_active: true, sort: 0 },
    { id: 's2', group_id: 'g-size', name: 'Full', price_delta: 250, is_removal: false, is_active: true, sort: 1 },
    { id: 's3', group_id: 'g-size', name: 'Family', price_delta: 500, is_removal: false, is_active: false, sort: 2 },
  ]
  // A PAN-bill dish (no VAT) and a 13% one, already carrying the group.
  const tikka = { id: 'p1', name: 'Paneer Tikka', category: 'Grill', selling_price: 250, inclPrice: 250, pos_enabled: true }
  const thali = { id: 'p2', name: 'Veg Thali', category: 'Meals', selling_price: 220, inclPrice: 248.6, pos_enabled: true }
  const attached = [{ id: 'a1', recipe_id: 'p2', group_id: 'g-size', sort: 0 }]

  function renderSize() {
    const catalog = { groups: [size], options: sizes, attachments: attached }
    render(<AttachToDishesModal group={size} dishes={[tikka, thali]} attachments={attached} catalog={catalog}
      onClose={() => {}} onSaved={() => {}} />)
  }

  it('shows each shown size at its price on a ticked dish, and nothing on an unticked one', () => {
    renderSize()
    expect(box('Paneer Tikka')).not.toHaveAttribute('aria-describedby')
    fireEvent.click(box('Paneer Tikka'))
    // The hidden Family size is not offered, so it is not listed.
    expect(box('Paneer Tikka')).toHaveAccessibleDescription('Half NPR 200 · Full NPR 500')
    // The difference takes the dish's own VAT: (220 − 50) × 1.13 and (220 + 250) × 1.13.
    expect(box('Veg Thali')).toHaveAccessibleDescription('Half NPR 192 · Full NPR 531')
    // Each price is one unbroken atom, so a narrow phone wraps between sizes, never inside one.
    expect(screen.getByText('NPR 500')).toHaveStyle({ whiteSpace: 'nowrap' })
  })

  it('keeps the price line out of the checkbox name, and drops it on untick', () => {
    renderSize()
    expect(screen.getByRole('checkbox', { name: 'Veg Thali NPR 249' })).toHaveAttribute('aria-describedby', 'atd-sizes-p2')
    fireEvent.click(box('Veg Thali'))
    expect(box('Veg Thali')).not.toBeChecked()
    expect(box('Veg Thali')).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText('NPR 531')).toBeNull()
  })

  it('is not shown for a group of another kind', () => {
    renderModal()
    fireEvent.click(box('Coke'))
    expect(box('Coke')).not.toHaveAttribute('aria-describedby')
  })
})
