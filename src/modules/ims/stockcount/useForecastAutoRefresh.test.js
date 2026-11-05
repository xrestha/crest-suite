import { renderHook, waitFor } from '@testing-library/react'
import { useForecastAutoRefresh, resetForecastAutoRefreshForTests } from './useForecastAutoRefresh'
import { runForecast } from '../../../utils/demandForecastData'
import { scopedFrom } from '../../../shared/scopedDb'
import { adToBs } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

jest.mock('../../../utils/demandForecastData', () => ({ runForecast: jest.fn() }))
jest.mock('../../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

const DAY = 86400000
const bsIn = days => { const d = nepalCivilDate(Date.now()); d.setDate(d.getDate() + days); return adToBs(d) }

// Both freshness reads answer with the same newest row: its run time and its day.
function storedRun({ daysAgo, lastDayIn }) {
  const bs = bsIn(lastDayIn)
  const row = { bs_year: bs.year, bs_month: bs.month, bs_day: bs.day, generated_at: new Date(Date.now() - daysAgo * DAY).toISOString() }
  scopedFrom.mockImplementation(() => {
    const q = { is: () => q, order: () => q, limit: () => Promise.resolve({ data: [row], error: null }) }
    return q
  })
}

beforeEach(() => {
  resetForecastAutoRefreshForTests()
  runForecast.mockReset()
  scopedFrom.mockReset()
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => console.error.mockRestore())

const props = over => ({ clientId: 'c1', enabled: true, canRun: true, sampleFactorOf: null, weatherPending: false, ...over })

test('a fresh forecast is left alone', async () => {
  storedRun({ daysAgo: 1, lastDayIn: 29 })
  const { result } = renderHook(() => useForecastAutoRefresh(props()))
  await waitFor(() => expect(result.current.status).toBe('fresh'))
  expect(runForecast).not.toHaveBeenCalled()
})

test('a week-old forecast is rebuilt for 30 days, and the page hears it', async () => {
  storedRun({ daysAgo: 8, lastDayIn: 22 })
  runForecast.mockResolvedValue({ tillDays: 40, manualDays: 0 })
  const onRefreshed = jest.fn()
  const { result } = renderHook(() => useForecastAutoRefresh(props({ onRefreshed })))
  await waitFor(() => expect(result.current.status).toBe('refreshed'))
  expect(runForecast).toHaveBeenCalledTimes(1)
  expect(runForecast.mock.calls[0][1]).toBe(30)
  expect(onRefreshed).toHaveBeenCalledWith({ tillDays: 40, manualDays: 0 }, expect.objectContaining({ reason: 'old' }))
})

test('a login that may not refresh it is told it is stale and nothing runs', async () => {
  storedRun({ daysAgo: 16, lastDayIn: -9 })
  const { result } = renderHook(() => useForecastAutoRefresh(props({ canRun: false })))
  await waitFor(() => expect(result.current.status).toBe('stale'))
  expect(result.current.fresh).toMatchObject({ reason: 'running_out' })
  expect(runForecast).not.toHaveBeenCalled()
})

test('it waits for the weather rather than building without the rain allowance', async () => {
  storedRun({ daysAgo: 8, lastDayIn: 22 })
  runForecast.mockResolvedValue({ tillDays: 1 })
  const { result, rerender } = renderHook(p => useForecastAutoRefresh(p), { initialProps: props({ weatherPending: true }) })
  await waitFor(() => expect(result.current.status).toBe('waiting'))
  expect(runForecast).not.toHaveBeenCalled()
  rerender(props({ weatherPending: false }))
  await waitFor(() => expect(result.current.status).toBe('refreshed'))
  expect(runForecast).toHaveBeenCalledTimes(1)
})

test('one attempt per outlet per tab: a second page does not run it again after a failure', async () => {
  storedRun({ daysAgo: 8, lastDayIn: 22 })
  runForecast.mockRejectedValue(new Error('boom'))
  const onFailed = jest.fn()
  const first = renderHook(() => useForecastAutoRefresh(props({ onFailed })))
  await waitFor(() => expect(first.result.current.status).toBe('failed'))
  expect(onFailed).toHaveBeenCalledTimes(1)
  const second = renderHook(() => useForecastAutoRefresh(props()))
  await waitFor(() => expect(second.result.current.status).toBe('stale'))
  expect(runForecast).toHaveBeenCalledTimes(1)
})

test('two pages open at once share the one run in flight', async () => {
  storedRun({ daysAgo: 8, lastDayIn: 22 })
  let finish
  runForecast.mockImplementation(() => new Promise(res => { finish = res }))
  const a = renderHook(() => useForecastAutoRefresh(props()))
  await waitFor(() => expect(a.result.current.status).toBe('refreshing'))
  const b = renderHook(() => useForecastAutoRefresh(props()))
  await waitFor(() => expect(b.result.current.status).toBe('refreshing'))
  finish({ tillDays: 3 })
  await waitFor(() => expect(a.result.current.status).toBe('refreshed'))
  await waitFor(() => expect(b.result.current.status).toBe('refreshed'))
  expect(runForecast).toHaveBeenCalledTimes(1)
})

test('a check that cannot be read claims nothing', async () => {
  scopedFrom.mockImplementation(() => {
    const q = { is: () => q, order: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } }) }
    return q
  })
  const { result } = renderHook(() => useForecastAutoRefresh(props()))
  await waitFor(() => expect(result.current.status).toBe('unknown'))
  expect(runForecast).not.toHaveBeenCalled()
})

test('off when the outlet has no Demand Forecast', async () => {
  const { result } = renderHook(() => useForecastAutoRefresh(props({ enabled: false })))
  expect(result.current.status).toBe('off')
  expect(scopedFrom).not.toHaveBeenCalled()
})
