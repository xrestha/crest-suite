import {
  findUncountedItems, isMaterialGap, mergeGaps, gapHeadline, gapNote, unjudgedFcFigure, UncountedItemsBanner,
  UNCOUNTED_MATERIAL_SHARE, UNCOUNTED_NAME_LIMIT,
} from './uncountedItems'

// S756 D6. An item with no closing count reads as fully consumed, so a summary page's FC% comes
// out high and would be painted as a verdict. These pin WHICH items are named and WHEN the verdict
// is withheld — both rules the owner set, and both silent if they drift.

const item = (id, rate = 10, extra = {}) => ({ id, name: `Item ${id}`, per_uom_rate: rate, ...extra })

describe('findUncountedItems — who is uncounted', () => {
  it('treats a closing row with physical_qty 0 as a COUNT, and no row as not counted', () => {
    const items = [item('a'), item('b')]
    // The caller builds countedIds from rows whose physical_qty is not null: a is counted-empty (0),
    // b has no row at all.
    const closing = [{ item_id: 'a', physical_qty: 0 }]
    const countedIds = new Set(closing.filter(r => r.physical_qty != null).map(r => r.item_id))
    const gap = findUncountedItems({ items, openingQty: { a: 5, b: 5 }, countedIds, cogs: 1000 })
    expect(gap.presentCount).toBe(2)
    expect(gap.uncounted.map(u => u.id)).toEqual(['b'])
  })

  it('treats a closing row with a NULL physical_qty as not counted', () => {
    const closing = [{ item_id: 'a', physical_qty: null }]
    const countedIds = new Set(closing.filter(r => r.physical_qty != null).map(r => r.item_id))
    const gap = findUncountedItems({ items: [item('a')], openingQty: { a: 1 }, countedIds, cogs: 100 })
    expect(gap.uncountedCount).toBe(1)
  })

  it('accepts a plain object map for countedIds', () => {
    const gap = findUncountedItems({ items: [item('a'), item('b')], openingQty: { a: 1, b: 1 }, countedIds: { a: 0 }, cogs: 100 })
    expect(gap.uncounted.map(u => u.id)).toEqual(['b'])
  })

  it('asks only about items with stock presence — opening or purchases', () => {
    const items = [item('open'), item('bought'), item('idle')]
    const gap = findUncountedItems({ items, openingQty: { open: 2 }, purchaseQty: { bought: 3 }, countedIds: new Set(), cogs: 100 })
    expect(gap.presentCount).toBe(2)
    expect(gap.uncounted.map(u => u.id).sort()).toEqual(['bought', 'open'])
  })

  it('ignores inactive items and sub-recipe mirrors whatever the caller loaded', () => {
    const items = [item('live'), item('off', 10, { is_active: false }), item('prep', 10, { is_sub_recipe: true })]
    const gap = findUncountedItems({ items, openingQty: { live: 1, off: 1, prep: 1 }, countedIds: new Set(), cogs: 100 })
    expect(gap.presentCount).toBe(1)
    expect(gap.uncounted.map(u => u.id)).toEqual(['live'])
  })

  it('values the gap at opening × rate plus what the purchases cost, largest first', () => {
    const items = [item('small', 1), item('big', 100)]
    const gap = findUncountedItems({
      items, openingQty: { small: 10, big: 1 }, purchaseQty: { big: 2 },
      purchaseValue: { big: 150 },   // net of a bill discount — not 2 × 100
      countedIds: new Set(), cogs: 10000,
    })
    expect(gap.uncounted.map(u => [u.id, u.value])).toEqual([['big', 250], ['small', 10]])
    expect(gap.uncountedValue).toBe(260)
  })

  it('falls back to qty × rate for purchases when no value is known', () => {
    const gap = findUncountedItems({ items: [item('a', 4)], purchaseQty: { a: 3 }, purchaseValue: {}, countedIds: new Set(), cogs: 100 })
    expect(gap.uncountedValue).toBe(12)
  })
})

describe('materiality — the owner rule', () => {
  it('is 5%', () => {
    expect(UNCOUNTED_MATERIAL_SHARE).toBe(0.05)
  })

  it('is material at ≥ 5% of the items with stock presence, even when their value is tiny', () => {
    expect(isMaterialGap({ presentCount: 100, uncountedCount: 5, uncountedValue: 1, cogs: 1e6 })).toBe(true)
    expect(isMaterialGap({ presentCount: 100, uncountedCount: 4, uncountedValue: 1, cogs: 1e6 })).toBe(false)
  })

  it('is material at ≥ 5% of COGS by value, even when it is one item', () => {
    expect(isMaterialGap({ presentCount: 1000, uncountedCount: 1, uncountedValue: 5000, cogs: 100000 })).toBe(true)
    expect(isMaterialGap({ presentCount: 1000, uncountedCount: 1, uncountedValue: 4999, cogs: 100000 })).toBe(false)
  })

  it('is never material with nothing uncounted', () => {
    expect(isMaterialGap({ presentCount: 0, uncountedCount: 0, uncountedValue: 0, cogs: 0 })).toBe(false)
    expect(findUncountedItems({ items: [item('a')], openingQty: { a: 1 }, countedIds: new Set(['a']), cogs: 0 }).material).toBe(false)
  })

  it('is material when COGS is zero or negative and anything of value is uncounted', () => {
    expect(isMaterialGap({ presentCount: 1000, uncountedCount: 1, uncountedValue: 10, cogs: 0 })).toBe(true)
    expect(isMaterialGap({ presentCount: 1000, uncountedCount: 1, uncountedValue: 10, cogs: -50 })).toBe(true)
  })

  it('is computed by findUncountedItems from the same figures', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, 1))
    const openingQty = Object.fromEntries(items.map(i => [i.id, 1]))
    const counted19 = new Set(items.slice(0, 19).map(i => i.id))
    // 1 of 20 = 5% of items → material.
    expect(findUncountedItems({ items, openingQty, countedIds: counted19, cogs: 1e6 }).material).toBe(true)
    const items40 = Array.from({ length: 40 }, (_, i) => item(`i${i}`, 1))
    const open40 = Object.fromEntries(items40.map(i => [i.id, 1]))
    const counted39 = new Set(items40.slice(0, 39).map(i => i.id))
    // 1 of 40 = 2.5% of items, NPR 1 of NPR 1,000,000 → not material.
    expect(findUncountedItems({ items: items40, openingQty: open40, countedIds: counted39, cogs: 1e6 }).material).toBe(false)
  })

  it('merges periods as item-months for a year total', () => {
    const jan = { presentCount: 100, uncountedCount: 10, uncountedValue: 100, cogs: 100000 }   // material by count
    const feb = { presentCount: 100, uncountedCount: 0, uncountedValue: 0, cogs: 100000 }
    const quiet = Array.from({ length: 10 }, () => feb)
    const merged = mergeGaps([jan, ...quiet])
    expect(merged.presentCount).toBe(1100)
    expect(merged.uncountedCount).toBe(10)
    expect(merged.material).toBe(false)   // 10 of 1,100 item-months, NPR 100 of 1.1M
    expect(mergeGaps([jan, feb]).material).toBe(true)   // 10 of 200 = 5%
  })
})

describe('wording', () => {
  const gap = findUncountedItems({
    items: Array.from({ length: 12 }, (_, i) => item(`i${i}`, 12 - i)),
    openingQty: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`i${i}`, 1])),
    countedIds: new Set(),
    cogs: 100,
  })

  it('names the count and the period in the headline', () => {
    expect(gapHeadline(gap, 'Bhadra 2083')).toBe('12 of 12 items have no closing count for Bhadra 2083 — food cost is overstated until they are counted')
  })

  it('carries every name into the export note, not only the first ten', () => {
    expect(UNCOUNTED_NAME_LIMIT).toBe(10)
    const note = gapNote(gap, 'Bhadra 2083')
    for (let i = 0; i < 12; i++) expect(note).toContain(`Item i${i}`)
    expect(note).toContain('not judged')
  })

  it('has nothing to say when nothing is uncounted', () => {
    const none = { presentCount: 3, uncountedCount: 0, uncounted: [] }
    expect(gapHeadline(none, 'x')).toBe('')
    expect(gapNote(none, 'x')).toBeNull()
  })

  it('banner names the first ten by value and folds the rest behind a disclosure', () => {
    const { renderToStaticMarkup } = require('react-dom/server')
    const view = renderToStaticMarkup(<UncountedItemsBanner gap={gap} scope="Bhadra 2083" />)
    expect(view).toContain('role="alert"')
    expect(view).toContain('12 of 12 items have no closing count for Bhadra 2083')
    expect(view).toMatch(/<summary[^>]*> and 2 more<\/summary>/)
    // i0 carries the highest rate, so it is named before the fold; i11 the lowest, so after it.
    expect(view.indexOf('Item i0')).toBeLessThan(view.indexOf('<details'))
    expect(view.indexOf('Item i11')).toBeGreaterThan(view.indexOf('<details'))
    expect(renderToStaticMarkup(<UncountedItemsBanner gap={{ uncountedCount: 0, uncounted: [] }} />)).toBe('')
  })

  it('renders an unjudged FC% with no mark and no signal colour', () => {
    const f = unjudgedFcFigure(41.26)
    expect(f.text).toBe('41.3%')
    expect(f.text).not.toMatch(/[✓△▲]/)
    expect(f.style.color).not.toMatch(/green|amber|red/)
    expect(f.title).toMatch(/Not judged/)
    expect(unjudgedFcFigure(null).text).toBe('—')
  })
})
