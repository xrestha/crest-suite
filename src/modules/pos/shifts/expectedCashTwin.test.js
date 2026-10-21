/**
 * Expected Cash now exists twice: `expectedCashOf` and `loadShiftReport` in PosShifts.jsx, and their
 * SQL twin inside `pos_shifts_guard` (S809 1l, migration 20261009180000), which adds up the shift's
 * stored cash as it closes and refuses a closing report whose cash figures differ.
 *
 * The server cannot import a .js module, so the two copies are held together by this test, the way
 * itemRefTables.test.js holds ITEM_REF_TABLES to its SQL twin. If one side changes what counts as cash
 * and the other does not, every honest close is refused (`pos_shift_figures_changed`) — the same reason
 * pos-billing.md keeps the VAT arithmetic out of SQL. A failure here means: change both in one commit.
 *
 * It reads source text on purpose. Comments are stripped first, so a sentence explaining the rule
 * cannot satisfy an assertion about the code.
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
const jsCode = s => s.replace(/\/\/[^\n]*/g, '')
const sqlCode = s => s.replace(/--[^\n]*/g, '')
const squash = s => s.replace(/\s+/g, ' ')

// The LATEST migration that defines the guard, so a later rebuild of it is what gets compared.
function latestGuardSql() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  const hits = files.filter(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
    .includes('CREATE OR REPLACE FUNCTION public.pos_shifts_guard()'))
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, hits[hits.length - 1]), 'utf8')
  const body = sql.split('CREATE OR REPLACE FUNCTION public.pos_shifts_guard()')[1].split('$function$;')[0]
  return { file: hits[hits.length - 1], body: squash(sqlCode(body)) }
}

// The LATEST migration's cash entry kinds and the way each one moves cash (both CHECKs on
// pos_cash_movements). S843 added 'credit_receipt_cancel', the cash of a cancelled customer payment.
function latestKindChecks() {
  let kinds = null
  let outKinds = null
  let inKinds = null
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = squash(sqlCode(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
    const k = sql.match(/ADD CONSTRAINT pos_cash_movements_kind_check CHECK \(kind IN \(([^)]*)\)\)/)
    if (k) kinds = [...k[1].matchAll(/'(\w+)'/g)].map(m => m[1])
    const d = sql.match(/ADD CONSTRAINT pos_cash_movements_kind_direction_check CHECK \((.*?)\);/)
    if (d) {
      const of = dir => {
        const m = d[1].match(new RegExp(`kind IN \\(([^)]*)\\) AND direction = '${dir}'`))
        return m ? [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]) : null
      }
      outKinds = of('out')
      inKinds = of('in')
    }
  }
  return { kinds, outKinds, inKinds }
}

const jsx = squash(jsCode(fs.readFileSync(path.join(__dirname, 'PosShifts.jsx'), 'utf8')))
const { file, body: guard } = latestGuardSql()
const { kinds, outKinds, inKinds } = latestKindChecks()

describe('Expected Cash and its SQL twin in pos_shifts_guard', () => {
  it('reads the guard from a migration at or after S809 1l', () => {
    expect(file >= '20261009180000').toBe(true)
  })

  it('both add the same four terms', () => {
    expect(jsx).toContain(
      'return (Number(shift.opening_cash) || 0) + (report.cashSales || 0) + (report.cashIn || 0) - (report.cashOut || 0)')
    expect(guard).toContain('v_expected := NEW.opening_cash + v_sales + v_in - v_out;')
  })

  it('both count as cash sales the paid Cash bills and the Cash legs of paid Split bills, nothing else', () => {
    // JS: the paid bills, a Split bill through its legs, any other bill by its own method; Cash only.
    expect(jsx).toContain("if (o.close_type === 'paid') {")
    expect(jsx).toContain("if (o.payment_method === 'Split') {")
    expect(jsx).toContain('const cashSales = byMethod.Cash || 0')
    // SQL: the same two sources.
    expect(guard).toContain("o.close_type = 'paid' AND o.payment_method = 'Cash';")
    expect(guard).toContain("o.close_type = 'paid' AND o.payment_method = 'Split' AND p.client_id = OLD.client_id AND p.payment_method = 'Cash';")
  })

  it('both read the bills, legs and cash entries of this shift and this outlet only', () => {
    expect(jsx).toContain("scopedFromRaw('pos_orders', clientId, 'id, close_type, payment_method, paid_amount, discount_amount, closed_at') .eq('shift_id', shiftId)")
    expect(jsx).toContain("scopedFromRaw('pos_cash_movements', clientId, '*') .eq('shift_id', shiftId)")
    expect(guard).toContain('o.shift_id = OLD.id AND o.client_id = OLD.client_id')
    expect(guard).toContain('m.shift_id = OLD.id AND m.client_id = OLD.client_id')
  })

  it('both split cash entries on direction alone', () => {
    expect(jsx).toContain("const cashIn = moveList.filter(m => m.direction === 'in')")
    expect(jsx).toContain("const cashOut = moveList.filter(m => m.direction === 'out')")
    expect(guard).toContain("sum(m.amount) FILTER (WHERE m.direction = 'in')")
    expect(guard).toContain("sum(m.amount) FILTER (WHERE m.direction = 'out')")
  })

  // S843: a customer payment's Cash In carries no bill (one receipt can cover several), and a payment
  // cancelled as a mistake takes its cash back out as a new kind. Expected Cash needs no change for
  // either only because both sides count by direction and the database pins each kind to one
  // direction; this holds the pinning, and the screen's naming of every kind, to the migrations.
  it('every kind of cash entry moves one way only, so counting by direction counts it (S843)', () => {
    expect(kinds).toEqual(expect.arrayContaining(['pay_in', 'pay_out', 'credit_settlement', 'refund', 'credit_receipt_cancel']))
    expect([...outKinds, ...inKinds].sort()).toEqual([...kinds].sort())
    expect(outKinds).toEqual(expect.arrayContaining(['pay_out', 'refund', 'credit_receipt_cancel']))
    expect(inKinds).toEqual(expect.arrayContaining(['pay_in', 'credit_settlement']))
  })

  it('names every kind of cash entry the database allows, and never needs a bill to count one (S843)', () => {
    for (const k of kinds.filter(k => k !== 'pay_in' && k !== 'pay_out')) {
      expect([k, jsx.includes(`m.kind === '${k}'`)]).toEqual([k, true])
    }
    // A cancelled payment is told apart from other cash outs on the screen and the slip.
    expect(jsx).toContain("if (m.kind === 'credit_receipt_cancel') return 'Customer payment cancelled'")
    expect(jsx).toContain(".filter(m => m.kind === 'credit_receipt_cancel').reduce(")
    // Credit collections are counted by kind alone: a receipt's Cash In has no order_id.
    expect(jsx).toContain(".filter(m => m.kind === 'credit_settlement').reduce(")
    expect(jsx).not.toMatch(/m\.order_id/)
  })

  // S854: a booking deposit taken in cash is a Cash In of its own kind, and a cash refund of one a Cash
  // Out. Expected Cash needs no new term on either side only because each kind is pinned to one
  // direction and both sides count by direction; and a Deposit payment line is a tender, never cash, so
  // the money is not counted again on the night the deposit pays the bill.
  it('a booking deposit and its refund move one way each, are named, and a Deposit line is never cash (S854)', () => {
    expect(kinds).toEqual(expect.arrayContaining(['deposit', 'deposit_refund']))
    expect(inKinds).toEqual(expect.arrayContaining(['deposit']))
    expect(outKinds).toEqual(expect.arrayContaining(['deposit_refund']))
    expect(jsx).toContain("if (m.kind === 'deposit') return 'Booking deposit'")
    expect(jsx).toContain("if (m.kind === 'deposit_refund') return 'Booking deposit refunded'")
    expect(jsx).toContain(".filter(m => m.kind === 'deposit').reduce(")
    expect(jsx).toContain(".filter(m => m.kind === 'deposit_refund').reduce(")
    // The method breakdown knows the Deposit line (a method it does not know is silently dropped), and
    // cash sales stay byMethod.Cash, so the Deposit line never reaches the drawer count.
    expect(jsx).toContain("const PAY_METHODS = [...PAYMENT_METHODS, 'Loyalty', 'Deposit', 'Credit']")
    expect(jsx).toContain('const cashSales = byMethod.Cash || 0')
    expect(guard).not.toMatch(/'Deposit'/)
  })

  it('the guard checks every cash figure the close sends, and the close still sends each one', () => {
    const checked = [...guard.matchAll(/\(\d+, '([\w.]+)', NEW\.closing_report/g)].map(m => m[1])
    expect(checked).toEqual(['cashSales', 'byMethod.Cash', 'cashIn', 'cashOut',
      'openingCash', 'expectedCash', 'closingCash', 'variance'])
    // loadShiftReport returns the first four inside the report the close spreads in; commitClose adds
    // the last four. A key renamed on the page and not in the guard would fail every close.
    expect(jsx).toContain('cashSales, movements: moveList, cashIn, cashOut,')
    for (const key of ['openingCash:', 'closingCash:', 'expectedCash:', 'variance:']) {
      expect(jsx).toContain(key)
    }
  })

  it('the counted total is the notes counted on both sides', () => {
    expect(jsx).toContain('const closing_cash = sumDenoms(denomCounts)')
    expect(jsx).toContain('const opening_cash = sumDenoms(denomCounts)')
    expect(jsx).toContain('const DENOMINATIONS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]')
    expect(guard).toContain('public.pos_cash_count_total(NEW.closing_denominations)')
    expect(guard).toContain('public.pos_cash_count_total(NEW.opening_denominations)')
  })

  it('stays SECURITY INVOKER, keyed on current_user, with only the restore passing for the operator', () => {
    const header = guard.split('AS $function$')[0]
    expect(header).not.toMatch(/SECURITY DEFINER/i)
    expect(guard).toContain("IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;")
    expect(guard).toContain("IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.opened_at < now() THEN RETURN NEW; END IF;")
  })
})
