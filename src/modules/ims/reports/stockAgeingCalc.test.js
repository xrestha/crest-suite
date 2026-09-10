import {
  AGE_BANDS, bandOf, ageInDays, allocateFifo, buildAgeing,
  daysUntilExpiry, parseDateLocal,
} from './stockAgeingCalc'

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

  // FifoReport hangs the purchase_entries row off each batch as `entry` and reads it back to
  // render the expiry date, the rate and the bill's period. Narrowing either spread inside
  // allocateFifo to a fixed field list would empty that report with no error anywhere (S717).
  test('carries a caller’s own fields through untouched', () => {
    const entry = { id: 'pe-1', expiry_date: '2026-10-01' }
    const out = allocateFifo([
      { item_id: 'A', qty: 10, rate: 5, date: daysAgo(20), entry, returnedQty: 2 },
    ], { A: 4 })
    expect(out[0].entry).toBe(entry)
    expect(out[0].returnedQty).toBe(2)
    expect(out[0].consumed).toBe(4)
    expect(out[0].remaining).toBe(6)
  })

  // The carried-forward batch is FifoReport's whole answer to "the month's consumption came off
  // stock that was already here". Without it the dated batches absorb usage that was never theirs
  // and an expiry report understates its exposure.
  test('stock carried into the window shields later batches from its consumption', () => {
    const out = allocateFifo([
      { item_id: 'A', qty: 30, rate: 0, date: daysAgo(60), carriedForward: true },
      { item_id: 'A', qty: 10, rate: 5, date: daysAgo(10), entry: { id: 'pe-1' } },
    ], { A: 30 })
    expect(out.find(b => b.carriedForward).remaining).toBe(0)
    expect(out.find(b => b.entry).remaining).toBe(10)   // untouched, still at risk
  })
})

describe('daysUntilExpiry', () => {
  // 12:00 local on the 19th — the middle of a working day, which is where the old UTC-parsed
  // version went wrong.
  const noon = new Date(2026, 7, 19, 12, 0, 0)

  test('counts whole days forward and backward from local midnight', () => {
    expect(daysUntilExpiry('2026-08-26', noon)).toBe(7)
    expect(daysUntilExpiry('2026-08-20', noon)).toBe(1)
    expect(daysUntilExpiry('2026-08-18', noon)).toBe(-1)
  })

  // The regression this exists for: `new Date('2026-08-19')` is UTC midnight, i.e. 05:45 local in
  // Nepal, so at noon the difference was negative-but-tiny and `Math.ceil` returned -0 — which is
  // not `< 0`, so a batch expiring TODAY was flagged OK rather than expiring.
  test('a batch expiring today is 0, not a fraction of a day either side', () => {
    expect(daysUntilExpiry('2026-08-19', noon)).toBe(0)
    expect(daysUntilExpiry('2026-08-19', new Date(2026, 7, 19, 23, 59))).toBe(0)
    expect(daysUntilExpiry('2026-08-19', new Date(2026, 7, 19, 0, 1))).toBe(0)
  })

  test('yesterday is -1 all day, so an expired batch reads expired from midnight', () => {
    expect(daysUntilExpiry('2026-08-18', new Date(2026, 7, 19, 0, 1))).toBe(-1)
    expect(daysUntilExpiry('2026-08-18', new Date(2026, 7, 19, 23, 59))).toBe(-1)
  })

  test('an unparseable or absent date is null, never 0', () => {
    // 0 would render as "expires today" on a row that has no expiry date at all.
    expect(daysUntilExpiry(null, noon)).toBeNull()
    expect(daysUntilExpiry('', noon)).toBeNull()
    expect(daysUntilExpiry('not a date', noon)).toBeNull()
  })

  test('accepts a timestamp string by taking its date part', () => {
    expect(daysUntilExpiry('2026-08-26T00:00:00+05:45', noon)).toBe(7)
  })
})

describe('parseDateLocal', () => {
  test('reads a bare date string as LOCAL midnight, not UTC', () => {
    const d = parseDateLocal('2026-08-19')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(19)
    expect(d.getHours()).toBe(0)
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

  // The KPI card summed carriedForwardQty across every item and printed it as "units" — kilograms
  // added to litres added to pieces. Value is the only figure that sums across items (S718).
  test('carried-forward VALUE is tracked per item and in the totals', () => {
    const { items, totals } = buildAgeing([
      { item_id: 'A', qty: 5, rate: 10, date: daysAgo(200), carriedForward: true },
      { item_id: 'B', qty: 2, rate: 300, date: daysAgo(200), carriedForward: true },
      { item_id: 'B', qty: 1, rate: 400, date: daysAgo(3) },
    ], {}, AS_OF)
    expect(items.find(i => i.item_id === 'A').carriedForwardValue).toBe(50)
    expect(items.find(i => i.item_id === 'B').carriedForwardValue).toBe(600)
    expect(totals.carriedForwardValue).toBe(650)
    // The ordinary purchase is not counted as carried forward.
    expect(totals.value).toBe(1050)
  })

  // Early in a fiscal year the window is shorter than 90 days, so carried-in stock lands in a
  // young band however long it has really been on the shelf — and the 90+ headline then read
  // NPR 0 with a green ✓. `unknownAgeValue` is what lets the page withhold that verdict.
  test('carried-forward stock in a young band is reported as unknown-age', () => {
    const { items, totals } = buildAgeing(
      // 40 days is the whole window: this stock could be four years old.
      [{ item_id: 'A', qty: 5, rate: 10, date: daysAgo(40), carriedForward: true }], {}, AS_OF)
    expect(items[0].carriedForwardBand).toBe('31-60')
    expect(totals.bands['90+'].value).toBe(0)     // the figure the card used to tick
    expect(totals.unknownAgeValue).toBe(50)       // ...and the reason it must not
  })

  test('carried-forward stock that HAS reached the oldest band is not unknown-age', () => {
    const { totals } = buildAgeing(
      [{ item_id: 'A', qty: 5, rate: 10, date: daysAgo(200), carriedForward: true }], {}, AS_OF)
    expect(totals.unknownAgeValue).toBe(0)
    expect(totals.carriedForwardValue).toBe(50)
  })

  test('a fully consumed carried-forward batch reports nothing at all', () => {
    const { totals } = buildAgeing(
      [{ item_id: 'A', qty: 5, rate: 10, date: daysAgo(40), carriedForward: true }], { A: 5 }, AS_OF)
    expect(totals.carriedForwardValue).toBe(0)
    expect(totals.unknownAgeValue).toBe(0)
  })

  test('an ordinary batch in a young band is never counted as unknown-age', () => {
    const { totals } = buildAgeing(
      [{ item_id: 'A', qty: 5, rate: 10, date: daysAgo(40) }], {}, AS_OF)
    expect(totals.unknownAgeValue).toBe(0)
  })

  test('empty input produces empty output, not NaN', () => {
    const { items, totals } = buildAgeing([], {}, AS_OF)
    expect(items).toEqual([])
    expect(totals.value).toBe(0)
    expect(totals.qty).toBe(0)
  })
})
