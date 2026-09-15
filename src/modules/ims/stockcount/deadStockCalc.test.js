import {
  judgeItemPeriod, stillStreak, classifyItem, suggestNextStep,
  DEAD_AFTER_MONTHS, RECENT_PURCHASE_DAYS,
} from './deadStockCalc'

// S756 (D20) — Dead only after 3 consecutive still months; uncounted months break the streak.
const still = { state: 'judged', available: 10, used: 0, closing: 10 }
const moving = { state: 'judged', available: 10, used: 6, closing: 4 }
const slowMoving = { state: 'judged', available: 10, used: 1, closing: 9 }
const uncounted = { state: 'uncounted', available: 10 }
const hist = (...judgements) => judgements.map((judgement, i) => ({ monthIndex: 100 - i, judgement }))

describe('judgeItemPeriod', () => {
  test('no count is not judged; a count of 0 is', () => {
    expect(judgeItemPeriod({ opening: 5, hasCount: false }).state).toBe('uncounted')
    expect(judgeItemPeriod({ opening: 5, hasCount: true, closing: 0 })).toMatchObject({ state: 'judged', used: 5 })
  })

  test('nothing available and nothing counted is absent, not Dead worth NPR 0', () => {
    expect(judgeItemPeriod({ hasCount: false }).state).toBe('absent')
    expect(judgeItemPeriod({ hasCount: true, closing: 0 }).state).toBe('absent')
  })

  test('counted higher than available is inconsistent, never "no movement"', () => {
    expect(judgeItemPeriod({ opening: 2, hasCount: true, closing: 5 }).state).toBe('inconsistent')
  })

  test('float residue reads as exactly 0 used', () => {
    expect(judgeItemPeriod({ opening: 0.7, purchased: 0.1, hasCount: true, closing: 0.8 })).toMatchObject({ state: 'judged', used: 0 })
  })

  test('staff meals are consumption', () => {
    expect(judgeItemPeriod({ opening: 5, staffUsed: 2, hasCount: true, closing: 3 }).used).toBe(0)
  })
})

describe('stillStreak', () => {
  test('counts consecutive still months from the newest', () => {
    expect(stillStreak(hist(still, still, still, moving))).toBe(3)
  })

  test('an uncounted month breaks the streak rather than counting as zero', () => {
    expect(stillStreak(hist(still, uncounted, still, still))).toBe(1)
  })

  test('a gap in the calendar breaks the streak', () => {
    const h = [{ monthIndex: 100, judgement: still }, { monthIndex: 98, judgement: still }, { monthIndex: 97, judgement: still }]
    expect(stillStreak(h)).toBe(1)
  })

  test('a month with no stock ends it too', () => {
    expect(stillStreak(hist(still, { state: 'absent', available: 0 }, still))).toBe(1)
  })
})

describe('classifyItem', () => {
  test(`Dead only after ${DEAD_AFTER_MONTHS} consecutive still months`, () => {
    expect(classifyItem(hist(still, still, still))).toMatchObject({ status: 'Dead', stillMonths: 3 })
    expect(classifyItem(hist(still, still, still, still, moving))).toMatchObject({ status: 'Dead', stillMonths: 4, atLeast: false })
  })

  test('still for only 1-2 months is Slow, not Dead', () => {
    expect(classifyItem(hist(still, moving))).toMatchObject({ status: 'Slow', stillMonths: 1 })
    expect(classifyItem(hist(still, still, uncounted))).toMatchObject({ status: 'Slow', stillMonths: 2 })
  })

  test('the old Slow meaning survives: used under 20% of what was available', () => {
    expect(classifyItem(hist(slowMoving, still, still))).toMatchObject({ status: 'Slow', stillMonths: 0 })
  })

  test('moving normally is no verdict', () => {
    expect(classifyItem(hist(moving, still, still, still))).toMatchObject({ status: null })
  })

  test('the newest month must be judged, or there is no verdict at all', () => {
    expect(classifyItem(hist(uncounted, still, still, still)).status).toBeNull()
    expect(classifyItem([]).status).toBeNull()
  })

  test('a streak reaching the oldest month read is flagged as "at least"', () => {
    expect(classifyItem(hist(still, still, still))).toMatchObject({ atLeast: true })
  })
})

describe('suggestNextStep', () => {
  const asOf = new Date(2026, 8, 15, 12)
  const daysAgo = n => new Date(2026, 8, 15 - n)

  test('no verdict, no suggestion', () => {
    expect(suggestNextStep({ status: null, asOf })).toBeNull()
  })

  test('past expiry → write off, even when recently bought', () => {
    const s = suggestNextStep({ status: 'Slow', stillMonths: 1, lastPurchase: { date: daysAgo(5), vendorName: 'Bhatbhateni', expiryDate: '2026-09-10' }, asOf })
    expect(s.key).toBe('write_off')
  })

  test('held more than 3 months → write off', () => {
    expect(suggestNextStep({ status: 'Dead', stillMonths: 4, asOf }).key).toBe('write_off')
    expect(suggestNextStep({ status: 'Dead', stillMonths: 3, asOf }).key).toBe('special')
  })

  test('still and bought recently → ask that supplier to take it back, by name', () => {
    const s = suggestNextStep({ status: 'Dead', stillMonths: 3, lastPurchase: { date: daysAgo(20), vendorName: 'Himalayan Dairy' }, asOf })
    expect(s).toEqual({ key: 'return', text: 'Ask Himalayan Dairy to take it back — bought 20 days ago.' })
  })

  test('no supplier on the bill → "Return to supplier"', () => {
    const s = suggestNextStep({ status: 'Slow', stillMonths: 2, lastPurchase: { date: daysAgo(10) }, asOf })
    expect(s.text).toBe('Return to supplier — it was bought recently.')
  })

  test(`a purchase older than ${RECENT_PURCHASE_DAYS} days is not returnable → special`, () => {
    const s = suggestNextStep({ status: 'Dead', stillMonths: 3, lastPurchase: { date: daysAgo(RECENT_PURCHASE_DAYS + 1), vendorName: 'X' }, asOf })
    expect(s.key).toBe('special')
  })

  test('moving slowly but bought recently → buy less next time', () => {
    const s = suggestNextStep({ status: 'Slow', stillMonths: 0, lastPurchase: { date: daysAgo(3), vendorName: 'X' }, asOf })
    expect(s.key).toBe('buy_less')
  })

  test('otherwise → put it on the menu as a special', () => {
    expect(suggestNextStep({ status: 'Slow', stillMonths: 0, lastPurchase: null, asOf }).key).toBe('special')
  })
})
