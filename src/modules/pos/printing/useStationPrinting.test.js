import { renderHook, act, waitFor } from '@testing-library/react'
import { useStationPrinting } from './useStationPrinting'
import { watchVerdict, onlineRouteFor, PRINT_FALLBACK_MS } from './printQueue'
import * as printQueue from './printQueue'
import { kotBotDoc } from './ticketDoc'

// S837: the till's half of kitchen and bar printers (docs/kitchen-printers.md).
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn() } }))
let mockN = 0
jest.mock('../../../utils/uuid', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockN).padStart(12, '0')}` }))

const DOC = kotBotDoc({ station: 'KOT', items: [{ name: 'Momo', qty: 2 }], tableName: 'T4', ticketNo: 23, at: '2026-10-12T14:20:00Z' })
const ONLINE = { KOT: { device_id: 'd1', device_name: 'Counter PC', online: true }, BOT: null }

describe('watchVerdict', () => {
  const t0 = 1_000_000
  const entry = { queuedAt: t0, deviceName: 'Counter PC', sendFailed: false }

  test('a printed job is done, a printing one is left alone however long it takes', () => {
    expect(watchVerdict(entry, { state: 'printed' }, t0 + 99999).done).toBe(true)
    expect(watchVerdict(entry, { state: 'printing' }, t0 + 99999)).toMatchObject({ done: false, needsAction: false })
  })

  test('waiting or never-arrived asks only after the fallback time', () => {
    expect(watchVerdict(entry, { state: 'waiting' }, t0 + 5000).needsAction).toBe(false)
    expect(watchVerdict(entry, { state: 'waiting' }, t0 + PRINT_FALLBACK_MS).needsAction).toBe(true)
    expect(watchVerdict(entry, undefined, t0 + PRINT_FALLBACK_MS)).toMatchObject({ needsAction: true, reason: 'It has not reached the printer computer.' })
  })

  test('a device that gave up asks at once, with its reason', () => {
    expect(watchVerdict(entry, { state: 'failed', device_name: 'Counter PC', fail_reason: 'Out of paper' }, t0 + 1000))
      .toMatchObject({ needsAction: true, reason: 'Counter PC: Out of paper' })
    expect(watchVerdict(entry, { state: 'expired' }, t0).needsAction).toBe(true)
    expect(watchVerdict({ ...entry, sendFailed: true }, undefined, t0).needsAction).toBe(true)
  })

  test('onlineRouteFor takes only an online device', () => {
    expect(onlineRouteFor(ONLINE, 'KOT').device_name).toBe('Counter PC')
    expect(onlineRouteFor(ONLINE, 'BOT')).toBeNull()
    expect(onlineRouteFor({ KOT: { online: false } }, 'KOT')).toBeNull()
  })
})

describe('useStationPrinting', () => {
  let routes
  beforeEach(() => {
    routes = ONLINE
    jest.spyOn(printQueue, 'readPrintRoutes').mockImplementation(async () => ({ routes, error: null }))
    jest.spyOn(printQueue, 'queuePrintJobs').mockResolvedValue({ ok: true })
    jest.spyOn(printQueue, 'readPrintJobStatus').mockResolvedValue({ rows: [], error: null })
    jest.spyOn(printQueue, 'claimPrintJobForTill').mockResolvedValue({ data: { ok: true }, error: null })
  })
  afterEach(() => jest.restoreAllMocks())

  async function mount({ offline = false } = {}) {
    const printHtml = jest.fn(() => true)
    const view = renderHook(() => useStationPrinting({ clientId: 'c1', isOffline: () => offline, printHtml }))
    await waitFor(() => expect(printQueue.readPrintRoutes).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))   // the routes answer lands in a ref, not state
    return { ...view, printHtml }
  }

  test('a station with an online device gets the job, and the till prints nothing', async () => {
    const { result, printHtml } = await mount()
    let res
    act(() => { res = result.current.deliver({ station: 'KOT', kind: 'ticket', doc: DOC, label: 'T4 · #23' }) })
    expect(res).toEqual({ via: 'device', deviceName: 'Counter PC' })
    expect(printHtml).not.toHaveBeenCalled()
    expect(printQueue.queuePrintJobs).toHaveBeenCalledWith('c1', [expect.objectContaining({ station: 'KOT', kind: 'ticket', doc: DOC, label: 'T4 · #23' })])
  })

  test('no device for the station, an offline till, or a send kept on the till prints here', async () => {
    const { result, printHtml } = await mount()
    act(() => { expect(result.current.deliver({ station: 'BOT', kind: 'ticket', doc: DOC })).toEqual({ via: 'till', printed: true }) })
    act(() => { expect(result.current.deliver({ station: 'KOT', kind: 'ticket', doc: DOC, local: true }).via).toBe('till') })
    expect(printHtml).toHaveBeenCalledTimes(2)
    expect(printHtml.mock.calls[0][0]).toContain('KITCHEN ORDER TICKET')
    expect(printQueue.queuePrintJobs).not.toHaveBeenCalled()

    const offline = await mount({ offline: true })
    act(() => { expect(offline.result.current.deliver({ station: 'KOT', kind: 'ticket', doc: DOC }).via).toBe('till') })
  })

  test('a refused queue call raises the banner at once; Print here claims, prints and clears it', async () => {
    printQueue.queuePrintJobs.mockResolvedValue({ ok: false, noAnswer: false, error: { message: 'no' } })
    const open = jest.spyOn(window, 'open').mockReturnValue(null)
    const { result, printHtml } = await mount()
    act(() => { result.current.deliver({ station: 'KOT', kind: 'ticket', doc: DOC, label: 'T4 · #23' }) })
    await waitFor(() => expect(result.current.alerts).toHaveLength(1))
    expect(result.current.alerts[0].reason).toBe('It could not be sent to the printer computer.')

    await act(async () => { await result.current.printHere(result.current.alerts[0].job.id) })
    expect(open).toHaveBeenCalled()
    expect(printQueue.claimPrintJobForTill).toHaveBeenCalledWith('c1', expect.objectContaining({ station: 'KOT', doc: DOC }))
    expect(printHtml).toHaveBeenCalledTimes(1)          // the window was blocked, so the till's own path tried
    expect(result.current.alerts).toHaveLength(0)
  })

  test('Print here on a job a device already printed prints nothing and says who did', async () => {
    printQueue.queuePrintJobs.mockResolvedValue({ ok: false, noAnswer: false, error: { message: 'no' } })
    printQueue.claimPrintJobForTill.mockResolvedValue({ data: { ok: false, state: 'printed', device_name: 'Counter PC' }, error: null })
    const close = jest.fn()
    jest.spyOn(window, 'open').mockReturnValue({ close, document: { write: jest.fn(), close: jest.fn() } })
    const { result, printHtml } = await mount()
    act(() => { result.current.deliver({ station: 'KOT', kind: 'ticket', doc: DOC }) })
    await waitFor(() => expect(result.current.alerts).toHaveLength(1))
    await act(async () => { await result.current.printHere(result.current.alerts[0].job.id) })
    expect(close).toHaveBeenCalled()
    expect(printHtml).not.toHaveBeenCalled()
    expect(result.current.notice).toBe('Counter PC has already printed the kitchen ticket.')
  })
})
