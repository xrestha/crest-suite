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

// The browser's copy of settings_guard_staff_roles' weather_city_rank (20260923130000).
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
