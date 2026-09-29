import {
  selectDepletingSales, selectDepletingSalesAcrossPeriods, buildPosIndex, posSupersedesManual, bulkTillHandover,
  earlierTillDay,
} from './salesDepletion'

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

  // Bulk rows carry bs_day 0 and are judged against the till across the whole period, so across a
  // fiscal year one POS sale in month one silenced every Bulk row for that dish for the rest of it.
  // Since D35 (S792) a Bulk row is superseded only when the till ran from day 1 or the pre-till days
  // were re-entered, so the fixture's till sale is on day 1 — the case that still supersedes.
  test('a Bulk row is only superseded inside its own period', () => {
    const rows = [
      { period_id: 'shrawan', recipe_id: 'r1', qty_sold: 4, bs_day: 1, source: 'pos' },
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

// Owner decision D35 (S792). A dish typed as a Bulk (month) total and later sold on the till: the
// Bulk total keeps counting for stock until the days before the till are entered as daily figures.
// It used to be dropped the moment the till sold the dish anywhere in the month, while revenue
// and the Stock Movements ledger kept it — so the pre-till days read as stock used, nothing sold.
describe('a Bulk total the till also sold (D35)', () => {
  const BULK = { recipe_id: 'momo', qty_sold: 40, bs_day: 0, source: 'manual' }
  const TILL = { recipe_id: 'momo', qty_sold: 6, bs_day: 12, source: 'pos' }

  test('before re-entry: the Bulk total still depletes beside the till', () => {
    const out = selectDepletingSales([BULK, TILL])
    expect(out).toHaveLength(2)
    expect(out.map(r => r.bs_day).sort((a, b) => a - b)).toEqual([0, 12])
  })

  test('once a pre-till day is entered as a daily figure, the Bulk total stops depleting', () => {
    const preTill = { recipe_id: 'momo', qty_sold: 3, bs_day: 4, source: 'manual' }
    const out = selectDepletingSales([BULK, TILL, preTill])
    expect(out).toHaveLength(2)
    expect(out.find(r => r.bs_day === 0)).toBeUndefined()
    expect(out.find(r => r.bs_day === 4)).toBeDefined()   // the re-entered day depletes
  })

  test('a daily row ON a till day is not a re-entry of the pre-till days', () => {
    const tillDayManual = { recipe_id: 'momo', qty_sold: 2, bs_day: 15, source: 'manual' }
    const out = selectDepletingSales([BULK, TILL, tillDayManual])
    // Day 15 had no till sale of momo, so the manual row depletes; the Bulk total still does too.
    expect(out.map(r => r.bs_day).sort((a, b) => a - b)).toEqual([0, 12, 15])
  })

  test('the till start is the first till sale of ANY dish, not of this one', () => {
    // The till opened on day 3 (tea); momo first sold on it on day 12. A momo row on day 8 is a
    // till-day row nobody rang up, not a pre-till re-entry, so the Bulk total still counts.
    const tea = { recipe_id: 'tea', qty_sold: 20, bs_day: 3, source: 'pos' }
    const day8 = { recipe_id: 'momo', qty_sold: 2, bs_day: 8, source: 'manual' }
    expect(selectDepletingSales([BULK, TILL, tea, day8]).some(r => r.bs_day === 0)).toBe(true)
    // …while a day before 3 is one.
    const day2 = { recipe_id: 'momo', qty_sold: 2, bs_day: 2, source: 'manual' }
    expect(selectDepletingSales([BULK, TILL, tea, day2]).some(r => r.bs_day === 0)).toBe(false)
  })

  test('a till that ran from day 1 leaves no pre-till day, so the Bulk total never counted (unchanged)', () => {
    const fromDayOne = { ...TILL, bs_day: 1 }
    expect(selectDepletingSales([BULK, fromDayOne])).toEqual([fromDayOne])
  })

  test('a comp is a till sale too; a credit note is not', () => {
    expect(selectDepletingSales([BULK, { ...TILL, source: 'pos_comp', bs_day: 1 }]).some(r => r.bs_day === 0)).toBe(false)
    expect(selectDepletingSales([BULK, { ...TILL, source: 'pos_credit', qty_sold: -1, bs_day: 1 }])).toEqual([BULK])
  })

  test('the write path: a recipe-scoped POS read plus the handed-in till start and manual rows', () => {
    // The write path reads POS rows for the saved recipes only, so the period's till start comes in
    // separately — here the till opened on day 3 though momo's first till sale was day 12.
    const scoped = buildPosIndex([{ recipe_id: 'momo', bs_day: 12 }], { tillStart: 3, manualRows: [] })
    expect(scoped.tillStart).toBe(3)
    expect(posSupersedesManual('momo', 0, scoped)).toBe(false)
    const reentered = buildPosIndex([{ recipe_id: 'momo', bs_day: 12 }], { tillStart: 3, manualRows: [{ recipe_id: 'momo', bs_day: 2, source: 'manual' }] })
    expect(posSupersedesManual('momo', 0, reentered)).toBe(true)
    // An index built the old way (no manual rows) never sees a re-entry, so the Bulk total depletes.
    expect(posSupersedesManual('momo', 0, buildPosIndex([{ recipe_id: 'momo', bs_day: 12 }]))).toBe(false)
    // …and Daily supersession is untouched.
    expect(posSupersedesManual('momo', 12, scoped)).toBe(true)
    expect(posSupersedesManual('momo', 11, scoped)).toBe(false)
  })
})

describe('bulkTillHandover — what Sales Entry says about it (D35)', () => {
  test('names the dishes still counted, with the till start', () => {
    const h = bulkTillHandover([
      { recipe_id: 'momo', qty_sold: 40, bs_day: 0, source: 'manual' },
      { recipe_id: 'chowmein', qty_sold: 10, bs_day: 0, source: null },     // legacy NULL = manual
      { recipe_id: 'momo', qty_sold: 6, bs_day: 12, source: 'pos' },
      { recipe_id: 'tea', qty_sold: 9, bs_day: 12, source: 'pos' },
    ])
    expect(h.tillStart).toBe(12)
    expect(h.needsReentry).toEqual([{ recipeId: 'momo', bulkQty: 40 }])   // chowmein never sold on the till
    expect(h.ignoredForStock).toEqual([])
    expect(h.manualBeforeTill).toBe(true)
  })

  test('a till from day 1 is reported as ignored, not as needing re-entry', () => {
    const h = bulkTillHandover([
      { recipe_id: 'momo', qty_sold: 40, bs_day: 0, source: 'manual' },
      { recipe_id: 'momo', qty_sold: 6, bs_day: 1, source: 'pos' },
    ])
    expect(h.needsReentry).toEqual([])
    expect(h.ignoredForStock).toEqual([{ recipeId: 'momo', bulkQty: 40, reason: 'till_from_day_one' }])
  })

  test('a month that is all till has nothing to hand over', () => {
    const h = bulkTillHandover([{ recipe_id: 'momo', qty_sold: 6, bs_day: 2, source: 'pos' }])
    expect(h).toEqual({ tillStart: 2, needsReentry: [], ignoredForStock: [], manualBeforeTill: false })
  })

  test('a month with no till sale has no till start and nothing to say', () => {
    const h = bulkTillHandover([{ recipe_id: 'momo', qty_sold: 40, bs_day: 0, source: 'manual' }])
    expect(h).toEqual({ tillStart: null, needsReentry: [], ignoredForStock: [], manualBeforeTill: false })
  })

  test('pre-till daily figures alone still mark the month as started by hand', () => {
    const h = bulkTillHandover([
      { recipe_id: 'momo', qty_sold: 3, bs_day: 4, source: 'manual' },
      { recipe_id: 'momo', qty_sold: 6, bs_day: 12, source: 'pos' },
    ])
    expect(h.manualBeforeTill).toBe(true)
    expect(h.needsReentry).toEqual([])
  })
})

// S792.4: sales_entries only hold the bills that reached IMS. An unsynced till, or bills waiting
// for Periods → Post POS bills to Inventory, made the till's real first days look pre-till.
describe('bulkTillHandover — the till\'s own bills can start it earlier (billTillStart)', () => {
  const rows = [
    { recipe_id: 'momo', qty_sold: 40, bs_day: 0, source: 'manual' },
    { recipe_id: 'momo', qty_sold: 3, bs_day: 5, source: 'manual' },
    { recipe_id: 'momo', qty_sold: 6, bs_day: 12, source: 'pos' },
  ]

  test('a bill not yet in IMS moves the till start back, and the pre-till range with it', () => {
    const h = bulkTillHandover(rows, { billTillStart: 8 })
    expect(h.tillStart).toBe(8)
    // Day 5 is still before the till, so the month was still started by hand.
    expect(h.manualBeforeTill).toBe(true)
  })

  test('the pre-till re-entry is judged against the earlier start', () => {
    // Day 5 re-entered momo's pre-till days whether the till began on 8 or 12.
    expect(bulkTillHandover(rows, { billTillStart: 8 }).ignoredForStock)
      .toEqual([{ recipeId: 'momo', bulkQty: 40, reason: 'reentered' }])
    // A till that really began on day 4 leaves day 5 a till day — nothing before it is re-entered.
    expect(bulkTillHandover(rows, { billTillStart: 4 }).needsReentry)
      .toEqual([{ recipeId: 'momo', bulkQty: 40 }])
  })

  test('bills from day 1 mean there were no pre-till days at all', () => {
    const h = bulkTillHandover(rows, { billTillStart: 1 })
    expect(h.tillStart).toBe(1)
    expect(h.ignoredForStock).toEqual([{ recipeId: 'momo', bulkQty: 40, reason: 'till_from_day_one' }])
  })

  test('a later or missing bill day changes nothing — IMS already holds the earlier sale', () => {
    const base = bulkTillHandover(rows)
    expect(bulkTillHandover(rows, { billTillStart: 20 })).toEqual(base)
    expect(bulkTillHandover(rows, { billTillStart: null })).toEqual(base)
    expect(bulkTillHandover(rows, {})).toEqual(base)
  })

  test('a till whose bills have not reached IMS at all still has a start', () => {
    const h = bulkTillHandover([{ recipe_id: 'momo', qty_sold: 3, bs_day: 2, source: 'manual' }], { billTillStart: 6 })
    expect(h).toEqual({ tillStart: 6, needsReentry: [], ignoredForStock: [], manualBeforeTill: true })
  })

  test('the stock reports are not moved by it: selectDepletingSales still reads the rows', () => {
    // Only Sales Entry passes billTillStart; the read path has no override to take. (The Bulk row
    // drops out on the rows' own day-12 start, since day 5 re-entered a pre-till day.)
    expect(selectDepletingSales(rows).map(r => r.bs_day)).toEqual([5, 12])
  })
})

describe('earlierTillDay', () => {
  test('the earlier of two known days, or whichever one is known', () => {
    expect(earlierTillDay(12, 8)).toBe(8)
    expect(earlierTillDay(3, 8)).toBe(3)
    expect(earlierTillDay(null, 8)).toBe(8)
    expect(earlierTillDay(8, undefined)).toBe(8)
  })

  test('nothing known is null, and a non-day is not a day', () => {
    expect(earlierTillDay(null, null)).toBeNull()
    expect(earlierTillDay(0, NaN)).toBeNull()
    expect(earlierTillDay(-2, 4)).toBe(4)
  })
})
