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
    scopedInsert: () => Promise.resolve({ data: null, error: null }),
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
  expect(await screen.findByText(/Test Bowl must pick 2 from “Toppings”, which offers only 1 option\./)).toBeInTheDocument()
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
