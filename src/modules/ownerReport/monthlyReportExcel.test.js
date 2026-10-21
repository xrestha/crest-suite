// The Vendor Summary sheet (S855, schema 19): a TOTAL row on every report; on a v19 section its Cash,
// Credit and FonePay add up to Net Spend, and an older section's TOTAL leaves them blank with a note.
import { vendorSummaryRows } from './monthlyReportExcel'

const v19 = {
  splitBasis: 'net',
  vendors: [{ vendorId: 'v1', name: 'Himalayan Dairy', gross: 15000, discount: 1000, returned: 900, net: 13100, cash: 5000, credit: 8100, fonepay: 0, billCount: 2 }],
  unassigned: { gross: 300, discount: 0, returned: 0, net: 300, cash: 0, credit: 0, fonepay: 300, billCount: 1 },
  grandGross: 15300, grandDiscount: 1000, grandReturn: 900, grandNet: 13400,
  grandCash: 5000, grandCredit: 8100, grandFonepay: 300,
}

describe('vendorSummaryRows', () => {
  test('v19: a no-supplier row and a TOTAL whose split adds up to Net Spend', () => {
    const rows = vendorSummaryRows(v19)
    expect(rows.map(r => r.Vendor)).toEqual(['Himalayan Dairy', 'No supplier recorded', 'TOTAL (every bill this month)'])
    const total = rows[2]
    expect(total['Net Spend (NPR)']).toBe(13400)
    expect(total['Cash (NPR)'] + total['Credit (NPR)'] + total['FonePay (NPR)']).toBe(13400)
    for (const r of rows.slice(0, 2)) {
      expect(r['Cash (NPR)'] + r['Credit (NPR)'] + r['FonePay (NPR)']).toBe(r['Net Spend (NPR)'])
    }
  })

  test('an older section: the TOTAL split is blank and a note row says the split is before discount', () => {
    const { splitBasis, unassigned, grandCash, grandCredit, grandFonepay, ...old } = v19
    const rows = vendorSummaryRows({ ...old, vendors: [{ ...v19.vendors[0], credit: 9100 }] })
    const total = rows.find(r => r.Vendor.startsWith('TOTAL'))
    expect(total['Net Spend (NPR)']).toBe(13400)
    expect(total['Cash (NPR)']).toBe('')
    expect(total['Credit (NPR)']).toBe('')
    expect(rows[rows.length - 1].Vendor).toMatch(/before the bill discount/)
  })

  test('no suppliers: no sheet rows at all', () => {
    expect(vendorSummaryRows({ vendors: [] })).toEqual([])
  })
})
