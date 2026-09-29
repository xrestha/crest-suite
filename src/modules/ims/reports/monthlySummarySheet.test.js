// Monthly Summary's Excel export (S792, FIGURES-10): the sheet says what the page says, in the page's
// order, and its TOTAL row adds up. Every expected figure is worked by hand from the fixture.
import {
  buildMonthlySummaryWorkbook, cogsShareLine, foodCostSentence, foodCostVerdict,
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
    expect(foodCostSentence(foodCostVerdict(41, settings, { withhold: true }), 'open')).toBe('Not judged: month still open')
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
    expect(open.scopeLine).toMatch(/^Period : Ashwin 2082 — PROVISIONAL: month still open/)
    expect(open.filename).toBe('Monthly-Summary-Ashwin-2082-provisional.xlsx')
    const by = Object.fromEntries(open.summaryRows.map(r => [r.Figure, r]))
    expect(by['Food Cost %'].Note).toBe('Not judged: month still open')
    expect(by['COGS'].Note).toBe('30.0% of revenue · not judged')
    expect(by['Spend % so far']).toBeDefined()
    expect(by['Spend %']).toBeUndefined()
    // Nothing counted yet on an open month: the items are not named, as on screen.
    expect(open.notes.some(n => /no closing count/.test(n))).toBe(false)
    expect(open.categoryRows[0]['Not counted']).toBe('')
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
