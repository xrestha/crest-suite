import { posPathReachable, isStationTeam, KITCHEN_TEAM_ALLOWED_PATHS, STATION_TEAM_HOME } from './posTeamAccess'

describe('posTeamAccess', () => {
  test('kitchen and bar are station teams; foh, null and undefined are not', () => {
    expect(isStationTeam('kitchen')).toBe(true)
    expect(isStationTeam('bar')).toBe(true)
    expect(isStationTeam('foh')).toBe(false)
    expect(isStationTeam(null)).toBe(false)
    expect(isStationTeam(undefined)).toBe(false)
  })

  test('a station team reaches the allowlist and nothing else — including the till and the drawer', () => {
    for (const team of ['kitchen', 'bar']) {
      expect(posPathReachable(team, '/pos/kds')).toBe(true)
      expect(posPathReachable(team, '/pos/orders')).toBe(false)
      expect(posPathReachable(team, '/pos/shifts')).toBe(false)
      expect(posPathReachable(team, '/pos')).toBe(false)
      expect(posPathReachable(team, '/menu-pricing')).toBe(false)
    }
  })

  test('fail-closed: a POS page that does not exist yet is unreachable to a station team', () => {
    expect(posPathReachable('kitchen', '/pos/some-future-page')).toBe(false)
  })

  test('front-of-house and unset teams reach everything', () => {
    expect(posPathReachable('foh', '/pos/shifts')).toBe(true)
    expect(posPathReachable(undefined, '/pos/orders')).toBe(true)
  })

  test('the station home is itself reachable, or the redirect would loop', () => {
    expect(KITCHEN_TEAM_ALLOWED_PATHS).toContain(STATION_TEAM_HOME)
  })
})
