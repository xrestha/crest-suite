import { FEATURE_TIER } from '../../shared/featureCatalog'
import { SUITE_KEYS, planHasFeature } from '../../context/AuthContext'
import { IMS_FEATURES, SUITE_FEATURES } from '../Help'
import { TIER_META, groupImsFeatures, tierOfEntry } from './helpFeatureTiers'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

// S849 DOCS-1: Help's Module Guide files each IMS page under the plan featureCatalog.js sells it in,
// and the six Crest Suite Pro pages in their own block. Until then every entry was filed by hand, and
// by S848 seven IMS pages sat under the wrong plan and the six Suite pages under IMS plans.

const PLANS = ['starter', 'growth', 'pro']

describe('IMS entries take their tier from the catalog', () => {
  it('every entry names its featureKey (null for a page every plan has)', () => {
    const missing = IMS_FEATURES.filter(e => !('featureKey' in e)).map(e => e.name)
    expect(missing).toEqual([])
  })

  it('a non-null featureKey is a real IMS plan feature', () => {
    const bad = IMS_FEATURES
      .filter(e => e.featureKey != null && !PLANS.includes(FEATURE_TIER[e.featureKey]))
      .map(e => `${e.name}: ${e.featureKey}`)
    expect(bad).toEqual([])
  })

  it('each band holds exactly the entries whose catalog tier it is', () => {
    const bands = groupImsFeatures(IMS_FEATURES)
    for (const band of bands) {
      for (const e of band.features) expect(FEATURE_TIER[e.featureKey] ?? 'core').toBe(band.tier)
    }
    expect(bands.reduce((n, b) => n + b.features.length, 0)).toBe(IMS_FEATURES.length)
    expect(bands.map(b => b.tier)).toEqual(TIER_META.map(m => m.tier).filter(t => bands.some(b => b.tier === t)))
  })

  it('files the pages S848 found misplaced under the plan that unlocks them', () => {
    const tierOf = name => tierOfEntry(IMS_FEATURES.find(e => e.name === name))
    expect(tierOf('Assigned Stock Counting')).toBe('growth')
    expect(tierOf('Stock Report')).toBe('growth')
    expect(tierOf('Reorder Report')).toBe('growth')
    expect(tierOf('Stock Movements')).toBe('growth')
    expect(tierOf('Overheads')).toBe('growth')
    expect(tierOf('Outstanding Payables')).toBe('starter')
    expect(tierOf('Vendor Balance Confirmation')).toBe('starter')
    expect(tierOf('Stock Transfers')).toBe('starter')
  })
})

describe('the catalog agrees with AuthContext', () => {
  it('a feature is on at its own tier and off one tier below', () => {
    const wrong = []
    for (const [key, tier] of Object.entries(FEATURE_TIER)) {
      const i = PLANS.indexOf(tier)
      if (i < 0) continue // POS features unlock with the module, not a plan
      if (!planHasFeature(key, { plan: tier, flags: {} })) wrong.push(`${key} off at ${tier}`)
      if (i > 0 && planHasFeature(key, { plan: PLANS[i - 1], flags: {} })) wrong.push(`${key} on at ${PLANS[i - 1]}`)
    }
    expect(wrong).toEqual([])
  })
})

describe('Crest Suite Pro pages', () => {
  it('no Suite key sits in an IMS entry', () => {
    expect(IMS_FEATURES.filter(e => SUITE_KEYS.has(e.featureKey)).map(e => e.name)).toEqual([])
  })

  it('every Suite key has exactly one Suite entry, and nothing else is there', () => {
    const keys = SUITE_FEATURES.map(e => e.featureKey)
    expect([...keys].sort()).toEqual([...SUITE_KEYS].sort())
    expect(new Set(keys).size).toBe(keys.length)
  })
})
