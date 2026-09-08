import { resolvePricing, annualOf, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_ADDON, DEFAULT_PLAN_PRICES } from './pricingPlans'

// resolvePricing is what stands between the admin's Settings > Plan Pricing figures and every
// screen that prints money — the public pricing page, Help's Plan & Pricing tab, the admin's own
// module picker. Before it existed those three imported the constants directly, so a price change
// moved the internal MRR estimate and nothing a customer could see (S701). Each case below is a
// property that fix depends on.

const tierOf = (p, key) => p.imsTiers.find(t => t.key === key)

describe('no override', () => {
  it('returns the shipped prices unchanged', () => {
    const p = resolvePricing(null)
    expect(tierOf(p, 'growth').monthly).toBe(IMS_TIERS[1].monthly)
    expect(p.hr.monthly).toBe(HR_PRICING.monthly)
    expect(p.pos.monthly).toBe(POS_PRICING.monthly)
    expect(p.suite.monthly).toBe(SUITE_ADDON.monthly)
  })

  it('keeps the features and labels each card renders', () => {
    const p = resolvePricing({ hr: 4000 })
    expect(p.hr.features).toEqual(HR_PRICING.features)
    expect(tierOf(p, 'pro').includesLabel).toBe(IMS_TIERS[2].includesLabel)
    expect(p.suite.label).toBe(SUITE_ADDON.label)
  })

  it('resolves the shipped defaults to exactly what DEFAULT_PLAN_PRICES says', () => {
    const p = resolvePricing(DEFAULT_PLAN_PRICES)
    expect(p.hr.monthly).toBe(HR_PRICING.monthly)
    expect(p.suite.monthly).toBe(SUITE_ADDON.monthly)
  })
})

describe('an override', () => {
  it('replaces the monthly price it names', () => {
    const p = resolvePricing({ hr: 2400, pos: 2100 })
    expect(p.hr.monthly).toBe(2400)
    expect(p.pos.monthly).toBe(2100)
  })

  it('re-derives annual from the new monthly rather than leaving the published pair', () => {
    const p = resolvePricing({ hr: 2400 })
    expect(p.hr.annual).toBe(annualOf(2400))
    expect(p.hr.annual).toBe(1800)
  })

  it('applies per IMS tier', () => {
    const p = resolvePricing({ ims: { growth: 3000 } })
    expect(tierOf(p, 'growth').monthly).toBe(3000)
    // The half-filled table is the realistic one — a row written before a price existed carries
    // some keys and not others, and an all-or-nothing fallback would revert the ones it does carry.
    expect(tierOf(p, 'starter').monthly).toBe(IMS_TIERS[0].monthly)
    expect(tierOf(p, 'pro').monthly).toBe(IMS_TIERS[2].monthly)
  })

  it('prices the Suite add-on, which used to be un-repriceable', () => {
    const p = resolvePricing({ suite: 3000 })
    expect(p.suite.monthly).toBe(3000)
    expect(p.suite.annual).toBe(2250)
  })
})

describe('values that are not prices', () => {
  // 0 is a real configuration (clientMrr.js lists a zero-priced live module rather than dropping
  // it), so the test is "is this a number" — `|| fallback` would quietly restore 2,600 over it.
  it('keeps a deliberate 0', () => {
    const p = resolvePricing({ hr: 0, ims: { starter: 0 } })
    expect(p.hr.monthly).toBe(0)
    expect(p.hr.annual).toBe(0)
    expect(tierOf(p, 'starter').monthly).toBe(0)
  })

  it('ignores null, undefined and a string the way a missing key is ignored', () => {
    const p = resolvePricing({ hr: null, pos: undefined, suite: '3000' })
    expect(p.hr.monthly).toBe(HR_PRICING.monthly)
    expect(p.pos.monthly).toBe(POS_PRICING.monthly)
    expect(p.suite.monthly).toBe(SUITE_ADDON.monthly)
  })

  // The column's own DB default predates the current shape (it is a flat starter/growth/pro
  // object with no `ims` key at all), so an untouched row must resolve to the shipped prices
  // rather than to undefined.
  it('survives a legacy-shaped table', () => {
    const p = resolvePricing({ starter: 5000, growth: 8000, pro: 12000 })
    expect(tierOf(p, 'growth').monthly).toBe(IMS_TIERS[1].monthly)
    expect(p.hr.monthly).toBe(HR_PRICING.monthly)
  })
})

describe('annualOf', () => {
  it('is 25% off, rounded — the one definition every screen shares', () => {
    expect(annualOf(2000)).toBe(1500)
    expect(annualOf(2600)).toBe(1950)
    expect(annualOf(3500)).toBe(2625)
    expect(annualOf(2100)).toBe(1575)
  })

  it('treats a missing price as 0 instead of returning NaN', () => {
    expect(annualOf(undefined)).toBe(0)
    expect(annualOf(null)).toBe(0)
  })

  // Every `annual` field written out in this file must already BE that derivation, or the constant
  // and the resolver would disagree the moment an admin touched one price and not another.
  it('matches every published annual figure in the file', () => {
    IMS_TIERS.forEach(t => expect(t.annual).toBe(annualOf(t.monthly)))
    expect(HR_PRICING.annual).toBe(annualOf(HR_PRICING.monthly))
    expect(POS_PRICING.annual).toBe(annualOf(POS_PRICING.monthly))
    expect(SUITE_ADDON.annual).toBe(annualOf(SUITE_ADDON.monthly))
  })
})
