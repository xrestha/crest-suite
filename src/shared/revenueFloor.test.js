import { hasRevenue, REVENUE_FLOOR } from './revenueFloor'

describe('hasRevenue: a float residue is not revenue (S887)', () => {
  test('the floor is one paisa', () => {
    expect(REVENUE_FLOOR).toBe(0.01)
  })

  test('a month whose bills were all credited back is no revenue', () => {
    // Bills and their credit notes summed in floating point land near 0, on either side of it.
    const residue = [1130.1, 2260.2, -1130.1, -2260.2].reduce((s, v) => s + v, 0)
    expect(hasRevenue(5.2e-13)).toBe(false)
    expect(hasRevenue(residue)).toBe(false)
  })

  test('nothing, zero and a negative are no revenue', () => {
    expect(hasRevenue(null)).toBe(false)
    expect(hasRevenue(undefined)).toBe(false)
    expect(hasRevenue(NaN)).toBe(false)
    expect(hasRevenue(0)).toBe(false)
    expect(hasRevenue(-500)).toBe(false)
    expect(hasRevenue(0.009)).toBe(false)
  })

  test('one paisa and up is revenue', () => {
    expect(hasRevenue(0.01)).toBe(true)
    expect(hasRevenue(1)).toBe(true)
    expect(hasRevenue(1250000)).toBe(true)
  })
})
