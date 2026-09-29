import {
  NO_FIXED_COSTS_ROW, isFigureRow, groupSavedRows, nearestPeriodWithFigures, overheadInserts,
} from './overheadsRows'

// S792 (COSTS-14): a month saved with no fixed costs is a record, not "nothing saved yet".
describe('overheadInserts', () => {
  test('saves every row with a category and an amount above zero', () => {
    const rows = {
      overhead: [{ category: 'Rent', description: ' Shop lease ', amount: '60000' }, { category: 'Utilities', description: '', amount: '' }],
      labor: [{ category: '  ', description: '', amount: '5000' }],
      tax_fees: [{ category: 'Bank Charges', description: null, amount: 350 }],
    }
    expect(overheadInserts(rows, 'p1')).toEqual([
      { period_id: 'p1', bucket: 'overhead', category: 'Rent', description: 'Shop lease', amount: 60000 },
      { period_id: 'p1', bucket: 'tax_fees', category: 'Bank Charges', description: '', amount: 350 },
    ])
  })

  test('with nothing above zero, saves the one marker row at amount 0', () => {
    const blank = { overhead: [{ category: 'Rent', description: '', amount: '' }], labor: [], tax_fees: [] }
    expect(overheadInserts(blank, 'p1')).toEqual([{ period_id: 'p1', ...NO_FIXED_COSTS_ROW }])
    expect(overheadInserts({ overhead: [], labor: [], tax_fees: [] }, 'p1')).toHaveLength(1)
    expect(NO_FIXED_COSTS_ROW).toEqual({ bucket: 'overhead', category: 'No fixed costs', description: 'Saved with no fixed costs for this month', amount: 0 })
  })
})

describe('groupSavedRows', () => {
  test('a period holding only the marker was saved empty, and shows no editable line for it', () => {
    const { grouped, savedEmpty } = groupSavedRows([{ id: 'm', period_id: 'p1', ...NO_FIXED_COSTS_ROW }])
    expect(savedEmpty).toBe(true)
    expect(grouped).toEqual({ overhead: [], labor: [], tax_fees: [] })
  })

  test('real figures are grouped by bucket, clean, with an unknown bucket filed under overhead', () => {
    const { grouped, savedEmpty } = groupSavedRows([
      { id: 'a', bucket: 'overhead', category: 'Rent', amount: 60000 },
      { id: 'b', bucket: 'labor', category: 'Kitchen Staff', amount: '45000' },
      { id: 'c', bucket: null, category: 'Old row', amount: 100 },
      { id: 'd', bucket: 'overhead', category: 'Blank', amount: 0 },
    ])
    expect(savedEmpty).toBe(false)
    expect(grouped.overhead.map(r => r.id)).toEqual(['a', 'c'])
    expect(grouped.labor).toEqual([{ id: 'b', bucket: 'labor', category: 'Kitchen Staff', amount: '45000', _dirty: false }])
  })

  test('no rows at all is not "saved empty" — that month has simply never been saved', () => {
    expect(groupSavedRows([]).savedEmpty).toBe(false)
    expect(groupSavedRows(null).savedEmpty).toBe(false)
  })
})

describe('nearestPeriodWithFigures', () => {
  const kartik = { id: 'kartik', label: 'Kartik 2082' }
  const ashwin = { id: 'ashwin', label: 'Ashwin 2082' }
  const bhadra = { id: 'bhadra', label: 'Bhadra 2082' }

  test('skips a month saved with no fixed costs and carries from the last month with real figures', () => {
    const rows = [
      { period_id: 'kartik', ...NO_FIXED_COSTS_ROW },
      { period_id: 'ashwin', bucket: 'overhead', category: 'Rent', amount: 60000 },
      { period_id: 'ashwin', bucket: 'overhead', category: 'Blank', amount: 0 },
      { period_id: 'bhadra', bucket: 'overhead', category: 'Rent', amount: 55000 },
    ]
    const r = nearestPeriodWithFigures([kartik, ashwin, bhadra], rows)
    expect(r.period).toBe(ashwin)
    expect(r.rows).toEqual([{ period_id: 'ashwin', bucket: 'overhead', category: 'Rent', amount: 60000 }])
  })

  test('nothing to carry when no earlier month has a figure', () => {
    expect(nearestPeriodWithFigures([kartik], [{ period_id: 'kartik', ...NO_FIXED_COSTS_ROW }])).toEqual({ rows: null, period: null })
    expect(nearestPeriodWithFigures([], [])).toEqual({ rows: null, period: null })
  })
})

describe('isFigureRow', () => {
  test('zero, blank and null are not figures; any other number is', () => {
    expect([0, '0', '', null, undefined, 'abc'].map(amount => isFigureRow({ amount }))).toEqual([false, false, false, false, false, false])
    expect([1, '250.5', -10].map(amount => isFigureRow({ amount }))).toEqual([true, true, true])
  })
})
