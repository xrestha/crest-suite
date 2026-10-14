import { normalizePhone } from '../../../utils/phone'
import { npr, nprExact } from '../../../shared/nepalMoney'

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
  const bill = o ? billLabel(o) : null
  const note = String(row?.note || '').trim()
  let what
  if (row?.kind === 'earn') what = 'Earned'
  else if (row?.kind === 'redeem') what = 'Spent'
  else what = note || 'Corrected'
  return { what, bill }
}

/** "Bill #1234", or "Order #56" for a bill with no invoice number (a comp), or "A bill". */
export function billLabel(o) {
  if (!o) return 'A bill'
  return o.invoice_no != null ? `Bill #${o.invoice_no}` : (o.order_no != null ? `Order #${o.order_no}` : 'A bill')
}

// ── S815 4g ──────────────────────────────────────────────────────────────────────────────────

/**
 * Points that can be spent now (CUSTOMERS-PARKING-9, owner decision Q19 c): the balance less the points
 * held on unpaid Credit bills. A Credit bill earns at its close, and its points can be spent once it is
 * settled. `held` comes from pos_loyalty_balances, the one place the server works it out, and
 * redeem_loyalty_points refuses the held part. Never below 0.
 */
export function spendablePoints(balance, held) {
  const b = Math.floor(Number(balance) || 0)
  const h = Math.max(0, Math.floor(Number(held) || 0))
  return Math.max(0, b - h)
}

/**
 * Points this customer has put on other bills still open (S835, S809.4 2g), one entry per bill, from
 * their `redeem` ledger rows with the bill embedded (`pos_orders!inner(order_no, table_name, status)`).
 * A redemption row is negative; the entry carries the points as a positive count. Bills with nothing
 * left on them (a handed-back try) are dropped.
 */
export function pointsOnOtherBills(rows) {
  const byOrder = new Map()
  for (const r of rows || []) {
    if (!r?.order_id) continue
    const cur = byOrder.get(r.order_id) || { orderId: r.order_id, points: 0, orderNo: r.pos_orders?.order_no ?? null, tableName: r.pos_orders?.table_name || null }
    cur.points += -(Math.floor(Number(r.points) || 0))
    byOrder.set(r.order_id, cur)
  }
  return [...byOrder.values()].filter(b => b.points > 0)
}

/** "40 points held on order #12 (Table 4) until it closes." for one pointsOnOtherBills entry. */
export function pointsOnOtherBillText({ points, orderNo, tableName }) {
  const n = `${points.toLocaleString('en-IN')} point${points === 1 ? '' : 's'}`
  const bill = `${orderNo != null ? `order #${orderNo}` : 'another open order'}${tableName ? ` (${tableName})` : ''}`
  return `${n} held on ${bill} until it closes, or until that bill hands them back.`
}

/** Money with paisa only when there are some: a point worth NPR 2.5 shows as NPR 2.50, NPR 10 as NPR 10. */
export function nprPoints(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return Number.isInteger(v) ? npr(v) : nprExact(v)
}

/**
 * What a scheme gives back, in rupees per NPR 100 spent, at the outlet's point value
 * (CUSTOMERS-PARKING-10). Per NPR 100, so the same number is the percentage of the bill. null when
 * either number is unknown or not usable.
 */
export function schemeGivesBack(pointsPer100, pointValue) {
  const r = Number(pointsPer100)
  const v = Number(pointValue)
  if (pointsPer100 == null || pointValue == null || !Number.isFinite(r) || !Number.isFinite(v) || r < 0 || v <= 0) return null
  return Math.round(r * v * 100) / 100
}

/** A scheme giving back this percentage of a bill or more asks before it is saved (CUSTOMERS-PARKING-10). */
export const GIVE_BACK_CONFIRM_PCT = 50

/**
 * What the bill on the payment screen will earn, in the cashier's words (CUSTOMERS-PARKING-11). The
 * window used to tell every customer with no points that "this bill will earn some", including those in
 * no scheme and those under the minimum, and then no points arrived.
 *
 * @param {{base: number, scheme: ({name?: string, points_per_100: number, min_spend_to_earn: number,
 *          is_active?: boolean}|null), credit?: boolean}} input
 *   `base` as loyaltyPoints() takes it; `scheme` the customer's scheme (null when in none); `credit`
 *   when the bill is going on Credit, whose points wait for the bill to be settled (Q19 c).
 * @returns {{points: number, text: string}}
 */
export function earnPreview({ base, scheme, credit = false }) {
  if (!scheme) return { points: 0, text: 'Not in a points scheme, so this bill earns no points.' }
  if (scheme.is_active === false) {
    return { points: 0, text: `Their scheme${scheme.name ? ` (${scheme.name})` : ''} is switched off, so this bill earns no points.` }
  }
  const min = Number(scheme.min_spend_to_earn) || 0
  if (min > 0 && (Number(base) || 0) < min) {
    return { points: 0, text: `Below the ${nprPoints(min)} minimum for points, so this bill earns no points.` }
  }
  const points = loyaltyPoints(base, scheme)
  if (points <= 0) return { points: 0, text: 'This bill earns no points.' }
  const n = `${points.toLocaleString('en-IN')} point${points === 1 ? '' : 's'}`
  return { points, text: credit ? `This bill earns ${n}, usable once it is settled.` : `This bill earns ${n}.` }
}

/**
 * A bill's earn base from its stored lines, as award_loyalty_points works it out: lines not comped, at
 * qty × unit_price, less the bill's discount.
 */
export function billEarnBase(items, discountAmount) {
  const sub = (items || []).reduce((s, i) => (i?.comped ? s : s + (Number(i?.qty) || 0) * (Number(i?.unit_price) || 0)), 0)
  return sub - (Number(discountAmount) || 0)
}

/**
 * The customer's bills that should have earned and have no points recorded, for the one-tap "add the
 * points this bill earned" (owner addition, S815 4g). Only bills closed since the customer joined their
 * scheme (D13): one from before earned nothing on purpose, and award_loyalty_points refuses it. Only a
 * paid bill with no credit note and no delivery partner, on which the scheme earns more than 0 today
 * (the server works the points out from the same stored lines and the scheme as it is now).
 *
 * @param {{bills: Array<{id: string, closed_at: string, close_type: string, credit_note_id: ?string,
 *          delivery_partner: ?string, discount_amount: ?number}>, earnedIds: Set<string>,
 *          itemsByOrder: Map<string, Array>, scheme: ?object, joinedAt: ?string}} input
 * @returns {Array<{bill: object, points: number}>} newest first, as `bills` is ordered.
 */
export function billsMissingPoints({ bills, earnedIds, itemsByOrder, scheme, joinedAt }) {
  if (!scheme || scheme.is_active === false) return []
  const since = joinedAt ? new Date(joinedAt).getTime() : null
  const out = []
  for (const b of bills || []) {
    if (b.close_type !== 'paid' || b.credit_note_id || b.delivery_partner) continue
    if (earnedIds?.has(b.id)) continue
    if (since != null && new Date(b.closed_at).getTime() < since) continue
    const points = loyaltyPoints(billEarnBase(itemsByOrder?.get(b.id), b.discount_amount), scheme)
    if (points > 0) out.push({ bill: b, points })
  }
  return out
}

/**
 * Checks a points move before it is sent, with the rules move_loyalty_points applies (owner addition,
 * S815 4g), so the window can say what is wrong next to the field. The server still decides.
 *
 * @param {{toPhone: string, reason: string, fromPhone: string, partners?: Array}} input
 * @returns {{toNumber: (string|null), errors: {phone?: string, reason?: string}}} `toNumber` is the new
 *   number as the customer book will store it.
 */
export function pointsMove({ toPhone, reason, fromPhone, partners = [] }) {
  const errors = {}
  const toNumber = normalizePhone(toPhone)
  if (!String(toPhone ?? '').trim()) errors.phone = 'Enter the new phone number.'
  else if (!toNumber) errors.phone = 'Type the new number in full (7 digits or more).'
  else if (toNumber === normalizePhone(fromPhone) || String(toPhone).trim() === String(fromPhone ?? '').trim()) errors.phone = 'That is this customer’s own number.'
  else if (isDeliveryPartnerPhone(toPhone, partners)) errors.phone = 'That is a delivery partner’s number, which does not earn or spend points.'

  const why = String(reason ?? '').trim()
  if (!why) errors.reason = 'Say why — the reason is kept on both numbers.'
  else if (why.length > MAX_ADJUST_REASON) errors.reason = `Keep the reason under ${MAX_ADJUST_REASON} characters.`
  return { toNumber, errors }
}
