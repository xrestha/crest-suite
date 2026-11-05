import {
  parseVendorRow, parseVendorRows, planVendorImport, vendorInsertRow, readPayWithinCell, isVendorHeaderRow,
  VENDOR_IMPORT_COLUMNS,
} from './vendorImportPlan'

// The pure plan reads purchaseTaxSplit.js, which reaches the supabase client through its imports.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

// Columns: name, contact, phone, address, PAN, pay within, terms note.
let n = 1
const r = (cells, text = []) => ({ rowNo: ++n, raw: cells, text })
beforeEach(() => { n = 1 })

describe('parseVendorRow', () => {
  test('keeps the form shape: trimmed text, the note as payment_terms, blank pay within as null', () => {
    expect(parseVendorRow(r(['  Big  Mart ', 'Ram', 9841000000, 'Balaju', '601234567', '', '']))).toEqual({
      rowNo: 2, name: 'Big Mart', contact_person: 'Ram', phone: '9841000000', address: 'Balaju',
      pan_vat_no: '601234567', payment_terms: null, pay_within_days: null, payFromNote: false,
    })
  })

  test('the phone is read as Excel shows it, so a leading 0 typed as text survives', () => {
    expect(parseVendorRow(r(['A', '', 14400000], ['', '', '014400000'])).phone).toBe('014400000')
  })

  test('pay within: whole days 0 to 365, or text the terms reader understands', () => {
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 30]))).toEqual({ value: 30 })
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 0]))).toEqual({ value: 0 })
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 'Net 45']))).toEqual({ value: 45 })
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 'COD']))).toEqual({ value: 0 })
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, '']))).toEqual({ value: null })
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 30.5])).bad).toBe('30.5')
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 400])).bad).toBe('400')
    expect(readPayWithinCell(r([0, 0, 0, 0, 0, 'cheque'])).bad).toBe('cheque')
  })

  test('a bad pay within skips the row with the rule; a blank one takes days from a readable note', () => {
    expect(parseVendorRow(r(['A', '', '', '', '', 'two weeks'])).reason).toMatch(/"two weeks" is not a number of days\. Pay within takes whole days from 0 to 365/)
    expect(parseVendorRow(r(['A', '', '', '', '', '', 'Net 30']))).toMatchObject({ pay_within_days: 30, payFromNote: true, payment_terms: 'Net 30' })
    expect(parseVendorRow(r(['A', '', '', '', '', 15, 'Net 30']))).toMatchObject({ pay_within_days: 15, payFromNote: false })
    expect(parseVendorRow(r(['A', '', '', '', '', '', '50% advance']))).toMatchObject({ pay_within_days: null, payment_terms: '50% advance' })
  })

  test('no name is skipped; the header row is dropped', () => {
    expect(parseVendorRow(r(['', 'Ram'])).reason).toBe('No supplier name.')
    expect(isVendorHeaderRow(r([VENDOR_IMPORT_COLUMNS[0]]))).toBe(true)
    expect(isVendorHeaderRow(r(['Name Brand Traders']))).toBe(false)
    expect(parseVendorRows([r(VENDOR_IMPORT_COLUMNS), r([]), r(['Big Mart'])]).map(p => p.name)).toEqual(['Big Mart'])
  })
})

describe('planVendorImport', () => {
  const vendors = [
    { name: 'Big Mart', vendor_code: 'VND-003', pan_vat_no: '601-234-567', is_active: true, archived_at: null },
    { name: 'Old Dairy', vendor_code: 'VND-007', pan_vat_no: '', is_active: false, archived_at: '2026-01-01' },
    { name: 'Quiet Supplier', vendor_code: 'VND-005', pan_vat_no: null, is_active: false, archived_at: null },
  ]
  const plan = rows => planVendorImport(parseVendorRows(rows), { vendors, prefix: 'vnd' })

  test('a name on file in any capitals, archived and inactive ones included, is skipped and never changed', () => {
    const { ready, skipped } = plan([r(['big mart']), r(['OLD DAIRY']), r(['quiet  supplier']), r(['New Farm'])])
    expect(ready.map(x => x.name)).toEqual(['New Farm'])
    expect(skipped.map(x => x.reason)).toEqual([
      '"Big Mart" is already a supplier. Nothing about it was changed.',
      '"Old Dairy" (archived) is already a supplier. Nothing about it was changed.',
      '"Quiet Supplier" (inactive) is already a supplier. Nothing about it was changed.',
    ])
  })

  test('the same name twice in the file: the second is skipped', () => {
    const { ready, skipped } = plan([r(['New Farm']), r(['new farm'])])
    expect(ready).toHaveLength(1)
    expect(skipped[0].reason).toMatch(/row 2 already has this supplier/)
  })

  test('codes follow every code on file, archived included', () => {
    expect(plan([r(['A']), r(['B'])]).ready.map(x => x.vendor_code)).toEqual(['VND-008', 'VND-009'])
  })

  test('an odd PAN and a PAN another supplier has still import, with warnings', () => {
    const { ready } = plan([r(['Twin Mart', '', '', '', '601234567']), r(['Short Pan', '', '', '', '1234']), r(['Twin Two', '', '', '', '999999999']), r(['Twin Three', '', '', '', '999 999 999'])])
    expect(ready).toHaveLength(4)
    expect(ready[0].warnings).toEqual(['"Big Mart" already has this PAN. Both are imported; check whether they are one supplier.'])
    expect(ready[1].warnings[0]).toMatch(/This PAN has 4 digits; a Nepal PAN has 9/)
    expect(ready[2].warnings).toEqual([])
    expect(ready[3].warnings).toEqual(['"Twin Two" already has this PAN. Both are imported; check whether they are one supplier.'])
  })

  test('vendorInsertRow is the Add Vendor form payload', () => {
    const [row] = plan([r(['New Farm', 'Hari', '98', 'Kalimati', '', '', 'COD'])]).ready
    expect(vendorInsertRow(row)).toEqual({
      vendor_code: 'VND-008', name: 'New Farm', contact_person: 'Hari', phone: '98', address: 'Kalimati',
      pan_vat_no: '', payment_terms: 'COD', pay_within_days: 0,
    })
  })
})
