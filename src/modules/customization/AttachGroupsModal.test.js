import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AttachGroupsModal from './AttachGroupsModal'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

const mockUpserts = []
jest.mock('../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedFrom: () => ({}),
    scopedUpsert: (table, rows) => { mockUpserts.push({ table, rows }); return Promise.resolve({ data: null, error: null }) },
    scopedDelete: () => {
      const q = { in: () => q, select: () => Promise.resolve({ data: [], error: null }) }
      return q
    },
  }),
}))

const mockCatalog = jest.fn()
jest.mock('./customizationData', () => ({
  ...jest.requireActual('./customizationData'),
  loadOptionCatalog: (...args) => mockCatalog(...args),
}))

afterEach(() => { mockUpserts.length = 0; mockCatalog.mockReset() })

const extras = { id: 'g-extras', name: 'Extras', kind: 'addon', min_select: 0, max_select: 3, included_count: 0, is_active: true }
const spice = { id: 'g-spice', name: 'Spice', kind: 'addon', min_select: 0, max_select: 1, included_count: 0, is_active: true }
const options = [
  { id: 'o1', group_id: 'g-extras', name: 'Extra cheese', price_delta: 40, is_removal: false, is_active: true },
  { id: 'o2', group_id: 'g-spice', name: 'Hot', price_delta: 0, is_removal: false, is_active: true },
]
const momo = { id: 'd1', name: 'Veg Momo', selling_price: 200, inclPrice: 226 }

function renderModal() {
  mockCatalog.mockResolvedValue({
    error: null,
    groups: [extras, spice],
    options,
    attachments: [
      { id: 'a1', recipe_id: 'd1', group_id: 'g-extras', sort: 0, min_override: null, max_override: null, default_option_id: null },
      { id: 'a2', recipe_id: 'd1', group_id: 'g-spice', sort: 1, min_override: null, max_override: null, default_option_id: null },
    ],
    ingredients: [],
    buildYourOwn: [],
  })
  const onSaved = jest.fn()
  render(<AttachGroupsModal recipe={momo} onClose={() => {}} onSaved={onSaved} />)
  return { onSaved }
}

it('S863: each per-dish box names its group, keeping the visible words', async () => {
  renderModal()
  expect(await screen.findByLabelText('Must pick (this dish) from Extras')).toBeInTheDocument()
  expect(screen.getByLabelText('At most (this dish) from Spice')).toBeInTheDocument()
  expect(screen.getByLabelText('Pre-selected on this dish from Extras')).toBeInTheDocument()
})

it('S863: a wrong maximum is tied to the maximum box, and Save focuses that box', async () => {
  renderModal()
  const max = await screen.findByLabelText('At most (this dish) from Extras')
  const min = screen.getByLabelText('Must pick (this dish) from Extras')
  fireEvent.change(max, { target: { value: '0' } })
  expect(max).toHaveAttribute('aria-invalid', 'true')
  expect(min).not.toHaveAttribute('aria-invalid')
  expect(max).toHaveAccessibleDescription('Maximum must be 1 or more.')
  fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
  expect(max).toHaveFocus()
  expect(mockUpserts).toHaveLength(0)
})

it('S863: a minimum above a maximum this dish also set describes both boxes with one message', async () => {
  renderModal()
  const max = await screen.findByLabelText('At most (this dish) from Extras')
  const min = screen.getByLabelText('Must pick (this dish) from Extras')
  fireEvent.change(min, { target: { value: '3' } })
  fireEvent.change(max, { target: { value: '2' } })
  expect(min).toHaveAttribute('aria-invalid', 'true')
  expect(max).toHaveAttribute('aria-invalid', 'true')
  expect(min).toHaveAccessibleDescription('Minimum cannot be above maximum for this dish.')
  expect(max).toHaveAccessibleDescription('Minimum cannot be above maximum for this dish.')
  expect(screen.getAllByText('Minimum cannot be above maximum for this dish.')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
  expect(min).toHaveFocus()
})

it('S863: moving a group to the top keeps focus on its other arrow', async () => {
  renderModal()
  const earlier = await screen.findByRole('button', { name: 'Show Spice earlier' })
  earlier.focus()
  fireEvent.click(earlier)
  expect(screen.getByRole('button', { name: 'Show Spice earlier' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Show Spice later' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Show Spice later' })).toHaveAttribute('title', 'Show Spice later')
})

it('S863: Save pressed while the groups are loading says so instead of doing nothing', async () => {
  mockCatalog.mockReturnValue(new Promise(() => {}))
  render(<AttachGroupsModal recipe={momo} onClose={() => {}} onSaved={() => {}} />)
  const save = screen.getByRole('button', { name: /^Save/ })
  expect(save).not.toBeDisabled()
  expect(save).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(save)
  expect(await screen.findByText('The groups are still loading. Save once they appear.')).toBeInTheDocument()
  expect(mockUpserts).toHaveLength(0)
})

it('S863: a second press while saving writes once', async () => {
  const { onSaved } = renderModal()
  const save = await screen.findByRole('button', { name: 'Save (2 groups)' })
  fireEvent.click(save)
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(2))
  expect(mockUpserts).toHaveLength(1)
})
