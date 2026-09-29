// The Item Master VAT-basis review (S792, owner decision D32). Pure arithmetic behind
// VatCostPriceBanner: which items to list, which way their price moves, and the D5 sentence.
import {
  samePrice, latestPricedLines, vatCostPriceReview, reviewImpactSentence, reviewSignature,
} from './vatCostPriceReview'

const rank = new Map([['p1', 208204], ['p2', 208205]])   // p2 is the later month

describe('latestPricedLines', () => {
  test('takes the latest month, then day, then entry; skips free lines', () => {
    const lines = [
      { id: 'a', item_id: 'oil', rate: 10, period_id: 'p2', bs_day: 3 },
      { id: 'b', item_id: 'oil', rate: 12, period_id: 'p1', bs_day: 30 },
      { id: 'c', item_id: 'oil', rate: 11, period_id: 'p2', bs_day: 9 },
      { id: 'd', item_id: 'oil', rate: 0, period_id: 'p2', bs_day: 20 },   // a gift, not a price
    ]
    expect(latestPricedLines(lines, rank).get('oil').id).toBe('c')
  })
})

describe('vatCostPriceReview', () => {
  const items = [
    { id: 'oil', name: 'Oil', uom: 'ML', per_uom_rate: 0.3 },
    { id: 'rice', name: 'Rice', uom: 'GM', per_uom_rate: 0.1 },
    { id: 'milk', name: 'Milk', uom: 'ML', per_uom_rate: 0.113 },
    { id: 'salt', name: 'Salt', uom: 'GM', per_uom_rate: 0.02, is_active: false },
  ]
  const lines = [
    { id: '1', item_id: 'oil', rate: 0.3, vat_inclusive: true, vat_is_cost: true, period_id: 'p2', bs_day: 1 },
    { id: '2', item_id: 'rice', rate: 0.1, vat_inclusive: false, vat_is_cost: true, period_id: 'p2', bs_day: 1 },
    { id: '3', item_id: 'milk', rate: 0.1, vat_inclusive: true, vat_is_cost: false, period_id: 'p2', bs_day: 1 },
    { id: '4', item_id: 'salt', rate: 0.02, vat_inclusive: true, vat_is_cost: true, period_id: 'p2', bs_day: 1 },
  ]

  test('PAN outlet: an item still at its VAT bill\'s ex-VAT rate is offered rate × 1.13', () => {
    const rows = vatCostPriceReview({ items, lines, periodRank: rank, mode: 'pan' })
    expect(rows.map(r => r.id)).toEqual(['oil'])        // rice: non-VAT line; salt: hidden
    expect(rows[0].direction).toBe('add')
    expect(rows[0].suggestedRate).toBeCloseTo(0.339, 9)
  })

  test('PAN outlet: an item already at the paid price is not listed', () => {
    const paid = items.map(i => (i.id === 'oil' ? { ...i, per_uom_rate: 0.339 } : i))
    expect(vatCostPriceReview({ items: paid, lines, periodRank: rank, mode: 'pan' })).toEqual([])
  })

  test('VAT-registered outlet (reverse): an item still carrying the 13% over an ex-VAT bill is offered the bill rate', () => {
    const rows = vatCostPriceReview({ items, lines, periodRank: rank, mode: 'vat' })
    expect(rows.map(r => r.id)).toEqual(['milk'])
    expect(rows[0].direction).toBe('remove')
    expect(rows[0].suggestedRate).toBeCloseTo(0.1, 9)
  })

  test('unknown VAT status lists nothing', () => {
    expect(vatCostPriceReview({ items, lines, periodRank: rank, mode: null })).toEqual([])
  })

  test('only the LATEST line decides: an older VAT-cost bill under a newer one is not a reason', () => {
    const later = [...lines, { id: '5', item_id: 'oil', rate: 0.3, vat_inclusive: false, vat_is_cost: true, period_id: 'p2', bs_day: 5 }]
    expect(vatCostPriceReview({ items, lines: later, periodRank: rank, mode: 'pan' })).toEqual([])
  })

  test('samePrice allows the 6-decimal rounding and nothing more', () => {
    expect(samePrice(0.339, 0.3 * 1.13)).toBe(true)
    expect(samePrice(0.34, 0.339)).toBe(false)
  })
})

describe('reviewImpactSentence', () => {
  test('one item speaks in priceImpactSentence\'s own words', () => {
    expect(reviewImpactSentence({ a: { CS: 2 } }, ['a'])).toMatch(/^This item's 2 stock counts are valued/)
  })
  test('several items sum their records', () => {
    expect(reviewImpactSentence({ a: { CS: 2 }, b: { CS: 1, W: 3 } }, ['a', 'b'])).toMatch(/3 stock counts and 3 wastage entries are valued/)
  })
  test('a failed count says it could not count, never "nothing changes"', () => {
    expect(reviewImpactSentence(null, ['a', 'b'], { complete: false })).toMatch(/could not count/)
    expect(reviewImpactSentence({}, ['a', 'b'])).toBeNull()
  })
  test('the signature changes when the list does', () => {
    expect(reviewSignature([{ id: 'b', direction: 'add' }, { id: 'a', direction: 'add' }])).toBe('a:add,b:add')
  })
})
