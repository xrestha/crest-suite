// The two halves of the IRD filing, and the money owed on a bill.
//
// Every defect these pin is SILENT — each one rendered a complete, confident, plausible figure —
// so nothing else in the suite would notice any of them coming back.
import fs from 'fs'
import path from 'path'
import { calcBillTotals } from '../purchases/purchasesHelpers'
import {
  VAT_RATE, splitPurchaseVat, buildVendorSummary, billPayables, netFactors, returnBase,
  isVatReturn, isNonVatReturn, isUnlinkedReturn, annexure13Rows, normalisePan, billWiseVat, ONE_LAKH, summariseUnlinkedReturns,
  returnLinesOutsidePeriod, priorBillFactors,
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

  // S756. `purchase_entry_id` is ON DELETE SET NULL, and deleting or re-saving a bill unlinks every
  // return against it. The predicates were `=== true` / `=== false`, so such a return — embed null —
  // was in NEITHER half: gone from both statutory reports, overstating the input VAT claimed.
  it('puts every return in exactly one of VAT, non-VAT or unlinked', () => {
    const cases = [
      ret(VAT_LINE),
      ret(NONVAT_LINE),
      ret(VAT_LINE, { id: 'legacy', purchase_entries: { vat_inclusive: null } }),
      ret(VAT_LINE, { id: 'unlinked', purchase_entry_id: null, purchase_entries: null }),
    ]
    for (const r of cases) {
      expect([isVatReturn(r), isNonVatReturn(r), isUnlinkedReturn(r)].filter(Boolean)).toHaveLength(1)
    }
  })

  it('routes a return on a legacy NULL vat_inclusive line to the non-VAT half, like its line', () => {
    const legacy = { ...NONVAT_LINE, vat_inclusive: null }
    const s = splitPurchaseVat([VAT_LINE, legacy], [ret(legacy, { purchase_entries: { vat_inclusive: null } })])
    expect(s.nonVatLines).toHaveLength(1)
    expect(s.nonVatReturns).toHaveLength(1)
    expect(s.nonVatReturnBase).toBeCloseTo(3600, 6)
  })

  it('counts an unlinked return, at list rate, and deducts it from neither half', () => {
    const orphan = ret(VAT_LINE, { id: 'u1', purchase_entry_id: null, purchase_entries: null })
    const s = splitPurchaseVat(MIXED_BILL, [orphan])
    expect(s.unlinkedReturns).toHaveLength(1)
    expect(s.unlinkedReturnBase).toBeCloseTo(6000, 6)
    expect(s.vatReturnBase).toBe(0)
    expect(s.nonVatReturnBase).toBe(0)
    // Every return is accounted for somewhere.
    expect(s.vatReturns.length + s.nonVatReturns.length + s.unlinkedReturns.length).toBe(1)
  })

  it('summarises the unlinked returns a page must name', () => {
    const orphan = ret(VAT_LINE, { id: 'u1', purchase_entry_id: null, purchase_entries: null, items: { name: 'Chicken' } })
    const sum = summariseUnlinkedReturns([ret(VAT_LINE), orphan, { ...orphan, id: 'u2' }], { max: 1 })
    expect(sum.count).toBe(2)
    expect(sum.value).toBeCloseTo(12000, 6)
    expect(sum.examples).toEqual(['day 5 · Chicken · Acme'])
    expect(sum.more).toBe(1)
  })

  // S756, owner decision D10. The return sits in THIS month; its bill is last month's, so the bill's
  // lines are not in this month's entries. Its VAT half still comes from the linked line, and its
  // value from that bill's own discount — read whole from its own month.
  describe('a return against a bill from an earlier month', () => {
    const LAST_MONTH = MIXED_BILL.map(l => ({ ...l, period_id: 'bhadra' }))
    const THIS_MONTH = [{ ...VAT_LINE, id: 'n1', purchase_group_id: 'G2', discount_amount: 0, rate: 1000 }]
    const late = ret(LAST_MONTH[0], { id: 'late', period_id: 'ashwin', bs_day: 2 })

    it('names the bill lines it has to fetch — and nothing already in the period, nothing unlinked', () => {
      const orphan = ret(VAT_LINE, { id: 'u', purchase_entry_id: null, purchase_entries: null })
      expect(returnLinesOutsidePeriod(THIS_MONTH, [late, ret(THIS_MONTH[0]), orphan])).toEqual(['l1'])
    })

    it('goes to the VAT half by its own line, not by this month', () => {
      const s = splitPurchaseVat(THIS_MONTH, [late], { priorBillLines: LAST_MONTH })
      expect(s.vatReturns).toHaveLength(1)
      expect(s.unlinkedReturns).toHaveLength(0)
    })

    it("is valued at its bill's discounted rate once the bill's lines are passed", () => {
      const s = splitPurchaseVat(THIS_MONTH, [late], { priorBillLines: LAST_MONTH })
      expect(s.vatReturnBase).toBeCloseTo(5400, 6)
      // THE BUG it closes: without the bill, the list rate — 600 of VAT reversed that was never claimed.
      expect(splitPurchaseVat(THIS_MONTH, [late]).vatReturnBase).toBeCloseTo(6000, 6)
    })

    it("keeps two months' legacy bills (no group id) with the same vendor, invoice and day apart", () => {
      const legacyA = { ...VAT_LINE, id: 'la', purchase_group_id: null, invoice_ref: 'X', period_id: 'p1', discount_amount: 1000, rate: 2000 }
      const legacyB = { ...VAT_LINE, id: 'lb', purchase_group_id: null, invoice_ref: 'X', period_id: 'p2', discount_amount: 0, rate: 8000 }
      const f = priorBillFactors([legacyA, legacyB])
      expect(f.get('la')).toBeCloseTo(0.5, 6)   // its own 1,000 off its own 2,000
      expect(f.get('lb')).toBeCloseTo(1, 6)     // untouched by the other month's discount
    })
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

// S756, owner decision D12. The disclosure is about a SUPPLIER (a PAN), not a vendor card. Two cards
// for one supplier each under one lakh used to be two undisclosed rows.
describe('annexure13Rows — one row per PAN', () => {
  const bill = (id, vendorId, name, pan, rate, vat = false) => ({
    id, purchase_group_id: `G-${id}`, vendor_id: vendorId, vendors: { name, pan_vat_no: pan },
    bs_day: 1, qty: 1, rate, vat_inclusive: vat, discount_amount: 0,
  })
  const rowsFor = (entries, returns = []) => {
    const allocated = allocateBillDiscounts(entries)
    return annexure13Rows(buildVendorSummary(allocated, returns, netFactors(allocated)))
  }

  it('normalises a PAN by trimming and removing inner spaces', () => {
    expect(normalisePan(' 301 234 567 ')).toBe('301234567')
    expect(normalisePan(null)).toBe('')
  })

  it('discloses a supplier whose two cards are each under one lakh', () => {
    const rows = rowsFor([
      bill('a', 'V1', 'Himalayan Traders', '301234567', 60000),
      bill('b', 'V2', 'Himalayan Traders Pvt Ltd', '301 234 567 ', 60000),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].net).toBeCloseTo(120000, 6)
    expect(rows[0].over).toBe(true)
    expect(rows[0].cards).toBe(2)
    expect(rows[0].count).toBe(2)
    expect(rows[0].name).toBe('Himalayan Traders / Himalayan Traders Pvt Ltd')
  })

  it('tests the invoiced total on the aggregate too', () => {
    // 45,000 + 45,000 ex-VAT is 90,000 — under. Invoiced with VAT it is 1,01,700 — over.
    const rows = rowsFor([
      bill('a', 'V1', 'Acme', '111', 45000, true),
      bill('b', 'V2', 'Acme Suppliers', '111', 45000, true),
    ])
    expect(rows[0].net).toBeCloseTo(90000, 6)
    expect(rows[0].invoiced).toBeCloseTo(101700, 6)
    expect(rows[0].over).toBe(true)
  })

  it('nets a return on either card against the aggregate', () => {
    const entries = [bill('a', 'V1', 'Acme', '111', 60000), bill('b', 'V2', 'Acme 2', '111', 60000)]
    const r = { id: 'r', purchase_entry_id: 'b', vendor_id: 'V2', vendors: { name: 'Acme 2', pan_vat_no: '111' },
      qty: 1, rate: 30000, purchase_entries: { vat_inclusive: false } }
    const [row] = rowsFor(entries, [r])
    expect(row.net).toBeCloseTo(90000, 6)
    expect(row.over).toBe(false)
  })

  it('keeps a PAN-less card on its own row and marks it unmatchable', () => {
    const rows = rowsFor([
      bill('a', 'V1', 'Local Veg', '', 60000),
      bill('b', 'V2', 'Local Veg Shop', '  ', 60000),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.panMissing && !r.over)).toBe(true)
  })

  it('does not merge different PANs', () => {
    const rows = rowsFor([bill('a', 'V1', 'A', '1', 60000), bill('b', 'V2', 'B', '2', 60000)])
    expect(rows).toHaveLength(2)
    expect(rows.some(r => r.over)).toBe(false)
  })

  it('uses the one-lakh threshold by default, strictly above it', () => {
    expect(rowsFor([bill('a', 'V1', 'A', '1', ONE_LAKH)])[0].over).toBe(false)
    expect(rowsFor([bill('a', 'V1', 'A', '1', ONE_LAKH + 1)])[0].over).toBe(true)
  })
})

// S756, owner decision D28 — one row per invoice beside the item-level sheet, tying to the same totals.
describe('billWiseVat', () => {
  const OTHER_BILL = [
    { ...VAT_LINE, id: 'l4', purchase_group_id: 'G9', bs_day: 2, rate: 2000, discount_amount: 0, invoice_ref: 'INV-9' },
  ]
  const ENTRIES = [...MIXED_BILL.map(l => ({ ...l, invoice_ref: 'INV-1' })), ...OTHER_BILL]

  it('writes one row per bill, in day order', () => {
    const rows = billWiseVat(allocateBillDiscounts(ENTRIES))
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.invoice)).toEqual(['INV-9', 'INV-1'])
  })

  it('reconciles to the split the page and the other sheets show', () => {
    const s = splitPurchaseVat(ENTRIES, [])
    const rows = billWiseVat(s.allocated)
    const sum = k => rows.reduce((t, r) => t + r[k], 0)
    expect(sum('taxable')).toBeCloseTo(s.vatBase, 6)
    expect(sum('exempt')).toBeCloseTo(s.nonVatBase, 6)
    expect(sum('vat')).toBeCloseTo(s.vatAmt, 6)
    expect(sum('total')).toBeCloseTo(s.vatTotal + s.nonVatBase, 6)
  })

  it("values each bill at what calcBillTotals says it was invoiced at", () => {
    const [, mixed] = billWiseVat(allocateBillDiscounts(ENTRIES))
    expect(mixed.taxable).toBeCloseTo(5400, 6)
    expect(mixed.exempt).toBeCloseTo(3600, 6)
    expect(mixed.total).toBeCloseTo(calcBillTotals(MIXED_BILL, 1000).grandTotal, 6)
    expect(mixed.pan).toBe('123')
  })

  // S756, owner decision D13 — the supplier's printed figures, flagged against the row's own VAT/Total.
  it('flags a bill whose printed VAT or total differs from the row by more than NPR 1', () => {
    const stamped = ENTRIES.map(l => (l.purchase_group_id === 'G1'
      ? { ...l, invoice_vat_amount: 702, invoice_total_amount: 9800 }
      : { ...l, invoice_vat_amount: 260.5 }))
    const [other, mixed] = billWiseVat(allocateBillDiscounts(stamped))
    expect(mixed.invoiceTotal).toBe(9800)
    expect(mixed.invoiceCheck.vatMismatch).toBe(false)
    expect(mixed.invoiceCheck.totalMismatch).toBe(true)
    expect(other.invoiceCheck.mismatch).toBe(false)   // 260 vs 260.50, inside the tolerance
    expect(billWiseVat(allocateBillDiscounts(ENTRIES))[0].invoiceCheck.checked).toBe(false)
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
