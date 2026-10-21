// Which loader the Sales Mix reads (S814). With Inventory in scope it is `sales_entries` in the
// revenue mode; a POS-only Home reads the till's own bills, because an outlet without Crest IMS posts
// nothing to `sales_entries` (4e, IMS-HANDOFF-9) and its mix would otherwise be empty.
import { renderHook, waitFor } from '@testing-library/react'
import { useFoodBeverageSplit } from './useFoodBeverageSplit'
import { loadFromSalesEntries, loadFromPos } from './useSalesPivotData'

jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ clientId: 'c1' }) }))
jest.mock('../../shared/hooks/useScopedDb', () => {
  const scopedFrom = jest.fn()
  return { useScopedDb: () => ({ scopedFrom }) }
})
jest.mock('./useSalesPivotData', () => ({
  loadFromSalesEntries: jest.fn(),
  loadFromPos: jest.fn(),
}))

const PERIOD = { id: 'p1', bs_year: 2083, bs_month: 6 }

beforeEach(() => {
  loadFromSalesEntries.mockReset().mockResolvedValue([
    { category: 'Food', amount: 900 }, { category: 'Food', amount: -100 }, { category: 'Sub-Recipe', amount: 50 },
  ])
  loadFromPos.mockReset().mockResolvedValue([
    { category: 'Beverage', amount: 1130 }, { category: null, amount: 226 },
  ])
})

test('with Inventory in scope it reads sales_entries in the revenue mode, never the till', async () => {
  const { result } = renderHook(() => useFoodBeverageSplit({ activePeriod: PERIOD, includeManual: true, includePos: false }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(loadFromSalesEntries).toHaveBeenCalledWith(PERIOD, expect.any(Function), { sources: 'revenue' })
  expect(loadFromPos).not.toHaveBeenCalled()
  expect(result.current.buckets).toEqual({ Food: 800 })
})

test('a POS-only Home reads the till bills, so an outlet without Inventory still has a mix', async () => {
  const { result } = renderHook(() => useFoodBeverageSplit({ activePeriod: PERIOD, includeManual: false, includePos: true }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(loadFromPos).toHaveBeenCalledWith(PERIOD, expect.any(Function), 'c1')
  expect(loadFromSalesEntries).not.toHaveBeenCalled()
  expect(result.current.buckets).toEqual({ Beverage: 1130, Uncategorized: 226 })
})

test('when the card stops asking, the old failure clears and a late answer does not repaint it', async () => {
  loadFromPos.mockRejectedValueOnce(new Error('boom'))
  const { result, rerender } = renderHook(props => useFoodBeverageSplit(props), {
    initialProps: { activePeriod: PERIOD, includeManual: false, includePos: true },
  })
  await waitFor(() => expect(result.current.error).toBe('boom'))

  // A second load starts and is still in flight when the card stops asking for a mix.
  let settle
  loadFromPos.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  rerender({ activePeriod: { ...PERIOD, id: 'p2' }, includeManual: false, includePos: true })
  await waitFor(() => expect(result.current.loading).toBe(true))
  expect(result.current.error).toBeNull()

  rerender({ activePeriod: { ...PERIOD, id: 'p2' }, includeManual: false, includePos: false })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBeNull()
  expect(result.current.buckets).toEqual({})

  settle([{ category: 'Beverage', amount: 500 }])
  await new Promise(r => setTimeout(r, 0))
  expect(result.current.buckets).toEqual({})
  expect(result.current.error).toBeNull()
})

test('a failed read is an error, not an empty mix', async () => {
  loadFromPos.mockRejectedValue(new Error('boom'))
  const { result } = renderHook(() => useFoodBeverageSplit({ activePeriod: PERIOD, includeManual: false, includePos: true }))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBe('boom')
  expect(result.current.buckets).toEqual({})
})
