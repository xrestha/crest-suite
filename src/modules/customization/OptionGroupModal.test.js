import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OptionGroupModal from './OptionGroupModal'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

const mockWrites = []
jest.mock('../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedUpdate: (table, row) => {
      mockWrites.push({ table, row })
      const q = { eq: () => q, select: () => Promise.resolve({ data: [{ id: 'g1', ...row }], error: null }) }
      return q
    },
    scopedInsert: (table, row) => {
      mockWrites.push({ table, row, insert: true })
      return Promise.resolve({ data: [{ id: 'g-new', ...row }], error: null })
    },
  }),
}))

afterEach(() => { mockWrites.length = 0 })

const bowl = { id: 'bowl', name: 'Test Bowl', selling_price: 300, inclPrice: 339 }

function renderGroup(group, catalog, dishes = [bowl]) {
  const onSaved = jest.fn()
  render(<OptionGroupModal group={group} attachedCount={dishes.length} nextSort={1} catalog={catalog}
    attachedDishes={dishes} onClose={() => {}} onSaved={onSaved} />)
  return { onSaved }
}

it('SETUP-4: a group holding a “No …” choice is not turned into a Size, and says why before the write', () => {
  const extras = { id: 'g1', name: 'Extras', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true, size_scaling: 'none' }
  const options = [
    { id: 'o1', group_id: 'g1', name: 'Extra cheese', price_delta: 50, is_removal: false, is_active: true },
    { id: 'o2', group_id: 'g1', name: 'No onion', price_delta: 0, is_removal: true, is_active: true },
  ]
  renderGroup({ ...extras, options }, { groups: [extras], options, attachments: [{ recipe_id: 'bowl', group_id: 'g1' }] })
  fireEvent.click(screen.getByRole('radio', { name: /^Size/ }))
  expect(screen.getByText(/This group has a “No …” choice, and a size cannot be one/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(mockWrites).toHaveLength(0)
})

it('SETUP-3: a minimum above what the group offers asks first, then saves', async () => {
  const toppings = { id: 'g1', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true, size_scaling: 'none' }
  const options = [{ id: 't1', group_id: 'g1', name: 'Granola', price_delta: 20, is_removal: false, is_active: true }]
  const { onSaved } = renderGroup({ ...toppings, options }, { groups: [toppings], options, attachments: [{ id: 'a1', recipe_id: 'bowl', group_id: 'g1', sort: 0 }] })
  fireEvent.change(screen.getByLabelText('How many the guest must choose'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(await screen.findByText(/Test Bowl must pick 2 from “Toppings”, which offers only 1 choice\./)).toBeInTheDocument()
  expect(mockWrites).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(mockWrites[0].row.min_select).toBe(2)
})

it('SETUP-3: ticking Shown on a hidden group that takes a dish below zero is refused', () => {
  const portion = { id: 'g1', name: 'Portion', kind: 'size', min_select: 1, max_select: 1, included_count: 0, is_active: false, size_scaling: 'none' }
  const options = [
    { id: 'h', group_id: 'g1', name: 'Half', price_delta: -100, is_removal: false, is_active: true, sort: 0 },
    { id: 'f', group_id: 'g1', name: 'Full', price_delta: 0, is_removal: false, is_active: true, sort: 1 },
  ]
  const kids = { id: 'kids', name: 'Kids Momo', selling_price: 80, inclPrice: 90.4 }
  renderGroup({ ...portion, options }, { groups: [portion], options, attachments: [{ id: 'a1', recipe_id: 'kids', group_id: 'g1', sort: 0 }] }, [kids])
  fireEvent.click(screen.getByLabelText(/Shown on the till/))
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(screen.getByText(/“Portion” is still hidden\. Kids Momo would cost −NPR 23 with “Half”/)).toBeInTheDocument()
  expect(mockWrites).toHaveLength(0)
})

// S863: the pressed Save stays enabled (a disabled button drops keyboard focus to the page), wears
// aria-busy, and turns a second press away itself.
it('Save stays pressable while it writes, and a second press sends nothing more', async () => {
  const extras = { id: 'g1', name: 'Extras', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true, size_scaling: 'none' }
  const options = [{ id: 'o1', group_id: 'g1', name: 'Extra cheese', price_delta: 50, is_removal: false, is_active: true }]
  const { onSaved } = renderGroup({ ...extras, options }, { groups: [extras], options, attachments: [{ id: 'a1', recipe_id: 'bowl', group_id: 'g1', sort: 0 }] })
  const save = screen.getByRole('button', { name: 'Save group' })
  fireEvent.click(save)
  expect(save).toHaveAttribute('aria-busy', 'true')
  expect(save).not.toBeDisabled()
  fireEvent.click(save)
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(mockWrites).toHaveLength(1)
})

// `.field-label` is styled only inside a `.form-field`, so outside one it rendered as body text.
const fieldOf = el => el.closest('.form-field') // eslint-disable-line testing-library/no-node-access

it('the "What is it?" and size captions sit in a form field, styled as "Name" is', () => {
  // S867: the size caption shows only where a build-your-own dish exists.
  renderGroup(null, { groups: [], options: [], attachments: [], buildYourOwn: ['bowl'] }, [])
  expect(fieldOf(screen.getByText('What is it?'))).not.toBeNull()
  expect(fieldOf(screen.getByText('When a bigger size is picked'))).not.toBeNull()
  expect(screen.getByRole('radiogroup', { name: 'What is it?' })).toBeInTheDocument()
})

// ── S867 ──

const noByo = { groups: [], options: [], attachments: [], buildYourOwn: [] }

it('S867: a new group on a client with no build-your-own dish hides the size chooser and saves no scaling', async () => {
  const { onSaved } = renderGroup(null, noByo, [])
  expect(screen.getByRole('dialog', { name: 'New choice group' })).toBeInTheDocument()
  expect(screen.queryByText('When a bigger size is picked')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Extras' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-new', name: 'Extras', kind: 'addon' })))
  expect(mockWrites[0].row).not.toHaveProperty('size_scaling')
})

it('S867: a group that already scales keeps the chooser, so it can be set back', () => {
  const toppings = { id: 'g1', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 0, is_active: true, size_scaling: 'stock' }
  renderGroup({ ...toppings, options: [] }, { ...noByo, groups: [toppings] }, [])
  expect(screen.getByText('When a bigger size is picked')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Scale stock only' })).toHaveAttribute('aria-checked', 'true')
})

it('S867: the kind stored as choice reads Preference, and Size says to go on dishes first', () => {
  renderGroup(null, noByo, [])
  expect(screen.getByRole('radio', { name: /^Preference/ })).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: /^Choice/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: /^Size/ }))
  expect(screen.getByText(/Put the group on its dishes before you add the sizes, so each size takes its full menu price\./)).toBeInTheDocument()
})

it('S867: the buttons sit outside the scrolling body, so Create stays on a short screen', () => {
  renderGroup(null, noByo, [])
  const scroller = screen.getByLabelText('Name').closest('[style*="overflow-y"]') // eslint-disable-line testing-library/no-node-access
  expect(scroller).not.toBeNull()
  expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Create group' }))
  expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Cancel' }))
})
