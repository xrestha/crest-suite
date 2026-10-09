// Canonicalizes free-text phone input for matching/dedup — buyer_phone on pos_orders has
// zero format validation today (raw whatever-the-cashier-typed), so "+977-98-4123-4567",
// "9841234567", and "098 4123 4567" all need to resolve to the same key for loyalty/RFM/
// digital-receipt lookups. Mirrors the phone_canonical generated column added to
// pos_customers (see README.md SQL log) — keep the two in sync if this logic changes.
export function normalizePhone(raw) {
  if (!raw) return null
  let digits = String(raw).replace(/\D/g, '')
  if (digits.startsWith('977') && digits.length > 10) digits = digits.slice(3)
  digits = digits.replace(/^0+/, '')
  return digits.length >= 7 ? digits : null
}

// The phone as a bill and the customer book store it (S809 3k, CUSTOMERS-PARKING-4): the number
// itself when it is one ("+977 984-1234567" → "9841234567"), so one regular is one customer however
// the cashier typed it; otherwise the text as typed, trimmed (a short code or a note is kept, not
// lost). '' when nothing was typed.
export function phoneForRecord(raw) {
  const typed = String(raw ?? '').trim()
  if (!typed) return ''
  return normalizePhone(typed) || typed
}

// How the till finds a customer by a typed phone, the way award_loyalty_points and
// redeem_loyalty_points find one (S809 3k, migration 20261010110000): by pos_customers.phone_canonical
// when the phone is a number of 7 digits or more (the outlet's book holds one row per number), else
// by the text exactly as typed. null when nothing was typed. If you change the rule, change the two
// functions' "S809 3k" blocks too.
export function customerPhoneKey(raw) {
  const typed = String(raw ?? '').trim()
  if (!typed) return null
  const canon = normalizePhone(typed)
  return canon ? { column: 'phone_canonical', value: canon } : { column: 'phone', value: typed }
}
