import { selectDepletingSales, selectDepletingSalesAcrossPeriods } from './salesDepletion'

// `bs_day` is a day NUMBER inside a month, so the supersedes test only means anything within one
// period. Two reports read a whole fiscal year — Stock Ageing always did, FIFO / Expiry since S717
// widened its window — and both were passing that year through the single-period form.
describe('selectDepletingSales (single period)', () => {
  test('POS supersedes a manual row on the same day', () => {
    const out = selectDepletingSales([
      { recipe_id: 'r1', qty_sold: 4, bs_day: 5, source: 'pos' },
      { recipe_id: 'r1', qty_sold: 3, bs_day: 5, source: 'manual' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('pos')
  })

  test('a manual row on a day POS did not sell survives', () => {
    const out = selectDepletingSales([
      { recipe_id: 'r1', qty_sold: 4, bs_day: 5, source: 'pos' },
      { recipe_id: 'r1', qty_sold: 3, bs_day: 6, source: 'manual' },
    ])
    expect(out).toHaveLength(2)
  })

  test('a credit note never depletes', () => {
    const out = selectDepletingSales([{ recipe_id: 'r1', qty_sold: -2, bs_day: 5, source: 'pos_credit' }])
    expect(out).toEqual([])
  })

  test('a NULL source counts as manual', () => {
    const out = selectDepletingSales([{ recipe_id: 'r1', qty_sold: 3, bs_day: 5, source: null }])
    expect(out).toHaveLength(1)
  })
})

describe('selectDepletingSalesAcrossPeriods', () => {
  // The defect, stated as a test: 5 Shrawan and 5 Bhadra are both bs_day 5.
  test('a POS sale in one period does not suppress the same day number in another', () => {
    const rows = [
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 4, bs_day: 5, source: 'pos' },
      { period_id: 'bhadra', recipe_id: 'r1', qty_sold: 3, bs_day: 5, source: 'manual' },
    ]
    // The single-period form is what the two reports were using, and it drops the Bhadra row.
    expect(selectDepletingSales(rows)).toHaveLength(1)
    // Per period, both survive — which is the whole of the fix.
    const out = selectDepletingSalesAcrossPeriods(rows)
    expect(out).toHaveLength(2)
    expect(out.map(r => r.period_id).sort()).toEqual(['bhadra', 'shrawan'])
  })

  // Bulk rows carry bs_day 0 and are superseded by a POS sale ANYWHERE in the period, so across a
  // fiscal year one POS sale in month one silenced every Bulk row for that dish for the rest of it.
  test('a Bulk row is only superseded inside its own period', () => {
    const rows = [
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 4, bs_day: 12, source: 'pos' },
      { period_id: 'bhadra', recipe_id: 'r1', qty_sold: 30, bs_day: 0, source: 'manual' },
    ]
    expect(selectDepletingSales(rows)).toHaveLength(1)
    expect(selectDepletingSalesAcrossPeriods(rows)).toHaveLength(2)
  })

  test('supersession still applies within a period', () => {
    const out = selectDepletingSalesAcrossPeriods([
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 4, bs_day: 5, source: 'pos' },
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 3, bs_day: 5, source: 'manual' },
      { period_id: 'bhadra', recipe_id: 'r1', qty_sold: 9, bs_day: 5, source: 'manual' },
    ])
    expect(out).toHaveLength(2)
    expect(out.find(r => r.period_id === 'shrawan').source).toBe('pos')
    expect(out.find(r => r.period_id === 'bhadra').qty_sold).toBe(9)
  })

  // Only ever DROPS manual rows, so the failure is one-directional: consumption comes out short,
  // stock that was eaten reads as still on the shelf, and the ageing/expiry figures read HIGH.
  test('the single-period form can only under-count across a year, never over-count', () => {
    const rows = []
    for (const period of ['p1', 'p2', 'p3']) {
      rows.push({ period_id: period, recipe_id: 'r1', qty_sold: 10, bs_day: 7, source: 'pos' })
      rows.push({ period_id: period, recipe_id: 'r2', qty_sold: 5, bs_day: 7, source: 'manual' })
    }
    const sum = list => list.reduce((s, r) => s + r.qty_sold, 0)
    expect(sum(selectDepletingSalesAcrossPeriods(rows))).toBe(45)
    expect(sum(selectDepletingSales(rows))).toBe(45)   // r2 never sold on POS, so nothing collides
    // Now give r2 a POS sale in one period only — the year-wide form loses the other two months.
    rows.push({ period_id: 'p1', recipe_id: 'r2', qty_sold: 6, bs_day: 7, source: 'pos' })
    expect(sum(selectDepletingSalesAcrossPeriods(rows))).toBe(46)   // p1's manual 5 correctly dropped
    expect(sum(selectDepletingSales(rows))).toBe(36)                // p2 and p3's 5s wrongly dropped too
  })

  test('a row with no period_id is its own group rather than joining another month', () => {
    const rows = [
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 4, bs_day: 5, source: 'pos' },
      { recipe_id: 'r1', qty_sold: 3, bs_day: 5, source: 'manual' },
      { recipe_id: 'r1', qty_sold: 2, bs_day: 5, source: 'manual' },
    ]
    expect(selectDepletingSalesAcrossPeriods(rows)).toHaveLength(3)
  })

  test('empty and null inputs produce an empty list, not a throw', () => {
    expect(selectDepletingSalesAcrossPeriods([])).toEqual([])
    expect(selectDepletingSalesAcrossPeriods(null)).toEqual([])
  })
})
