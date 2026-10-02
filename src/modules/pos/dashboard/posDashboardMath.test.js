import {
  summariseBills, compareToLastWeek, hourlySales, paymentMix, channelOf, channelMix,
  topItems, openBillsSummary, ticketSummary, sameWeekdayLastWeek,
} from './posDashboardMath'

const bill = (over) => ({ close_type: 'paid', credit_note_id: null, paid_amount: 1000, covers: 2, discount_amount: 0, table_id: 't1', ...over })

describe('summariseBills', () => {
  test('counts paid bills only, leaves out a credit-noted bill, and counts voids and comps apart', () => {
    const s = summariseBills([
      bill({ paid_amount: 1200, covers: 3, discount_amount: 100 }),
      bill({ paid_amount: 800, covers: 1 }),
      bill({ paid_amount: 500, credit_note_id: 'cn1' }),
      { close_type: 'void' }, { close_type: 'writeoff' }, { close_type: 'writeoff' },
    ])
    expect(s).toMatchObject({ sales: 2000, bills: 2, covers: 4, discount: 100, avgBill: 1000, avgCover: 500, voids: 1, comps: 2 })
  })

  test('no covers is no average per cover, never zero', () => {
    expect(summariseBills([bill({ covers: 0 })]).avgCover).toBeNull()
    expect(summariseBills([]).avgBill).toBeNull()
  })
})

describe('compareToLastWeek', () => {
  test('more sales is good, more discount is not; the arrow states the direction either way', () => {
    expect(compareToLastWeek(1200, 1000)).toMatchObject({ glyph: '▲', good: true })
    expect(compareToLastWeek(800, 1000)).toMatchObject({ glyph: '▼', good: false })
    expect(compareToLastWeek(1200, 1000, { goodDirection: -1 })).toMatchObject({ glyph: '▲', good: false })
  })

  test('inside the dead zone it is ≈ with no verdict, and the floor widens it for small numbers', () => {
    expect(compareToLastWeek(1030, 1000)).toMatchObject({ glyph: '≈', good: null })
    expect(compareToLastWeek(5, 3, { floor: 2 })).toMatchObject({ glyph: '≈', good: null })
  })

  test('nothing last week means no comparison at all', () => {
    expect(compareToLastWeek(500, 0)).toBeNull()
    expect(compareToLastWeek(null, 100)).toBeNull()
  })
})

describe('hourlySales', () => {
  // 13:10 and 13:50 Nepal (+05:45) are 07:25Z and 08:05Z.
  test('buckets by Nepal hour and trims to the hours either day traded', () => {
    const rows = hourlySales(
      [bill({ paid_amount: 300, closed_at: '2026-10-02T07:25:00Z' }), bill({ paid_amount: 200, closed_at: '2026-10-02T08:05:00Z' })],
      [bill({ paid_amount: 900, closed_at: '2026-09-25T09:20:00Z' })],
    )
    expect(rows).toEqual([
      { hour: 13, today: 500, lastWeek: 0 },
      { hour: 14, today: 0, lastWeek: 0 },
      { hour: 15, today: 0, lastWeek: 900 },
    ])
  })

  test('the current hour stays on the chart even with no sales in it', () => {
    expect(hourlySales([], [], { currentHour: 11 })).toEqual([{ hour: 11, today: 0, lastWeek: 0 }])
  })
})

describe('paymentMix', () => {
  test('groups wallets and QR together and shares a Split bill across its legs', () => {
    const orders = [
      bill({ id: 'a', paid_amount: 1000, payment_method: 'Cash' }),
      bill({ id: 'b', paid_amount: 500, payment_method: 'eSewa' }),
      bill({ id: 'c', paid_amount: 400, payment_method: 'Split' }),
    ]
    const legs = new Map([['c', [{ payment_method: 'Cash', amount: 100 }, { payment_method: 'FonePay', amount: 300 }]]])
    const mix = paymentMix(orders, legs)
    expect(mix.map(r => [r.method, Math.round(r.amount)])).toEqual([['Cash', 1100], ['Wallet / QR', 800]])
    expect(mix.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1)
  })
})

describe('channels', () => {
  test('delivery names a partner, takeaway has no table, the rest is dine-in', () => {
    expect(channelOf({ delivery_partner: 'Foodmandu', table_id: null })).toBe('Delivery')
    expect(channelOf({ table_id: null })).toBe('Takeaway')
    expect(channelOf({ table_id: 't3' })).toBe('Dine-in')
    expect(channelMix([bill({}), bill({ table_id: null, paid_amount: 250 })])).toEqual([
      { channel: 'Dine-in', bills: 1, amount: 1000 },
      { channel: 'Takeaway', bills: 1, amount: 250 },
    ])
  })
})

describe('topItems', () => {
  test('ranks by quantity and leaves comped lines out', () => {
    const rows = topItems([
      { recipe_id: 'r1', name: 'Momo', qty: 3 }, { recipe_id: 'r1', name: 'Momo', qty: 2 },
      { recipe_id: 'r2', name: 'Tea', qty: 4 }, { recipe_id: 'r3', name: 'Cake', qty: 9, comped: true },
    ])
    expect(rows.map(r => [r.name, r.qty])).toEqual([['Momo', 5], ['Tea', 4]])
  })
})

describe('the floor band', () => {
  const now = Date.parse('2026-10-02T08:00:00Z')
  test('open bills: count, the oldest one\'s age, and the value on them before VAT', () => {
    const s = openBillsSummary([
      { opened_at: '2026-10-02T07:20:00Z', pos_order_items: [{ qty: 2, unit_price: 150 }, { qty: 1, unit_price: 500, comped: true }] },
      { opened_at: '2026-10-02T07:50:00Z', pos_order_items: [] },
    ], now)
    expect(s).toEqual({ count: 2, oldestMins: 40, value: 300 })
  })

  test('tickets past the late line, finished ones never counted', () => {
    const s = ticketSummary([
      { status: 'new', sent_at: '2026-10-02T07:40:00Z' },
      { status: 'in_progress', sent_at: '2026-10-02T07:55:00Z' },
      { status: 'ready', sent_at: '2026-10-02T07:00:00Z' },
    ], 15 * 60000, now)
    expect(s).toEqual({ working: 2, late: 1 })
  })
})

test('same weekday last week crosses a month and a year cleanly', () => {
  expect(sameWeekdayLastWeek('2026-10-02')).toBe('2026-09-25')
  expect(sameWeekdayLastWeek('2026-01-03')).toBe('2025-12-27')
})
