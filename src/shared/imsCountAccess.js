/**
 * Which paths an IMS PIN count account may reach.
 *
 * WHY (S737): a PIN count account exists to do one job on a shared store-room tablet — enter a
 * closing count — and is created by a manager who is handing out a 4-digit PIN, not a login. It
 * carries `ims_role = 'staff'`, which on its own would open Purchases, Gate Passes, Sales Entry
 * and Requisitions to anyone who picks the tablet up.
 *
 * Deliberately modelled on `posTeamAccess.js` rather than invented: one predicate, read by the
 * sidebar and the command palette (through `isItemVisible`) AND by `ProtectedRoute`, so a page
 * nobody has written yet is already unreachable — which is what fail-closed has to mean. The
 * enforcement sits in `ProtectedRoute` rather than `ModuleGate` because `/dashboard` carries no
 * `ModuleGate` at all: the count tablet would otherwise have landed on the client's revenue.
 *
 * Help is on the list on purpose. It reads no client data, and the person most likely to need
 * "how do I count a sub-recipe" is the one holding the tablet.
 */
export const IMS_COUNT_ALLOWED_PATHS = ['/stock', '/help']

/** Where a count account is sent when it lands somewhere it cannot use. */
export const IMS_COUNT_HOME = '/stock'

/**
 * Where a count account signs in, and where it goes back to when it signs out or locks (S792, D39).
 * The email /login page is the wrong door: a counter holding the tablet has no email to type.
 */
export const IMS_COUNT_LOGIN = '/ims/count'

/** Where a set-up counting device keeps its outlet (ImsCountLogin writes it when the QR is scanned). */
export const IMS_COUNT_DEVICE_KEY = 'ims_count_client_id'

/**
 * Whether this browser was set up as a counting device (S856). ProtectedRoute sends a session that
 * ends here to the PIN screen, as it sends a till's to the till's: the idle lock asked for
 * /ims/count, but the signed-out guard's own redirect to /login landed after it, so a counting
 * phone woke on the email page the counter has no key for (found on a real storeroom phone).
 */
export function isCountDevice() {
  try { return !!localStorage.getItem(IMS_COUNT_DEVICE_KEY) } catch (_) { return false }
}

/**
 * Minutes of no input before a counting tablet locks back to its PIN screen (S792, owner decision
 * D39). A shared tablet stayed signed in for ever, so the next person counted under the previous
 * counter's name — `closing_stock.counted_by`, and the recount protection keyed on it. Ten minutes,
 * not the till's three: a counter legitimately stands at a shelf for minutes between entries, and a
 * lock mid-shelf would teach them to share one PIN.
 */
export const IMS_COUNT_IDLE_LOCK_MS = 10 * 60 * 1000

/** Whether a count-only account may reach `path`. Every other account reaches everything. */
export function imsCountPathReachable(countOnly, path) {
  if (!countOnly) return true
  return IMS_COUNT_ALLOWED_PATHS.includes(path)
}
