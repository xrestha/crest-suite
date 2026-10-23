// S862: the build-cost loader returns the option catalog it read (SETUP-2: Recipe Costing's price box
// checks a dish's sizes from it) and every read has a time limit (SETUP-9), so a hang becomes the
// failed-read state instead of "…" for the whole visit.
import { renderHook, waitFor, act } from '@testing-library/react'
import { useBuildCostRanges } from './useBuildCostRanges'
import { loadOptionCatalog } from './customizationData'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { buildCostRange } from '../../shared/buildCost'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))
jest.mock('../../shared/hooks/useScopedDb', () => {
  const scopedFrom = jest.fn()
  return { useScopedDb: () => ({ scopedFrom, clientId: 'c1' }) }
})
jest.mock('./customizationData', () => ({ loadOptionCatalog: jest.fn(), CUSTOMIZATION_READ_MS: 20000 }))
jest.mock('../../utils/orderLineIngredients', () => ({ loadDeltaExplosion: jest.fn() }))
jest.mock('../../shared/fetchAllRows', () => ({ fetchAllRowsChunked: jest.fn() }))
jest.mock('../../shared/buildCost', () => ({ buildCostRange: jest.fn(), typicalSelections: jest.fn() }))

const never = () => new Promise(() => {})
const fixedCostOf = () => 0
const bowl = { id: 'bowl', selling_price: 300, category: 'Food' }
const CATALOG = {
  error: null,
  groups: [{ id: 'base', name: 'Base', kind: 'choice', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true }],
  options: [{ id: 'rice', group_id: 'base', name: 'Rice', price_delta: 0, sort: 0, is_active: true, is_default: true }],
  attachments: [{ recipe_id: 'bowl', group_id: 'base', sort: 0 }],
  ingredients: [{ option_id: 'rice', item_id: 'i1', sub_recipe_id: null, qty_per_portion: 100 }],
  buildYourOwn: ['bowl'],
}

beforeEach(() => {
  loadOptionCatalog.mockReset()
  loadDeltaExplosion.mockReset()
  fetchAllRowsChunked.mockReset()
  buildCostRange.mockReset().mockReturnValue({ typicalFilled: false })
})
afterEach(() => jest.useRealTimers())

test('returns the catalog it read, and says it is loading until then', async () => {
  const cat = { ...CATALOG, buildYourOwn: [] }
  loadOptionCatalog.mockResolvedValue(cat)
  const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  expect(result.current.catalogLoading).toBe(true)
  await waitFor(() => expect(result.current.catalog).toBe(cat))
  expect(result.current.catalogLoading).toBe(false)
  expect(result.current.catalogFailed).toBe(false)
  expect(loadDeltaExplosion).not.toHaveBeenCalled()
})

test('reads nothing and claims no catalog while Customization is off', () => {
  const { result } = renderHook(() => useBuildCostRanges({ enabled: false, recipes: [bowl], fixedCostOf }))
  expect(result.current).toMatchObject({ catalog: null, catalogLoading: false, catalogFailed: false, error: null })
  expect(loadOptionCatalog).not.toHaveBeenCalled()
})

test('a catalog read that never answers becomes the failed state after the time limit', async () => {
  jest.useFakeTimers()
  loadOptionCatalog.mockImplementation(never)
  const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  await act(async () => { jest.advanceTimersByTime(20000) })
  await waitFor(() => expect(result.current.catalogFailed).toBe(true))
  expect(result.current.catalog).toBeNull()
  expect(result.current.catalogLoading).toBe(false)
  expect(result.current.loading).toBe(false)
  expect(result.current.error).toMatch(/timed out/)
})

test('a later read that hangs is an error, and the catalog it already read is kept', async () => {
  jest.useFakeTimers()
  loadOptionCatalog.mockResolvedValue(CATALOG)
  loadDeltaExplosion.mockImplementation(never)
  const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  // The catalog is there before the cost reads finish.
  await waitFor(() => expect(result.current.catalog).toBe(CATALOG))
  expect(result.current.loading).toBe(true)
  await act(async () => { jest.advanceTimersByTime(20000) })
  await waitFor(() => expect(result.current.error).toMatch(/timed out/))
  expect(result.current.catalog).toBe(CATALOG)
  expect(result.current.catalogFailed).toBe(false)
  expect(result.current.byRecipe).toEqual({})
})

test('an order-line read that hangs falls back to the pre-selected choices, and says so', async () => {
  jest.useFakeTimers()
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
  loadOptionCatalog.mockResolvedValue(CATALOG)
  loadDeltaExplosion.mockResolvedValue({ subPerUnit: {} })
  fetchAllRowsChunked.mockImplementation(ids => (ids.includes('bowl') ? never() : Promise.resolve({ data: [{ id: 'i1', per_uom_rate: 2 }], error: null })))
  const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  await waitFor(() => expect(fetchAllRowsChunked).toHaveBeenCalledTimes(2))
  await act(async () => { jest.advanceTimersByTime(20000) })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBeNull()
  expect(result.current.byRecipe.bowl.typicalSource).toMatch(/pre-selected choices/)
  expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/order lines unreadable/), expect.anything())
  quiet.mockRestore()
})
