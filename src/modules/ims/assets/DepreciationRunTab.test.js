import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import DepreciationRunTab from './DepreciationRunTab'
import { supabase } from '../../../supabaseClient'

// S857: a regular depreciation run used to post at one press when no earlier run overlapped it,
// the one permanent write in Suite Pro with no confirm. These pin the single dialog every Post now
// goes through, and the pressable-but-refusing Post a login without the rank gets.

jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: {} } }))

let mockCanPost = true
let mockPostedRuns = []
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', hasImsAccess: () => mockCanPost }),
}))

const mockAsset = {
  id: 'a1', asset_code: 'FA-1', name: 'Oven', status: 'active',
  quantity: 1, unit_cost: 120000, total_cost: 120000, salvage_value: 0,
  acquisition_date: '2024-07-16', useful_life_years: 10, assets_categories: { name: 'Kitchen' },
}
const mockRowsFor = table => (table === 'assets_register' ? [mockAsset] : table === 'assets_depreciation_runs' ? mockPostedRuns : [])
// A chainable stand-in for a scoped query: every filter returns itself, a paged read answers on
// .range(), and a plain read answers when awaited.
function mockQuery(table) {
  const q = {}
  for (const m of ['eq', 'lte', 'gte', 'order', 'in', 'select', 'neq', 'limit']) q[m] = () => q
  q.range = from => Promise.resolve({ data: from === 0 ? mockRowsFor(table) : [], error: null })
  q.then = (ok, bad) => Promise.resolve({ data: mockRowsFor(table), error: null }).then(ok, bad)
  return q
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => ({ scopedFrom: table => mockQuery(table) }) }))

beforeEach(() => {
  mockCanPost = true
  mockPostedRuns = []
  supabase.rpc.mockReset()
  supabase.rpc.mockResolvedValue({ data: null, error: null })
})

async function previewAYear() {
  const fill = screen.getByLabelText(/Fill from BS/)
  const firstYear = within(fill).getAllByRole('option')[1]
  fireEvent.change(fill, { target: { value: firstYear.value } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
  return screen.findByRole('button', { name: 'Post' })
}

test('a regular run asks first, naming the money, the assets and the period, and posts only on confirm', async () => {
  const onOpenTab = jest.fn()
  render(<DepreciationRunTab assets={[mockAsset]} onReload={jest.fn()} onOpenTab={onOpenTab} />)
  fireEvent.click(await previewAYear())

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Post this depreciation run?')).toBeInTheDocument()
  expect(dialog.textContent).toMatch(/NPR [\d,]+ of depreciation on 1 asset/)
  expect(dialog.textContent).toMatch(/cannot be edited afterwards/)
  expect(supabase.rpc).not.toHaveBeenCalled()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Post depreciation' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('post_asset_depreciation_run', expect.objectContaining({ p_client_id: 'c1' })))
  expect(await screen.findByText(/Depreciation posted/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open the Valuation Report' }))
  expect(onOpenTab).toHaveBeenCalledWith('valuation')
})

test('an overlap is folded into the same one dialog, not asked as a second question', async () => {
  mockPostedRuns = [{ id: 'r1', period_start: '2026-07-17', period_end: '2026-08-16', posted_at: '2026-08-20T05:00:00Z', notes: null }]
  render(<DepreciationRunTab assets={[mockAsset]} onReload={jest.fn()} />)
  fireEvent.click(await previewAYear())

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('This period already has depreciation posted')).toBeInTheDocument()
  expect(dialog.textContent).toMatch(/NPR [\d,]+ of depreciation on 1 asset/)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Post depreciation again' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a login that cannot post keeps a pressable Post that says why, and nothing is asked or written', async () => {
  mockCanPost = false
  render(<DepreciationRunTab assets={[mockAsset]} onReload={jest.fn()} />)
  const post = await previewAYear()
  expect(post).toHaveAttribute('aria-disabled', 'true')
  expect(post).not.toBeDisabled()

  fireEvent.click(post)
  expect(await screen.findByRole('alert')).toHaveTextContent(/Only a Manager or Owner login can post/)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(supabase.rpc).not.toHaveBeenCalled()
})
