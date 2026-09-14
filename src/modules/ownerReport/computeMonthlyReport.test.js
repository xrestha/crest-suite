// The two figures schema v6 changed the meaning of (see CURRENT_SCHEMA_VERSION's comment):
// purchases net of supplier bill discounts, and employer SSF only for real SSF contributors.
// Both defects were SILENT — a plausible, slightly-high number — so the arithmetic is pinned here
// and the reads that feed it are pinned by reading the source, since a select that omits a column
// makes the helper quietly fall back to the old behaviour rather than fail.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { netPurchaseFigures, estimatePayrollAccrual, CURRENT_SCHEMA_VERSION } from './computeMonthlyReport'
// eslint-disable-next-line import/first
import { SSF_CAP, SSF_EMPLOYER_PCT } from '../hr/payrollConstants'

const line = (over) => ({
  item_id: 'i1', qty: 1, rate: 0, payment_method: 'Cash', discount_amount: 0,
  purchase_group_id: 'bill-1', vendor_id: 'v1', invoice_ref: 'INV-1', bs_day: 3, ...over,
})

describe('netPurchaseFigures', () => {
  test('a bill discount lowers net purchases by exactly the discount, once per bill', () => {
    // Two lines of one bill, each carrying the bill's 1,000 discount (it is repeated per line).
    const purchases = [
      line({ qty: 2, rate: 3000, discount_amount: 1000 }),
      line({ item_id: 'i2', qty: 4, rate: 1000, discount_amount: 1000 }),
    ]
    const undiscounted = netPurchaseFigures(purchases.map(p => ({ ...p, discount_amount: 0 })), [])
    const discounted = netPurchaseFigures(purchases, [])
    expect(undiscounted.purchaseTotal).toBeCloseTo(10000, 6)
    expect(discounted.purchaseTotal).toBeCloseTo(9000, 6) // not 8,000: max, never sum, per bill
  })

  test('food cost % falls with the discount', () => {
    const revenue = 30000
    const purchases = [line({ qty: 10, rate: 1000, discount_amount: 1500 })]
    const fcBefore = (netPurchaseFigures(purchases.map(p => ({ ...p, discount_amount: 0 })), []).purchaseTotal / revenue) * 100
    const fcAfter = (netPurchaseFigures(purchases, []).purchaseTotal / revenue) * 100
    expect(fcBefore).toBeCloseTo(33.333, 2)
    expect(fcAfter).toBeCloseTo(28.333, 2)
  })

  test('legacy bills with no purchase_group_id are keyed by vendor + invoice + day', () => {
    const purchases = [
      line({ purchase_group_id: null, qty: 1, rate: 600, discount_amount: 100 }),
      line({ purchase_group_id: null, item_id: 'i2', qty: 1, rate: 400, discount_amount: 100 }),
      // a different bill from the same vendor on another day keeps its own discount
      line({ purchase_group_id: null, bs_day: 9, qty: 1, rate: 500, discount_amount: 50 }),
    ]
    expect(netPurchaseFigures(purchases, []).purchaseTotal).toBeCloseTo(1500 - 100 - 50, 6)
  })

  test('returns come off at list value, and Cash + Credit still adds up to the total', () => {
    const purchases = [
      line({ qty: 1, rate: 8000, discount_amount: 1000, payment_method: 'Credit' }),
      line({ item_id: 'i2', qty: 1, rate: 2000, discount_amount: 1000, payment_method: 'Credit' }),
      line({ purchase_group_id: 'bill-2', qty: 5, rate: 200, discount_amount: 0 }),
    ]
    const returns = [{ item_id: 'i1', qty: 1, rate: 300 }]
    const f = netPurchaseFigures(purchases, returns)
    expect(f.purchaseTotal).toBeCloseTo(9000 + 1000 - 300, 6)
    expect(f.creditNet).toBeCloseTo(9000, 6)
    expect(f.cashNet).toBeCloseTo(1000 - 300, 6)
    expect(f.cashNet + f.creditNet).toBeCloseTo(f.purchaseTotal, 6)
  })

  test('empty and missing inputs are zero, not NaN', () => {
    expect(netPurchaseFigures(null, undefined)).toEqual({ purchaseTotal: 0, cashNet: 0, creditNet: 0 })
  })
})

describe('estimatePayrollAccrual — employer SSF follows payroll’s own gate', () => {
  // A 30-or-so-day BS month; the exact length does not matter because every employee below
  // works the whole of it, so gross is the monthly figure and SSF is on the full capped base.
  const period = { bs_year: 2083, bs_month: 5 }
  const base = { status: 'active', basic_salary: 40000, pay_basis: 'monthly', join_date: null, end_date: null }

  test('enrolled AND numbered: employer SSF is added', () => {
    const { gross, ssfEmployer } = estimatePayrollAccrual({
      employees: [{ ...base, id: 'e1', ssf_enrolled: true, ssf_no: '1234567890' }], components: [], period,
    })
    expect(gross).toBeCloseTo(40000, 6)
    expect(ssfEmployer).toBeCloseTo(Math.min(40000, SSF_CAP) * SSF_EMPLOYER_PCT, 6)
  })

  test('enrolled WITHOUT a number: no employer SSF (payroll contributes nothing for them)', () => {
    for (const ssf_no of [null, undefined, '', '   ']) {
      const { gross, ssfEmployer } = estimatePayrollAccrual({
        employees: [{ ...base, id: 'e2', ssf_enrolled: true, ssf_no }], components: [], period,
      })
      expect(gross).toBeCloseTo(40000, 6)
      expect(ssfEmployer).toBe(0)
    }
  })

  test('a number without the enrolment flag adds nothing either', () => {
    const { ssfEmployer } = estimatePayrollAccrual({
      employees: [{ ...base, id: 'e3', ssf_enrolled: false, ssf_no: '1234567890' }], components: [], period,
    })
    expect(ssfEmployer).toBe(0)
  })
})

describe('computeMonthlyReport reads what the two helpers need', () => {
  const flat = fs.readFileSync(path.join(__dirname, 'computeMonthlyReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')

  test('the purchase_entries read selects the discount and every bill-key column', () => {
    const at = flat.indexOf("from('purchase_entries')")
    expect(at).toBeGreaterThan(-1)
    const chain = flat.slice(at, at + 260)
    for (const col of ['discount_amount', 'purchase_group_id', 'vendor_id', 'invoice_ref', 'bs_day']) {
      expect(chain).toContain(col)
    }
  })

  test('the hr_employees read selects ssf_no, and nothing gates employer SSF on the flag alone', () => {
    const at = flat.indexOf("scopedFrom('hr_employees'")
    expect(at).toBeGreaterThan(-1)
    expect(flat.slice(at, at + 160)).toContain('ssf_no')
    expect(flat).not.toMatch(/if \(\s*emp\.ssf_enrolled\s*\)/)
    expect(flat).toMatch(/isSsfContributor\(emp\)/)
  })

  test('the schema version moved for the change of meaning', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6)
  })
})
