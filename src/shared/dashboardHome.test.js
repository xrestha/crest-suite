import { dashboardModules, isOverviewHome } from './dashboardHome'

const access = (ranks) => ({
  hasImsAccess: () => !!ranks.ims,
  hasHrAccess: () => !!ranks.hr,
  hasPosAccess: () => !!ranks.pos,
})

describe('dashboardModules / isOverviewHome (S800)', () => {
  test('a module counts only when the client has it AND this login holds a rank in it', () => {
    const m = dashboardModules({ clientModules: { ims: true, hr: true, pos: false }, ...access({ ims: true, hr: false, pos: true }) })
    expect(m).toEqual({ ims: true, hr: false, pos: false })
  })

  test('two or more modules make /dashboard a Home; one keeps it the module\'s own dashboard', () => {
    expect(isOverviewHome({ ims: true, hr: true, pos: false })).toBe(true)
    expect(isOverviewHome({ ims: true, hr: true, pos: true })).toBe(true)
    expect(isOverviewHome({ ims: true, hr: false, pos: false })).toBe(false)
    expect(isOverviewHome({ ims: false, hr: false, pos: true })).toBe(false)
  })

  test('an Owner of IMS + POS gets a Home; that client\'s POS-only waiter does not', () => {
    const clientModules = { ims: true, hr: false, pos: true }
    expect(isOverviewHome(dashboardModules({ clientModules, ...access({ ims: true, pos: true }) }))).toBe(true)
    expect(isOverviewHome(dashboardModules({ clientModules, ...access({ pos: true }) }))).toBe(false)
  })

  test('a missing clientModules reads as no modules, never a crash', () => {
    expect(dashboardModules({ clientModules: null, ...access({ ims: true, hr: true, pos: true }) }))
      .toEqual({ ims: false, hr: false, pos: false })
  })
})
