import { loadDepreciationMemo } from './depreciationMemo'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'

function mockScopedFrom({ rows = [], error = null, reject = false, calls = [] } = {}) {
  return (table, columns) => {
    const call = { table, columns, filters: [], ordered: [] }
    calls.push(call)
    const b = {
      eq: (c, v) => { call.filters.push(['eq', c, v]); return b },
      lte: (c, v) => { call.filters.push(['lte', c, v]); return b },
      gte: (c, v) => { call.filters.push(['gte', c, v]); return b },
      order: c => { call.ordered.push(c); return b },
      range: () => (reject ? Promise.reject(new Error('network down')) : Promise.resolve(error ? { data: null, error } : { data: rows, error: null })),
    }
    return b
  }
}

describe('loadDepreciationMemo', () => {
  const kartik = { bs_year: 2083, bs_month: 7 }
  const start = formatAd(bsToAd(2083, 7, 1))
  const end = formatAd(bsToAd(2083, 7, daysInBsMonth(2083, 7)))

  test('posted rows only, inside the month\'s AD bounds (formatAd, never toISOString)', async () => {
    const calls = []
    const rows = [{ id: 'a', period_start: start, period_end: end, depreciation_amount: '4000', override_amount: null }]
    const r = await loadDepreciationMemo(mockScopedFrom({ rows, calls }), kartik)
    expect(r).toEqual({ amount: 4000, count: 1, prorated: false })
    expect(calls[0].table).toBe('assets_depreciation_schedule')
    expect(calls[0].filters).toEqual([['eq', 'is_posted', true], ['lte', 'period_start', end], ['gte', 'period_end', start]])
    expect(calls[0].ordered).toEqual(['period_end', 'id'])
  })

  test('a run longer than the month is pro-rated by overlapping days', async () => {
    // A whole fiscal year's run, Shrawan 2083 to Ashadh 2084.
    const rows = [{ id: 'y', period_start: formatAd(bsToAd(2083, 4, 1)), period_end: formatAd(bsToAd(2084, 3, daysInBsMonth(2084, 3))), depreciation_amount: 365000, override_amount: null }]
    const r = await loadDepreciationMemo(mockScopedFrom({ rows }), kartik)
    expect(r.prorated).toBe(true)
    expect(r.count).toBe(1)
    expect(r.amount).toBeGreaterThan(0)
    expect(r.amount).toBeLessThan(365000)
  })

  test('a failed read comes back as { error }, and a rejected one never throws', async () => {
    expect(await loadDepreciationMemo(mockScopedFrom({ error: { code: '42501', message: 'denied' } }), kartik)).toEqual({ error: { code: '42501', message: 'denied' } })
    const r = await loadDepreciationMemo(mockScopedFrom({ reject: true }), kartik)
    expect(r.error).toBeInstanceOf(Error)
  })

  test('Overheads re-exports it under the contract name', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, 'Overheads.js'), 'utf8')
    expect(src).toMatch(/export \{ loadDepreciationMemo \} from '\.\/depreciationMemo'/)
  })
})
