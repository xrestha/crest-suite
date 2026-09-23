import { NEPAL_CITIES, NEPAL_BOX, cityByKey } from './nepalCities'

describe('nepalCities', () => {
  test('every city sits inside the box the settings CHECK enforces', () => {
    NEPAL_CITIES.forEach(c => {
      expect(c.lat).toBeGreaterThanOrEqual(NEPAL_BOX.latMin)
      expect(c.lat).toBeLessThanOrEqual(NEPAL_BOX.latMax)
      expect(c.lon).toBeGreaterThanOrEqual(NEPAL_BOX.lonMin)
      expect(c.lon).toBeLessThanOrEqual(NEPAL_BOX.lonMax)
    })
  })

  test('coordinates have at most two decimals, the column precision', () => {
    NEPAL_CITIES.forEach(c => {
      expect(Math.round(c.lat * 100) / 100).toBe(c.lat)
      expect(Math.round(c.lon * 100) / 100).toBe(c.lon)
    })
  })

  test('keys are unique and resolve', () => {
    const keys = NEPAL_CITIES.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(cityByKey('pokhara').name).toBe('Pokhara')
    expect(cityByKey('nowhere')).toBeNull()
  })
})
