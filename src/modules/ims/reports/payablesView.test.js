// S885: Outstanding Payables' status chip, balance, grouping, scope line and Excel rows. The screen,
// the print and the workbook read these, so they are pinned here rather than in a page render.
import {
  billBalance, billStatus, overdueText, vendorGroups, payablesScopeLine, payablesSheetRows, payablesSheetNotes,
} from './payablesView'

const bill = (over = {}) => ({
  key: over.key || 'b', vendorName: over.vendorName || 'Himalayan Traders', vendorId: over.vendorId || 'v1',
  invoice_ref: over.invoice_ref ?? '452', period: { bs_year: 2083, bs_month: 6 },
  entries: over.entries || [{ id: 'l1' }, { id: 'l2' }], total: 1130, paid: 0, remaining: 1130,
  writtenOff: 0, credit: 0, isCredit: false, isPartial: false, daysOld: 10, aging: { label: 'Current' },
  settledOn: null, ...over,
})

describe('billStatus — overdue by the supplier own days (owner decision 2)', () => {
  test('no days set: the 60-day default', () => {
    expect(billStatus(bill({ daysOld: 60 }), null)).toMatchObject({ key: 'due', label: 'Due today', days: 60 })
    expect(billStatus(bill({ daysOld: 61 }), {})).toMatchObject({ key: 'overdue', label: '1 day overdue', late: 1 })
  })

  test('30 days: overdue from day 31, and the days left before that', () => {
    const v = { pay_within_days: 30 }
    expect(billStatus(bill({ daysOld: 25 }), v)).toMatchObject({ key: 'due', label: 'Due in 5 days', dueIn: 5 })
    expect(billStatus(bill({ daysOld: 29 }), v).label).toBe('Due in 1 day')
    expect(billStatus(bill({ daysOld: 45 }), v)).toMatchObject({ key: 'overdue', label: '15 days overdue', late: 15 })
  })

  test('0 days is due on delivery: overdue from the next day', () => {
    const v = { pay_within_days: 0 }
    expect(billStatus(bill({ daysOld: 0 }), v).label).toBe('Due today')
    expect(billStatus(bill({ daysOld: 1 }), v)).toMatchObject({ key: 'overdue', late: 1 })
  })

  test('a part-paid bill is Partial until it is late, then overdue wins', () => {
    const v = { pay_within_days: 30 }
    expect(billStatus(bill({ daysOld: 10, isPartial: true, paid: 100, remaining: 1030 }), v)).toMatchObject({ key: 'partial', dueIn: 20 })
    expect(billStatus(bill({ daysOld: 40, isPartial: true, paid: 100, remaining: 1030 }), v).key).toBe('overdue')
  })

  test('a bill owing nothing is never overdue, however old', () => {
    expect(billStatus(bill({ daysOld: 400, remaining: 0 }), { pay_within_days: 0 })).toMatchObject({ key: 'nothing', label: 'Nothing owed' })
    expect(billStatus(bill({ daysOld: 400, remaining: -50, isCredit: true, credit: 50 }), null).key).toBe('credit')
  })

  test('overdueText words the export column', () => {
    expect(overdueText(billStatus(bill({ daysOld: 64 }), null))).toBe('Yes, 4 days late')
    expect(overdueText(billStatus(bill({ daysOld: 59 }), null))).toBe('No, due in 1 day')
    expect(overdueText(billStatus(bill({ daysOld: 60 }), null))).toBe('No, due today')
    expect(overdueText(billStatus(bill({ remaining: 0 }), null))).toBe('')
  })
})

describe('billBalance', () => {
  test('owed is positive, a credit negative and money only, a few paisa under zero is nothing', () => {
    expect(billBalance(bill({ remaining: 250 }))).toBe(250)
    expect(billBalance(bill({ remaining: -100, isCredit: true, credit: 95 }))).toBe(-95)
    expect(billBalance(bill({ remaining: -3, isCredit: false, credit: 0 }))).toBe(0)
  })
})

describe('vendorGroups', () => {
  const bills = [
    bill({ key: 'a', vendorName: 'A', remaining: 100, daysOld: 5 }),
    bill({ key: 'b', vendorName: 'B', remaining: 900, daysOld: 3 }),
    bill({ key: 'c', vendorName: 'A', remaining: 50, daysOld: 40 }),
  ]
  test('supplier owed most first; on Outstanding the oldest bill first', () => {
    const g = vendorGroups(bills, 'outstanding')
    expect(g.map(x => x.vName)).toEqual(['B', 'A'])
    expect(g[1].bills.map(b => b.key)).toEqual(['c', 'a'])
  })
  test('on Paid History the latest settled first', () => {
    const paid = [bill({ key: 'x', settledOn: '2026-08-01', remaining: 0 }), bill({ key: 'y', settledOn: '2026-10-01', remaining: 0 })]
    expect(vendorGroups(paid, 'paid')[0].bills.map(b => b.key)).toEqual(['y', 'x'])
  })
})

describe('payablesScopeLine — every filter stated', () => {
  test('all filters off', () => {
    expect(payablesScopeLine({ tab: 'outstanding', asOf: '19 Kartik 2083' }))
      .toBe('Unpaid credit bills · All suppliers · All ages · All months · as at 19 Kartik 2083')
  })
  test('each filter on, and no age on Paid History', () => {
    expect(payablesScopeLine({ tab: 'outstanding', vendor: 'Himalayan Traders', aging: '61–90 days', monthLabel: 'Ashwin 2083', asOf: 'x' }))
      .toBe('Unpaid credit bills · Supplier: Himalayan Traders · Age: 61–90 days · Bill month: Ashwin 2083 · as at x')
    expect(payablesScopeLine({ tab: 'paid', aging: '90+ days', asOf: 'x' })).toBe('Settled credit bills · All suppliers · All months · as at x')
  })
})

describe('payablesSheetRows — the workbook is the table on screen', () => {
  const vendors = { v1: { pay_within_days: 30 }, v2: { pay_within_days: null } }
  const groups = [
    { vName: 'Himalayan Traders', bills: [
      bill({ key: 'a', daysOld: 45, total: 1130.456, paid: 500.1, remaining: 630.356, isPartial: true }),
      bill({ key: 'b', daysOld: 5, total: 2000, paid: 0, remaining: 2000 }),
    ] },
    { vName: 'Kathmandu Dairy', bills: [bill({ key: 'c', vendorId: 'v2', daysOld: 70, total: 300, paid: 0, remaining: 300 })] },
  ]

  test('Outstanding: money as numbers to the paisa, the supplier days, the overdue state, and a TOTAL row', () => {
    const rows = payablesSheetRows(groups, { tab: 'outstanding', vendorOf: id => vendors[id] })
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      'Supplier': 'Himalayan Traders', 'Invoice': '452', 'Bill Month': 'Ashwin 2083', 'Items': 2,
      'Bill Total (NPR)': 1130.46, 'Paid (NPR)': 500.1, 'Remaining (NPR)': 630.36,
      'Days Old': 45, 'Pay Within (days)': 30, 'Status': '15 days overdue', 'Overdue': 'Yes, 15 days late',
    })
    expect(typeof rows[0]['Remaining (NPR)']).toBe('number')
    expect(rows[1]).toMatchObject({ 'Status': 'Due in 25 days', 'Overdue': 'No, due in 25 days' })
    expect(rows[2]).toMatchObject({ 'Pay Within (days)': 60, 'Status': '10 days overdue' })
    expect(rows[3]).toMatchObject({ 'Supplier': 'TOTAL', 'Items': 6, 'Bill Total (NPR)': 3430.46, 'Remaining (NPR)': 2930.36 })
    // No bill on the sheet has a write-off, so neither does the sheet.
    expect(Object.keys(rows[0])).not.toContain('Of Which Written Off (NPR)')
  })

  test('a written off amount gets its own column when any bill on the sheet has one', () => {
    const g = [{ vName: 'H', bills: [bill({ key: 'w', paid: 1130, writtenOff: 4.5, remaining: 0 }), bill({ key: 'n' })] }]
    const rows = payablesSheetRows(g, { tab: 'outstanding' })
    expect(rows[0]['Of Which Written Off (NPR)']).toBe(4.5)
    expect(rows[1]['Of Which Written Off (NPR)']).toBe(0)
    expect(rows[2]['Of Which Written Off (NPR)']).toBe(4.5)
  })

  test('Paid History: settled date, credit owed back, no overdue column', () => {
    const g = [{ vName: 'H', bills: [bill({ key: 'p', paid: 1130, remaining: 0, settledOn: '2026-10-01', credit: 25, isCredit: true })] }]
    const rows = payablesSheetRows(g, { tab: 'paid', vendorOf: () => ({ pay_within_days: 0 }), settledLabel: () => '15 Ashwin 2083' })
    expect(rows[0]).toMatchObject({ 'Settled On': '15 Ashwin 2083', 'Credit Owed Back (NPR)': 25, 'Pay Within (days)': 0 })
    expect(Object.keys(rows[0])).not.toContain('Overdue')
    expect(rows[1]).toMatchObject({ 'Supplier': 'TOTAL', 'Credit Owed Back (NPR)': 25 })
  })

  test('nothing on screen, nothing exported, and no TOTAL row', () => {
    expect(payablesSheetRows([], { tab: 'outstanding' })).toEqual([])
  })

  test('the notes say what the days and written off mean, without an apostrophe', () => {
    for (const tab of ['outstanding', 'paid']) {
      const notes = payablesSheetNotes(tab)
      expect(notes.join(' ')).toMatch(/60 days/)
      expect(notes.join(' ')).toMatch(/written off/)
      expect(notes.join(' ')).not.toMatch(/'/)
    }
  })
})
