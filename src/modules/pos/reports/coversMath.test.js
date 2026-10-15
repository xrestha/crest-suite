import {
  PARTY_BANDS, bandFor, turnoverByBand, isDineIn, isPartBill, dineInOnly, seatedCovers, coversTotals, addReturnsByBand,
  MAX_SITTING_MINUTES, turnoverExclusions, turnoverExclusionNote, coverRowsTotal,
} from './coversMath'

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

  test('seatedCovers counts the guests of dine-in bills only, a credit-noted one included (S809 3n)', () => {
    expect(seatedCovers(BILLS)).toBe(6)                                   // d1 4 + d2 2; the takeaways' default 1s are out
    expect(seatedCovers(BILLS)).toBe(coversTotals(BILLS, netOf).covers)   // the report's headline is this count
    expect(seatedCovers([{ table_id: 't1', covers: 3, credit_note_id: 'cn1' }])).toBe(3)
    expect(seatedCovers([{ table_id: null, covers: 2, delivery_partner: 'Foodmandu' }])).toBe(0)
    expect(seatedCovers([{ table_id: 't1', covers: '2' }, { table_id: 't1', covers: null }])).toBe(2)
    expect(seatedCovers([])).toBe(0)
    expect(seatedCovers(null)).toBe(0)
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

// S814 4d (B4, owner decision D3): a sitting is at most 12 hours, POS Setup → Reservations' own
// ceiling for a party's table time. A bill open longer was left open past closing.
describe('the 12-hour sitting cap', () => {
  const thirteenHours = { id: 'h', covers: 2, opened_at: at(1, 0), closed_at: at(14, 0), net: 700 }
  const twelveExactly = { id: 'x', covers: 2, opened_at: at(1, 0), closed_at: at(13, 0), net: 700 }

  test('the cap is the reservation settings\' 720 minutes', () => {
    expect(MAX_SITTING_MINUTES).toBe(720)
  })

  test('a 13-hour bill is not a sitting; 12 hours exactly still is', () => {
    const rows = turnoverByBand([...ORDERS, thirteenHours, twelveExactly], o => o.net)
    const by = Object.fromEntries(rows.map(r => [r.key, r]))
    expect(by['1-2'].orders).toBe(4)                     // a, b, g and the 12-hour bill
    expect(by['1-2'].avgMinutes).toBeCloseTo((50 + 70 + 20 + 720) / 4)
  })

  test('the excluded bills are counted by reason, from the same classifier', () => {
    expect(turnoverExclusions([...ORDERS, thirteenHours, twelveExactly])).toEqual({ partBill: 0, untimed: 1, negative: 1, overCap: 1 })
    expect(turnoverExclusions(ORDERS.slice(0, 4))).toEqual({ partBill: 0, untimed: 0, negative: 0, overCap: 0 })
  })

  test('the note names only the reasons that happened, and nothing when none did', () => {
    expect(turnoverExclusionNote({ untimed: 0, negative: 0, overCap: 0 })).toBeNull()
    expect(turnoverExclusionNote({ untimed: 0, negative: 2, overCap: 1 })).toBe(
      '3 dine-in bills are not in this table: 2 closed before they were opened (a till clock behind), 1 open over 12 hours (left open past closing). Their sales are still in the Overview.')
    expect(turnoverExclusionNote({ untimed: 0, negative: 0, overCap: 1 })).toBe(
      '1 dine-in bill is not in this table: 1 open over 12 hours (left open past closing). Their sales are still in the Overview.')
  })
})

// S836: a part bill is split off a table's bill so one guest can pay separately. It has no table of
// its own (table_id null, the table's name), but its guests sat at that table.
describe('a part bill', () => {
  // Table T1 seated 4; one guest paid separately on a part bill, so the split moved 1 cover over.
  const parent = { id: 'p', table_id: 't1', part_of_order_id: null, covers: 3, opened_at: at(19, 0), closed_at: at(20, 30), net: 3000 }
  const part = { id: 'q', table_id: null, part_of_order_id: 'p', covers: 1, opened_at: at(20, 10), closed_at: at(20, 12), net: 800 }
  const takeaway = { id: 'k', table_id: null, part_of_order_id: null, covers: 1, opened_at: at(19, 0), closed_at: at(19, 10), net: 500 }
  const BILLS = [parent, part, takeaway]
  const netOf = o => o.net

  test('is dine-in, though it has no table; a plain takeaway still is not', () => {
    expect(isPartBill(part)).toBe(true)
    expect(isPartBill(parent)).toBe(false)
    expect(isPartBill(null)).toBe(false)
    expect(isDineIn(part)).toBe(true)
    expect(isDineIn(takeaway)).toBe(false)
    expect(dineInOnly(BILLS).map(o => o.id)).toEqual(['p', 'q'])
  })

  test('its guests count once: the split moved them off the table\'s bill', () => {
    expect(seatedCovers(BILLS)).toBe(4)
    const t = coversTotals(BILLS, netOf)
    expect(t.bills).toBe(2)
    expect(t.covers).toBe(4)
    expect(t.net).toBe(3800)
    expect(t.takeaway).toEqual({ bills: 1, net: 500, returns: 0 })
  })

  test('a part bill with no guests of its own (one paid and stayed) adds sales, not covers', () => {
    const stayed = { ...part, covers: 0 }
    expect(seatedCovers([{ ...parent, covers: 4 }, stayed])).toBe(4)
  })

  test('is not a sitting: turnover leaves it out, and the note says so', () => {
    const rows = turnoverByBand(dineInOnly(BILLS), netOf)
    expect(rows.reduce((s, r) => s + r.orders, 0)).toBe(1)          // the table's own bill only
    expect(rows.find(r => r.key === '3-4').avgMinutes).toBe(90)
    expect(rows.find(r => r.key === '1-2').orders).toBe(0)           // not a two-minute 1-cover sitting
    const ex = turnoverExclusions(dineInOnly(BILLS))
    expect(ex).toEqual({ partBill: 1, untimed: 0, negative: 0, overCap: 0 })
    expect(turnoverExclusionNote(ex)).toBe(
      "1 dine-in bill is not in this table: 1 part bill (a guest paying separately; the sitting is the table's own bill). Their sales are still in the Overview.")
    expect(turnoverExclusionNote({ partBill: 2, untimed: 1, negative: 0, overCap: 0 })).toBe(
      "3 dine-in bills are not in this table: 2 part bills (a guest paying separately; the sitting is the table's own bill), 1 with no opening or closing time. Their sales are still in the Overview.")
  })

  test('a part bill is classified before its times: an untimed one is still a part bill', () => {
    expect(turnoverExclusions([{ ...part, opened_at: null }])).toEqual({ partBill: 1, untimed: 0, negative: 0, overCap: 0 })
  })

  test('its return comes off dine-in revenue, and off no band', () => {
    const t = coversTotals(BILLS, netOf, [{ order: part, net: -800 }])
    expect(t.net).toBe(3000)
    expect(t.returns).toBe(1)
    expect(t.takeaway.net).toBe(500)
    const rows = addReturnsByBand(turnoverByBand(dineInOnly(BILLS), netOf), [{ order: part, net: -800 }])
    expect(rows.find(r => r.key === '1-2').net).toBe(0)
    expect(rows.find(r => r.key === '3-4').net).toBe(3000)
  })

  test('read without part_of_order_id it falls back to takeaway, which is why the select needs it', () => {
    const { part_of_order_id, ...unread } = part
    expect(part_of_order_id).toBe('p')
    expect(isDineIn(unread)).toBe(false)
  })
})

// The TOTAL row under Daily Trend, Peak Hours and By Server (2026-10-15 audit).
describe('coverRowsTotal', () => {
  test('sums bills, covers and net, and takes revenue per cover from the sums, not the rows\' averages', () => {
    const rows = [
      { bills: 1, covers: 2, net: 1000, revPerCover: 500 },
      { bills: 3, covers: 40, net: 4000, revPerCover: 100 },
    ]
    const t = coverRowsTotal(rows)
    expect(t).toEqual({ bills: 4, covers: 42, net: 5000, revPerCover: 5000 / 42 })
    expect(t.revPerCover).not.toBe(300) // the average of 500 and 100
  })

  test('a credit note that takes a day below zero comes off the total too', () => {
    expect(coverRowsTotal([{ bills: 2, covers: 4, net: 2000 }, { bills: 0, covers: 0, net: -500 }]).net).toBe(1500)
  })

  test('rows with no net (Peak Hours) add bills and covers only', () => {
    expect(coverRowsTotal([{ hour: 13, bills: 2, covers: 5 }, { hour: 19, bills: 4, covers: 11 }]))
      .toEqual({ bills: 6, covers: 16, net: 0, revPerCover: 0 })
  })

  test('no covers is no average, not an average of 0', () => {
    expect(coverRowsTotal([]).revPerCover).toBeNull()
    expect(coverRowsTotal([{ bills: 1, covers: 0, net: 300 }]).revPerCover).toBeNull()
  })
})
