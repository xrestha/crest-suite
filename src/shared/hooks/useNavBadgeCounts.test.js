import { pollWhileVisible } from './useNavBadgeCounts'

// The hook's supabase reads are not exercised here; this pins the timing rule it polls by.
jest.mock('./useScopedDb', () => ({ useScopedDb: () => ({}) }))

// S852: the rail's badge counts were polled every minute from hidden tabs too.

let hidden = false
beforeAll(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
beforeEach(() => { hidden = false; jest.useFakeTimers() })
afterEach(() => jest.useRealTimers())

const setHidden = value => {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}

test('polls while visible, not while hidden, and refreshes at once on return', () => {
  const load = jest.fn()
  const stop = pollWhileVisible(load, 1000)
  expect(load).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(1000)
  expect(load).toHaveBeenCalledTimes(2)

  setHidden(true)
  jest.advanceTimersByTime(5000)
  expect(load).toHaveBeenCalledTimes(2)

  setHidden(false)
  expect(load).toHaveBeenCalledTimes(3)

  stop()
  jest.advanceTimersByTime(5000)
  setHidden(true)
  setHidden(false)
  expect(load).toHaveBeenCalledTimes(3)
})

test('a tab opened in the background loads when it is first shown', () => {
  hidden = true
  const load = jest.fn()
  const stop = pollWhileVisible(load, 1000)
  expect(load).not.toHaveBeenCalled()
  setHidden(false)
  expect(load).toHaveBeenCalledTimes(1)
  stop()
})
