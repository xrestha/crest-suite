import { act, renderHook } from '@testing-library/react'
import { useBsToday } from './useBsToday'
import { adToBs } from '../../../utils/bsCalendar'

// SELF-SERVICE-3 (S798): Crest Staff resumed the next day must move Today forward. A todayView test
// cannot catch this — the selectors were right; the date they were handed was a day old.
describe('useBsToday', () => {
  const SUNDAY_NIGHT = new Date(2026, 8, 27, 22, 0) // 27 Sep 2026, local time
  const MONDAY_EVENING = new Date(2026, 8, 28, 19, 0)

  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(SUNDAY_NIGHT) })
  afterEach(() => { jest.useRealTimers() })

  const showScreen = () => act(() => { document.dispatchEvent(new Event('visibilitychange')) })

  it('moves to the new day when the app comes back the next day, and says so once', () => {
    const onDayChange = jest.fn()
    const { result } = renderHook(() => useBsToday(onDayChange))
    expect(result.current).toEqual(adToBs(SUNDAY_NIGHT))

    jest.setSystemTime(MONDAY_EVENING)
    showScreen()
    expect(result.current).toEqual(adToBs(MONDAY_EVENING))
    expect(onDayChange).toHaveBeenCalledTimes(1)
    expect(onDayChange).toHaveBeenCalledWith(adToBs(MONDAY_EVENING))

    showScreen()
    expect(onDayChange).toHaveBeenCalledTimes(1)
  })

  it('keeps the same object, and calls nothing, when the day has not changed', () => {
    const onDayChange = jest.fn()
    const { result } = renderHook(() => useBsToday(onDayChange))
    const first = result.current
    jest.setSystemTime(new Date(2026, 8, 27, 23, 30))
    showScreen()
    expect(result.current).toBe(first)
    expect(onDayChange).not.toHaveBeenCalled()
  })

  it('also notices midnight passing while the screen stays open', () => {
    const { result } = renderHook(() => useBsToday())
    jest.setSystemTime(MONDAY_EVENING)
    act(() => { jest.advanceTimersByTime(60 * 1000) })
    expect(result.current).toEqual(adToBs(MONDAY_EVENING))
  })
})
