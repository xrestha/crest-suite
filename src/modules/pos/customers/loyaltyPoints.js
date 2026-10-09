import { normalizePhone } from '../../../utils/phone'

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

/**
 * Whether a bill's phone is one of the outlet's delivery partners' (S809 2g, CUSTOMERS-PARKING-1).
 * A platform owes its bills and remits them later; it is in the customer book only because picking it
 * puts its name and phone on the bill. So it neither earns nor spends points, and the till shows no
 * points panel for it.
 *
 * Mirrors pos_phone_is_delivery_partner() in `20261009230000_pos_loyalty_points_s809.sql`, which
 * award_loyalty_points and redeem_loyalty_points ask: the same text (the picker copies the partner's
 * phone exactly), or the same number written another way, through normalizePhone (the twin of
 * pos_customers.phone_canonical). **If you change one, change both.**
 *
 * @param {string} phone      The phone on the bill.
 * @param {Array<{phone?: string}>} partners  settings.pos_delivery_partners (null when unset).
 */
export function isDeliveryPartnerPhone(phone, partners) {
  const raw = String(phone || '').trim()
  if (!raw || !Array.isArray(partners)) return false
  const canon = normalizePhone(raw)
  return partners.some(p => {
    const pRaw = String(p?.phone || '').trim()
    if (!pRaw) return false
    if (pRaw === raw) return true
    const pCanon = normalizePhone(pRaw)
    return pCanon !== null && pCanon === canon
  })
}

/**
 * Whether the amount redeem_loyalty_points charged for the points differs from the amount the till
 * showed (S809 2g, CUSTOMERS-PARKING-3). The server values the points at the outlet's point value at
 * that moment; the till's figure was worked out from the value it read when the phone was entered,
 * which a manager may have changed since. More than a paisa apart is a difference (the two sides
 * round independently); an answer that is not a number cannot be compared and is not one.
 */
export function redeemedAmountDiffers(serverAmount, screenAmount) {
  if (serverAmount === null || serverAmount === undefined || serverAmount === '') return false
  const s = Number(serverAmount)
  if (!Number.isFinite(s)) return false
  const c = Number(screenAmount) || 0
  return Math.abs(Math.round(s * 100) - Math.round(c * 100)) > 1
}

// The most points one hand correction may change, either way: adjust_loyalty_points refuses more
// (a typo guard, well above any real balance). Kept equal to the SQL's 1,000,000.
export const MAX_POINTS_ADJUST = 1000000
// The longest reason adjust_loyalty_points keeps.
export const MAX_ADJUST_REASON = 300

/**
 * Checks a hand correction of a points balance before it is sent (S809 3k, CUSTOMERS-PARKING-5), with
 * the same rules adjust_loyalty_points applies on the server, so the window can say what is wrong next
 * to the field instead of after a round trip. The server still decides.
 *
 * @param {{direction: 'add'|'take'|'', pointsStr: string, reason: string, balance: number|null,
 *          isPartner?: boolean}} input  `balance` is the customer's points now (null when unknown).
 * @returns {{points: number|null, newBalance: number|null,
 *            errors: {direction?: string, points?: string, reason?: string}}}
 *   `points` is signed (+ adds, − takes off); null until the choice and the box make an allowed amount.
 *   Nothing may be sent while `errors` has any key.
 */
export function pointsAdjustment({ direction, pointsStr, reason, balance, isPartner = false }) {
  const errors = {}
  if (direction !== 'add' && direction !== 'take') errors.direction = 'Choose whether to add points or take them off.'
  else if (direction === 'add' && isPartner) errors.direction = 'A delivery partner’s number cannot be given points — it does not earn or spend them.'

  const typed = String(pointsStr ?? '').replace(/[,\s]/g, '')
  let count = null
  if (!typed) errors.points = 'Enter how many points.'
  else if (!/^\d+$/.test(typed)) errors.points = 'Points are whole numbers, like 50.'
  else {
    count = Number(typed)
    if (count === 0) { errors.points = 'Enter more than 0 points.'; count = null }
    else if (count > MAX_POINTS_ADJUST) { errors.points = `At most ${MAX_POINTS_ADJUST.toLocaleString('en-IN')} points at a time — check the number.`; count = null }
  }

  // Never below zero by hand (the server refuses it too). A balance already below zero can still be
  // brought up.
  const known = typeof balance === 'number' && Number.isFinite(balance)
  if (count !== null && direction === 'take' && known && count > Math.max(balance, 0)) {
    errors.points = balance > 0
      ? `This customer holds ${balance.toLocaleString('en-IN')} points, so at most ${balance.toLocaleString('en-IN')} can be taken off.`
      : 'This customer holds no points, so none can be taken off.'
  }

  const why = String(reason ?? '').trim()
  if (!why) errors.reason = 'Say why — the reason is kept with the correction.'
  else if (why.length > MAX_ADJUST_REASON) errors.reason = `Keep the reason under ${MAX_ADJUST_REASON} characters.`

  // The reason does not hold back the preview: the new balance shows as soon as the amount is right.
  const points = count === null || errors.direction || errors.points ? null : (direction === 'take' ? -count : count)
  return { points, newBalance: points !== null && known ? balance + points : null, errors }
}

/**
 * What a box in a scheme's row does when it loses focus (S809 3k, CUSTOMERS-PARKING-12): an empty box
 * keeps the stored value (it used to save 0, which stopped a scheme earning or dropped its minimum), the
 * stored value itself saves nothing, and anything else must be a number of 0 or more.
 *
 * @returns {{action: 'keep'} | {action: 'save', value: number} | {action: 'invalid', text: string}}
 */
export function schemeNumberCommit(typed, stored) {
  const t = String(typed ?? '').trim()
  if (t === '') return { action: 'keep' }
  const v = Number(t)
  if (!Number.isFinite(v) || v < 0) return { action: 'invalid', text: 'Enter a number of 0 or more.' }
  if (v === Number(stored)) return { action: 'keep' }
  return { action: 'save', value: v }
}

/**
 * One line of a customer's points history in plain words (S809 3k): what happened, and on which bill.
 * `row` is a pos_loyalty_ledger row with `pos_orders` embedded as {order_no, invoice_no} when it has a
 * bill. A correction's own note is the best description of it (a hand correction's starts "By hand:").
 */
export function describeLedgerRow(row) {
  const o = row?.pos_orders || null
  const bill = o ? (o.invoice_no != null ? `Bill #${o.invoice_no}` : (o.order_no != null ? `Order #${o.order_no}` : 'A bill')) : null
  const note = String(row?.note || '').trim()
  let what
  if (row?.kind === 'earn') what = 'Earned'
  else if (row?.kind === 'redeem') what = 'Spent'
  else what = note || 'Corrected'
  return { what, bill }
}
