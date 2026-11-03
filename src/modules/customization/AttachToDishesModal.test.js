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
