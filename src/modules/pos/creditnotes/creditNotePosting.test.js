import { creditNoteReversalRows, creditNoteRestockMovements, backfillCreditNotesToIms, postCreditNoteToIms } from './creditNotePosting'
import { bsToAd, formatAd } from '../../../utils/bsCalendar'

jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: async make => make(),
  fetchAllRowsChunked: async (ids, make) => make(ids),
  runChunkedByIds: async (ids, make) => make(ids),
}))

const ITEMS = [
  { recipe_id: 'r1', qty: 2, unit_price: 500, vat_rate: 0.13, comped: false },
  { recipe_id: 'r2', qty: 1, unit_price: 1000, vat_rate: 0.13, comped: false },
  { recipe_id: 'r3', qty: 1, unit_price: 300, vat_rate: 0.13, comped: true },
  { recipe_id: null, qty: 1, unit_price: 50, vat_rate: 0, comped: false },
]

describe('creditNoteReversalRows — the revenue the bill POSTED, negated', () => {
  it('skips comped and non-recipe lines, and links every row to its note', () => {
    const rows = creditNoteReversalRows({ order: { close_type: 'paid', discount_amount: 0 }, items: ITEMS, periodId: 'p', bsDay: 7, creditNoteId: 'cn1' })
    expect(rows.map(r => r.recipe_id)).toEqual(['r1', 'r2'])
    expect(rows.every(r => r.source === 'pos_credit' && r.pos_credit_note_id === 'cn1' && r.bs_day === 7)).toBe(true)
    expect(rows.map(r => r.qty_sold)).toEqual([-2, -1])
  })

  it('spreads the bill discount over the payable lines, exactly as the close posted it', () => {
    // payable gross 2,000; a 400 discount leaves 80% of each line's price
    const rows = creditNoteReversalRows({ order: { close_type: 'paid', discount_amount: 400 }, items: ITEMS, periodId: 'p', bsDay: 1, creditNoteId: 'cn' })
    expect(rows.map(r => r.unit_price)).toEqual([400, 800])
    const reversed = rows.reduce((s, r) => s + -r.qty_sold * r.unit_price, 0)
    expect(reversed).toBe(1600)
  })

  it('reverses nothing for a whole-bill comp, which posted no revenue', () => {
    expect(creditNoteReversalRows({ order: { close_type: 'writeoff' }, items: ITEMS, periodId: 'p', bsDay: 1, creditNoteId: 'cn' })).toEqual([])
  })
})

// A tiny query-builder stand-in: every chained call returns itself, and awaiting it resolves the
// canned result for that table/operation.
function builder(result) {
  const b = new Proxy({}, {
    get: (_t, prop) => prop === 'then'
      ? (ok, bad) => Promise.resolve(result).then(ok, bad)
      : () => b,
  })
  return b
}

describe('postCreditNoteToIms', () => {
  const today = { year: 2083, month: 5, day: 12 }
  const note = { id: 'cn1' }
  const order = { close_type: 'paid', discount_amount: 0 }

  it('does not post, and says why, when no period exists for today', async () => {
    const insert = jest.fn()
    const res = await postCreditNoteToIms({
      supabase: { from: () => ({ insert }) },
      scopedFrom: () => builder({ data: null, error: null }),
      scopedUpdate: jest.fn(),
      note, order, items: ITEMS, today,
    })
    expect(res).toEqual({ posted: false, reason: 'no_period' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('reports a refused insert instead of swallowing it, and does not stamp', async () => {
    const scopedUpdate = jest.fn(() => builder({ error: null }))
    const res = await postCreditNoteToIms({
      supabase: { from: () => ({ insert: async () => ({ error: { message: 'refused' } }) }) },
      scopedFrom: () => builder({ data: { id: 'p1', status: 'open' }, error: null }),
      scopedUpdate, note, order, items: ITEMS, today,
    })
    expect(res.posted).toBe(false)
    expect(res.reason).toBe('write')
    expect(scopedUpdate).not.toHaveBeenCalled()
  })

  it('stamps the note once the rows land', async () => {
    const scopedUpdate = jest.fn(() => builder({ error: null }))
    const res = await postCreditNoteToIms({
      supabase: { from: () => ({ insert: async () => ({ error: null }) }) },
      scopedFrom: () => builder({ data: { id: 'p1', status: 'open' }, error: null }),
      scopedUpdate, note, order, items: ITEMS, today,
    })
    expect(res).toEqual({ posted: true })
    expect(scopedUpdate).toHaveBeenCalledWith('pos_credit_notes', expect.objectContaining({ ims_posted_at: expect.any(String) }))
  })
})

describe('backfillCreditNotesToIms', () => {
  const period = { id: 'p1', bs_year: 2083, bs_month: 5 }

  it('stamps a note whose reversal rows already exist instead of posting it again', async () => {
    const inserts = []
    const supabase = {
      from: () => ({
        select: () => builder({ data: [{ pos_credit_note_id: 'cn1', id: 's1' }], error: null }),
        insert: async rows => { inserts.push(rows); return { error: null } },
      }),
    }
    const scopedFrom = table => builder(table === 'pos_credit_notes'
      ? { data: [{ id: 'cn1', order_id: 'o1', created_at: '2026-08-20T10:00:00Z' }], error: null }
      : { data: [], error: null })
    const scopedUpdate = jest.fn(() => builder({ error: null }))
    const res = await backfillCreditNotesToIms({ supabase, scopedFrom, scopedUpdate, period })
    expect(res).toEqual({ posted: 0, skipped: 1 })
    expect(inserts).toHaveLength(0)
    expect(scopedUpdate).toHaveBeenCalled()
  })

  // S792, SALES-6: the day comes from Nepal's calendar, whatever zone the backfill runs in (the old
  // `adToBs(new Date(created_at))` fails this under TZ=UTC).
  it("dates each reversal by the day the note was issued in Nepal, and leaves another month's note waiting", async () => {
    const inserts = []
    const supabase = {
      from: () => ({
        select: () => builder({ data: [], error: null }),
        insert: async rows => { inserts.push(rows); return { error: null } },
      }),
    }
    const npt = (m, d, hhmm) => `${formatAd(bsToAd(2083, m, d))}T${hhmm}:00+05:45`
    const scopedFrom = table => builder(table === 'pos_credit_notes'
      ? { data: [
          { id: 'cn1', order_id: 'o1', created_at: npt(5, 1, '00:10') },
          { id: 'cn2', order_id: 'o1', created_at: npt(6, 1, '00:10') },
        ], error: null }
      : { data: [{ id: 'o1', close_type: 'paid', discount_amount: 0, pos_order_items: ITEMS }], error: null })
    const scopedUpdate = jest.fn(() => builder({ error: null }))
    const res = await backfillCreditNotesToIms({ supabase, scopedFrom, scopedUpdate, period })
    expect(res).toEqual({ posted: 1, skipped: 1 })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].every(r => r.bs_day === 1 && r.pos_credit_note_id === 'cn1')).toBe(true)
    expect(scopedUpdate).toHaveBeenCalledTimes(1)
  })

  it('aborts rather than posting when it cannot check what already posted', async () => {
    const insert = jest.fn()
    const supabase = { from: () => ({ select: () => builder({ data: null, error: { message: 'boom' } }), insert }) }
    const scopedFrom = () => builder({ data: [{ id: 'cn1', order_id: 'o1', created_at: '2026-08-20T10:00:00Z' }], error: null })
    const res = await backfillCreditNotesToIms({ supabase, scopedFrom, scopedUpdate: jest.fn(), period })
    expect(res.error).toMatch(/Could not check/)
    expect(insert).not.toHaveBeenCalled()
  })
})

// S809 2e (CREDIT-NOTES-1, owner decision Q10 a): a note whose food was not served on its bill puts
// that food back — its reversal rows count against stock usage, and the bill's own depletion is undone.
describe('a note whose food was not served (restock)', () => {
  const today = { year: 2083, month: 6, day: 23 }
  const order = { id: 'o1', close_type: 'paid', discount_amount: 0 }
  const note = { id: 'cn9', restock: true }

  it('posts the same reversal rows under the restock source', () => {
    const plain = creditNoteReversalRows({ order, items: ITEMS, periodId: 'p', bsDay: 7, creditNoteId: 'cn9' })
    const back = creditNoteReversalRows({ order, items: ITEMS, periodId: 'p', bsDay: 7, creditNoteId: 'cn9', restock: true })
    expect(back.every(r => r.source === 'pos_credit_restock')).toBe(true)
    // revenue, quantities, prices and the link are exactly a plain reversal's
    expect(back.map(({ source, ...r }) => r)).toEqual(plain.map(({ source, ...r }) => r))
  })

  it("puts back exactly the bill's POS Sale depletion, item by item, linked to the bill", () => {
    const rows = creditNoteRestockMovements({
      saleMovements: [
        { item_id: 'chicken', qty: -0.4 },
        { item_id: 'flour', qty: -0.25 },
        { item_id: 'chicken', qty: -0.2 },   // a second row for one item (a double post in the past)
        { item_id: 'oil', qty: 0 },          // nothing taken, nothing to put back
        { item_id: null, qty: -1 },
      ],
      periodId: 'p6', bsDay: 23, orderId: 'o1',
    })
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.item_id === 'chicken').qty).toBeCloseTo(0.6)
    expect(rows.every(r => r.qty > 0 && r.source === 'pos_credit_restock' && r.ref_id === 'o1' && r.period_id === 'p6' && r.bs_day === 23)).toBe(true)
    expect(creditNoteRestockMovements({ saleMovements: [], periodId: 'p', bsDay: 1, orderId: 'o' })).toEqual([])
  })

  function harness({ billPosted, salesInsertError = null, movements = [{ item_id: 'chicken', qty: -0.4 }] }) {
    const salesInserts = []
    const supabase = {
      from: () => ({
        select: () => builder({ data: billPosted ? [{ id: 's1' }] : [], error: null }),
        insert: async rows => { salesInserts.push(rows); return { error: salesInsertError } },
      }),
    }
    const scopedFrom = table => builder(table === 'monthly_periods'
      ? { data: { id: 'p6', status: 'open' }, error: null }
      : { data: movements, error: null })
    const scopedInsert = jest.fn(async () => ({ error: null }))
    const scopedUpdate = jest.fn(() => builder({ error: null }))
    return { supabase, scopedFrom, scopedInsert, scopedUpdate, salesInserts }
  }

  it("waits for its bill when the bill's own sale has not reached Inventory, writing nothing", async () => {
    const h = harness({ billPosted: false })
    const res = await postCreditNoteToIms({ ...h, note, order, items: ITEMS, today })
    expect(res).toEqual({ posted: false, reason: 'bill_waiting' })
    expect(h.salesInserts).toHaveLength(0)
    expect(h.scopedInsert).not.toHaveBeenCalled()
    expect(h.scopedUpdate).not.toHaveBeenCalled()
  })

  it('posts the restock reversal, puts the stock back and stamps the note', async () => {
    const h = harness({ billPosted: true })
    const res = await postCreditNoteToIms({ ...h, note, order, items: ITEMS, today })
    expect(res).toEqual({ posted: true })
    expect(h.salesInserts).toHaveLength(1)
    expect(h.salesInserts[0].every(r => r.source === 'pos_credit_restock' && r.bs_day === 23 && r.period_id === 'p6')).toBe(true)
    expect(h.scopedInsert).toHaveBeenCalledWith('stock_movements', [
      { item_id: 'chicken', period_id: 'p6', bs_day: 23, qty: 0.4, source: 'pos_credit_restock', ref_id: 'o1' },
    ])
    expect(h.scopedUpdate).toHaveBeenCalledWith('pos_credit_notes', expect.objectContaining({ ims_posted_at: expect.any(String) }))
  })

  it('puts no stock back when the revenue reversal is refused', async () => {
    const h = harness({ billPosted: true, salesInsertError: { message: 'refused' } })
    const res = await postCreditNoteToIms({ ...h, note, order, items: ITEMS, today })
    expect(res.reason).toBe('write')
    expect(h.scopedInsert).not.toHaveBeenCalled()
    expect(h.scopedUpdate).not.toHaveBeenCalled()
  })

  it('a served note never touches stock', async () => {
    const h = harness({ billPosted: true })
    const res = await postCreditNoteToIms({ ...h, note: { id: 'cn8', restock: false }, order, items: ITEMS, today })
    expect(res).toEqual({ posted: true })
    expect(h.salesInserts[0].every(r => r.source === 'pos_credit')).toBe(true)
    expect(h.scopedInsert).not.toHaveBeenCalled()
  })

  it('the backfill leaves a not-served note waiting while its bill is not in Inventory, and posts it once it is', async () => {
    const period = { id: 'p6', bs_year: 2083, bs_month: 6 }
    const npt = (m, d, hhmm) => `${formatAd(bsToAd(2083, m, d))}T${hhmm}:00+05:45`
    for (const billPosted of [false, true]) {
      const salesInserts = []
      const supabase = {
        from: () => ({
          // the already-reversed check finds nothing; the bill-posted check (select 'id') answers billPosted
          select: cols => builder({ data: cols === 'id' ? (billPosted ? [{ id: 's1' }] : []) : [], error: null }),
          insert: async rows => { salesInserts.push(rows); return { error: null } },
        }),
      }
      const scopedFrom = table => builder(
        table === 'pos_credit_notes' ? { data: [{ id: 'cn9', order_id: 'o1', created_at: npt(6, 23, '12:00'), restock: true }], error: null }
          : table === 'pos_orders' ? { data: [{ id: 'o1', close_type: 'paid', discount_amount: 0, pos_order_items: ITEMS }], error: null }
            : { data: [{ item_id: 'chicken', qty: -0.4 }], error: null })
      const scopedInsert = jest.fn(async () => ({ error: null }))
      const scopedUpdate = jest.fn(() => builder({ error: null }))
      const res = await backfillCreditNotesToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period })
      if (!billPosted) {
        expect(res).toEqual({ posted: 0, skipped: 1 })
        expect(salesInserts).toHaveLength(0)
        expect(scopedInsert).not.toHaveBeenCalled()
      } else {
        expect(res).toEqual({ posted: 1, skipped: 0 })
        expect(salesInserts[0].every(r => r.source === 'pos_credit_restock' && r.bs_day === 23)).toBe(true)
        expect(scopedInsert).toHaveBeenCalledWith('stock_movements', [expect.objectContaining({ item_id: 'chicken', qty: 0.4, ref_id: 'o1', bs_day: 23 })])
      }
    }
  })
})
