import { loyaltyPoints, pointsValue, maxRedeemablePoints } from './loyaltyPoints'

// These encode the same boundaries award_loyalty_points() enforces in SQL. The till renders a
// preview from this module and the ledger is written by that function, so a divergence would show
// up to a diner as a promised number the receipt then contradicts.

const scheme = (points_per_100, min_spend_to_earn = 0) => ({ points_per_100, min_spend_to_earn })

describe('loyaltyPoints', () => {
  test('an untagged customer earns nothing, whatever they spend', () => {
    // The opt-in rule. This is the branch that stops loyalty switching itself on for an entire
    // existing customer book the moment the feature ships.
    expect(loyaltyPoints(10000, null)).toBe(0)
    expect(loyaltyPoints(10000, undefined)).toBe(0)
  })

  test('earns at the scheme rate per NPR 100', () => {
    expect(loyaltyPoints(1000, scheme(1))).toBe(10)
    expect(loyaltyPoints(1000, scheme(2))).toBe(20)
    expect(loyaltyPoints(1000, scheme(0.5))).toBe(5)
  })

  test('rounds DOWN — a bill never earns a point it has not fully paid for', () => {
    // 1990 at 1/100 is 19.9. Rounding up would make the preview optimistic on most real bills,
    // and would disagree with the SQL's floor().
    expect(loyaltyPoints(1990, scheme(1))).toBe(19)
    expect(loyaltyPoints(99, scheme(1))).toBe(0)
  })

  test('below the minimum spend earns nothing — the threshold qualifies, it does not deduct', () => {
    expect(loyaltyPoints(499, scheme(1, 500))).toBe(0)
    // At exactly the minimum it qualifies, and the WHOLE bill earns — not the excess over 500.
    expect(loyaltyPoints(500, scheme(1, 500))).toBe(5)
    expect(loyaltyPoints(1000, scheme(1, 500))).toBe(10)
  })

  test('a zero, negative or non-numeric base earns nothing rather than throwing', () => {
    // A fully comped bill nets to zero, and a discount larger than the line total is enterable.
    expect(loyaltyPoints(0, scheme(1))).toBe(0)
    expect(loyaltyPoints(-250, scheme(1))).toBe(0)
    expect(loyaltyPoints(null, scheme(1))).toBe(0)
    expect(loyaltyPoints(undefined, scheme(1))).toBe(0)
    expect(loyaltyPoints('abc', scheme(1))).toBe(0)
  })

  test('a scheme with a zero or missing rate earns nothing', () => {
    expect(loyaltyPoints(1000, scheme(0))).toBe(0)
    expect(loyaltyPoints(1000, { min_spend_to_earn: 0 })).toBe(0)
  })
})

describe('pointsValue', () => {
  test('converts points to rupees at the client rate, to 2dp', () => {
    expect(pointsValue(10, 1)).toBe(10)
    expect(pointsValue(10, 0.5)).toBe(5)
    expect(pointsValue(3, 0.333)).toBe(1)
  })

  test('a zero balance or unset rate is worth nothing, not NaN', () => {
    expect(pointsValue(0, 1)).toBe(0)
    expect(pointsValue(10, 0)).toBe(0)
    expect(pointsValue(10, null)).toBe(0)
  })
})

describe('maxRedeemablePoints', () => {
  test('capped by the balance', () => {
    expect(maxRedeemablePoints(50, 10000, 1)).toBe(50)
  })

  test('capped by the bill, so a redemption can never hand back change', () => {
    // 500 points at NPR 1 is worth 500, but the bill is only 120.
    expect(maxRedeemablePoints(500, 120, 1)).toBe(120)
  })

  test('respects a point value above NPR 1 when capping against the bill', () => {
    // At NPR 5 a point, a bill of 120 can absorb only 24 points.
    expect(maxRedeemablePoints(500, 120, 5)).toBe(24)
  })

  test('degrades to zero rather than NaN on missing inputs', () => {
    expect(maxRedeemablePoints(0, 100, 1)).toBe(0)
    expect(maxRedeemablePoints(50, 0, 1)).toBe(0)
    expect(maxRedeemablePoints(50, 100, 0)).toBe(0)
    expect(maxRedeemablePoints(null, null, null)).toBe(0)
  })
})
