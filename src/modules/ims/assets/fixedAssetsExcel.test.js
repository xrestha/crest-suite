import {
  registerSheetRows, valuationAssetRows, valuationCategoryRows, valuationNotes, disposalSheetRows,
  taxPoolSheetRows, taxPoolSheetNotes, showsWriteOff, money, fileSafe, REGISTER_NOTES, DISPOSAL_NOTES,
} from './fixedAssetsExcel'
import { computeValuationAsOf } from './depreciationCompute'
import { formatAdAsBs } from '../../../utils/bsCalendar'

const cat = name => ({ assets_categories: { name } })

describe('money', () => {
  it('is a number at two places, never text', () => {
    expect(money('1234.567')).toBe(1234.57)
    expect(money(null)).toBe(0)
    expect(typeof money('5')).toBe('number')
  })
})

describe('registerSheetRows', () => {
  const assets = [
    { id: 'A', asset_code: 'FA-001', name: 'Oven', quantity: 1, unit_cost: 100000, total_cost: 100000, acquisition_date: '2025-07-16', status: 'active', ...cat('Kitchen') },
    { id: 'B', asset_code: 'FA-002', name: 'Chairs', quantity: 4, unit_cost: 2500.125, total_cost: 10000.5, acquisition_date: '2025-08-01', status: 'disposed', ...cat('Furniture') },
  ]
  const nbv = { A: 80000, B: 10000.5 }
  const rows = registerSheetRows(assets, a => nbv[a.id])

  it('writes one row per asset on screen, money and percentages as numbers, dates in BS', () => {
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      'Code': 'FA-001', 'Name': 'Oven', 'Category': 'Kitchen', 'Qty': 1, 'Unit Cost': 100000, 'Total Cost': 100000,
      'Acquired (BS)': formatAdAsBs('2025-07-16'), 'Current NBV': 80000, '% Depreciated': 20, 'Status': 'Active',
    })
    expect(rows[1]['Unit Cost']).toBe(2500.13)
    expect(rows[1]['Status']).toBe('Disposed')
    expect(rows[1]['Acquired (BS)']).not.toMatch(/AD/)
  })

  it('totals money only, with the whole list as its % depreciated', () => {
    const total = rows[2]
    expect(total['Code']).toBe('TOTAL')
    expect(total['Qty']).toBe('')
    expect(total['Unit Cost']).toBe('')
    expect(total['Total Cost']).toBe(110000.5)
    expect(total['Current NBV']).toBe(90000.5)
    expect(total['% Depreciated']).toBe(18.2)
  })

  it('an empty list still states its total', () => {
    expect(registerSheetRows([], () => 0)).toEqual([expect.objectContaining({ 'Code': 'TOTAL', 'Total Cost': 0, '% Depreciated': 0 })])
  })
})

describe('the valuation sheets', () => {
  const assets = [
    { id: 'A', asset_code: 'FA-002', name: 'Oven', status: 'active', acquisition_date: '2024-01-01', total_cost: 100000.25, ...cat('Kitchen') },
    { id: 'B', asset_code: 'FA-001', name: 'Fridge', status: 'disposed', disposal_date: '2026-01-10', acquisition_date: '2024-01-01', total_cost: 50000, ...cat('Kitchen') },
    { id: 'E', asset_code: 'FA-010', name: 'Tables', status: 'active', acquisition_date: '2024-01-01', total_cost: 40000.4, ...cat('Furniture') },
  ]
  const rows = [
    { asset_id: 'A', period_start: '2024-07-16', period_end: '2025-07-15', depreciation_amount: 10000.33 },
    { asset_id: 'B', period_start: '2024-07-16', period_end: '2025-07-15', depreciation_amount: 5000.17 },
    { asset_id: 'E', period_start: '2024-07-16', period_end: '2025-07-15', depreciation_amount: 1234.56 },
  ]
  const v = computeValuationAsOf({ assets, postedRows: rows, asOf: '2025-07-15' })
  const perAsset = valuationAssetRows(v)
  const byCategory = valuationCategoryRows(v)

  it('lists every asset held, by category then code, and names a later disposal', () => {
    expect(perAsset.slice(0, -1).map(r => [r['Code'], r['Category']])).toEqual([
      ['FA-001', 'Kitchen'], ['FA-002', 'Kitchen'], ['FA-010', 'Furniture'],
    ])
    expect(perAsset[0]['Disposed or Written Off (BS)']).toBe(`Disposed ${formatAdAsBs('2026-01-10')}`)
    expect(perAsset[1]['Disposed or Written Off (BS)']).toBe('')
  })

  it('the per-asset sheet adds up to the category sheet, category by category and in total', () => {
    for (const c of byCategory.slice(0, -1)) {
      const mine = perAsset.filter(r => r['Category'] === c['Category'])
      for (const k of ['Total Cost', 'Accumulated Depreciation', 'NBV']) {
        expect(mine.reduce((s, r) => s + r[k], 0)).toBeCloseTo(c[k], 2)
      }
    }
    const [assetTotal, categoryTotal] = [perAsset[perAsset.length - 1], byCategory[byCategory.length - 1]]
    for (const k of ['Total Cost', 'Accumulated Depreciation', 'NBV']) {
      expect(assetTotal[k]).toBe(categoryTotal[k])
      expect(perAsset.slice(0, -1).reduce((s, r) => s + r[k], 0)).toBeCloseTo(assetTotal[k], 2)
    }
    expect(categoryTotal).toEqual({ 'Category': 'TOTAL', 'Total Cost': 190000.65, 'Accumulated Depreciation': 16235.06, 'NBV': 173765.59 })
  })

  it('the category sheet is the screen table, with its Total row', () => {
    expect(byCategory.map(r => r['Category'])).toEqual(['Kitchen', 'Furniture', 'TOTAL'])
  })

  it('names a personal-use share only when there is one', () => {
    expect(valuationNotes(0).join(' ')).not.toMatch(/personal-use/)
    expect(valuationNotes(2).join(' ')).toMatch(/2 assets carry a personal-use share/)
  })
})

describe('disposalSheetRows', () => {
  const disposed = [
    { asset_code: 'FA-1', name: 'Van', status: 'disposed', disposal_date: '2025-10-01', disposal_proceeds: 300000, disposal_gain_loss: 25000.5, disposal_reason: 'Sold' },
    { asset_code: 'FA-2', name: 'Mixer', status: 'written_off', disposal_date: '2025-11-01', disposal_proceeds: 0, disposal_gain_loss: -4200 },
  ]
  const rows = disposalSheetRows(disposed)

  it('keeps the screen columns, NBV at disposal as proceeds less the gain, a loss as a negative', () => {
    expect(rows[0]).toEqual({
      'Code': 'FA-1', 'Name': 'Van', 'Outcome': 'Disposed', 'Disposal Date (BS)': formatAdAsBs('2025-10-01'),
      'NBV at Disposal': 274999.5, 'Proceeds': 300000, 'Gain / (Loss)': 25000.5, 'Reason': 'Sold',
    })
    expect(rows[1]).toEqual(expect.objectContaining({ 'Outcome': 'Written Off', 'NBV at Disposal': 4200, 'Gain / (Loss)': -4200, 'Reason': '' }))
  })

  it('totals what the screen totals: Proceeds and Gain / (Loss)', () => {
    expect(rows[2]).toEqual(expect.objectContaining({ 'Code': 'TOTAL', 'NBV at Disposal': '', 'Proceeds': 300000, 'Gain / (Loss)': 20800.5 }))
  })
})

describe('taxPoolSheetRows', () => {
  const line = (pool, o = {}) => ({
    pool, opening_wdv: 1000, repair_carried_in: 10, additions_full: 300, additions_two_third: 60, additions_one_third: 30,
    disposal_proceeds: 50, depreciation_base: 1200, repair_expense_deductible: 70, repair_expense_capitalized: 5,
    depreciation_amount: 180, terminal_deduction: 0, balancing_income: 0, closing_wdv: 1170, ...o,
  })

  it('leaves out Write-off and Income when no pool has one, as the screen does', () => {
    const rows = taxPoolSheetRows([line('A'), line('B')])
    expect(Object.keys(rows[0])).not.toContain('Write-off')
    expect(Object.keys(rows[0])).not.toContain('Income')
    expect(rows[0]['Pool']).toMatch(/^Pool A/)
    expect(rows[0]['Repair Deductible']).toBe(70)
    expect(rows[0]['Repair Capitalized']).toBe(5)
  })

  it('shows both when one pool has either, and totals as the footer does', () => {
    const lines = [line('A'), line('D', { terminal_deduction: 400.25, closing_wdv: 0 })]
    expect(showsWriteOff(lines)).toBe(true)
    const rows = taxPoolSheetRows(lines)
    const total = rows[rows.length - 1]
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Write-off', 'Income']))
    expect(Object.keys(rows[0]).pop()).toBe('Closing WDV')
    expect(total).toEqual(expect.objectContaining({
      'Pool': 'TOTAL', 'Opening WDV': 2000, 'Additions (full rate)': 600, 'Disposals': 100, 'Depreciation': 360,
      'Write-off': 400.25, 'Income': 0, 'Closing WDV': 1170, 'Depreciation Base': '', 'Repair Deductible': '', 'Repair Capitalized': '',
    }))
  })
})

describe('taxPoolSheetNotes', () => {
  const lines = [
    { pool: 'B', disposal_proceeds: 90000, balancing_income: 12000, closing_wdv: 0, terminal_deduction: 0, small_balance_written_off: 0 },
    { pool: 'D', disposal_proceeds: 0, balancing_income: 0, closing_wdv: 0, terminal_deduction: 3500, small_balance_written_off: 0 },
    { pool: 'C', disposal_proceeds: 0, balancing_income: 0, closing_wdv: 0, terminal_deduction: 0, small_balance_written_off: 1500 },
  ]
  const built = { askDissolve: ['A', 'D'], untracked: [{ asset_code: 'FA-9', name: 'Sign board', total_cost: 8000 }] }
  const notes = {
    openingGap: { priorLabel: '82/83', earlierLabel: null, pools: ['A', 'B'] },
    openingTyped: { priorLabel: '82/83', pools: ['C'], eOpening: 2500 },
    poolECapped: { scheduled: 9000, held: 7000 },
    poolEDisposed: { value: 1000, proceeds: 200 },
  }
  const out = taxPoolSheetNotes({
    fyLabel: '83/84', lines, built, notes, zeroPoolsText: 'Pools A, B open at 0', closedPools: { D: true }, disclaimer: 'DISCLAIMER',
  })

  it('opens by saying the sheet is a preview, and ends with the disclaimer', () => {
    expect(out[0]).toMatch(/^PREVIEW, not a posted schedule/)
    expect(out[out.length - 1]).toBe('DISCLAIMER')
  })

  it('carries every note the screen shows', () => {
    const all = out.join('\n')
    expect(all).toMatch(/Pools A, B open at 0\. No tax pool schedule is posted for FY 82\/83/)
    expect(all).toMatch(/Pool C opens from the values typed in/)
    expect(all).toMatch(/Pool E opens at NPR 2,500/)
    expect(all).toMatch(/Pool B: the NPR 90,000 received is NPR 12,000 more/)
    expect(all).toMatch(/Pool D closed: every asset in it was sold or scrapped\. The NPR 3,500 left/)
    expect(all).toMatch(/Pool C: the NPR 1,500 left after the depreciation/)
    expect(all).toMatch(/Pool A: no asset of this pool is left/)
    expect(all).not.toMatch(/Pool D: no asset of this pool is left/) // ticked as closed on screen
    expect(all).toMatch(/only holds NPR 7,000/)
    expect(all).toMatch(/software or licences sold/)
    expect(all).toMatch(/FA-9 Sign board NPR 8,000/)
  })

  it('writes no apostrophe of its own', () => {
    // The memory rule (S851): reword, never escape. Data (asset names) and the disclaimer aside.
    for (const n of out.slice(0, -1)) expect(n.replace('Sign board', '')).not.toMatch(/['’]/)
    for (const n of [...REGISTER_NOTES, ...DISPOSAL_NOTES, ...valuationNotes(1)]) expect(n).not.toMatch(/['’]/)
  })
})

describe('fileSafe', () => {
  it('keeps letters and digits only', () => {
    expect(fileSafe('FY 83/84')).toBe('FY-83-84')
    expect(fileSafe('18 Kartik 2083')).toBe('18-Kartik-2083')
  })
})
