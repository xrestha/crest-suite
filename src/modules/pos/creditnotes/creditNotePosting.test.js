import { creditNoteReversalRows, backfillCreditNotesToIms, postCreditNoteToIms } from './creditNotePosting'

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

  it('aborts rather than posting when it cannot check what already posted', async () => {
    const insert = jest.fn()
    const supabase = { from: () => ({ select: () => builder({ data: null, error: { message: 'boom' } }), insert }) }
    const scopedFrom = () => builder({ data: [{ id: 'cn1', order_id: 'o1', created_at: '2026-08-20T10:00:00Z' }], error: null })
    const res = await backfillCreditNotesToIms({ supabase, scopedFrom, scopedUpdate: jest.fn(), period })
    expect(res.error).toMatch(/Could not check/)
    expect(insert).not.toHaveBeenCalled()
  })
})
