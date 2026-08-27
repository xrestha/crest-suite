/**
 * The loyalty earn arithmetic, in one place.
 *
 * This mirrors award_loyalty_points()'s body in
 * `supabase/migrations/20260827160000_pos_loyalty.sql`. The SQL is authoritative — it is what
 * actually writes the ledger, and it computes from the order's own stored lines so a till cannot
 * name its own earn base. This copy exists so the till can show a diner what a bill is about to
 * earn BEFORE it closes, and so the rule is covered by tests without needing a database.
 *
 * **If you change one, change both.** The two are kept honest by `loyaltyPoints.test.js`, which
 * encodes the same boundaries the SQL enforces; a divergence shows up as a preview that promises
 * a number the ledger then contradicts, which is the worst shape this could fail in.
 *
 * @param {number} base   Ex-VAT, post-discount, comps excluded — the same base PosCustomers
 *                        settles delivery commission against (S596), so the two can never
 *                        disagree about what a bill was worth.
 * @param {{points_per_100: number, min_spend_to_earn: number}|null} scheme
 *                        The customer's scheme, or null/undefined when untagged.
 * @returns {number} Whole points earned. 0 for every case that does not qualify.
 */
export function loyaltyPoints(base, scheme) {
  // Untagged earns nothing. This is the opt-in rule, and it is deliberately the first branch:
  // loyalty must never switch itself on for a customer book that predates it.
  if (!scheme) return 0

  const amount = Number(base)
  if (!Number.isFinite(amount) || amount <= 0) return 0

  const rate = Number(scheme.points_per_100)
  if (!Number.isFinite(rate) || rate <= 0) return 0

  const minSpend = Number(scheme.min_spend_to_earn) || 0
  // Below the minimum earns nothing at all. The threshold is a qualifier, not a deduction — once
  // a bill qualifies the WHOLE bill earns, which is what a diner expects and what staff can
  // explain at the till without arithmetic.
  if (amount < minSpend) return 0

  // floor, not round: a bill must never earn a point it has not fully paid for, and the SQL uses
  // floor() too. Rounding up here would make the preview optimistic by one point on most bills.
  return Math.floor((amount / 100) * rate)
}

/**
 * What a points balance is worth in rupees. One client-level rate — schemes differ in how fast
 * you earn, everyone redeems at the same value (the product decision behind this feature).
 */
export function pointsValue(points, pointValue) {
  const p = Number(points)
  const v = Number(pointValue)
  if (!Number.isFinite(p) || !Number.isFinite(v) || p <= 0 || v <= 0) return 0
  return Math.round(p * v * 100) / 100
}

/**
 * The most points that may be applied to a bill: capped by the balance AND by the bill itself, so
 * a redemption can never hand back change. Returns whole points.
 */
export function maxRedeemablePoints(balance, billTotal, pointValue) {
  const bal = Math.max(0, Math.floor(Number(balance) || 0))
  const v = Number(pointValue)
  if (!Number.isFinite(v) || v <= 0) return 0
  const total = Number(billTotal)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(bal, Math.floor(total / v))
}
