import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import TaxPoolTab from './TaxPoolTab'
import { supabase } from '../../../supabaseClient'

// S858: the tax pool Post was `disabled` for a login without the rank, so it took no focus, its Tip
// (the one place saying why) was out of reach and a press did nothing. It is aria-disabled now, the
// S857 Depreciation Runs pattern, and the press says why. These pin that, and that the confirm a
// login with the rank gets in front of the post is still there.

jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: {} } }))

let mockCanPost = true
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', hasImsAccess: () => mockCanPost }),
}))
jest.mock('../../../shared/hooks/useBizInfo', () => ({
  useBizInfo: () => ({ name: 'Test Cafe', ready: true, error: null }),
}))
// The openings card does its own reads and has its own tests of nothing here; out of the way.
jest.mock('./TaxPoolOpeningsCard', () => () => null)

// A chainable stand-in for a scoped query: every filter returns itself, a paged read answers on
// .range(), and a plain read answers when awaited. Every table is empty: no repairs, no posted
// years, no typed openings, no assets, which still gives a schedule with every pool at 0.
function mockQuery() {
  const q = {}
  for (const m of ['eq', 'lte', 'gte', 'order', 'in', 'select', 'neq', 'limit']) q[m] = () => q
  q.range = () => Promise.resolve({ data: [], error: null })
  q.then = (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return q
}
const mockInsert = jest.fn()
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: () => mockQuery(), scopedInsert: (...a) => mockInsert(...a), scopedDelete: () => mockQuery() }),
}))

beforeEach(() => {
  mockCanPost = true
  mockInsert.mockReset()
  supabase.rpc.mockReset()
  supabase.rpc.mockResolvedValue({ data: null, error: null })
})

async function previewTheYear() {
  const preview = screen.getByRole('button', { name: 'Preview' })
  // Preview is held (aria-disabled) until the year's repair list has loaded.
  await waitFor(() => expect(preview).not.toHaveAttribute('aria-disabled'))
  fireEvent.click(preview)
  return screen.findByRole('button', { name: 'Post' })
}

test('a login that cannot post keeps a pressable Post that says why, and nothing is asked or written', async () => {
  mockCanPost = false
  render(<TaxPoolTab />)
  const post = await previewTheYear()
  expect(post).toHaveAttribute('aria-disabled', 'true')
  expect(post).not.toBeDisabled()

  fireEvent.click(post)
  expect(await screen.findByRole('alert')).toHaveTextContent(/Only a Manager or Owner login can post a tax pool schedule/)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(supabase.rpc).not.toHaveBeenCalled()
})

test('a login with the rank is still asked first, and posts only on confirm', async () => {
  render(<TaxPoolTab />)
  const post = await previewTheYear()
  expect(post).not.toHaveAttribute('aria-disabled')

  fireEvent.click(post)
  // The year on screen is the current one, so the first question is that it has not ended.
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/has not ended/)
  expect(supabase.rpc).not.toHaveBeenCalled()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Post anyway' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('post_tax_pool_run', expect.objectContaining({ p_client_id: 'c1' })))
  expect(await screen.findByText(/tax pool schedule locked for FY/)).toBeInTheDocument()
})
