// Shared between the manager view (TadaClaims.jsx) and the Self-Service submit tab
// (SelfServiceHome.jsx) so the expense-line/vehicle-rate UI logic isn't duplicated.

// Exactly the four `hr_tada_claim_items_category_check` accepts — a fifth here without the
// database fails every claim that uses it.
export const CATEGORIES = ['Transport', 'Lodging', 'Daily Allowance', 'Other']
export const VEHICLE_TYPES = [
  { key: '2w', label: '2-Wheeler' },
  { key: '4w', label: '4-Wheeler' },
  { key: 'ev', label: 'EV' },
]
export const DEFAULT_PURPOSE_OPTIONS = ['Vendor site visit', 'Purchase', 'Bank errand', 'Client meeting', 'Delivery', 'Site inspection', 'Training / Conference']
export const OTHER_PURPOSE = '__other__'
// No sensible generic default (varies too much per client, unlike Purpose) — starts empty;
// a client adds their own via ⚙ Settings. "Other" is still always available regardless.
export const DEFAULT_START_POINTS = []
// Purpose value that triggers the vendor picker on the Destination field.
export const PURCHASE_PURPOSE = 'Purchase'

// vehicle/distanceKm are UI-only — they drive the auto-computed Amount but are never persisted
// (hr_tada_claim_items only has category/description/amount).
export const EMPTY_TADA_ITEM = () => ({ category: 'Transport', description: '', amount: '', vehicle: '2w', distanceKm: '' })

// Live-recompute Amount whenever Distance or Vehicle changes on a Transport line — only
// overwrites Amount when both a distance and a configured rate exist, so it never clobbers a
// manually-typed Amount just because the rate isn't set up yet for that vehicle.
export function recomputeTadaAmount(it, distanceKm, vehicle, vehicleRates) {
  const dist = parseFloat(distanceKm) || 0
  const rate = vehicleRates[vehicle]
  return (dist > 0 && rate != null && rate >= 0) ? String(Math.round(dist * rate)) : it.amount
}

// What a line contributes to the claim, counted the way the database counts it (S751): a positive,
// finite figure, else nothing. Both forms used to sum `parseFloat(amount) || 0`, so a -500 line
// shrank the Total shown on screen while the save dropped that line — the claim then read
// differently in the list than on the form the employee had just checked.
export function tadaLineAmount(it) {
  const n = parseFloat(it?.amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}
export function tadaItemsTotal(items) {
  return (items || []).reduce((s, it) => s + tadaLineAmount(it), 0)
}

// The onChange filter for an amount box: a blank or a non-negative number is accepted, anything
// else (a negative, "1e999") is simply not taken, so a minus can never reach the total (S751).
export function acceptTadaAmount(value) {
  if (value === '' || value == null) return true
  const n = parseFloat(value)
  return Number.isFinite(n) && n >= 0
}

// '' when the dates are usable, else the sentence to show. AD 'YYYY-MM-DD' strings order
// lexically, so a string comparison is a date comparison. The database refuses a reversed trip
// too (tada_dates_invalid); this says so before a round trip.
export function tadaDatesError(start, end) {
  if (!start || !end) return 'Set the trip dates.'
  if (end < start) return 'The trip ends before it starts — check the end date.'
  return ''
}

// An existing claim that looks like the one being entered: same employee, same dates, same total,
// and not rejected (a rejected claim re-filed is the normal way to correct one). A warning, never a
// refusal — two genuine trips can match (decision 16, S751).
export function findLookAlikeClaim(claims, { employeeId, startDate, endDate, total }) {
  if (!employeeId || !startDate || !endDate || !(total > 0)) return null
  return (claims || []).find(c =>
    c.employee_id === employeeId && c.status !== 'rejected'
    && c.start_date === startDate && c.end_date === endDate
    && Math.abs((parseFloat(c.total_amount) || 0) - total) < 0.005) || null
}
