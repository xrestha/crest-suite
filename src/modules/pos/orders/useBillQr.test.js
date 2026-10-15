import { renderHook, act } from '@testing-library/react'
import { useBillQr } from './useBillQr'
import { PREVIEW_DEBOUNCE_MS } from './posOrdersConstants'

// 2026-10-15 audit: every keystroke of a discount or a tendered amount ran QRCode.toDataURL on the main
// thread and re-rendered the till. The first QR paints at once; a changing amount waits for the hand.

beforeEach(() => { jest.useFakeTimers() })
afterEach(() => { jest.useRealTimers() })

const flush = async () => { await act(async () => { for (let i = 0; i < 3; i++) await Promise.resolve() }) }

function mount(initial) {
  const make = jest.fn(async (amount, ref) => `qr:${amount}:${ref}`)
  const view = renderHook(p => useBillQr({ make, reference: 'CR12', ...p }), { initialProps: initial })
  return { ...view, make }
}

test('the first QR is drawn at once, without waiting', async () => {
  const { result, make } = mount({ active: true, amount: 500 })
  await flush()
  expect(make).toHaveBeenCalledTimes(1)
  expect(result.current).toBe('qr:500:CR12')
})

test('typing an amount draws one QR once the hand pauses, not one per keystroke', async () => {
  const { result, rerender, make } = mount({ active: true, amount: 500 })
  await flush()
  make.mockClear()
  for (const amount of [5, 50, 450, 4500, 450]) {
    rerender({ active: true, amount })
    act(() => { jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 50) })
  }
  expect(make).not.toHaveBeenCalled()
  expect(result.current).toBe('qr:500:CR12') // the shown QR stays up meanwhile
  act(() => { jest.advanceTimersByTime(50) })
  await flush()
  expect(make).toHaveBeenCalledTimes(1)
  expect(make).toHaveBeenCalledWith(450, 'CR12')
  expect(result.current).toBe('qr:450:CR12')
})

test('no QR while inactive, and the next one paints at once', async () => {
  const { result, rerender, make } = mount({ active: true, amount: 500 })
  await flush()
  rerender({ active: false, amount: 500 })
  await flush()
  expect(result.current).toBe('')
  make.mockClear()
  rerender({ active: true, amount: 700 })
  await flush()
  expect(make).toHaveBeenCalledTimes(1)
  expect(result.current).toBe('qr:700:CR12')
})

test('an answer for an amount already replaced is never shown', async () => {
  let resolveFirst
  const make = jest.fn()
    .mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
    .mockImplementation(async amount => `qr:${amount}`)
  const { result, rerender } = renderHook(p => useBillQr({ make, reference: null, ...p }), { initialProps: { active: true, amount: 100 } })
  rerender({ active: false, amount: 100 })
  rerender({ active: true, amount: 200 })
  await flush()
  expect(result.current).toBe('qr:200')
  await act(async () => { resolveFirst('qr:100') })
  expect(result.current).toBe('qr:200')
})
