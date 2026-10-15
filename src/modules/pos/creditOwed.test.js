/**
 * "What a Credit bill still owes" exists twice: pos_credit_open_bills() in the database (S843,
 * migration 20261015120000) and creditOwed.js here. The browser copy reads a date range's bills and
 * works for Crest support's view of an outlet, which the function (scoped by my_client_id()) does not.
 * The server cannot import a .js module, so this test holds the two together the way
 * expectedCashTwin.test.js holds Expected Cash: comments are stripped first, so a sentence explaining
 * the rule cannot satisfy an assertion about the code. A failure here means: change both in one commit.
 */
import fs from 'fs'
import path from 'path'
import { receiptTotalsByBill, owedOn, isPartPaid, settledMethodLabel, RECEIPT_LINE_COLUMNS, readReceiptLines } from './creditOwed'

jest.mock('../../shared/fetchAllRows', () => ({
  fetchAllRowsChunked: (ids, makeQuery) => Promise.resolve({ data: ids.length ? [makeQuery(ids)] : [], error: null }),
}))

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations')
const sqlCode = s => s.replace(/--[^\n]*/g, '')
const squash = s => s.replace(/\s+/g, ' ')

// The LATEST migration that defines the function, so a later rebuild is what gets compared.
function latestOpenBillsSql() {
  const marker = 'FUNCTION public.pos_credit_open_bills('
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  const hits = files.filter(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').includes(`CREATE OR REPLACE ${marker}`))
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, hits[hits.length - 1]), 'utf8')
  const body = sql.split(`CREATE OR REPLACE ${marker}`)[1].split('$$;')[0]
  return { file: hits[hits.length - 1], body: squash(sqlCode(body)) }
}

const { file, body } = latestOpenBillsSql()
const js = squash(fs.readFileSync(path.join(__dirname, 'creditOwed.js'), 'utf8').replace(/\/\/[^\n]*/g, ''))

describe('what a Credit bill still owes, and its SQL twin pos_credit_open_bills', () => {
  it('reads the function from a migration at or after S843', () => {
    expect(file >= '20261015120000').toBe(true)
  })

  it('both take received AND commission off paid_amount, to the paisa', () => {
    expect(body).toContain('round(COALESCE(o.paid_amount, 0) - COALESCE(x.received, 0) - COALESCE(x.commission, 0), 2)')
    expect(body).toContain('sum(l.amount) AS received, sum(l.commission) AS commission')
    expect(js).toContain('return round2((Number(paidAmount) || 0) - (totals?.received || 0) - (totals?.commission || 0))')
    expect(owedOn(1130, { received: 500, commission: 30 })).toBe(600)
    expect(owedOn('1130.10', { received: 1000.05, commission: 0 })).toBe(130.05)
  })

  it('both leave a cancelled receipt out', () => {
    expect(body).toContain('WHERE l.order_id = o.id AND r.cancelled_at IS NULL')
    expect(js).toContain('if (!r || r.cancelled_at) continue')
    const totals = receiptTotalsByBill([
      { order_id: 'a', amount: 400, commission: 0, pos_credit_receipts: { method: 'Cash', cancelled_at: null } },
      { order_id: 'a', amount: 300, commission: 20, pos_credit_receipts: { method: 'eSewa', cancelled_at: null } },
      { order_id: 'a', amount: 999, commission: 0, pos_credit_receipts: { method: 'Cash', cancelled_at: '2026-10-15T08:00:00Z' } },
    ])
    expect(totals.a).toEqual({ received: 700, commission: 20, cash: 400 })
    expect(owedOn(1130, totals.a)).toBe(410)
  })

  it('both count only a paid, billed Credit bill with no settlement and no credit note as owing', () => {
    expect(body).toContain("o.payment_method = 'Credit' AND o.status = 'billed' AND o.close_type = 'paid' AND o.credit_settled_at IS NULL AND o.credit_note_id IS NULL")
  })

  it('reads every line of the bills with its receipt, chunked', async () => {
    expect(RECEIPT_LINE_COLUMNS).toBe('order_id, amount, commission, pos_credit_receipts!inner(method, cancelled_at)')
    const calls = []
    const scopedFrom = (table, cols) => {
      const q = { table, cols, ops: [] }
      q.in = (c, v) => { q.ops.push(['in', c, v]); return q }
      q.order = c => { q.ops.push(['order', c]); return q }
      calls.push(q)
      return q
    }
    await readReceiptLines(scopedFrom, ['o1', 'o2'])
    expect(calls[0].table).toBe('pos_credit_receipt_lines')
    expect(calls[0].ops).toEqual([['in', 'order_id', ['o1', 'o2']], ['order', 'id']])
    // No bills, no read.
    expect((await readReceiptLines(scopedFrom, [])).data).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('a bill is part-paid only while something was paid and something is still owed', () => {
    expect(isPartPaid(1000, undefined)).toBe(false)
    expect(isPartPaid(1000, { received: 0, commission: 0 })).toBe(false)
    expect(isPartPaid(1000, { received: 400, commission: 0 })).toBe(true)
    expect(isPartPaid(1000, { received: 970, commission: 30 })).toBe(false)
  })

  it("names a bill paid off by several methods 'Mixed' in words, and leaves the others as they are", () => {
    expect(settledMethodLabel('Mixed')).toBe('Mixed (several payments)')
    expect(settledMethodLabel('eSewa')).toBe('eSewa')
    expect(settledMethodLabel(null)).toBe('—')
  })
})
