import { suiteAccess, SUITE_PAGES, SUITE_PAGE_BY_PATH } from './SuiteGate'
import { SUITE_KEYS } from '../context/AuthContext'

jest.mock('../supabaseClient', () => ({ supabase: {} }))

// S849 ACCESS-9/-11/-12: suiteAccess is the one answer the gate and every Suite page's loads give.
const owner = (over = {}) => ({
  isAdmin: false, isOwner: true, clientKnown: true,
  imsEnabled: true, hrEnabled: true, posEnabled: false, customizationEnabled: false,
  suitePlan: 'pro', hasFeature: () => false,
  ...over,
})

describe('suiteAccess', () => {
  it('the operator is always let through', () => {
    const a = suiteAccess({ isAdmin: true, clientKnown: false, imsEnabled: false, suitePlan: null }, SUITE_PAGES.ownerDashboard)
    expect(a).toMatchObject({ allowed: true, reason: 'ok' })
  })

  it("an outlet whose row did not load is 'unknown', never the sales pitch", () => {
    expect(suiteAccess(owner({ clientKnown: false, suitePlan: null }), SUITE_PAGES.ownerReport))
      .toMatchObject({ allowed: false, reason: 'unknown' })
  })

  it('a missing module is named before the plan is asked', () => {
    const a = suiteAccess(owner({ hrEnabled: false }), SUITE_PAGES.ownerDashboard)
    expect(a).toMatchObject({ allowed: false, reason: 'modules', missingModules: ['hr'] })
    // The other five need IMS only.
    expect(suiteAccess(owner({ hrEnabled: false }), SUITE_PAGES.ownerReport).allowed).toBe(true)
  })

  it('a live Suite opens the page', () => {
    expect(suiteAccess(owner(), SUITE_PAGES.consolidatedPnl)).toMatchObject({ allowed: true, reason: 'ok', overridden: false })
  })

  it("no Suite is 'plan'", () => {
    expect(suiteAccess(owner({ suitePlan: null }), SUITE_PAGES.fixedAssets)).toMatchObject({ allowed: false, reason: 'plan' })
  })

  it('a per-client override opens that page only', () => {
    const auth = owner({ suitePlan: null, hasFeature: k => k === 'demand_forecast' })
    expect(suiteAccess(auth, SUITE_PAGES.demandForecast)).toMatchObject({ allowed: true, overridden: true })
    expect(suiteAccess(auth, SUITE_PAGES.fixedAssets).allowed).toBe(false)
  })

  it('a Suite client with Crest IMS off is stopped at the module floor (suitePlan is already null there)', () => {
    expect(suiteAccess(owner({ imsEnabled: false, suitePlan: null }), SUITE_PAGES.ownerReport))
      .toMatchObject({ allowed: false, reason: 'modules', missingModules: ['ims'] })
  })

  it('a group page entitled by another outlet opens, but never past the module floor (ACCESS-7)', () => {
    expect(suiteAccess(owner({ suitePlan: null }), SUITE_PAGES.groupConsole, { entitled: true }).allowed).toBe(true)
    expect(suiteAccess(owner({ suitePlan: null, imsEnabled: false }), SUITE_PAGES.groupConsole, { entitled: true }).reason).toBe('modules')
    expect(suiteAccess(owner({ suitePlan: null }), SUITE_PAGES.groupConsole, { entitled: false }).allowed).toBe(false)
  })

  it('entitled may ride on the page object, as GroupDashboard passes it', () => {
    const page = { ...SUITE_PAGES.groupConsole, entitled: true }
    expect(suiteAccess(owner({ suitePlan: null }), page).allowed).toBe(true)
    // An empty or unloaded group list never locks an outlet that has Suite itself.
    expect(suiteAccess(owner(), { ...SUITE_PAGES.consolidatedPnl, entitled: false }).allowed).toBe(true)
  })

  it('a featureKey string gives the same answer as the SUITE_PAGES entry', () => {
    const auth = owner({ suitePlan: null, hasFeature: k => k === 'demand_forecast' })
    expect(suiteAccess(auth, { featureKey: 'demand_forecast', requireModules: ['ims'] }))
      .toEqual(suiteAccess(auth, SUITE_PAGES.demandForecast))
  })

  it('an auth value with no clientKnown (an older provider) is treated as known', () => {
    const { clientKnown, ...rest } = owner()
    expect(suiteAccess(rest, SUITE_PAGES.ownerReport).allowed).toBe(true)
  })
})

describe('SUITE_PAGES', () => {
  it('covers exactly the six Suite feature keys', () => {
    expect(Object.values(SUITE_PAGES).map(p => p.featureKey).sort()).toEqual([...SUITE_KEYS].sort())
  })

  it('maps each Suite route to its page', () => {
    expect(Object.keys(SUITE_PAGE_BY_PATH)).toHaveLength(6)
    expect(SUITE_PAGE_BY_PATH['/owner-dashboard']).toBe(SUITE_PAGES.ownerDashboard)
    expect(SUITE_PAGE_BY_PATH['/fixed-assets']).toBe(SUITE_PAGES.fixedAssets)
  })

  it('only the Owner Dashboard needs Crest HR', () => {
    for (const [key, page] of Object.entries(SUITE_PAGES)) {
      expect(page.requireModules.includes('hr')).toBe(key === 'ownerDashboard')
      expect(page.requireModules.includes('ims')).toBe(true)
    }
  })
})
