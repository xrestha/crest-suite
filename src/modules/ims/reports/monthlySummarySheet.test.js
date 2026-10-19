// Monthly Summary's Excel export (S792, FIGURES-10): the sheet says what the page says, in the page's
// order, and its TOTAL row adds up. Every expected figure is worked by hand from the fixture.
import {
  buildMonthlySummaryWorkbook, cogsShareLine, foodCostSentence, foodCostVerdict, openFcText, openMonthLine,
  uncountedNamed, verdictWithheld,
} from './monthlySummarySheet'

const settings = { fc_warning_pct: 30, fc_critical_pct: 40 }

// Two categories. Food: 5000 gross − 500 discount − 200 returns = 4300 net; 1000 opening + 4300
// − 100 wastage − 50 staff meals − 1150 closing → COGS 4000. Drinks: 500 opening + 1000 net − 1600
// closing → COGS −100 (counted more than it had), which exercises a negative share.
const catRows = [
  { category: 'Food', itemCount: 12, uncountedCount: 2,
    openingVal: 1000, purchaseVal: 5000, discountVal: 500, returnVal: 200, netPurchaseVal: 4300,
    wastageVal: 100, staffMealsVal: 50, closingVal: 1150, cogsVal: 4000 },
  { category: 'Drinks', itemCount: 3, uncountedCount: 0,
    openingVal: 500, purchaseVal: 1000, discountVal: 0, returnVal: 0, netPurchaseVal: 1000,
    wastageVal: 0, staffMealsVal: 0, closingVal: 1600, cogsVal: -100 },
]
const gap = {
  presentCount: 15, uncountedCount: 2, uncountedValue: 300, cogs: 3900, material: false,
  uncounted: [{ id: 'a', name: 'Paneer', value: 200 }, { id: 'b', name: 'Cream', value: 100 }],
}
const report = {
  catRows,
  totalOpening: 1500, totalPurchase: 6000, totalDiscount: 500, totalReturn: 200, totalNetPurchase: 5300,
  totalWastage: 100, totalStaffMeals: 50, totalClosing: 2750, totalCOGS: 3900,
  totalRevenue: 13000, fcPct: 30, purchaseFcPct: (5300 / 13000) * 100, gap,
}

describe('verdictWithheld / uncountedNamed', () => {
  it('withholds on an open month or a material gap, and only then', () => {
    expect(verdictWithheld('open', { material: false })).toBe(true)
    expect(verdictWithheld('closed', { material: true })).toBe(true)
    expect(verdictWithheld('closed', { material: false })).toBe(false)
    expect(verdictWithheld('closed', undefined)).toBe(false)
  })

  it('names the uncounted items on a closed month, and on an open one only once counting began', () => {
    expect(uncountedNamed({ uncountedCount: 15, presentCount: 15 }, 'closed')).toBe(true)
    expect(uncountedNamed({ uncountedCount: 15, presentCount: 15 }, 'open')).toBe(false)
    expect(uncountedNamed({ uncountedCount: 3, presentCount: 15 }, 'open')).toBe(true)
    expect(uncountedNamed(null, 'closed')).toBe(false)
  })
})

describe('the Food Cost % verdict and the COGS line', () => {
  it("bands on the client's own thresholds", () => {
    expect(foodCostSentence(foodCostVerdict(30, settings), 'closed')).toBe('✓ Within your target (≤30%)')
    expect(foodCostSentence(foodCostVerdict(35, settings), 'closed')).toBe('△ Above target — review purchases (30–40%)')
    expect(foodCostSentence(foodCostVerdict(41, settings), 'closed')).toBe('▲ Critical — immediate review needed (>40%)')
  })

  it('says why a withheld verdict is withheld, and what to do with no sales', () => {
    expect(foodCostSentence(foodCostVerdict(41, settings, { withhold: true }), 'open')).toBe('Stock used ÷ sales, shown once the month is closed')
    expect(foodCostSentence(foodCostVerdict(41, settings, { withhold: true }), 'closed')).toBe('Not judged: count incomplete')
    // No sales stays "none" even when withheld — there is no figure to withhold a verdict on.
    expect(foodCostVerdict(null, settings, { withhold: true }).key).toBe('none')
    expect(foodCostSentence(foodCostVerdict(null, settings), 'closed')).toBe('Add sales entries to calculate')
  })

  it('prints the share of revenue, marked when not judged', () => {
    expect(cogsShareLine(32.14, false)).toBe('32.1% of revenue')
    expect(cogsShareLine(32.14, true)).toBe('32.1% of revenue · not judged')
    expect(cogsShareLine(null, false)).toBe('No sales data')
  })

  it('on an open month prints no share, and says what it waits for as the count moves', () => {
    expect(cogsShareLine(32.14, true, true, { presentCount: 15, uncountedCount: 15 })).toBe('Provisional until the closing count')
    expect(cogsShareLine(32.14, true, true, { presentCount: 15, uncountedCount: 2 })).toBe('Provisional until the count is finished')
    expect(cogsShareLine(32.14, true, true, { presentCount: 15, uncountedCount: 0 })).toBe('Provisional until the month is closed')
  })
})

describe('openFcText: what the Food Cost % box waits for on an open month', () => {
  it('asks for the closing count while any item still lacks one', () => {
    expect(openFcText({ presentCount: 15, uncountedCount: 15 })).toBe('Needs closing count')
    expect(openFcText({ presentCount: 15, uncountedCount: 2 })).toBe('Needs closing count')
  })

  it('waits for the close once the count is in, rather than asking for a count that exists', () => {
    expect(openFcText({ presentCount: 15, uncountedCount: 0 })).toBe('Shown when the month closes')
  })
})

describe('openMonthLine: the open month\'s provisional reason follows the count', () => {
  it('says every shelf counts as used only while nothing is counted', () => {
    expect(openMonthLine({ presentCount: 15, uncountedCount: 15 }))
      .toBe('closing stock is counted at month end, so COGS counts every shelf as used and food cost % is shown once the month is closed')
  })

  it('names the part still missing once counting has begun', () => {
    expect(openMonthLine({ presentCount: 15, uncountedCount: 2 }))
      .toBe('2 of 15 items are not counted yet (named below), so COGS counts their stock as used and food cost % is shown once the month is closed')
    expect(openMonthLine({ presentCount: 15, uncountedCount: 1 })).toMatch(/^1 of 15 items is not counted yet \(named below\), so COGS counts its stock/)
  })

  it('claims nothing is used up once every item is counted, and still waits for the close', () => {
    const line = openMonthLine({ presentCount: 15, uncountedCount: 0 })
    expect(line).toBe('closing stock is counted, but the figures can still change until the month is closed, and food cost % is shown once it is')
    expect(line).not.toMatch(/every shelf/)
    // Nothing had stock to count: no claim that a count was made.
    expect(openMonthLine({ presentCount: 0, uncountedCount: 0 })).toBe('the figures can still change until the month is closed, and food cost % is shown once it is')
  })
})

describe('buildMonthlySummaryWorkbook', () => {
  const closed = buildMonthlySummaryWorkbook(report, { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })

  it('lists the headline figures in the page order, under the page labels, as numbers', () => {
    expect(closed.summaryRows.map(r => r.Figure)).toEqual([
      'Opening Stock', 'Gross Purchases', 'Discount', 'Returns', 'Net Purchases', 'Wastage',
      'Staff Meals', 'Closing Stock', 'COGS', 'Net Sales Revenue', 'Food Cost %', 'Spend %',
    ])
    const by = Object.fromEntries(closed.summaryRows.map(r => [r.Figure, r]))
    expect(by['Net Purchases']['Amount (NPR)']).toBe(5300)
    expect(by['COGS']['Amount (NPR)']).toBe(3900)
    expect(by['COGS'].Note).toBe('30.0% of revenue')
    expect(by['Food Cost %']['%']).toBe(30)
    expect(by['Food Cost %']['Amount (NPR)']).toBe('')
    expect(by['Food Cost %'].Note).toBe('✓ Within your target (≤30%)')
    expect(by['Spend %']['%']).toBe(40.8)   // 5300 ÷ 13000 = 40.77%
    // COGS rebuilds from the sheet alone: opening + net − wastage − staff meals − closing.
    const a = f => by[f]['Amount (NPR)']
    expect(a('Opening Stock') + a('Net Purchases') - a('Wastage') - a('Staff Meals') - a('Closing Stock')).toBe(a('COGS'))
    expect(a('Gross Purchases') - a('Discount') - a('Returns')).toBe(a('Net Purchases'))
  })

  it('carries the category table with a TOTAL row the columns add up to', () => {
    const rows = closed.categoryRows
    expect(Object.keys(rows[0])).toEqual([
      'Category', 'Items', 'Not counted', 'Opening Stock', 'Gross Purchases', 'Discount', 'Returns',
      'Net Purchases', 'Wastage', 'Staff Meals', 'Closing Stock', 'COGS', '% of Total COGS',
    ])
    expect(rows.map(r => r.Category)).toEqual(['Food', 'Drinks', 'TOTAL'])
    const [food, drinks, total] = rows
    for (const col of ['Items', 'Not counted', 'Opening Stock', 'Gross Purchases', 'Discount', 'Returns',
      'Net Purchases', 'Wastage', 'Staff Meals', 'Closing Stock', 'COGS']) {
      expect(`${col} ${food[col] + drinks[col]}`).toBe(`${col} ${total[col]}`)
    }
    // Shares are computed, a negative one included, and the TOTAL's is computed too — never asserted.
    expect(food['% of Total COGS']).toBe(102.6)     // 4000 ÷ 3900
    expect(drinks['% of Total COGS']).toBe(-2.6)    // −100 ÷ 3900
    expect(total['% of Total COGS']).toBe(100)
  })

  it('states the period and names the uncounted items on a closed month', () => {
    expect(closed.scopeLine).toMatch(/^Period : Bhadra 2082 \(closed\)/)
    expect(closed.scopeLine).toMatch(/sub-recipes \(prep items\) excluded/)
    expect(closed.scopeLine).not.toMatch(/PROVISIONAL/)
    expect(closed.notes[0]).toMatch(/2 of 15 items have no closing count for Bhadra 2082/)
    expect(closed.notes[0]).toMatch(/Not counted: Paneer, Cream\./)
    expect(closed.notes.some(n => n.startsWith('COGS = '))).toBe(true)
    expect(closed.categoryRows[0]['Not counted']).toBe(2)
    expect(closed.filename).toBe('Monthly-Summary-Bhadra-2082.xlsx')
  })

  it('marks an open month provisional everywhere it goes, with the running-month label', () => {
    const open = buildMonthlySummaryWorkbook({ ...report, gap: { ...gap, uncountedCount: 15 } },
      { periodLabel: 'Ashwin 2082', periodStatus: 'open', settings })
    expect(open.scopeLine).toMatch(/^Period : Ashwin 2082 — PROVISIONAL: month still open; closing stock is counted at month end, so COGS counts every shelf as used/)
    // S796 prints no Food Cost % on an open month, so the scope line must not describe one.
    expect(open.scopeLine).not.toMatch(/reads high/)
    expect(open.filename).toBe('Monthly-Summary-Ashwin-2082-provisional.xlsx')
    const by = Object.fromEntries(open.summaryRows.map(r => [r.Figure, r]))
    // S796: an open month has no Food Cost %, so the sheet writes none — and not its twin under COGS.
    expect(by['Food Cost %']['%']).toBe('')
    expect(by['Food Cost %'].Note).toBe('Needs closing count — Stock used ÷ sales, shown once the month is closed')
    expect(by['COGS'].Note).toBe('Provisional until the closing count')
    // Every item still uncounted: the zero stays for the arithmetic, the note says it is no count.
    expect(by['Closing Stock'].Note).toBe('Not counted yet')
    expect(by['Spend % so far']).toBeDefined()
    expect(by['Spend %']).toBeUndefined()
    // Nothing counted yet on an open month: the items are not named, as on screen.
    expect(open.notes.some(n => /no closing count/.test(n))).toBe(false)
    expect(open.categoryRows[0]['Not counted']).toBe('')
  })

  it('on an open month says what the count has reached, the way the page banner does', () => {
    const args = { periodLabel: 'Ashwin 2082', periodStatus: 'open', settings }
    // Part counted: the missing part is on the scope line and named in the note directly under it.
    const part = buildMonthlySummaryWorkbook(report, args)
    expect(part.scopeLine).toMatch(/— PROVISIONAL: month still open; 2 of 15 items are not counted yet \(named below\)/)
    expect(part.notes[0]).toMatch(/Not counted: Paneer, Cream\./)
    expect(Object.fromEntries(part.summaryRows.map(r => [r.Figure, r]))['COGS'].Note).toBe('Provisional until the count is finished')
    // All counted, month not yet closed: no "every shelf as used", and no "not counted" anywhere.
    const counted = buildMonthlySummaryWorkbook({ ...report, gap: { ...gap, uncountedCount: 0, uncounted: [] } }, args)
    expect(counted.scopeLine).toMatch(/— PROVISIONAL: month still open; closing stock is counted, but the figures can still change until the month is closed/)
    expect(counted.scopeLine).not.toMatch(/every shelf|not counted/)
    const by = Object.fromEntries(counted.summaryRows.map(r => [r.Figure, r]))
    expect(by['COGS'].Note).toBe('Provisional until the month is closed')
    expect(by['Closing Stock'].Note).toBe('')
    expect(by['Food Cost %']['%']).toBe('')
  })

  it('leaves an unknown ratio blank rather than writing 0', () => {
    const noSales = buildMonthlySummaryWorkbook({ ...report, totalRevenue: 0, fcPct: null, purchaseFcPct: null },
      { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })
    const by = Object.fromEntries(noSales.summaryRows.map(r => [r.Figure, r]))
    expect(by['Food Cost %']['%']).toBe('')
    expect(by['Spend %']['%']).toBe('')
    expect(by['COGS'].Note).toBe('No sales data')
  })

  it('writes money to the paisa, never a string, and folds −0', () => {
    const odd = buildMonthlySummaryWorkbook({ ...report, totalOpening: 1234.5678, totalDiscount: -0.001 },
      { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })
    const by = Object.fromEntries(odd.summaryRows.map(r => [r.Figure, r]))
    expect(by['Opening Stock']['Amount (NPR)']).toBe(1234.57)
    expect(Object.is(by['Discount']['Amount (NPR)'], 0)).toBe(true)
  })

  it('leaves the share column blank when there is no positive COGS to share', () => {
    const none = buildMonthlySummaryWorkbook({ ...report, totalCOGS: 0 },
      { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })
    expect(none.categoryRows.every(r => r['% of Total COGS'] === '')).toBe(true)
  })
})

// S849 (PNL-8): stock moved between sister outlets. The sheet carries Transfers In / Out only in a
// month that had any, and Net Purchases still rebuilds from the columns beside it.
describe('buildMonthlySummaryWorkbook with stock transfers (S849)', () => {
  const withTransfers = {
    ...report,
    totalTransferIn: 700, totalTransferOut: 200, totalNetPurchase: 5300 + 700 - 200,
    catRows: report.catRows.map((r, i) => ({
      ...r,
      transferInVal: i === 0 ? 700 : 0,
      transferOutVal: i === 0 ? 200 : 0,
      netPurchaseVal: (Number(r.netPurchaseVal) || 0) + (i === 0 ? 500 : 0),
    })),
  }
  const wb = buildMonthlySummaryWorkbook(withTransfers, { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })

  it('adds the two figures between Returns and Net Purchases, and Net Purchases still rebuilds', () => {
    const figures = wb.summaryRows.map(r => r.Figure)
    expect(figures.slice(1, 7)).toEqual(['Gross Purchases', 'Discount', 'Returns', 'Transfers In', 'Transfers Out', 'Net Purchases'])
    const by = Object.fromEntries(wb.summaryRows.map(r => [r.Figure, r['Amount (NPR)']]))
    expect(by['Gross Purchases'] - by['Discount'] - by['Returns'] + by['Transfers In'] - by['Transfers Out']).toBe(by['Net Purchases'])
  })

  it('adds the two columns to the category table, and the TOTAL adds up', () => {
    const rows = wb.categoryRows
    const keys = Object.keys(rows[0])
    expect(keys.slice(keys.indexOf('Returns'), keys.indexOf('Returns') + 4)).toEqual(['Returns', 'Transfers In', 'Transfers Out', 'Net Purchases'])
    const total = rows[rows.length - 1]
    for (const col of ['Transfers In', 'Transfers Out']) {
      expect(rows.slice(0, -1).reduce((s, r) => s + r[col], 0)).toBe(total[col])
    }
  })

  it('says what a transfer is and puts it in the formula', () => {
    expect(wb.notes.join(' ')).toMatch(/Transfers In is stock received from your other outlets/)
    expect(wb.notes.join(' ')).toMatch(/Net Purchases = Gross − bill discounts − returns \+ transfers in − transfers out/)
  })

  it('a month with none keeps the sheet it always had', () => {
    const plain = buildMonthlySummaryWorkbook(report, { periodLabel: 'Bhadra 2082', periodStatus: 'closed', settings })
    expect(plain.summaryRows.map(r => r.Figure)).not.toContain('Transfers In')
    expect(Object.keys(plain.categoryRows[0])).not.toContain('Transfers In')
    expect(plain.notes.join(' ')).not.toMatch(/transfer/i)
  })
})
