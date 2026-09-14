import { PARTY_BANDS, bandFor, turnoverByBand, isDineIn, dineInOnly, coversTotals, addReturnsByBand } from './coversMath'

// Verbatim copy of the loop CoversReport.jsx carried before S677 lifted it out. The helper must
// produce the same rows for the same input — this is the guard that the extraction changed
// nothing the report prints.
function legacyTurnover(orders, netOf) {
  const buckets = PARTY_BANDS.map(b => ({ ...b, orders: 0, totalMinutes: 0, covers: 0, net: 0 }))
  for (const o of orders) {
    if (!o.opened_at || !o.closed_at) continue
    const mins = (new Date(o.closed_at) - new Date(o.opened_at)) / 60000
    if (mins < 0) continue
    const band = buckets.find(b => b.test(o.covers || 0))
    if (!band) continue
    band.orders += 1; band.totalMinutes += mins; band.covers += (o.covers || 0)
    band.net += netOf(o)
  }
  return buckets.map(b => ({ ...b, avgMinutes: b.orders > 0 ? b.totalMinutes / b.orders : 0 }))
}

const at = (h, m) => new Date(Date.UTC(2026, 8, 4, h, m)).toISOString()

const ORDERS = [
  { id: 'a', covers: 2, opened_at: at(13, 0),  closed_at: at(13, 50), net: 1200 },
  { id: 'b', covers: 2, opened_at: at(14, 0),  closed_at: at(15, 10), net: 900 },
  { id: 'c', covers: 4, opened_at: at(19, 0),  closed_at: at(20, 30), net: 4000 },
  { id: 'd', covers: 9, opened_at: at(19, 15), closed_at: at(21, 45), net: 9000 },
  { id: 'e', covers: 3, opened_at: at(19, 0),  closed_at: at(18, 30), net: 500 },   // negative dwell — skipped
  { id: 'f', covers: 5, opened_at: null,       closed_at: at(20, 0),  net: 500 },   // no opened_at — skipped
  { id: 'g', covers: 0, opened_at: at(12, 0),  closed_at: at(12, 20), net: 100 },   // covers 0 lands in 1–2
]

test('turnoverByBand is byte-identical to the loop CoversReport used to carry', () => {
  const netOf = o => o.net
  expect(turnoverByBand(ORDERS, netOf)).toEqual(legacyTurnover(ORDERS, netOf))
})

test('averages per band, skipping negative dwell and missing timestamps', () => {
  const rows = turnoverByBand(ORDERS)
  const by = Object.fromEntries(rows.map(r => [r.key, r]))
  expect(by['1-2'].orders).toBe(3)                 // a, b, g
  expect(by['1-2'].avgMinutes).toBeCloseTo((50 + 70 + 20) / 3)
  expect(by['3-4'].orders).toBe(1)                 // c only — e is negative
  expect(by['3-4'].avgMinutes).toBe(90)
  expect(by['5-6'].orders).toBe(0)                 // f has no opened_at
  expect(by['5-6'].avgMinutes).toBe(0)
  expect(by['7+'].avgMinutes).toBe(150)
})

test('net defaults to zero when no netOf is given', () => {
  expect(turnoverByBand(ORDERS).every(r => r.net === 0)).toBe(true)
})

test('bandFor maps covers onto the closed set of bands', () => {
  expect(bandFor(1).key).toBe('1-2')
  expect(bandFor(2).key).toBe('1-2')
  expect(bandFor(3).key).toBe('3-4')
  expect(bandFor(6).key).toBe('5-6')
  expect(bandFor(7).key).toBe('7+')
  expect(bandFor(40).key).toBe('7+')
  expect(bandFor(0).key).toBe('1-2')
  expect(bandFor(undefined).key).toBe('1-2')
})

describe('dine-in only (S754)', () => {
  const T = (id, table_id, covers, net) => ({ id, table_id, covers, net, opened_at: at(19, 0), closed_at: at(20, 0) })
  const BILLS = [
    T('d1', 't1', 4, 4000),
    T('d2', 't2', 2, 1500),
    T('k1', null, 1, 800),   // takeaway — the till's default "1 cover"
    T('k2', null, 1, 700),
  ]
  const netOf = o => o.net

  test('a bill is dine-in only when it has a table', () => {
    expect(isDineIn({ table_id: 't' })).toBe(true)
    expect(isDineIn({ table_id: null })).toBe(false)
    expect(isDineIn({})).toBe(false)
    expect(isDineIn(null)).toBe(false)
    expect(dineInOnly(BILLS).map(o => o.id)).toEqual(['d1', 'd2'])
  })

  test('covers, party size and revenue per cover ignore takeaway; takeaway is its own line', () => {
    const t = coversTotals(BILLS, netOf)
    expect(t.bills).toBe(2)
    expect(t.covers).toBe(6)
    expect(t.avgParty).toBe(3)
    expect(t.net).toBe(5500)
    expect(t.revPerCover).toBeCloseTo(5500 / 6)
    expect(t.takeaway).toEqual({ bills: 2, net: 1500, returns: 0 })
    // Nothing lost: the two sides add back to every bill.
    expect(t.net + t.takeaway.net).toBe(BILLS.reduce((s, o) => s + o.net, 0))
  })

  test('a return comes off the side its original bill was on; covers stay counted', () => {
    const returns = [{ order: BILLS[0], net: -4000 }, { order: BILLS[2], net: -800 }]
    const t = coversTotals(BILLS, netOf, returns)
    expect(t.covers).toBe(6)          // the guests were still served
    expect(t.net).toBe(1500)
    expect(t.revPerCover).toBeCloseTo(1500 / 6)
    expect(t.returns).toBe(1)
    expect(t.takeaway.net).toBe(700)
    expect(t.takeaway.returns).toBe(1)
  })

  test('turnover over dine-in only never sees a takeaway bill', () => {
    const rows = turnoverByBand(dineInOnly(BILLS), netOf)
    expect(rows.reduce((s, r) => s + r.orders, 0)).toBe(2)
    expect(rows.find(r => r.key === '1-2').orders).toBe(1) // d2 only — the two 1-cover takeaways are out
  })

  test('returns land in the band of the bill they credit, and only on Net', () => {
    const rows = turnoverByBand(dineInOnly(BILLS), netOf)
    const out = addReturnsByBand(rows, [{ order: BILLS[0], net: -1000 }, { order: BILLS[2], net: -800 }])
    const by = Object.fromEntries(out.map(r => [r.key, r]))
    expect(by['3-4'].net).toBe(3000)
    expect(by['3-4'].orders).toBe(1)
    expect(by['1-2'].net).toBe(1500)  // the takeaway return is not a dine-in band's
    expect(rows.find(r => r.key === '3-4').net).toBe(4000) // input not mutated
  })
})
