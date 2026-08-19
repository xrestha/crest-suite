import { AGE_BANDS, bandOf, ageInDays, allocateFifo, buildAgeing } from './stockAgeingCalc'

const AS_OF = new Date('2026-08-19T12:00:00')
const daysAgo = n => new Date(AS_OF.getTime() - n * 24 * 60 * 60 * 1000)

describe('bandOf', () => {
  test('maps ages to the documented bands', () => {
    expect(bandOf(0)).toBe('0-30')
    expect(bandOf(30)).toBe('0-30')
    expect(bandOf(31)).toBe('31-60')
    expect(bandOf(60)).toBe('31-60')
    expect(bandOf(61)).toBe('61-90')
    expect(bandOf(90)).toBe('61-90')
    expect(bandOf(91)).toBe('90+')
    expect(bandOf(9999)).toBe('90+')
  })

  test('a negative age (future-dated / mis-converted row) still lands in a band', () => {
    // It must be counted somewhere, or the bands stop summing to the total.
    expect(bandOf(-5)).toBe('0-30')
    expect(AGE_BANDS.map(b => b.key)).toContain(bandOf(-5))
  })
})

describe('ageInDays', () => {
  test('counts whole days and never goes negative', () => {
    expect(ageInDays(daysAgo(10), AS_OF)).toBe(10)
    expect(ageInDays(AS_OF, AS_OF)).toBe(0)
    expect(ageInDays(new Date('2027-01-01'), AS_OF)).toBe(0)
  })

  test('an unparseable date is 0, not NaN', () => {
    expect(ageInDays('not a date', AS_OF)).toBe(0)
  })
})

describe('allocateFifo', () => {
  test('eats oldest batches first and leaves the newest standing', () => {
    const batches = [
      { item_id: 'A', qty: 10, rate: 5, date: daysAgo(10) },
      { item_id: 'A', qty: 10, rate: 5, date: daysAgo(100) },
      { item_id: 'A', qty: 10, rate: 5, date: daysAgo(50) },
    ]
    const out = allocateFifo(batches, { A: 15 })
    // returned oldest-first
    expect(out.map(b => b.remaining)).toEqual([0, 5, 10])
    expect(out[0].date).toEqual(daysAgo(100))
  })

  test('carried-forward stock is consumed before a same-dated purchase', () => {
    const d = daysAgo(30)
    const out = allocateFifo([
      { item_id: 'A', qty: 4, rate: 5, date: d },
      { item_id: 'A', qty: 6, rate: 5, date: d, carriedForward: true },
    ], { A: 6 })
    const cf = out.find(b => b.carriedForward)
    const purch = out.find(b => !b.carriedForward)
    expect(cf.remaining).toBe(0)
    expect(purch.remaining).toBe(4)
  })

  test('consumption never bleeds across items', () => {
    const out = allocateFifo([
      { item_id: 'A', qty: 10, rate: 1, date: daysAgo(5) },
      { item_id: 'B', qty: 10, rate: 1, date: daysAgo(5) },
    ], { A: 100 })
    expect(out.find(b => b.item_id === 'A').remaining).toBe(0)
    expect(out.find(b => b.item_id === 'B').remaining).toBe(10)
  })

  test('does not mutate its input', () => {
    const batches = [{ item_id: 'A', qty: 10, rate: 1, date: daysAgo(5) }]
    allocateFifo(batches, { A: 5 })
    expect(batches[0].remaining).toBeUndefined()
    expect(batches[0].qty).toBe(10)
  })

  test('consumption exceeding all stock leaves nothing negative', () => {
    const out = allocateFifo([{ item_id: 'A', qty: 3, rate: 1, date: daysAgo(5) }], { A: 999 })
    expect(out[0].remaining).toBe(0)
  })
})

describe('buildAgeing', () => {
  const batches = [
    { item_id: 'A', qty: 10, rate: 100, date: daysAgo(5) },    // fresh
    { item_id: 'A', qty: 10, rate: 100, date: daysAgo(120) },   // stale
    { item_id: 'B', qty: 4, rate: 50, date: daysAgo(45) },
  ]

  test('bands the surviving stock and values it at each batch\'s own rate', () => {
    const { items, totals } = buildAgeing(batches, {}, AS_OF)
    const a = items.find(i => i.item_id === 'A')
    expect(a.bands['0-30'].qty).toBe(10)
    expect(a.bands['90+'].qty).toBe(10)
    expect(a.value).toBe(2000)
    expect(a.oldestDays).toBe(120)

    const b = items.find(i => i.item_id === 'B')
    expect(b.bands['31-60'].qty).toBe(4)
    expect(b.value).toBe(200)

    expect(totals.value).toBe(2200)
  })

  test('bands always sum back to the total (the invariant the page reports on)', () => {
    const { totals } = buildAgeing(batches, { A: 7 }, AS_OF)
    const summed = AGE_BANDS.reduce((s, band) => s + totals.bands[band.key].value, 0)
    expect(Math.round(summed * 100)).toBe(Math.round(totals.value * 100))
  })

  test('consumption clears the oldest band first, which is the whole point', () => {
    // 10 units consumed exactly clears A's 120-day-old batch.
    const { items } = buildAgeing(batches, { A: 10 }, AS_OF)
    const a = items.find(i => i.item_id === 'A')
    expect(a.bands['90+'].qty).toBe(0)
    expect(a.bands['0-30'].qty).toBe(10)
    expect(a.oldestDays).toBe(5)
  })

  test('fully consumed items drop out entirely rather than showing a zero row', () => {
    const { items } = buildAgeing(batches, { A: 20, B: 4 }, AS_OF)
    expect(items).toEqual([])
  })

  test('carried-forward quantity is tracked so the page can disclose it', () => {
    const { items } = buildAgeing(
      [{ item_id: 'A', qty: 5, rate: 10, date: daysAgo(200), carriedForward: true }], {}, AS_OF)
    expect(items[0].carriedForwardQty).toBe(5)
    expect(items[0].bands['90+'].qty).toBe(5)
  })

  test('empty input produces empty output, not NaN', () => {
    const { items, totals } = buildAgeing([], {}, AS_OF)
    expect(items).toEqual([])
    expect(totals.value).toBe(0)
    expect(totals.qty).toBe(0)
  })
})
