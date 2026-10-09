// S809 CHECKOUT-7: a close whose first try lands late is settled from what the server stored, and
// "still open" is final only once nothing of that try can still land.
import {
  CLOSE_LAND_GRACE_MS, trackCloseWrite, openReadIsFinal, describeStoredPayment, storedPaymentDiffers,
  paymentDifferenceNote, storedDiscountRatio, legsToRecord, customerRowFromBill, latestCompRows,
  storedLinesMatchPaid,
} from './closeAttempt'

const flush = () => new Promise(r => setTimeout(r, 0))

describe('trackCloseWrite — when an "open" read becomes final', () => {
  test('a write still travelling keeps every open read from being final', async () => {
    const attempt = {}
    let resolve
    const builder = { then: (ok, ko) => new Promise(r => { resolve = r }).then(ok, ko) }
    const write = trackCloseWrite(attempt, builder, () => 1000)
    await flush()
    expect(attempt.writesInFlight).toBe(1)
    expect(openReadIsFinal(attempt, 10 ** 12)).toBe(false)
    resolve({ data: null, error: { message: 'x' }, status: 400 })
    await write
    await flush()
    expect(attempt.writesInFlight).toBe(0)
  })

  test('the database\'s own answer (a 2xx or 4xx) is final straight away', async () => {
    const attempt = {}
    await trackCloseWrite(attempt, Promise.resolve({ data: null, error: { hint: 'bill_locked' }, status: 403 }), () => 5000)
    await flush()
    expect(attempt.finalAfter).toBe(5000)
    expect(openReadIsFinal(attempt, 5000)).toBe(true)
    expect(openReadIsFinal(attempt, 4999)).toBe(false) // a read that began before it finished proves nothing
  })

  test('no answer (status 0: cancelled or the connection dropped) waits out the grace', async () => {
    const attempt = {}
    await trackCloseWrite(attempt, Promise.resolve({ data: null, error: { message: 'AbortError' }, status: 0 }), () => 5000)
    await flush()
    expect(openReadIsFinal(attempt, 5000)).toBe(false)
    expect(openReadIsFinal(attempt, 5000 + CLOSE_LAND_GRACE_MS)).toBe(true)
  })

  test('a 5xx may be the gateway giving up while the database works on, so it waits out the grace', async () => {
    const attempt = {}
    await trackCloseWrite(attempt, Promise.resolve({ data: null, error: { message: 'Bad gateway' }, status: 502 }), () => 5000)
    await flush()
    expect(openReadIsFinal(attempt, 5000)).toBe(false)
    expect(openReadIsFinal(attempt, 5000 + CLOSE_LAND_GRACE_MS)).toBe(true)
  })

  test('a rejected write counts as no answer', async () => {
    const attempt = {}
    await trackCloseWrite(attempt, Promise.reject(new Error('boom')), () => 0).catch(() => {})
    await flush()
    expect(attempt.writesInFlight).toBe(0)
    expect(openReadIsFinal(attempt, CLOSE_LAND_GRACE_MS - 1)).toBe(false)
    expect(openReadIsFinal(attempt, CLOSE_LAND_GRACE_MS)).toBe(true)
  })

  test('the builder is run once — a supabase builder sends again every time it is awaited', async () => {
    let sends = 0
    const builder = { then: (ok, ko) => { sends += 1; return Promise.resolve({ status: 200, data: { id: 'o1' } }).then(ok, ko) } }
    const write = trackCloseWrite({}, builder)
    await write
    await write
    expect(sends).toBe(1)
  })

  test('a second press on the same attempt keeps it unsettled until both writes finish', async () => {
    const attempt = {}
    let first
    trackCloseWrite(attempt, { then: (ok, ko) => new Promise(r => { first = r }).then(ok, ko) }, () => 100)
    await trackCloseWrite(attempt, Promise.resolve({ status: 200 }), () => 200)
    await flush()
    expect(attempt.writesInFlight).toBe(1)
    expect(openReadIsFinal(attempt, 10 ** 12)).toBe(false)
    first({ status: 0 })
    await flush()
    expect(openReadIsFinal(attempt, 100 + CLOSE_LAND_GRACE_MS)).toBe(true)
  })

  test('an attempt with no write tracked is never final', () => {
    expect(openReadIsFinal({}, 10 ** 12)).toBe(false)
    expect(openReadIsFinal(null, 10 ** 12)).toBe(false)
  })
})

describe('the stored payment against the screen', () => {
  const stored = { close_type: 'paid', payment_method: 'Cash', paid_amount: 3400 }

  test('describes a stored bill in the till\'s words', () => {
    expect(describeStoredPayment(stored)).toBe('Cash NPR 3,400')
    expect(describeStoredPayment({ close_type: 'paid', payment_method: 'Split', paid_amount: 240000 })).toBe('Split NPR 2,40,000')
    expect(describeStoredPayment({ close_type: 'writeoff' })).toBe('Complimentary')
  })

  test('the same payment is not a difference, within the rupee rounding', () => {
    expect(storedPaymentDiffers(stored, { method: 'Cash', amount: 3400 })).toBe(false)
    expect(storedPaymentDiffers(stored, { method: 'Cash', amount: 3400.4 })).toBe(false)
    expect(paymentDifferenceNote('Table 9', stored, { method: 'Cash', amount: 3400 })).toBeNull()
  })

  test('another method or amount is a difference (the CHECKOUT-7 counter case)', () => {
    expect(storedPaymentDiffers(stored, { method: 'Card', amount: 3400 })).toBe(true)
    expect(storedPaymentDiffers(stored, { method: 'Cash', amount: 3150 })).toBe(true)
    const note = paymentDifferenceNote('Table 9', stored, { method: 'Card', amount: 3150 })
    expect(note).toMatch(/^The first try closed Table 9 as Cash NPR 3,400, not Card NPR 3,150/)
  })

  test('only a paid close is compared', () => {
    expect(storedPaymentDiffers({ close_type: 'writeoff' }, { method: 'Cash', amount: 0 })).toBe(false)
    expect(storedPaymentDiffers(null, { method: 'Cash', amount: 1 })).toBe(false)
  })
})

describe('finishing from the stored bill', () => {
  test('the discount ratio is taken over the charged (not comped) stored lines', () => {
    const items = [
      { qty: 2, unit_price: 500, comped: false },
      { qty: 1, unit_price: 250, comped: true },
    ]
    expect(storedDiscountRatio(items, 100)).toBeCloseTo(0.1)
    expect(storedDiscountRatio(items, 0)).toBe(0)
    expect(storedDiscountRatio(null, 100)).toBe(0)
    expect(storedDiscountRatio([{ qty: 1, unit_price: 100 }], 500)).toBe(1)
  })

  test('Split legs come from the attempt, and never once any leg landed', () => {
    const sent = [{ method: 'Cash', amount: 1500 }, { method: 'eSewa', amount: 900 }, { method: 'Loyalty', amount: 100, points: 100 }]
    expect(legsToRecord(sent, [])).toEqual([{ method: 'Cash', amount: 1500 }, { method: 'eSewa', amount: 900 }])
    expect(legsToRecord(sent, [{ payment_method: 'Loyalty', amount: 100 }])).toHaveLength(2) // the redemption's own leg
    expect(legsToRecord(sent, [{ payment_method: 'Cash', amount: 1500 }])).toEqual([])
    expect(legsToRecord(sent, null)).toHaveLength(2) // unread: the server decides
    expect(legsToRecord(undefined, [])).toEqual([])
  })

  test('the customer row is the bill\'s, and only with a name and a phone', () => {
    expect(customerRowFromBill({ buyer_name: ' Asha ', buyer_phone: '9800000000', buyer_address: '', buyer_pan: '123' }, 'T'))
      .toEqual({ name: 'Asha', phone: '9800000000', updated_at: 'T', pan: '123' })
    expect(customerRowFromBill({ buyer_name: 'Asha', buyer_phone: '' }, 'T')).toBeNull()
    expect(customerRowFromBill(null, 'T')).toBeNull()
  })

  test('the customer row stores the number, however the bill had it typed (S809 3k)', () => {
    expect(customerRowFromBill({ buyer_name: 'Asha', buyer_phone: '+977 980-000-0000' }, 'T'))
      .toEqual({ name: 'Asha', phone: '9800000000', updated_at: 'T' })
    // A short code is kept as typed: there is no number to go by.
    expect(customerRowFromBill({ buyer_name: 'Asha', buyer_phone: ' 1-2345 ' }, 'T'))
      .toEqual({ name: 'Asha', phone: '1-2345', updated_at: 'T' })
    expect(customerRowFromBill({ buyer_name: 'Asha', buyer_phone: '   ' }, 'T')).toBeNull()
  })

  test('stored lines must come to what the bill was paid (the save-then-late-landing case)', () => {
    const row = { close_type: 'paid', paid_amount: 3150, discount_amount: 0 }
    const withComp = [
      { qty: 1, unit_price: 3150, vat_rate: 0, comped: false },
      { qty: 1, unit_price: 250, vat_rate: 0, comped: true },
    ]
    expect(storedLinesMatchPaid(row, withComp, false)).toBe(true)
    // A later save put the dessert back as an ordinary line before the first try landed.
    const compWiped = [{ qty: 1, unit_price: 3150, vat_rate: 0 }, { qty: 1, unit_price: 250, vat_rate: 0 }]
    expect(storedLinesMatchPaid(row, compWiped, false)).toBe(false)
    // VAT and a discount: 1,000 ex-VAT − 100 discount, 13% on the rest = 1,017.
    expect(storedLinesMatchPaid({ close_type: 'paid', paid_amount: 1017, discount_amount: 100 },
      [{ qty: 1, unit_price: 1000, vat_rate: 0.13 }], true)).toBe(true)
    expect(storedLinesMatchPaid({ close_type: 'writeoff', paid_amount: 0 }, compWiped, false)).toBe(true)
    expect(storedLinesMatchPaid(row, null, false)).toBe(true) // unread lines are reported elsewhere
    // S809 2c: the stored bill's own stamp decides, as on the printed bill, not the till's flag.
    const stampedVat = { close_type: 'paid', paid_amount: 1130, discount_amount: 0, vat_registered: true }
    expect(storedLinesMatchPaid(stampedVat, [{ qty: 1, unit_price: 1000, vat_rate: 0.13 }], false)).toBe(true)
    expect(storedLinesMatchPaid({ ...stampedVat, vat_registered: false }, [{ qty: 1, unit_price: 1000, vat_rate: 0.13 }], true)).toBe(false)
  })

  test('the comp slip is the latest comp number on the stored bill', () => {
    const items = [
      { id: 1, comp_no: null },
      { id: 2, comp_no: 14 },
      { id: 3, comp_no: 15 },
      { id: 4, comp_no: 15 },
    ]
    expect(latestCompRows(items)).toEqual({ compNo: 15, rows: [{ id: 3, comp_no: 15 }, { id: 4, comp_no: 15 }] })
    expect(latestCompRows([{ id: 1, comp_no: null }])).toEqual({ compNo: null, rows: [] })
    expect(latestCompRows(null)).toEqual({ compNo: null, rows: [] })
  })
})
