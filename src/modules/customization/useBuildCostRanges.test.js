// S862: the build-cost loader returns the option catalog it read (SETUP-2: Recipe Costing's price box
// checks a dish's sizes from it) and every read has a time limit (SETUP-9), so a hang becomes the
// failed-read state instead of "…" for the whole visit.
import { renderHook, waitFor, act } from '@testing-library/react'
import { useBuildCostRanges } from './useBuildCostRanges'
import { loadOptionCatalog } from './customizationData'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { buildCostRange } from '../../shared/buildCost'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))
jest.mock('../../shared/hooks/useScopedDb', () => {
  const scopedFrom = jest.fn()
  return { useScopedDb: () => ({ scopedFrom, clientId: 'c1' }) }
})
jest.mock('./customizationData', () => ({ loadOptionCatalog: jest.fn(), CUSTOMIZATION_READ_MS: 20000 }))
jest.mock('../../utils/orderLineIngredients', () => ({ loadDeltaExplosion: jest.fn() }))
jest.mock('../../shared/fetchAllRows', () => ({ fetchAllRows: jest.fn(), fetchAllRowsChunked: jest.fn() }))
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
  fetchAllRows.mockReset()
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
  fetchAllRows.mockResolvedValue({ data: [{ id: 'i1', per_uom_rate: 2 }], error: null })
  fetchAllRowsChunked.mockImplementation(never)
  const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  await waitFor(() => expect(fetchAllRowsChunked).toHaveBeenCalledTimes(1))
  await act(async () => { jest.advanceTimersByTime(20000) })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBeNull()
  expect(result.current.byRecipe.bowl.typicalSource).toMatch(/pre-selected choices/)
  expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/order lines unreadable/), expect.anything())
  quiet.mockRestore()
})

// S869: the rates and the recent orders need nothing from the explosion, so they go out beside it.
// They used to wait for it: one more wait on Recipe Costing and Menu Pricing than the page's own reads.
test('asks for the rates and the recent orders while the stock-line walk is still out', async () => {
  loadOptionCatalog.mockResolvedValue(CATALOG)
  loadDeltaExplosion.mockImplementation(never)
  fetchAllRows.mockImplementation(never)
  fetchAllRowsChunked.mockImplementation(never)
  renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf }))
  await waitFor(() => expect(loadDeltaExplosion).toHaveBeenCalledTimes(1))
  expect(fetchAllRows).toHaveBeenCalledTimes(1)
  expect(fetchAllRowsChunked).toHaveBeenCalledTimes(1)
  expect(fetchAllRowsChunked.mock.calls[0][0]).toEqual(['bowl'])
})

// S877: Menu Pricing reads the catalog once, for its choice labels and price check, and hands that
// read in; the hook then reads no catalog of its own. A failed read is still the failed state, never
// "no choices", and an answer for another client is treated as one still on its way.
describe('a catalog read handed in by the page (catalogRead)', () => {
  const costed = () => {
    loadDeltaExplosion.mockResolvedValue({ subPerUnit: {} })
    fetchAllRows.mockResolvedValue({ data: [{ id: 'i1', per_uom_rate: 2 }], error: null })
    fetchAllRowsChunked.mockResolvedValue({ data: [], error: null })
    require('../../shared/buildCost').typicalSelections.mockReturnValue({})
  }

  test('costs from the read it was given and reads no catalog itself', async () => {
    costed()
    const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf, catalogRead: { clientId: 'c1', catalog: CATALOG } }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(loadOptionCatalog).not.toHaveBeenCalled()
    expect(result.current.catalog).toBe(CATALOG)
    expect(result.current.error).toBeNull()
    expect(result.current.byRecipe.bowl).toBeDefined()
    expect(buildCostRange).toHaveBeenCalled()
  })

  test('waits while the read is on its way, or is for another client', async () => {
    const { result, rerender } = renderHook(props => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf, ...props }),
      { initialProps: { catalogRead: null } })
    expect(result.current.loading).toBe(true)
    expect(result.current.catalogLoading).toBe(true)
    rerender({ catalogRead: { clientId: 'other', catalog: CATALOG } })
    expect(result.current.loading).toBe(true)
    expect(result.current.catalog).toBeNull()
    expect(loadOptionCatalog).not.toHaveBeenCalled()
    expect(loadDeltaExplosion).not.toHaveBeenCalled()
  })

  test('a failed read handed in is the failed state, with its reason', async () => {
    const { result } = renderHook(() => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf, catalogRead: { clientId: 'c1', error: 'permission denied for table pos_options' } }))
    await waitFor(() => expect(result.current.catalogFailed).toBe(true))
    expect(result.current.error).toMatch(/permission denied/)
    expect(result.current.catalog).toBeNull()
    expect(result.current.catalogLoading).toBe(false)
    expect(loadOptionCatalog).not.toHaveBeenCalled()
  })

  test('a new answer (after groups are attached) is costed again', async () => {
    costed()
    const { result, rerender } = renderHook(props => useBuildCostRanges({ enabled: true, recipes: [bowl], fixedCostOf, ...props }),
      { initialProps: { catalogRead: { clientId: 'c1', catalog: CATALOG } } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    const next = { ...CATALOG, attachments: [...CATALOG.attachments] }
    rerender({ catalogRead: { clientId: 'c1', catalog: next } })
    await waitFor(() => expect(result.current.catalog).toBe(next))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(loadDeltaExplosion).toHaveBeenCalledTimes(2)
    expect(loadOptionCatalog).not.toHaveBeenCalled()
  })

  test('Menu Pricing reads the option catalog once and hands it to the hook', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '../ims/recipes/MenuPricing.js'), 'utf8')
    expect(src.match(/loadOptionCatalog\(/g)).toHaveLength(1)
    expect(src).toMatch(/useBuildCostRanges\(\{[^}]*catalogRead[^}]*\}\)/)
    expect(src).toMatch(/loadOptionCatalog\(scopedFrom, \{ withIngredients: byoEnabled \}\)/)
  })
})
