import {
  LINES, buildStatement, columnMarkers, fmtLine, groupColumn, labourMarker, lineColor, lineWithheld,
  pnlNotes, statementRows, sumStatements,
} from './pnlStatement'

const payroll = (amount = 30000) => ({ source: 'payroll', amount, hasFigure: true, verdictWithheld: false, ignoredBucket: 0 })
const raw = over => ({
  revenue: 100000, openingVal: 20000, purchasesVal: 40000, returnsVal: 0, wastageVal: 1000, staffMealsVal: 500,
  closingVal: 25000, overheads: 10000, taxFees: 2000, deliveryCommission: 3000, hasClosing: true, open: false,
  labour: payroll(), ...over,
})

describe('buildStatement', () => {
  it('derives every line, delivery commission netted after staff meals', () => {
    const s = buildStatement(raw())
    expect(s.cogs).toBeCloseTo(20000 + 40000 - 1000 - 500 - 25000)   // 33,500
    expect(s.grossProfit).toBeCloseTo(100000 - 33500)
    expect(s.netProfit).toBeCloseTo(66500 - 1000 - 500 - 3000 - 30000 - 10000 - 2000)
    expect(LINES.map(l => l.key)).toEqual(['revenue', 'cogs', 'grossProfit', 'wastageVal', 'staffMealsVal',
      'deliveryCommission', 'labour', 'overheads', 'taxFees', 'netProfit'])
  })

  it('a material uncounted gap withholds both verdicts; an immaterial one does not', () => {
    const material = buildStatement(raw({ gap: { presentCount: 10, uncountedCount: 3, uncountedValue: 9000, material: true } }))
    expect(material.grossWithheld).toBe(true)
    expect(material.netWithheld).toBe(true)
    const small = buildStatement(raw({ gap: { presentCount: 100, uncountedCount: 1, uncountedValue: 10, material: false } }))
    expect(small.grossWithheld).toBe(false)
    expect(small.netWithheld).toBe(false)
  })

  it('no labour figure prints a dash and withholds Net Profit only', () => {
    const s = buildStatement(raw({ labour: { source: 'none', amount: 0, hasFigure: false } }))
    expect(s.labour).toBeNull()
    expect(fmtLine(LINES.find(l => l.key === 'labour'), s.labour)).toBe('—')
    expect(s.netWithheld).toBe(true)
    expect(s.grossWithheld).toBe(false)
    expect(labourMarker(s)).toBe('none entered')
  })

  it('a withheld estimate keeps its figure but no colour', () => {
    const s = buildStatement(raw({ labour: { source: 'estimate', amount: 25000, hasFigure: true, verdictWithheld: true, reason: 'nopay' } }))
    expect(s.labour).toBe(25000)
    expect(s.netWithheld).toBe(true)
    expect(labourMarker(s)).toBe('estimate — payroll not finalized')
  })

  it('an open month is unjudged on both profit lines', () => {
    const s = buildStatement(raw({ open: true, hasClosing: false }))
    expect(s.grossWithheld && s.netWithheld).toBe(true)
    expect(s.closedWithoutCount).toBe(false)
    const net = LINES.find(l => l.key === 'netProfit')
    expect(lineColor(net, s.netProfit, lineWithheld(net, s))).toBe('var(--theme-text1)')
  })

  it('colours a judged profit and never a cost green', () => {
    const s = buildStatement(raw())
    const net = LINES.find(l => l.key === 'netProfit')
    const cogs = LINES.find(l => l.key === 'cogs')
    expect(lineColor(net, s.netProfit, lineWithheld(net, s))).toBe('var(--theme-green-text)')
    expect(lineColor(cogs, s.cogs, false)).toBe('var(--theme-text2)')
  })
})

describe('sumStatements', () => {
  const a = buildStatement(raw({ onTheWayVal: 500 }))
  const b = buildStatement(raw({ revenue: 50000, labour: payroll(20000), onTheWayVal: 1200 }))

  it('adds every line and keeps labour as the per-month sum', () => {
    const y = sumStatements([a, b])
    for (const l of LINES) expect(y[l.key]).toBeCloseTo(a[l.key] + b[l.key])
    expect(y.labour).toBeCloseTo(50000)
    expect(y.months).toBe(2)
  })

  it('takes the last month\'s on-the-way value for a year, and sums it across outlets', () => {
    expect(sumStatements([a, b]).onTheWayVal).toBe(1200)
    expect(sumStatements([a, b], { stock: 'sum' }).onTheWayVal).toBe(1700)
  })

  it('is unjudged when any month is open or unjudged, and counts months with no labour', () => {
    const open = buildStatement(raw({ open: true }))
    const noLab = buildStatement(raw({ labour: { source: 'failed', amount: null, hasFigure: false } }))
    const y = sumStatements([a, open, noLab])
    expect(y.open).toBe(true)
    expect(y.grossWithheld).toBe(true)
    expect(y.netWithheld).toBe(true)
    expect(y.labourMissing).toBe(1)
    expect(y.labourHasFigure).toBe(false)
    expect(y.labour).toBeCloseTo(60000)   // the two months with a figure
  })

  it('merges gaps and refuses a depreciation total when one month failed', () => {
    const g1 = buildStatement(raw({ gap: { presentCount: 10, uncountedCount: 1, uncountedValue: 100, cogs: 1000, material: false }, depreciation: { amount: 100, count: 1 } }))
    const g2 = buildStatement(raw({ gap: { presentCount: 10, uncountedCount: 1, uncountedValue: 100, cogs: 1000, material: false }, depreciation: { error: { message: 'x' } } }))
    const y = sumStatements([g1, g2])
    expect(y.gap.uncountedCount).toBe(2)
    expect(y.depreciation.error).toBeTruthy()
  })
})

const row = over => ({
  client_id: 'c1', client_name: 'BLOOM CAFE', is_included: true, has_period: true, period_status: 'closed',
  revenue: '100000', opening_val: '20000', purchases_val: '40000', returns_val: '0', wastage_val: '1000',
  staff_meals_val: '500', closing_val: '25000', has_closing: true, overheads_val: '10000', tax_fees_val: '2000',
  transfer_in_val: '0', transfer_out_val: '0', stock_items: 50, uncounted_count: 0, uncounted_val: '0',
  delivery_commission: '0', delivery_unsettled: 0, depreciation_memo: '0', till_waiting_bills: 0,
  till_waiting_notes: 0, on_the_way_val: '0', ...over,
})

describe('groupColumn / columnMarkers', () => {
  it('judges the SQL gap against the column\'s own COGS and marks it', () => {
    const c = groupColumn(row({ uncounted_count: 5, uncounted_val: '9000' }), payroll())
    expect(c.stmt.gapMaterial).toBe(true)   // 5 of 50 items = 10%
    expect(columnMarkers(c).map(m => m.text)).toContain('count incomplete')
  })

  it('marks a no-period column and nothing else', () => {
    expect(columnMarkers({ hasPeriod: false })).toEqual([{ text: 'no period', tone: 'muted' }])
  })

  it('marks open, no count and a missing labour figure', () => {
    expect(columnMarkers(groupColumn(row({ period_status: 'open' }), payroll())).map(m => m.text)).toEqual(['open'])
    expect(columnMarkers(groupColumn(row({ has_closing: false }), payroll())).map(m => m.text)).toEqual(['no count'])
    expect(columnMarkers(groupColumn(row(), { source: 'failed', amount: null, hasFigure: false })).map(m => m.text)).toEqual(['labour not loaded'])
  })
})

describe('pnlNotes', () => {
  const texts = notes => notes.map(n => n.text).join('\n')

  it('says the open month, the no-period outlet, the withheld labour and the stock on the way', () => {
    const open = groupColumn(row({ client_name: 'BLOOM CAFE', period_status: 'open' }), { source: 'none', amount: 0, hasFigure: false })
    const none = { name: 'BLOOM CAFE - PKR', hasPeriod: false, stmt: buildStatement({}) }
    const consolidated = sumStatements([open.stmt], { stock: 'sum' })
    const out = texts(pnlNotes({
      scope: 'Bhadra 2083', grouped: true, stmt: consolidated, cols: [open, none],
      senders: [{ name: 'BLOOM CAFE', value: 1000 }],
    }))
    expect(out).toMatch(/Still open at BLOOM CAFE/)
    expect(out).toMatch(/No Bhadra 2083 in Inventory for: BLOOM CAFE - PKR — the consolidated column is the other outlets only/)
    expect(out).toMatch(/BLOOM CAFE: No labour entered/)
    expect(out).toMatch(/NPR 1,000 of stock was on the way between your outlets at the end of Bhadra 2083 — sent by BLOOM CAFE/)
  })

  it('names unsettled delivery bills, waiting till bills, the memo and the price rule for one outlet', () => {
    const s = buildStatement(raw({ deliveryUnsettled: 3, tillWaiting: { bills: 2, notes: 1 }, depreciation: { amount: 40000, count: 1, prorated: true } }))
    const out = texts(pnlNotes({ scope: 'Bhadra 2083', stmt: s, hrOn: true }))
    expect(out).toMatch(/3 delivery bills from Bhadra 2083 are not settled yet/)
    expect(out).toMatch(/counted twice — remove that entry/)
    expect(out).toMatch(/2 till bills from Bhadra 2083 are not in Inventory yet/)
    expect(out).toMatch(/1 credit note from Bhadra 2083 is not in Inventory yet/)
    expect(out).toMatch(/Depreciation \(not subtracted\): NPR 40,000 — posted Fixed Asset runs for Bhadra 2083 \(pro-rated/)
    expect(out).toMatch(/valued at today's item prices/)
  })

  it('names a typed Labor tab ignored beside HR', () => {
    const s = buildStatement(raw({ labour: { ...payroll(), ignoredBucket: 250000 } }))
    expect(texts(pnlNotes({ scope: 'Bhadra 2083', stmt: s, hrOn: true }))).toMatch(/Labour tab NPR 2,50,000 not counted — Crest HR is the labour figure/)
  })
})

describe('statementRows', () => {
  it('leaves a no-period column blank on every line, with markers and the memo row', () => {
    const c1 = groupColumn(row(), payroll())
    const c2 = { name: 'BLOOM CAFE - PKR', hasPeriod: false, stmt: buildStatement({}) }
    const rows = statementRows({ grouped: true, cols: [c1, c2], consolidated: sumStatements([c1.stmt], { stock: 'sum' }) })
    expect(rows[0]).toMatchObject({ Line: 'Status', 'BLOOM CAFE - PKR': 'no period' })
    for (const r of rows.slice(1)) expect(r['BLOOM CAFE - PKR']).toBe('')
    expect(rows[rows.length - 1].Line).toBe('Depreciation (memo, not subtracted)')
    expect(rows.find(r => r.Line === 'Cost of Goods Sold')['BLOOM CAFE']).toBeLessThan(0)
  })

  it('adds a column per month for a fiscal year', () => {
    const a = buildStatement(raw())
    const rows = statementRows({ stmt: sumStatements([a, a]), monthCols: [{ label: 'Shrawan 2082', stmt: a }, { label: 'Bhadra 2082', stmt: a }] })
    expect(Object.keys(rows[0])).toEqual(['Line', 'Shrawan 2082', 'Bhadra 2082', 'Year (NPR)', '% of Revenue'])
    expect(rows.find(r => r.Line === 'Labour')['Year (NPR)']).toBe(-60000)
  })
})
