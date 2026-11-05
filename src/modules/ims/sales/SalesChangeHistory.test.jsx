/**
 * Sales Entry's Change history tab (S885): a failed read is a failed read with a retry, an empty
 * month says the record has a start, Load more carries on from the oldest row shown, and a month
 * switched mid-read never lands the old month's rows.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import SalesChangeHistory from './SalesChangeHistory'
import { HISTORY_PAGE_SIZE } from './salesHistoryRows'

const mockCalls = []
let mockAnswer = () => Promise.resolve({ data: [], error: null })

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => { mockCalls.push({ name, args }); return mockAnswer(args) },
  },
}))

const period = (id, bs_month = 7) => ({ id, bs_year: 2083, bs_month, status: 'open' })
const row = (id, o = {}) => ({
  id, bs_day: 3, recipe_id: 'r1', recipe_name: `Dish ${id}`, old_qty: 2, new_qty: 5,
  old_value: 600, new_value: 1500, changed_by_name: 'Sita', changed_at: '2026-11-04T08:15:00Z', ...o,
})

beforeEach(() => {
  mockCalls.length = 0
  mockAnswer = () => Promise.resolve({ data: [], error: null })
})

test('asks for the month, newest first, and says the record has a start when nothing is listed', async () => {
  render(<SalesChangeHistory period={period('p1')} />)
  expect(await screen.findByText(/No changes are recorded for Kartik 2083/)).toBeInTheDocument()
  expect(screen.getByText(/changes made before then are not listed/)).toBeInTheDocument()
  expect(mockCalls).toEqual([{ name: 'get_sales_history', args: { p_period_id: 'p1', p_before_id: null, p_limit: HISTORY_PAGE_SIZE } }])
})

test('a failed read is a report error with a working retry, never an empty month', async () => {
  mockAnswer = () => Promise.resolve({ data: null, error: { code: '42501', hint: 'sales_history_rank', message: 'sales_history_rank: no' } })
  render(<SalesChangeHistory period={period('p1')} />)
  expect(await screen.findByText('Could not load this report')).toBeInTheDocument()
  expect(screen.queryByText(/No changes are recorded/)).not.toBeInTheDocument()
  mockAnswer = () => Promise.resolve({ data: [row(5)], error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Dish 5')).toBeInTheDocument()
})

test('shows the kind in words, the day with its month, Bulk for day 0, and pages with Load more', async () => {
  const first = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => row(1000 - i))
  first[0] = row(1000, { old_qty: null, old_value: null, bs_day: 0 })
  mockAnswer = args => Promise.resolve({ data: args.p_before_id == null ? first : [row(10, { new_qty: null, new_value: null })], error: null })
  render(<SalesChangeHistory period={period('p1')} />)
  expect(await screen.findByText('Dish 1000')).toBeInTheDocument()
  expect(screen.getByText('Added')).toBeInTheDocument()
  expect(screen.getByText('Bulk')).toBeInTheDocument()
  expect(screen.getAllByText('3rd Kartik').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('Dish 10')).toBeInTheDocument()
  expect(mockCalls[1].args).toEqual({ p_period_id: 'p1', p_before_id: 1000 - HISTORY_PAGE_SIZE + 1, p_limit: HISTORY_PAGE_SIZE })
  expect(screen.getByText('Removed')).toBeInTheDocument()
  // A short page was the last one.
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
})

test('a month switched while a read is out never shows the old month', async () => {
  let releaseOld
  mockAnswer = args => (args.p_period_id === 'old'
    ? new Promise(resolve => { releaseOld = () => resolve({ data: [row(1, { recipe_name: 'Old month dish' })], error: null }) })
    : Promise.resolve({ data: [row(2, { recipe_name: 'New month dish' })], error: null }))
  const { rerender } = render(<SalesChangeHistory period={period('old', 6)} />)
  rerender(<SalesChangeHistory period={period('new', 7)} />)
  expect(await screen.findByText('New month dish')).toBeInTheDocument()
  await act(async () => { releaseOld() })
  await waitFor(() => expect(screen.queryByText('Old month dish')).not.toBeInTheDocument())
  expect(screen.getByText('New month dish')).toBeInTheDocument()
})
