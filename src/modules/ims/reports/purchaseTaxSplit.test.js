// The two halves of the IRD filing, and the money owed on a bill.
//
// Every defect these pin is SILENT — each one rendered a complete, confident, plausible figure —
// so nothing else in the suite would notice any of them coming back.
import fs from 'fs'
import path from 'path'
import { calcBillTotals } from '../purchases/purchasesHelpers'
import {
  VAT_RATE, splitPurchaseVat, buildVendorSummary, billPayables, netFactors, returnBase,
} from './purchaseTaxSplit'
import { allocateBillDiscounts } from './supplierAttribution'

// One bill, two lines, one of each kind, with a bill-level discount — the shape the whole file is
// about. `discount_amount` is repeated on every line because that is how the column is stored.
const VAT_LINE = {
  id: 'l1', purchase_group_id: 'G1', vendor_id: 'V', vendors: { name: 'Acme', pan_vat_no: '123' },
  bs_day: 5, qty: 1, rate: 6000, vat_inclusive: true, discount_amount: 1000, payment_method: 'Credit',
}
const NONVAT_LINE = {
  id: 'l2', purchase_group_id: 'G1', vendor_id: 'V', vendors: { name: 'Acme', pan_vat_no: '123' },
  bs_day: 5, qty: 1, rate: 4000, vat_inclusive: false, discount_amount: 1000, payment_method: 'Credit',
}
const MIXED_BILL = [VAT_LINE, NONVAT_LINE]

const ret = (entry, over = {}) => ({
  id: `r-${entry.id}`, purchase_entry_id: entry.id, vendor_id: entry.vendor_id,
  vendors: entry.vendors, bs_day: entry.bs_day, qty: entry.qty, rate: entry.rate,
  payment_method: entry.payment_method,
  purchase_entries: { vat_inclusive: entry.vat_inclusive },
  ...over,
})

describe('splitPurchaseVat — one bill discount, two reports', () => {
  it('splits a mixed bill discount in proportion to line value', () => {
    const s = splitPurchaseVat(MIXED_BILL, [])
    // 6000/10000 of 1000 to the VAT half, 4000/10000 to the non-VAT half.
    expect(s.vatDiscount).toBeCloseTo(600, 6)
    expect(s.nonVatDiscount).toBeCloseTo(400, 6)
  })

  it('never claims more discount than the bill carried', () => {
    // THE BUG. Non-VAT Report queried `.eq('vat_inclusive', false)`, so it could not see the VAT
    // lines and charged the whole 1000 here while VAT Report charged its 600 there — 1600 of
    // discount against a bill that gave 1000, across two pages that are filed together.
    const s = splitPurchaseVat(MIXED_BILL, [])
    expect(s.vatDiscount + s.nonVatDiscount).toBeCloseTo(1000, 6)
  })

  it('has the two halves sum back to the bill', () => {
    const s = splitPurchaseVat(MIXED_BILL, [])
    expect(s.vatGross + s.nonVatGross).toBeCloseTo(10000, 6)
    expect(s.vatBase + s.nonVatBase).toBeCloseTo(9000, 6)
  })

  it('agrees with calcBillTotals about the taxable base and the VAT', () => {
    // calcBillTotals is what the bill form's live total and the printed voucher use. If this
    // report and that voucher disagree about one bill, one of them is wrong on paper.
    const s = splitPurchaseVat(MIXED_BILL, [])
    const t = calcBillTotals(MIXED_BILL, 1000)
    expect(s.vatBase).toBeCloseTo(5400, 6)
    expect(s.vatBase * VAT_RATE).toBeCloseTo(t.vatTotal, 6)
  })

  it('reports the same non-VAT figure both reports will print', () => {
    // VAT Report's "Non-VAT Purchases" card and Non-VAT Report's headline read the same property
    // off the same split, so they cannot drift the way gross-vs-net did.
    const s = splitPurchaseVat(MIXED_BILL, [])
    expect(s.nonVatNet).toBeCloseTo(3600, 6)
  })
})

describe('splitPurchaseVat — returns', () => {
  it('values a return at the discounted rate its bill carried', () => {
    const s = splitPurchaseVat(MIXED_BILL, [ret(VAT_LINE)])
    expect(s.vatReturnBase).toBeCloseTo(5400, 6)   // not the 6000 list rate
  })

  it('nets a fully returned discounted bill to zero, never negative', () => {
    // THE BUG. `vendor_returns.rate` is the LIST rate, and it was subtracted from a base that had
    // already lost the discount — so returning everything left a taxable base of −1000 and a
    // NEGATIVE input VAT claim on a statutory report.
    const s = splitPurchaseVat(MIXED_BILL, [ret(VAT_LINE), ret(NONVAT_LINE)])
    expect(s.netVatBase).toBeCloseTo(0, 6)
    expect(s.nonVatNet).toBeCloseTo(0, 6)
    expect(s.netVatAmt).toBeCloseTo(0, 6)
  })

  it('routes each return to the half its original purchase belonged to', () => {
    const s = splitPurchaseVat(MIXED_BILL, [ret(NONVAT_LINE)])
    expect(s.vatReturnBase).toBe(0)
    expect(s.nonVatReturnBase).toBeCloseTo(3600, 6)
  })

  it('prices a return whose purchase is not in the fetched set at its list rate', () => {
    // Falls back rather than dropping the row: a return nobody can price is still a return, and
    // silently omitting it overstates the period.
    const orphan = ret(VAT_LINE, { purchase_entry_id: 'gone' })
    expect(returnBase(orphan, netFactors(allocateBillDiscounts(MIXED_BILL)))).toBeCloseTo(6000, 6)
  })
})

describe('buildVendorSummary', () => {
  it('ties a vendor row to the period totals', () => {
    const s = splitPurchaseVat(MIXED_BILL, [ret(VAT_LINE)])
    const [v] = buildVendorSummary(s.vatLines, s.vatReturns, s.factors)
    expect(v.name).toBe('Acme')
    expect(v.gross).toBeCloseTo(6000, 6)
    expect(v.discount).toBeCloseTo(600, 6)
    expect(v.returned).toBeCloseTo(5400, 6)
    expect(v.gross - v.discount - v.returned).toBeCloseTo(s.netVatBase, 6)
  })

  it('sums every line when handed every line (the Annexure-13 caller)', () => {
    const allocated = allocateBillDiscounts(MIXED_BILL)
    const [v] = buildVendorSummary(allocated, [], netFactors(allocated))
    expect(v.gross).toBeCloseTo(10000, 6)
    expect(v.discount).toBeCloseTo(1000, 6)   // the WHOLE bill discount, since every line is in
  })

  // S723. `count` was a LINE count under a column headed "Bills" on both callers — the VAT Report
  // workbook's `# Bills` and the Annexure 13 disclosure — so a vendor's six seven-line bills read
  // as 42 against a figure an accountant ties back to the purchase register.
  it('counts BILLS, not lines', () => {
    const allocated = allocateBillDiscounts(MIXED_BILL)
    const [v] = buildVendorSummary(allocated, [], netFactors(allocated))
    expect(v.count).toBe(1)
  })

  it('counts a second bill from the same vendor separately', () => {
    const second = { ...VAT_LINE, id: 'l3', purchase_group_id: 'G2', discount_amount: 0 }
    const allocated = allocateBillDiscounts([...MIXED_BILL, second])
    const [v] = buildVendorSummary(allocated, [], netFactors(allocated))
    expect(v.count).toBe(2)
  })

  // The one-lakh threshold is tested on the ex-VAT net AND on what the vendor invoiced, because a
  // vendor just under it ex-VAT is over it once VAT is added (decision, Aashish 2026-09-10).
  it('reports VAT and the invoiced total alongside the ex-VAT net', () => {
    const allocated = allocateBillDiscounts(MIXED_BILL)
    const [v] = buildVendorSummary(allocated, [], netFactors(allocated))
    expect(v.net).toBeCloseTo(9000, 6)                 // 10,000 gross less the 1,000 discount
    expect(v.vatAmt).toBeCloseTo(5400 * VAT_RATE, 6)   // only the VAT line's post-discount value
    expect(v.invoiced).toBeCloseTo(9000 + 5400 * VAT_RATE, 6)
    // …and the invoiced total is exactly what the bill itself was invoiced at.
    expect(v.invoiced).toBeCloseTo(calcBillTotals(MIXED_BILL, 1000).grandTotal, 6)
  })

  it('takes the VAT back off a returned VAT line, and never off a non-VAT one', () => {
    const allocated = allocateBillDiscounts(MIXED_BILL)
    const factors = netFactors(allocated)
    const [full] = buildVendorSummary(allocated, [ret(VAT_LINE), ret(NONVAT_LINE)], factors)
    // Everything came back, so nothing was invoiced on balance.
    expect(full.net).toBeCloseTo(0, 6)
    expect(full.vatAmt).toBeCloseTo(0, 6)
    expect(full.invoiced).toBeCloseTo(0, 6)
  })
})

describe('billPayables — what a payment method actually cost', () => {
  it('values a bill the way the Purchases register and Outstanding Payables do', () => {
    // THE BUG. This was `sum(qty x rate)` — ex-VAT AND pre-discount, so it reported 10,000 for a
    // bill the supplier invoiced at 9,702: neither the cost basis nor the money owed.
    const { bills } = billPayables(MIXED_BILL, [], { bs_year: 2082, bs_month: 5 })
    expect(bills).toHaveLength(1)
    expect(bills[0].total).toBeCloseTo(calcBillTotals(MIXED_BILL, 1000).grandTotal, 6)
    expect(bills[0].total).toBeCloseTo(9702, 6)
  })

  it('counts one bill however many lines it has', () => {
    const { bills } = billPayables(MIXED_BILL, [], { bs_year: 2082, bs_month: 5 })
    expect(bills[0].method).toBe('Credit')
    expect(bills[0].lines).toHaveLength(2)
  })

  it('gives a return its VAT back when the original line carried VAT', () => {
    const { returns } = billPayables(MIXED_BILL, [ret(VAT_LINE), ret(NONVAT_LINE)], { bs_year: 2082, bs_month: 5 })
    const byId = Object.fromEntries(returns.map(r => [r.purchase_entry_id, r.value]))
    expect(byId.l1).toBeCloseTo(5400 * 1.13, 6)   // discounted base plus its VAT
    expect(byId.l2).toBeCloseTo(3600, 6)          // no VAT was ever charged on this line
  })

  it('nets a fully returned bill to zero owed', () => {
    const period = { bs_year: 2082, bs_month: 5 }
    const { bills, returns } = billPayables(MIXED_BILL, [ret(VAT_LINE), ret(NONVAT_LINE)], period)
    const owed = bills.reduce((s, b) => s + b.total, 0) - returns.reduce((s, r) => s + r.value, 0)
    expect(owed).toBeCloseTo(0, 6)
  })

  it('reads a NULL payment_method as Cash', () => {
    // PURCHASE_PAYMENT_METHODS' documented rule: bills written before the column existed, and the
    // form's own default, both render as Cash — so a filter that misses NULL loses real bills.
    const { bills } = billPayables(
      [{ ...VAT_LINE, purchase_group_id: 'G2', payment_method: null }], [], { bs_year: 2082, bs_month: 5 })
    expect(bills[0].method).toBe('Cash')
  })
})

// ── Source-reading half, the summaryReads.test.js pattern ──────────────────────────────────────
// The query filter is the defect that cannot be caught by testing the arithmetic: the split is
// correct, and it is still wrong if the page hands it half a bill.
function flatten(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
}

const VAT_PAGE = path.join(__dirname, 'VatReport.js')
const NONVAT_PAGE = path.join(__dirname, 'NonVatReport.js')

describe('the two statutory pages read whole bills', () => {
  it('Non-VAT Report does not filter vat_inclusive in the query', () => {
    // The whole defect in one line. A bill-level discount cannot be apportioned by a query that
    // can only see one half of the bill, so the filter has to happen after the split, not before.
    expect(flatten(NONVAT_PAGE)).not.toMatch(/\.eq\(\s*'vat_inclusive'/)
  })

  it.each([['VatReport.js', VAT_PAGE], ['NonVatReport.js', NONVAT_PAGE]])(
    '%s splits through the shared helper rather than its own arithmetic', (_n, file) => {
      expect(flatten(file)).toMatch(/splitPurchaseVat\(/)
    })

  it.each([['VatReport.js', VAT_PAGE], ['NonVatReport.js', NONVAT_PAGE]])(
    '%s pages its vendor_returns read', (_n, file) => {
      // PostgREST truncates at 1000 rows with no error, and a dropped return overstates a filed
      // figure. Both purchase_entries reads were already paged; these were not.
      const flat = flatten(file)
      const at = flat.indexOf("scopedFrom('vendor_returns'")
      expect(at).toBeGreaterThan(-1)
      expect(flat.slice(Math.max(0, at - 90), at)).toMatch(/fetchAllRows\(/)
      expect(flat.slice(at, at + 320)).toMatch(/\.order\(\s*'id'/)
    })
})
