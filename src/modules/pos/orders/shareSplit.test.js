// S836: the equal split's shares. Whole rupees when the bill is, leftovers on the first slips, and
// always adding back to the total to the paisa.
import { equalShares, MIN_SHARES, MAX_SHARES } from './shareSplit'

const paisaOf = shares => Math.round(shares.reduce((s, x) => s + x, 0) * 100)

describe('equalShares', () => {
  test('3,542 three ways puts the two leftover rupees on the first two slips', () => {
    expect(equalShares(3542, 3)).toEqual([1181, 1181, 1180])
  })

  test('an even split has no leftover', () => {
    expect(equalShares(3000, 4)).toEqual([750, 750, 750, 750])
  })

  test('a whole-rupee bill always splits into whole rupees', () => {
    for (const [total, n] of [[3542, 3], [1001, 7], [99, 20], [1172, 2], [10, 3]]) {
      const shares = equalShares(total, n)
      expect(shares.every(Number.isInteger)).toBe(true)
      expect(paisaOf(shares)).toBe(total * 100)
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
    }
  })

  test('a total with paisa is split in paisa, the leftover paisa on the first slips', () => {
    expect(equalShares(3542.5, 3)).toEqual([1180.84, 1180.83, 1180.83])
    expect(equalShares(100.01, 2)).toEqual([50.01, 50])
    expect(paisaOf(equalShares(3542.5, 3))).toBe(354250)
  })

  test('the shares add back to the total exactly, counted in paisa', () => {
    for (const total of [0.01, 1, 12.34, 999.99, 1172.48, 125000.07]) {
      for (let n = MIN_SHARES; n <= MAX_SHARES; n++) {
        const shares = equalShares(total, n)
        expect(shares).toHaveLength(n)
        expect(paisaOf(shares)).toBe(Math.round(total * 100))
        // Largest first, never more than one unit apart.
        expect([...shares].sort((a, b) => b - a)).toEqual(shares)
      }
    }
  })

  test('a total finer than the paisa is taken to the paisa first', () => {
    expect(paisaOf(equalShares(1172.4779, 2))).toBe(117248)
  })

  test('a bill of 0 splits into shares of 0', () => {
    expect(equalShares(0, 3)).toEqual([0, 0, 0])
    expect(Object.is(equalShares(-0, 2)[0], 0)).toBe(true)
  })

  test('refuses a count outside 2 to 20, or not a whole number', () => {
    for (const n of [0, 1, 21, 2.5, NaN, Infinity, '3', null, undefined]) {
      expect(equalShares(3542, n)).toEqual([])
    }
    expect(equalShares(3542, 2)).toHaveLength(2)
    expect(equalShares(3542, 20)).toHaveLength(20)
  })

  test('refuses a total that is negative or not a number', () => {
    for (const total of [-1, -0.01, NaN, Infinity, '3542', null, undefined, {}]) {
      expect(equalShares(total, 3)).toEqual([])
    }
  })
})
