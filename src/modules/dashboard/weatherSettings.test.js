import { cityPatch, canEditWeatherCity, weatherEntitled, WEATHER_CITY_FIELDS } from './weatherSettings'

describe('cityPatch', () => {
  test('writes the three location columns together, from the city list', () => {
    expect(cityPatch('kathmandu')).toEqual({ weather_city: 'kathmandu', weather_lat: 27.72, weather_lon: 85.32 })
    expect(Object.keys(cityPatch('pokhara')).sort()).toEqual([...WEATHER_CITY_FIELDS].sort())
  })
  test('blank or unknown clears all three: no city, no weather', () => {
    expect(cityPatch('')).toEqual({ weather_city: null, weather_lat: null, weather_lon: null })
    expect(cityPatch('atlantis')).toEqual({ weather_city: null, weather_lat: null, weather_lon: null })
  })
  test('never touches the Owner\'s rainy-day figure', () => {
    expect(cityPatch('kathmandu')).not.toHaveProperty('rain_sales_pct')
  })
})

// The browser's copy of settings_guard_staff_roles' weather_city_rank (20260923130000, effective
// ranks since S829's 20261013150000).
describe('canEditWeatherCity', () => {
  const who = (profile, extra = {}) => canEditWeatherCity({ isAdmin: false, isOwner: false, profile, ...extra })

  test('the Owner and admin may', () => {
    expect(canEditWeatherCity({ isAdmin: true, isOwner: false, profile: null })).toBe(true)
    expect(canEditWeatherCity({ isAdmin: false, isOwner: true, profile: {} })).toBe(true)
  })
  test('a manager of any module may', () => {
    expect(who({ pos_role: 'manager' })).toBe(true)
    expect(who({ hr_role: 'manager' })).toBe(true)
    expect(who({ ims_role: 'manager', ims_email: null })).toBe(true)
  })
  test('an IMS count PIN is never a manager, and staff or supervisor rank may not', () => {
    expect(who({ ims_role: 'manager', ims_email: 'count-pin@x' })).toBe(false)
    expect(who({ pos_role: 'supervisor', hr_role: 'staff' })).toBe(false)
    expect(who({ pos_role: 'staff' })).toBe(false)
    expect(who({})).toBe(false)
    expect(who(null)).toBe(false)
  })
  // S834: the guard's effective ranks since S829 (20261013150000).
  test('a settled login holds no manager rank on any axis', () => {
    const settled = { settlement_blocked_by: 'owner-id' }
    expect(who({ ...settled, pos_role: 'manager' })).toBe(false)
    expect(who({ ...settled, hr_role: 'manager' })).toBe(false)
    expect(who({ ...settled, ims_role: 'manager', ims_email: null })).toBe(false)
    expect(who({ ...settled, pos_role: 'manager', ims_role: 'manager', hr_role: 'manager' })).toBe(false)
  })
  test('a POS-blocked login loses only its POS rank', () => {
    const blocked = { pos_blocked_at: '2026-10-10T08:00:00Z' }
    expect(who({ ...blocked, pos_role: 'manager' })).toBe(false)
    expect(who({ ...blocked, pos_role: 'manager', hr_role: 'manager' })).toBe(true)
    expect(who({ ...blocked, pos_role: 'manager', ims_role: 'manager', ims_email: null })).toBe(true)
  })
  test('cleared blocks (NULL) leave the rank as it was', () => {
    expect(who({ pos_role: 'manager', settlement_blocked_by: null, pos_blocked_at: null })).toBe(true)
  })
  test('the Owner and admin are exempt whatever the profile row says, as in the guard', () => {
    expect(canEditWeatherCity({ isAdmin: false, isOwner: true, profile: { settlement_blocked_by: 'x' } })).toBe(true)
  })
})

describe('weatherEntitled', () => {
  test('comes with POS and with HR, flat, whatever the IMS plan', () => {
    expect(weatherEntitled({ growthWeather: false, posEnabled: true, hrEnabled: false })).toBe(true)
    expect(weatherEntitled({ growthWeather: false, posEnabled: false, hrEnabled: true })).toBe(true)
  })
  test('with IMS it needs the Growth key, as before', () => {
    expect(weatherEntitled({ growthWeather: true, posEnabled: false, hrEnabled: false })).toBe(true)
    expect(weatherEntitled({ growthWeather: false, posEnabled: false, hrEnabled: false })).toBe(false)
  })
})
