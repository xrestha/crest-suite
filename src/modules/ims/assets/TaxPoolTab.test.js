import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import TaxPoolTab from './TaxPoolTab'
import { supabase } from '../../../supabaseClient'
import { getBsToday, getBsFiscalYearStart, getBsFiscalYear, daysInBsMonth, bsToAd, formatAd } from '../../../utils/bsCalendar'
import { POOL_LABELS } from './taxPoolConstants'

// S858: the tax pool Post was `disabled` for a login without the rank, so it took no focus, its Tip
// (the one place saying why) was out of reach and a press did nothing. It is aria-disabled now, the
// S857 Depreciation Runs pattern, and the press says why. These pin that, and that the confirm a
// login with the rank gets in front of the post is still there.
//
// S887: a post with nothing to warn about locked the schedule at a single press. Every post now ends
// with ONE summary dialog naming the year, every pool and the total; Cancel sends nothing. And the
// repair-expense writes are bounded: a lost answer reads as not known yet, never as not added.

jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: {} } }))

let mockCanPost = true
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', hasImsAccess: () => mockCanPost }),
}))
jest.mock('../../../shared/hooks/useBizInfo', () => ({
  useBizInfo: () => ({ name: 'Test Cafe', ready: true, error: null }),
}))
// The openings card does its own reads and has its own tests; out of the way.
jest.mock('./TaxPoolOpeningsCard', () => () => null)
// The BS calendar grid is its own component with its own tests; a plain box stands in, handing the
// page the stored AD string the real picker hands back.
jest.mock('../../../components/BsCalendarPicker', () => props => (
  <input aria-label={props.ariaLabel} value={props.value || ''} onChange={e => props.onChange(e.target.value)} />
))

// A chainable stand-in for a scoped query: every filter returns itself, a paged read answers on
// .range(), and a plain read answers when awaited. By default every table is empty: no repairs, no
// posted years, no typed openings, no assets, which still gives a schedule with every pool at 0.
// A test puts rows in `mockRows[table]`; filters are not applied, so each table holds only rows the
// test means every read of it to see.
let mockRows = {}
function mockQuery(table) {
  const rows = () => ({ data: mockRows[table] || [], error: null })
  const q = {}
  for (const m of ['eq', 'lte', 'gte', 'order', 'in', 'select', 'neq', 'limit']) q[m] = () => q
  q.range = () => Promise.resolve(rows())
  q.then = (ok, bad) => Promise.resolve(rows()).then(ok, bad)
  return q
}
const mockInsert = jest.fn()
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: table => mockQuery(table), scopedInsert: (...a) => mockInsert(...a), scopedDelete: table => mockQuery(table) }),
}))

const today = getBsToday()
const thisFy = getBsFiscalYearStart(today.year, today.month)
const lastFy = thisFy - 1
const lastLabel = getBsFiscalYear(lastFy, 4)

// What withTimeout hands back when the clock runs out.
const timedOut = () => Object.assign(new Error('Request timed out after 20s'), { name: 'TimeoutError' })

beforeEach(() => {
  mockCanPost = true
  mockRows = {}
  mockInsert.mockReset()
  mockInsert.mockResolvedValue({ data: null, error: null })
  supabase.rpc.mockReset()
  supabase.rpc.mockResolvedValue({ data: null, error: null })
})

async function repairsLoaded() {
  const preview = screen.getByRole('button', { name: 'Preview' })
  // Preview is held (aria-disabled) until the year's repair list has loaded.
  await waitFor(() => expect(preview).not.toHaveAttribute('aria-disabled'))
  return preview
}

async function previewTheYear() {
  fireEvent.click(await repairsLoaded())
  return screen.findByRole('button', { name: 'Post' })
}

// Last year has ended, so nothing about it is asked before the summary.
async function previewLastYear() {
  fireEvent.change(screen.getByRole('combobox', { name: /Fiscal Year/ }), { target: { value: String(lastFy) } })
  return previewTheYear()
}

// One Pool B asset bought on the first day of last year: NPR 1,00,000 at the full rate, so 25% of it
// (NPR 25,000) is that pool's depreciation, and it closes at NPR 75,000.
function oneAssetLastYear() {
  mockRows.assets_register = [{
    id: 'a1', asset_code: 'FA-001', name: 'Coffee machine', tax_pool: 'B', status: 'active',
    acquisition_date: formatAd(bsToAd(lastFy, 4, 1)), total_cost: 100000, disposal_date: null, disposal_proceeds: null,
  }]
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

test('with nothing to warn about, Post still asks once, naming the year, every pool and the total', async () => {
  oneAssetLastYear()
  render(<TaxPoolTab />)
  fireEvent.click(await previewLastYear())

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(`Post the tax pool schedule for FY ${lastLabel}?`)).toBeInTheDocument()
  const text = dialog.textContent
  // The year, in BS, with its first and last day.
  expect(text).toContain(`FY ${lastLabel} (1 Shrawan ${lastFy} to ${daysInBsMonth(lastFy + 1, 3)} Ashadh ${lastFy + 1})`)
  // Every pool being posted, each with its figure.
  for (const p of ['A', 'B', 'C', 'D', 'E']) expect(text).toContain(POOL_LABELS[p])
  expect(text).toContain(`${POOL_LABELS.B}: NPR 25,000`)
  expect(text).toContain(`${POOL_LABELS.A}: NPR 0`)
  // The total, what next year opens from, and the lock.
  expect(text).toMatch(/Total tax depreciation: NPR 25,000/)
  expect(text).toContain(`close at NPR 75,000 in all, the value FY ${getBsFiscalYear(lastFy + 1, 4)} opens from`)
  expect(text).toMatch(/locked and cannot be edited afterwards/)
  expect(supabase.rpc).not.toHaveBeenCalled()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Post schedule' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('post_tax_pool_run', expect.objectContaining({
    p_client_id: 'c1', p_fiscal_year: lastLabel,
    p_lines: expect.arrayContaining([expect.objectContaining({ pool: 'B', depreciation_amount: 25000, closing_wdv: 75000 })]),
  })))
  expect(await screen.findByText(new RegExp(`tax pool schedule locked for FY ${lastLabel}`))).toBeInTheDocument()
})

test('Cancel on the summary posts nothing, and the next Post asks again', async () => {
  oneAssetLastYear()
  render(<TaxPoolTab />)
  const post = await previewLastYear()
  fireEvent.click(post)

  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(mockInsert).not.toHaveBeenCalled()
  expect(screen.queryByText(/tax pool schedule locked/)).not.toBeInTheDocument()

  // The preview is still on screen; a second press asks again rather than posting.
  fireEvent.click(screen.getByRole('button', { name: 'Post' }))
  expect(await screen.findByRole('dialog')).toHaveTextContent(`Post the tax pool schedule for FY ${lastLabel}?`)
  expect(supabase.rpc).not.toHaveBeenCalled()
})

test('an earlier question is kept, and the summary is still the last step', async () => {
  render(<TaxPoolTab />)
  const post = await previewTheYear()
  expect(post).not.toHaveAttribute('aria-disabled')

  fireEvent.click(post)
  // The year on screen is the current one, so the first question is that it has not ended.
  const first = await screen.findByRole('dialog')
  expect(first.textContent).toMatch(/has not ended/)
  fireEvent.click(within(first).getByRole('button', { name: 'Post anyway' }))

  // Answering it does not post: the summary follows.
  const summary = await screen.findByText(`Post the tax pool schedule for FY ${getBsFiscalYear(thisFy, 4)}?`)
  const dialog = summary.closest('[role="dialog"]')
  expect(dialog.textContent).toMatch(/Total tax depreciation: NPR 0/)
  expect(supabase.rpc).not.toHaveBeenCalled()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Post schedule' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('post_tax_pool_run', expect.objectContaining({ p_client_id: 'c1' })))
  expect(await screen.findByText(/tax pool schedule locked for FY/)).toBeInTheDocument()
})

test('a year already posted is named inside the same one summary, not asked as another question', async () => {
  oneAssetLastYear()
  mockRows.assets_tax_pool_runs = [{ id: 'r1', fiscal_year: lastLabel, status: 'posted', created_at: '2026-08-01T05:00:00Z', posted_at: '2026-08-01T05:00:00Z' }]
  render(<TaxPoolTab />)
  fireEvent.click(await previewLastYear())

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(`FY ${lastLabel} already has a posted schedule`)).toBeInTheDocument()
  expect(dialog.textContent).toMatch(/Total tax depreciation: NPR 25,000/)
  expect(dialog.textContent).toMatch(/adds a second locked schedule beside it/)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Post a second schedule' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a repair expense whose answer never came back reads as not known yet, and the form keeps it', async () => {
  mockInsert.mockResolvedValue({ data: null, error: timedOut() })
  render(<TaxPoolTab />)
  await repairsLoaded()

  fireEvent.change(screen.getByLabelText('Repair expense date'), { target: { value: formatAd(bsToAd(thisFy, 4, 2)) } })
  fireEvent.change(screen.getByLabelText('Repair expense amount (NPR)'), { target: { value: '5000' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/whether the repair expense was added is not known yet/)
  expect(alert).not.toHaveTextContent(/was not added/)
  expect(mockInsert).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Repair expense amount (NPR)')).toHaveValue(5000)
})
