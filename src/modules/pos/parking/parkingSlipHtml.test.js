/**
 * A parking token's print (S814, CUSTOMERS-PARKING-14). Only a print that happens is counted, the
 * count is the server's answer, and the label is the bill's copy convention (owner decision D8):
 * the first print is the original, later ones read "COPY OF ORIGINAL - (N)", never "REPRINT #N".
 */

let mockCalls = []
let mockResult = null

jest.mock('../../../shared/scopedDb', () => ({
  scopedUpdate: (table, clientId, patch) => {
    const call = { table, clientId, patch, filters: [], select: null }
    mockCalls.push(call)
    const b = {
      eq: (col, val) => { call.filters.push([col, val]); return b },
      select: cols => { call.select = cols; return b },
      maybeSingle: () => (typeof mockResult === 'function' ? mockResult() : Promise.resolve(mockResult)),
    }
    return b
  },
}))

// eslint-disable-next-line import/first
import { printParkingSlip, openSlipWindow, PRINT_COUNT_BUMP } from './parkingSlipHtml'

const slip = { id: 's1', slip_no: 7, vehicle_number: 'BA 2 KHA 1234', time_in: '2026-10-12T10:00:00+05:45', print_count: 0 }

function fakeWindow() {
  const w = {
    closed: false,
    opener: 'app',
    html: '',
    document: { open() { w.html = '' }, write(h) { w.html += h }, close() {} },
    focus() {},
    print: jest.fn(),
    close() { w.closed = true },
  }
  return w
}

const print = (w, over = {}) => printParkingSlip({
  w, clientId: 'c1', slip, outletName: 'Casa Acai', propertyAddress: 'Thamel', issuedByName: 'Sita', ...over,
})

beforeEach(() => { mockCalls = []; mockResult = null })

test('the first print is the original and carries no copy label', async () => {
  mockResult = { data: { print_count: 1 }, error: null }
  const w = fakeWindow()
  const res = await print(w)
  expect(res).toEqual({ printed: true, closed: false, count: 1, countError: null })
  expect(w.html).toContain('PARKING TOKEN')
  expect(w.html).toContain('P-7')
  expect(w.html).not.toContain('COPY OF ORIGINAL')
})

test('the third print reads COPY OF ORIGINAL - (2)', async () => {
  mockResult = { data: { print_count: 3 }, error: null }
  const w = fakeWindow()
  await print(w)
  expect(w.html).toContain('COPY OF ORIGINAL - (2)')
})

test('"REPRINT #" never appears, whatever the count', async () => {
  for (let n = 1; n <= 6; n++) {
    mockResult = { data: { print_count: n }, error: null }
    const w = fakeWindow()
    await print(w)
    expect(w.html).not.toMatch(/REPRINT/i)
  }
})

test('a blocked window sends no count and prints nothing, so the next print is still the original', async () => {
  const res = await print(null)
  expect(res).toEqual({ printed: false, closed: false, count: null, countError: null })
  expect(mockCalls).toHaveLength(0)
})

test('the count write sends a value no stored count can equal, and reads back what the server made of it', async () => {
  mockResult = { data: { print_count: 2 }, error: null }
  await print(fakeWindow())
  expect(PRINT_COUNT_BUMP).toBe(-1)
  expect(mockCalls).toEqual([{
    table: 'pos_parking_slips', clientId: 'c1', patch: { print_count: -1 }, filters: [['id', 's1']], select: 'print_count',
  }])
})

test('the server\'s count drives the label, not the count this page last saw', async () => {
  // Another tablet reprinted twice since this page loaded the slip at 0.
  mockResult = { data: { print_count: 4 }, error: null }
  const w = fakeWindow()
  const res = await print(w, { slip: { ...slip, print_count: 1 } })
  expect(res.count).toBe(4)
  expect(w.html).toContain('COPY OF ORIGINAL - (3)')
})

test('a refused count still prints, labelled from the count this page knows, and says so', async () => {
  mockResult = { data: null, error: { code: '42501', message: 'denied' } }
  const w = fakeWindow()
  const res = await print(w, { slip: { ...slip, print_count: 2 } })
  expect(res.printed).toBe(true)
  expect(res.count).toBe(3)
  expect(res.countError).toEqual({ code: '42501', message: 'denied' })
  expect(w.html).toContain('COPY OF ORIGINAL - (2)')
})

test('zero rows matched is a refusal, not a count', async () => {
  mockResult = { data: null, error: null }
  const res = await print(fakeWindow())
  expect(res.printed).toBe(true)
  expect(res.count).toBe(1)
  expect(res.countError).toBeTruthy()
})

test('a count that never answers prints after the wait, with a timeout as its countError', async () => {
  mockResult = () => new Promise(() => {})
  const w = fakeWindow()
  const res = await print(w, { timeoutMs: 10 })
  expect(res.printed).toBe(true)
  expect(res.countError?.name).toBe('TimeoutError')
  expect(w.html).toContain('PARKING TOKEN')
})

test('a window closed before the token went in prints nothing and says so', async () => {
  const closedFirst = fakeWindow()
  closedFirst.closed = true
  expect(await print(closedFirst)).toEqual({ printed: false, closed: true, count: null, countError: null })
  expect(mockCalls).toHaveLength(0)

  const w = fakeWindow()
  mockResult = () => { w.closed = true; return Promise.resolve({ data: { print_count: 2 }, error: null }) }
  const res = await print(w)
  expect(res).toEqual({ printed: false, closed: true, count: 2, countError: null })
  expect(w.html).toBe('')
})

describe('openSlipWindow', () => {
  const realOpen = window.open
  afterEach(() => { window.open = realOpen })

  test('opens the window on the tap, cut off from the app, saying Printing…', () => {
    const w = fakeWindow()
    window.open = jest.fn(() => w)
    expect(openSlipWindow()).toBe(w)
    expect(w.opener).toBeNull()
    expect(w.html).toContain('Printing…')
  })

  test('returns null when the browser blocks it', () => {
    window.open = jest.fn(() => null)
    expect(openSlipWindow()).toBeNull()
  })
})
